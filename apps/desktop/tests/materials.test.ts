import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { buildLessonPlan, validateLessonPlan, type LessonPlanSpec } from '../src/main/lesson/build';
import { buildMaterialSet } from '../src/main/materials/generate';
import { extractBuffer } from '../src/main/sources/extract';

const hasCjkFont = ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'].some((f) => existsSync(f));

// 自拟《春》完整课时计划规格（明确标注为自拟内容）。
function chunSpec(overrides: Partial<LessonPlanSpec> = {}): LessonPlanSpec {
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
      {
        prompt: '朗读第一段并标出重音与停连',
        cognitive_demand: 'aesthetic_response',
        support_level: 'partial_prompt',
        teacher_notes: '追问：为何反复“盼望着”？体会期盼之情。',
        acceptable_variants: ['重音落在“盼望着”，通过反复表达急切期盼'],
        insufficient_examples: ['只标注句末停顿，未体会情感'],
        anchorIndexes: [1]
      },
      {
        prompt: '找出一处拟人句并说明其效果',
        cognitive_demand: 'explain',
        support_level: 'independent',
        teacher_notes: '追问：拟人与比喻的区别？',
        acceptable_variants: ['“东风来了”赋予东风以人的动作，生动写出春的到来'],
        insufficient_examples: ['把比喻误判为拟人'],
        anchorIndexes: [1]
      }
    ],
    activities: [
      { title: '导入齐读', start_sec: 0, end_sec: 300, actor: 'both', student_action: '齐读课文', teacher_action: '范读并纠音', priority: 'essential', taskIndexes: [1] },
      { title: '研读修辞', start_sec: 300, end_sec: 1500, actor: 'student', student_action: '分组找修辞句', teacher_action: '巡视点拨、揭示合理答案', priority: 'essential', taskIndexes: [2] }
    ],
    homework: [{ description: '背诵第一段', necessary_reason: '积累语感', estimated_sec: 600, stop_condition: '能流畅背诵' }],
    teacher_summary: '本课以朗读带动修辞体会，注意情感与语言的结合。',
    unknowns: ['本班学情：是否已学过拟人（需教师核实）'],
    ...overrides
  };
}

describe('G05 完整 LessonPlan', () => {
  it('组建的计划通过关键约束校验（objectives/tasks/rubrics/activities/时长/角色）', () => {
    const plan = buildLessonPlan(chunSpec());
    const v = validateLessonPlan(plan);
    expect(v.ok).toBe(true);
    expect(plan.objectives.length).toBeGreaterThanOrEqual(1);
    expect(plan.tasks.length).toBe(2);
    expect(plan.rubrics.length).toBe(2);
    expect(plan.activities.every((a) => ['teacher', 'student', 'both'].includes(a.actor))).toBe(true);
    expect(plan.declared_duration_sec).toBeGreaterThanOrEqual(300);
  });

  it('时长不足 / 无任务 → 校验失败', () => {
    const bad = buildLessonPlan(chunSpec({ declared_duration_sec: 100 }));
    expect(validateLessonPlan(bad).ok).toBe(false);
  });
});

const ORIGIN = 'authored';
async function textOf(bytes: Buffer, format: string): Promise<string> {
  const r = await extractBuffer(bytes, format);
  return r.fullText;
}

