// G05：从“获准来源锚点 + 结构化规格”组建完整 LessonPlan，并做关键约束校验。
// 内容来源身份（content_origin）随计划与下游成品传递；模型产物（含离线注入）标记为模拟，不冒充真实备课。
import { randomUUID } from 'node:crypto';
import { LESSONPLAN_SCHEMA_VERSION, type Activity, type Homework, type LessonPlan, type Objective, type Rubric, type SourceAnchor, type Task } from './types';

export interface LessonAnchorInput {
  source_version_id: string;
  locator: Record<string, number | string>;
  quote: string;
  source_class: SourceAnchor['source_class'];
  verification?: SourceAnchor['verification'];
}
export interface LessonTaskInput {
  prompt: string; // 学生任务
  cognitive_demand: Task['cognitive_demand'];
  support_level: Task['support_level'];
  teacher_notes: string; // 教师追问/备注
  acceptable_variants: string[]; // 合理答案范围
  insufficient_examples: string[]; // 典型误解
  anchorIndexes: number[]; // 引用第几个 anchor（1-based）
}
export interface LessonActivityInput {
  title: string;
  start_sec: number;
  end_sec: number;
  actor: Activity['actor'];
  student_action: string;
  teacher_action: string;
  priority: Activity['priority'];
  taskIndexes: number[]; // 关联第几个 task（1-based）
}
export interface LessonPlanSpec {
  title: string;
  declared_duration_sec: number;
  task_context_id: string;
  objectives: { description: string; cognitive_demand: Objective['cognitive_demand']; curriculum_ref_ids?: string[] }[];
  anchors: LessonAnchorInput[];
  tasks: LessonTaskInput[];
  activities: LessonActivityInput[];
  homework?: { description: string; necessary_reason: string; estimated_sec: number; stop_condition: string }[];
  teacher_summary: string;
  unknowns?: string[];
  previous_revision_id?: string | null;
  plan_id?: string; // 修订同一 plan 时复用
}

export type LessonValidation = { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };
const SCHEDULE_UNDERFILL_TOLERANCE_SEC = 600; // 欠时容忍（超出需解释，仅告警不拦截）

// 自拟示例《春》完整课时计划规格（明确标注自拟；用于 G05/G06 确定性并行开发）。
export function demoLessonSpec(overrides: Partial<LessonPlanSpec> = {}): LessonPlanSpec {
  return {
    title: '《春》第一课时',
    declared_duration_sec: 45 * 60,
    task_context_id: 'ctx_demo',
    objectives: [
      { description: '朗读课文，把握重音与停连', cognitive_demand: 'aesthetic_response' },
      { description: '找出比喻与拟人并体会其表达效果', cognitive_demand: 'explain' }
    ],
    anchors: [{ source_version_id: 'ver_demo', locator: { line: 2 }, quote: '盼望着，东风来了，春天的脚步近了。', source_class: 'public_reference', verification: 'exact_checked' }],
    tasks: [
      { prompt: '朗读第一段并标出重音与停连', cognitive_demand: 'aesthetic_response', support_level: 'partial_prompt', teacher_notes: '追问：为何反复“盼望着”？', acceptable_variants: ['重音落在盼望着，反复表期盼'], insufficient_examples: ['只标句末停顿'], anchorIndexes: [1] },
      { prompt: '找出一处拟人句并说明效果', cognitive_demand: 'explain', support_level: 'independent', teacher_notes: '追问：拟人与比喻区别？', acceptable_variants: ['东风来了赋予人的动作'], insufficient_examples: ['把比喻误判为拟人'], anchorIndexes: [1] }
    ],
    activities: [
      { title: '导入齐读', start_sec: 0, end_sec: 300, actor: 'both', student_action: '齐读课文', teacher_action: '范读并纠音', priority: 'essential', taskIndexes: [1] },
      { title: '朗读标注', start_sec: 300, end_sec: 900, actor: 'student', student_action: '标出重音与停连并练读', teacher_action: '巡视纠音', priority: 'essential', taskIndexes: [1] },
      { title: '研读修辞', start_sec: 900, end_sec: 2100, actor: 'student', student_action: '分组找修辞句', teacher_action: '巡视点拨并揭示合理答案', priority: 'essential', taskIndexes: [2] },
      { title: '小结与作业', start_sec: 2100, end_sec: 2640, actor: 'both', student_action: '回顾并记录作业', teacher_action: '小结并布置作业', priority: 'compressible', taskIndexes: [] }
    ],
    homework: [{ description: '背诵第一段', necessary_reason: '积累语感', estimated_sec: 600, stop_condition: '能流畅背诵' }],
    teacher_summary: '以朗读带动修辞体会，注意情感与语言结合。',
    unknowns: ['本班是否已学拟人（需教师核实）'],
    ...overrides
  };
}

