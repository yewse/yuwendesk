import { validateLessonPlan } from '../lesson/build';
import type { LessonPlan } from '../lesson/types';
import type {
  ReturnModule,
  ReviewIds,
  ReviewIssue,
  ReviewOptions,
  ReviewReport,
  ReviewSeverity
} from './types';

const REVIEW_SEVERITIES: ReviewSeverity[] = ['blocking', 'fix', 'teacher_review', 'info'];
const RETURN_MODULES: ReturnModule[] = [
  'M01',
  'M02',
  'M03',
  'M04',
  'M05',
  'M06',
  'M07',
  'M08',
  'M09',
  'M10',
  'M11',
  'M12'
];
const VERIFICATION_TYPES: ReviewIssue['verification_type'][] = [
  'deterministic',
  'model_assisted',
  'human_observation'
];
const ISSUE_STATUSES: ReviewIssue['status'][] = ['open', 'fixed', 'accepted_with_limit'];
const DISPOSITIONS: ReviewReport['disposition'][] = ['ready_for_teacher', 'needs_fix', 'blocked'];

interface ValidationRoute {
  severity: ReviewSeverity;
  module: ReturnModule;
}

const validationRoutes: Record<string, ValidationRoute> = {
  schema_version: { severity: 'blocking', module: 'M11' },
  title_empty: { severity: 'fix', module: 'M01' },
  duration_lt_300: { severity: 'fix', module: 'M01' },
  objectives_min: { severity: 'fix', module: 'M05' },
  tasks_min: { severity: 'fix', module: 'M07' },
  rubrics_min: { severity: 'fix', module: 'M07' },
  activities_min: { severity: 'fix', module: 'M08' },
  task_prompt_empty: { severity: 'fix', module: 'M07' },
  task_anchor_missing: { severity: 'blocking', module: 'M03' },
  rubric_anchor_missing: { severity: 'blocking', module: 'M03' },
  task_rubric_missing: { severity: 'fix', module: 'M07' },
  rubric_no_variants: { severity: 'teacher_review', module: 'M07' },
  objective_mapped_without_curriculum: { severity: 'fix', module: 'M05' },
  activity_actor: { severity: 'fix', module: 'M08' },
  activity_time: { severity: 'fix', module: 'M08' },
  activity_overtime: { severity: 'fix', module: 'M08' },
  activity_task_missing: { severity: 'fix', module: 'M08' },
  schedule_underfilled: { severity: 'teacher_review', module: 'M08' }
};

const ruleMessages: Record<string, string> = {
  schema_version: '课时计划版本不受支持。',
  title_empty: '课时计划标题不能为空。',
  duration_lt_300: '声明课时不足五分钟。',
  objectives_min: '课时计划至少需要一个教学目标。',
  tasks_min: '课时计划至少需要一个学生任务。',
  rubrics_min: '课时计划至少需要一个评价量规。',
  activities_min: '课时计划至少需要一个课堂活动。',
  task_prompt_empty: '学生任务提示不能为空。',
  task_anchor_missing: '学生任务引用了不存在的来源锚点。',
  rubric_anchor_missing: '评价量规引用了不存在的来源锚点。',
  task_rubric_missing: '学生任务引用了不存在的评价量规。',
  rubric_no_variants: '教师自定义量规未给出可接受答案范围，需教师判断。',
  objective_mapped_without_curriculum: '教学目标缺少课程依据却被标记为已映射。',
  activity_actor: '课堂活动角色无效。',
  activity_time: '课堂活动时间范围无效。',
  activity_overtime: '课堂活动排程超出声明课时。',
  activity_task_missing: '课堂活动引用了不存在的学生任务。',
  schedule_underfilled: '课堂排程与声明课时存在较大空档，需教师确认。',
  source_anchor_conflict: '来源锚点存在冲突，必须返回来源核验。',
  source_anchor_needs_review: '来源锚点尚未完成教师核验。'
};