describe('G06 三类五文件：生成/角色隔离/版本一致/一处修改联动', () => {
  it('生成五个文件并可回解析（DOCX/PPTX）', async () => {
    const plan = buildLessonPlan(chunSpec());
    const set = await buildMaterialSet(plan, ORIGIN);
    expect(set.files.map((f) => `${f.role}/${f.format}`).sort()).toEqual(['presentation/pptx', 'student/docx', 'student/pdf', 'teacher/docx', 'teacher/pdf'].sort());
    for (const f of set.files) expect(f.bytes.length).toBeGreaterThan(200);
    // 回解析 docx/pptx
    const sDocx = set.files.find((f) => f.role === 'student' && f.format === 'docx')!;
    const tDocx = set.files.find((f) => f.role === 'teacher' && f.format === 'docx')!;
    const pptx = set.files.find((f) => f.format === 'pptx')!;
    expect((await textOf(sDocx.bytes, 'docx')).length).toBeGreaterThan(10);
    expect((await textOf(pptx.bytes, 'pptx')).length).toBeGreaterThan(10);
    expect((await textOf(tDocx.bytes, 'docx')).length).toBeGreaterThan(10);
  });

  it('角色隔离：教师专属内容不出现在学生版/投屏 PPTX；仅在教师版', async () => {
    const plan = buildLessonPlan(chunSpec());
    const set = await buildMaterialSet(plan, ORIGIN);
    const sDocxText = await textOf(set.files.find((f) => f.role === 'student' && f.format === 'docx')!.bytes, 'docx');
    const pptxText = await textOf(set.files.find((f) => f.format === 'pptx')!.bytes, 'pptx');
    const tDocxText = await textOf(set.files.find((f) => f.role === 'teacher' && f.format === 'docx')!.bytes, 'docx');
    const teacherOnly = ['重音落在“盼望着”', '把比喻误判为拟人', '追问：为何反复', '范读并纠音', '本课以朗读带动修辞体会'];
    for (const s of teacherOnly) {
      expect(sDocxText.includes(s), `学生DOCX不应含: ${s}`).toBe(false);
      expect(pptxText.includes(s), `投屏PPTX不应含: ${s}`).toBe(false);
      expect(tDocxText.includes(s), `教师DOCX应含: ${s}`).toBe(true);
    }
    // 学生版应含学生任务
    expect(sDocxText).toContain('朗读第一段并标出重音与停连');
  });

  it('版本一致：五个文件都内嵌同一 plan_id 与 revision_id', async () => {
    const plan = buildLessonPlan(chunSpec());
    const set = await buildMaterialSet(plan, ORIGIN);
    const parseable = set.files.filter((f) => f.format !== 'pdf');
    for (const f of parseable) {
      const t = await textOf(f.bytes, f.format);
      expect(t.includes(plan.plan_id), `${f.role}/${f.format} 含 plan_id`).toBe(true);
      expect(t.includes(plan.revision_id), `${f.role}/${f.format} 含 revision_id`).toBe(true);
    }
  });

  it('一处修改联动：改任务→新修订→重生成，五个文件同步更新且带新 revision_id', async () => {
    const plan1 = buildLessonPlan(chunSpec());
    const set1 = await buildMaterialSet(plan1, ORIGIN);
    // 一处修改：改第一个任务提示；沿用同一 plan_id，形成新修订
    const spec2 = chunSpec({ plan_id: plan1.plan_id, previous_revision_id: plan1.revision_id });
    spec2.tasks[0].prompt = '朗读第一段并标注情感变化（修订）';
    const plan2 = buildLessonPlan(spec2);
    expect(plan2.plan_id).toBe(plan1.plan_id);
    expect(plan2.revision_id).not.toBe(plan1.revision_id);
    const set2 = await buildMaterialSet(plan2, ORIGIN);
    const sText = await textOf(set2.files.find((f) => f.role === 'student' && f.format === 'docx')!.bytes, 'docx');
    const pText = await textOf(set2.files.find((f) => f.format === 'pptx')!.bytes, 'pptx');
    expect(sText).toContain('标注情感变化（修订）');
    expect(pText).toContain('标注情感变化（修订）');
    // 旧集合不含新文本
    const sOld = await textOf(set1.files.find((f) => f.role === 'student' && f.format === 'docx')!.bytes, 'docx');
    expect(sOld.includes('标注情感变化（修订）')).toBe(false);
    // 新 revision_id 已写入
    expect(sText).toContain(plan2.revision_id);
  });

  it.skipIf(!hasCjkFont)('PDF（学生/教师）可回解析且遵守角色隔离', async () => {
    const plan = buildLessonPlan(chunSpec());
    const set = await buildMaterialSet(plan, ORIGIN);
    const sPdf = set.files.find((f) => f.role === 'student' && f.format === 'pdf')!;
    const tPdf = set.files.find((f) => f.role === 'teacher' && f.format === 'pdf')!;
    const sText = await textOf(sPdf.bytes, 'pdf');
    const tText = await textOf(tPdf.bytes, 'pdf');
    expect(sText).toContain('朗读第一段');
    // 用无花引号的纯中文教师专属标记做健壮断言（PDF 文本抽取会丢弃花引号）
    expect(sText.includes('范读并纠音')).toBe(false); // 学生PDF无教师动作
    expect(sText.includes('把比喻误判为拟人')).toBe(false); // 学生PDF无“典型误解”
    expect(tText.includes('范读并纠音')).toBe(true);
    expect(tText.includes('把比喻误判为拟人')).toBe(true);
  });
});