export function validateLessonPlan(p: LessonPlan): LessonValidation {
  const e: string[] = [];
  const w: string[] = [];
  if (p.schema_version !== LESSONPLAN_SCHEMA_VERSION) e.push('schema_version');
  if (!p.title.trim()) e.push('title_empty');
  if (!Number.isInteger(p.declared_duration_sec) || p.declared_duration_sec < 300) e.push('duration_lt_300');
  if (p.objectives.length < 1) e.push('objectives_min');
  if (p.tasks.length < 1) e.push('tasks_min');
  if (p.rubrics.length < 1) e.push('rubrics_min');
  if (p.activities.length < 1) e.push('activities_min');
  const anchorIds = new Set(p.source_anchors.map((a) => a.anchor_id));
  const rubricIds = new Set(p.rubrics.map((r) => r.rubric_id));
  const taskIds = new Set(p.tasks.map((t) => t.task_id));
  for (const t of p.tasks) {
    if (!t.prompt.trim()) e.push(`task_prompt_empty:${t.task_id}`);
    if (!rubricIds.has(t.rubric_id)) e.push(`task_rubric_missing:${t.task_id}`);
    // 引用完整性：无效锚点不得被静默忽略，必须报错。
    for (const a of t.material_anchor_ids) if (!anchorIds.has(a)) e.push(`task_anchor_missing:${t.task_id}:${a}`);
  }
  for (const r of p.rubrics) {
    if (r.kind === 'teacher_defined' && r.criteria.every((c) => c.acceptable_variants.length === 0)) e.push(`rubric_no_variants:${r.rubric_id}`);
    for (const id of r.source_anchor_ids) if (!anchorIds.has(id)) e.push(`rubric_anchor_missing:${r.rubric_id}:${id}`);
  }
  // 无课程依据不得标 mapped（应保持待确认）。
  for (const o of p.objectives) if (o.curriculum_ref_ids.length === 0 && o.coverage_state === 'mapped') e.push(`objective_mapped_without_curriculum:${o.objective_id}`);
  let maxEnd = 0;
  for (const a of p.activities) {
    if (!['teacher', 'student', 'both'].includes(a.actor)) e.push(`activity_actor:${a.activity_id}`);
    if (a.end_sec < a.start_sec || a.start_sec < 0) e.push(`activity_time:${a.activity_id}`);
    for (const id of a.task_ids) if (!taskIds.has(id)) e.push(`activity_task_missing:${a.activity_id}:${id}`);
    if (a.end_sec > p.declared_duration_sec) e.push(`activity_overtime:${a.activity_id}`); // 超声明课时 → 拦截
    maxEnd = Math.max(maxEnd, a.end_sec);
  }
  // 欠时（大段未编排且未解释）→ 告警，不拦截。
  if (p.activities.length && p.declared_duration_sec - maxEnd > SCHEDULE_UNDERFILL_TOLERANCE_SEC) w.push(`schedule_underfilled:${p.declared_duration_sec - maxEnd}s`);
  return e.length ? { ok: false, errors: e, warnings: w } : { ok: true, warnings: w };
}

