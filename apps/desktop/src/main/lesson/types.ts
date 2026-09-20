// G05 完整课时计划（LessonPlan）类型，对齐 contracts/LessonPlan.schema.json 关键字段。
// lesson_outline.v1 仅为模型中间产物，不作为最终备课成果；LessonPlan 才是完整成果。
export const LESSONPLAN_SCHEMA_VERSION = '1.0.0';

export interface SourceAnchor {
  anchor_id: string;
  source_version_id: string;
  locator: Record<string, number | string>;
  quote: string;
  context_before: string;
  context_after: string;
  verification: 'exact_checked' | 'needs_review' | 'conflict';
  source_class: 'public_reference' | 'licensed_reference' | 'teacher_private' | 'student_sensitive';
}
export type CognitiveDemand = 'recall' | 'understand' | 'summarize' | 'explain' | 'compare' | 'evaluate' | 'create' | 'communicate' | 'aesthetic_response';
export interface Objective {
  objective_id: string;
  description: string;
  curriculum_ref_ids: string[];
  cognitive_demand: CognitiveDemand;
  independent_task_ids: string[];
  coverage_state: 'mapped' | 'needs_source_confirmation' | 'enrichment';
}
export interface Task {
  task_id: string;
  objective_ids: string[];
  prompt: string; // 学生任务提示（学生可见）
  material_anchor_ids: string[];
  cognitive_demand: CognitiveDemand;
  support_level: 'full_model' | 'partial_prompt' | 'independent';
  rubric_id: string;
  teacher_notes: string; // 教师备注/追问（仅教师版可见）
  is_formal_exam: boolean;
}
export interface Criterion {
  criterion_id: string;
  description: string;
  acceptable_variants: string[]; // 合理答案范围（教师版）
  insufficient_examples: string[]; // 典型不足/误解（教师版）
  anchor_ids: string[];
}
export interface Rubric {
  rubric_id: string;
  kind: 'project_formative' | 'official_exam' | 'teacher_defined';
  criteria: Criterion[];
  source_anchor_ids: string[];
  allows_alternatives: boolean;
  professional_calibration: 'not_calibrated' | 'teacher_reviewed' | 'multiple_reviewers';
}
export interface Activity {
  activity_id: string;
  title: string;
  objective_ids: string[];
  task_ids: string[];
  start_sec: number;
  end_sec: number;
  duration_kind: 'estimated' | 'observed';
  actor: 'teacher' | 'student' | 'both'; // 时间线上的角色
  requires_teacher_attention: boolean;
  parallel_group_id: string | null;
  branch_group_id: string | null;
  selected: boolean;
  student_action: string; // 学生动作（学生版）
  teacher_action: string; // 教师动作/讲解（教师版）
  priority: 'essential' | 'compressible' | 'optional';
  fallback: string;
}
export interface Homework {
  homework_id: string;
  description: string;
  necessary_reason: string;
  target_group: string;
  estimated_sec: number;
  replaces: string;
  stop_condition: string;
}
export interface LessonPlan {
  schema_version: string;
  plan_id: string;
  revision_id: string;
  previous_revision_id: string | null;
  task_context_id: string;
  title: string;
  declared_duration_sec: number; // ≥300
  source_anchors: SourceAnchor[];
  claims: unknown[];
  objectives: Objective[]; // ≥1
  tasks: Task[]; // ≥1
  rubrics: Rubric[]; // ≥1
  activities: Activity[]; // ≥1
  links: unknown[];
  homework: Homework[];
  teacher_summary: string;
  unknowns: string[];
  software_review_state: 'not_reviewed' | 'model_reviewed' | 'teacher_reviewed';
  teaching_effect_state: 'not_taught' | 'taught_pending' | 'taught_reviewed';
}