const REPORT_KEYS = [
  'report_id',
  'plan_revision_id',
  'issues',
  'disposition',
  'executed_checks',
  'not_executed_checks',
  'is_effectiveness_proof'
] as const;
const ISSUE_KEYS = [
  'issue_id',
  'severity',
  'rule_id',
  'object_ids',
  'message',
  'evidence',
  'return_module',
  'verification_type',
  'status'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function validationParts(raw: string): { ruleId: string; objectIds: string[] } {
  const [ruleId, ...details] = raw.split(':');
  const objectIds = details.filter((detail) => detail && !/^\d+s?$/.test(detail));
  return { ruleId, objectIds };
}

function issue(
  ruleId: string,
  severity: ReviewSeverity,
  returnModule: ReturnModule,
  objectIds: string[],
  ids: ReviewIds
): ReviewIssue {
  return {
    issue_id: ids.issueId(ruleId, objectIds),
    severity,
    rule_id: ruleId,
    object_ids: objectIds,
    message: ruleMessages[ruleId] ?? `课时计划未通过规则 ${ruleId}。`,
    evidence: `deterministic:${ruleId}:${objectIds.join(',')}`,
    return_module: returnModule,
    verification_type: 'deterministic',
    status: 'open'
  };
}

function lessonValidationIssues(plan: LessonPlan, ids: ReviewIds): ReviewIssue[] {
  const validation = validateLessonPlan(plan);
  const findings = validation.ok ? [] : validation.errors;
  const warnings = validation.warnings;

  return [...findings, ...warnings].map((finding) => {
    const { ruleId, objectIds } = validationParts(finding);
    const route = validationRoutes[ruleId] ?? { severity: 'fix' as const, module: 'M11' as const };
    return issue(ruleId, route.severity, route.module, objectIds, ids);
  });
}

function validateIssue(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}:type`];

  const errors = unknownKeys(value, ISSUE_KEYS).map((key) => `${path}:extra_key:${key}`);
  if (typeof value.issue_id !== 'string' || value.issue_id.length === 0) errors.push(`${path}:issue_id`);
  if (!REVIEW_SEVERITIES.includes(value.severity as ReviewSeverity)) errors.push(`${path}:severity`);
  if (typeof value.rule_id !== 'string' || value.rule_id.length === 0) errors.push(`${path}:rule_id`);
  if (!stringArray(value.object_ids)) errors.push(`${path}:object_ids`);
  if (typeof value.message !== 'string' || value.message.length === 0) errors.push(`${path}:message`);
  if (typeof value.evidence !== 'string' || value.evidence.length === 0) errors.push(`${path}:evidence`);
  if (!RETURN_MODULES.includes(value.return_module as ReturnModule)) errors.push(`${path}:return_module`);
  if (!VERIFICATION_TYPES.includes(value.verification_type as ReviewIssue['verification_type'])) {
    errors.push(`${path}:verification_type`);
  }
  if (!ISSUE_STATUSES.includes(value.status as ReviewIssue['status'])) errors.push(`${path}:status`);
  return errors;
}

function assertModelAssisted(modelIssue: ReviewIssue): ReviewIssue {
  const errors = validateIssue(modelIssue, 'model_issue');
  if (modelIssue.verification_type !== 'model_assisted') errors.push('model_issue:verification_type:model_assisted_required');
  if (errors.length) throw new Error(`invalid_model_review_issue:${errors.join('|')}`);
  return { ...modelIssue, object_ids: [...modelIssue.object_ids] };
}

export function reviewLessonPlan(plan: LessonPlan, options: ReviewOptions): ReviewReport {
  const issues = lessonValidationIssues(plan, options.ids);

  for (const anchor of plan.source_anchors) {
    if (anchor.verification === 'conflict') {
      issues.push(issue('source_anchor_conflict', 'blocking', 'M03', [anchor.anchor_id], options.ids));
    } else if (anchor.verification === 'needs_review') {
      issues.push(issue('source_anchor_needs_review', 'teacher_review', 'M03', [anchor.anchor_id], options.ids));
    }
  }

  if (options.modelIssues) issues.push(...options.modelIssues.map(assertModelAssisted));

  const modelReviewExecuted = options.modelIssues !== undefined;
  return {
    report_id: options.ids.reportId(),
    plan_revision_id: plan.revision_id,
    issues,
    disposition: issues.some((item) => item.severity === 'blocking')
      ? 'blocked'
      : issues.some((item) => item.severity === 'fix')
        ? 'needs_fix'
        : 'ready_for_teacher',
    executed_checks: [
      'lesson_schema',
      'reference_integrity',
      'schedule_bounds',
      'source_verification',
      ...(modelReviewExecuted ? ['model_semantic_review'] : [])
    ],
    not_executed_checks: [
      ...(!modelReviewExecuted ? ['model_semantic_review'] : []),
      'teacher_professional_review',
      'office_wps_fidelity'
    ],
    is_effectiveness_proof: false
  };
}

export function validateReviewReport(value: unknown): string[] {
  if (!isRecord(value)) return ['report:type'];

  const errors = unknownKeys(value, REPORT_KEYS).map((key) => `report:extra_key:${key}`);
  if (typeof value.report_id !== 'string' || value.report_id.length === 0) errors.push('report:report_id');
  if (typeof value.plan_revision_id !== 'string' || value.plan_revision_id.length === 0) {
    errors.push('report:plan_revision_id');
  }
  if (!Array.isArray(value.issues)) {
    errors.push('report:issues');
  } else {
    value.issues.forEach((item, index) => errors.push(...validateIssue(item, `report:issues:${index}`)));
  }
  if (!DISPOSITIONS.includes(value.disposition as ReviewReport['disposition'])) errors.push('report:disposition');
  if (!stringArray(value.executed_checks)) errors.push('report:executed_checks');
  if (!stringArray(value.not_executed_checks)) errors.push('report:not_executed_checks');
  if (value.is_effectiveness_proof !== false) errors.push('report:is_effectiveness_proof');
  return errors;
}