// 组建 LessonPlan：分配稳定 ID，连接 objectives/tasks/rubrics/activities/anchors。
export function buildLessonPlan(spec: LessonPlanSpec): LessonPlan {
  const planId = spec.plan_id ?? `plan_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const anchors: SourceAnchor[] = spec.anchors.map((a, i) => ({
    anchor_id: `anc_${i + 1}`,
    source_version_id: a.source_version_id,
    locator: a.locator,
    quote: a.quote,
    context_before: '',
    context_after: '',
    verification: a.verification ?? 'needs_review',
    source_class: a.source_class
  }));
  const objectives: Objective[] = spec.objectives.map((o, i) => {
    const refs = o.curriculum_ref_ids ?? [];
    return {
      objective_id: `obj_${i + 1}`,
      description: o.description,
      curriculum_ref_ids: refs,
      cognitive_demand: o.cognitive_demand,
      independent_task_ids: [],
      // 无课程依据 → 保持待确认，不靠填字段制造“已映射”。
      coverage_state: refs.length ? 'mapped' : 'needs_source_confirmation'
    };
  });
  const rubrics: Rubric[] = [];
  const tasks: Task[] = spec.tasks.map((t, i) => {
    const rubricId = `rub_${i + 1}`;
    // 不静默过滤无效引用：保留调用方给定的 anchor 引用，交由校验暴露错误。
    const anchorRefs = t.anchorIndexes.map((n) => `anc_${n}`);
    rubrics.push({
      rubric_id: rubricId,
      kind: 'teacher_defined',
      criteria: [
        {
          criterion_id: `crit_${i + 1}`,
          description: `任务${i + 1}的评分要点`,
          acceptable_variants: t.acceptable_variants,
          insufficient_examples: t.insufficient_examples,
          anchor_ids: anchorRefs
        }
      ],
      source_anchor_ids: anchorRefs,
      allows_alternatives: t.acceptable_variants.length > 1,
      professional_calibration: 'not_calibrated'
    });
    return {
      task_id: `task_${i + 1}`,
      objective_ids: objectives.length ? [objectives[Math.min(i, objectives.length - 1)].objective_id] : [],
      prompt: t.prompt,
      material_anchor_ids: anchorRefs,
      cognitive_demand: t.cognitive_demand,
      support_level: t.support_level,
      rubric_id: rubricId,
      teacher_notes: t.teacher_notes,
      is_formal_exam: false
    };
  });
  const activities: Activity[] = spec.activities.map((a, i) => ({
    activity_id: `act_${i + 1}`,
    title: a.title,
    objective_ids: [],
    task_ids: a.taskIndexes.map((n) => `task_${n}`), // 不静默过滤，交由校验暴露无效引用
    start_sec: a.start_sec,
    end_sec: a.end_sec,
    duration_kind: 'estimated',
    actor: a.actor,
    requires_teacher_attention: a.actor !== 'student',
    parallel_group_id: null,
    branch_group_id: null,
    selected: true,
    student_action: a.student_action,
    teacher_action: a.teacher_action,
    priority: a.priority,
    fallback: ''
  }));
  const homework: Homework[] = (spec.homework ?? []).map((h, i) => ({
    homework_id: `hw_${i + 1}`,
    description: h.description,
    necessary_reason: h.necessary_reason,
    target_group: 'all',
    estimated_sec: h.estimated_sec,
    replaces: '',
    stop_condition: h.stop_condition
  }));
  return {
    schema_version: LESSONPLAN_SCHEMA_VERSION,
    plan_id: planId,
    revision_id: revisionId,
    previous_revision_id: spec.previous_revision_id ?? null,
    task_context_id: spec.task_context_id,
    title: spec.title,
    declared_duration_sec: spec.declared_duration_sec,
    source_anchors: anchors,
    claims: [],
    objectives,
    tasks,
    rubrics,
    activities,
    links: [],
    homework,
    teacher_summary: spec.teacher_summary,
    unknowns: spec.unknowns ?? [],
    software_review_state: 'not_reviewed',
    teaching_effect_state: 'not_taught'
  };
}
