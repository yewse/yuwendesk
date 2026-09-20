import { createHash } from 'node:crypto';
import type { Activity, LessonPlan } from '../lesson/types';
import type { ReturnModule } from '../review/types';
import type {
  ChangeDiffEntry,
  ChangeIds,
  ChangePreview,
  ChangeProposal,
  LessonChange,
  PresentationSpec
} from './types';

const DEFAULT_PRESENTATION_SPEC: PresentationSpec = {
  fontScale: 1,
  paperSize: 'A4',
  theme: 'light'
};
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
const PROPOSAL_STATUSES: ChangeProposal['status'][] = [
  'proposed',
  'accepted',
  'rejected',
  'reverted',
  'supported_with_limits'
];
const CHANGE_FIELDS: Record<LessonChange['kind'], readonly string[]> = {
  change_duration: ['kind', 'durationSec'],
  increase_independent_time: ['kind', 'activityId', 'addedSec'],
  remove_link: ['kind', 'linkId'],
  edit_task: ['kind', 'taskId', 'prompt', 'acceptableVariants'],
  edit_rubric: ['kind', 'rubricId', 'acceptableVariants'],
  presentation_only: ['kind', 'fontScale', 'paperSize', 'theme']
};
const PROPOSAL_FIELDS = [
  'change_id',
  'plan_revision_id',
  'observation_ids',
  'hypothesis',
  'replacement_action',
  'removed_or_reduced',
  'predicted_evidence',
  'disconfirming_evidence',
  'next_normal_task',
  'return_modules',
  'status'
] as const;

export class ChangeValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`INVALID_LESSON_CHANGE:${errors.join('|')}`);
    this.name = 'ChangeValidationError';
  }
}

export class ChangeBlockedError extends Error {
  constructor(public readonly reason: 'CORE_ACTIONS_DO_NOT_FIT' | 'TARGET_NOT_FOUND' | 'NO_REDUCIBLE_TIME') {
    super(reason);
    this.name = 'ChangeBlockedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): string[] {
  const set = new Set(allowed);
  return Object.keys(value).filter((key) => !set.has(key)).map((key) => `${path}:extra_key:${key}`);
}

function requiredString(value: unknown, name: string, errors: string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4000) errors.push(`change:${name}`);
}

function answerVariants(value: unknown, errors: string[]): void {
  if (
    !stringArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    value.some((item) => item.trim().length === 0 || item.length > 4000)
  ) {
    errors.push('change:acceptableVariants');
  }
}

export function validateLessonChange(value: unknown): string[] {
  if (!isRecord(value)) return ['change:type'];
  if (typeof value.kind !== 'string' || !(value.kind in CHANGE_FIELDS)) return ['change:kind'];

  const kind = value.kind as LessonChange['kind'];
  const errors = exactKeys(value, CHANGE_FIELDS[kind], 'change');
  if (kind === 'change_duration') {
    if (!Number.isSafeInteger(value.durationSec) || (value.durationSec as number) < 300 || (value.durationSec as number) > 14_400) {
      errors.push('change:durationSec');
    }
  } else if (kind === 'increase_independent_time') {
    requiredString(value.activityId, 'activityId', errors);
    if (!Number.isSafeInteger(value.addedSec) || (value.addedSec as number) < 60 || (value.addedSec as number) > 1800) {
      errors.push('change:addedSec');
    }
  } else if (kind === 'remove_link') {
    requiredString(value.linkId, 'linkId', errors);
  } else if (kind === 'edit_task') {
    requiredString(value.taskId, 'taskId', errors);
    requiredString(value.prompt, 'prompt', errors);
    answerVariants(value.acceptableVariants, errors);
  } else if (kind === 'edit_rubric') {
    requiredString(value.rubricId, 'rubricId', errors);
    answerVariants(value.acceptableVariants, errors);
  } else {
    if (typeof value.fontScale !== 'number' || !Number.isFinite(value.fontScale) || value.fontScale < 0.8 || value.fontScale > 1.5) {
      errors.push('change:fontScale');
    }
    if (value.paperSize !== 'A4' && value.paperSize !== 'Letter') errors.push('change:paperSize');
    if (value.theme !== 'light' && value.theme !== 'high_contrast') errors.push('change:theme');
  }
  return errors;
}

function duration(activity: Activity): number {
  return Math.max(0, activity.end_sec - activity.start_sec);
}

function repack(activities: Activity[], durations?: Map<string, number>): Activity[] {
  let cursor = 0;
  return activities.map((activity) => {
    const seconds = durations?.get(activity.activity_id) ?? duration(activity);
    const packed = { ...activity, start_sec: cursor, end_sec: cursor + seconds };
    cursor = packed.end_sec;
    return packed;
  });
}

function fitSchedule(activities: Activity[], targetDuration: number): Activity[] {
  const essential = activities.filter((activity) => activity.priority === 'essential');
  const compressible = activities.filter((activity) => activity.priority === 'compressible');
  const optional = activities.filter((activity) => activity.priority === 'optional');
  const essentialDuration = essential.reduce((sum, activity) => sum + duration(activity), 0);
  const minimum = essentialDuration + compressible.length * 60;
  if (minimum > targetDuration) throw new ChangeBlockedError('CORE_ACTIONS_DO_NOT_FIT');

  const allocated = new Map<string, number>();
  essential.forEach((activity) => allocated.set(activity.activity_id, duration(activity)));
  compressible.forEach((activity) => allocated.set(activity.activity_id, 60));
  let remaining = targetDuration - minimum;

  for (const activity of compressible) {
    const extra = Math.min(Math.max(0, duration(activity) - 60), remaining);
    allocated.set(activity.activity_id, 60 + extra);
    remaining -= extra;
  }
  for (const activity of optional) {
    const seconds = duration(activity);
    if (seconds <= remaining) {
      allocated.set(activity.activity_id, seconds);
      remaining -= seconds;
    }
  }

  return repack(
    activities.filter((activity) => allocated.has(activity.activity_id)),
    allocated
  );
}

function addIndependentTime(activities: Activity[], activityId: string, addedSec: number): Activity[] {
  const target = activities.find((activity) => activity.activity_id === activityId && activity.actor === 'student');
  if (!target) throw new ChangeBlockedError('TARGET_NOT_FOUND');

  const allocated = new Map(activities.map((activity) => [activity.activity_id, duration(activity)]));
  let remaining = addedSec;
  const donors = [
    ...activities.filter((activity) => activity.priority === 'optional' && activity.activity_id !== activityId).reverse(),
    ...activities.filter((activity) => activity.priority === 'compressible' && activity.activity_id !== activityId).reverse()
  ];
  for (const donor of donors) {
    const current = allocated.get(donor.activity_id) ?? 0;
    const minimum = donor.priority === 'compressible' ? 60 : 0;
    const taken = Math.min(Math.max(0, current - minimum), remaining);
    allocated.set(donor.activity_id, current - taken);
    remaining -= taken;
    if (remaining === 0) break;
  }
  if (remaining > 0) throw new ChangeBlockedError('NO_REDUCIBLE_TIME');
  allocated.set(activityId, (allocated.get(activityId) ?? 0) + addedSec);
  return repack(
    activities.filter((activity) => (allocated.get(activity.activity_id) ?? 0) > 0),
    allocated
  );
}

function invalidatedModules(change: LessonChange): ReturnModule[] {
  switch (change.kind) {
    case 'remove_link':
      return ['M05', 'M06', 'M07', 'M08', 'M09', 'M10'];
    case 'edit_task':
      return ['M07', 'M08', 'M09', 'M10'];
    case 'edit_rubric':
      return ['M07', 'M09', 'M10'];
    case 'presentation_only':
      return ['M09', 'M10'];
    default:
      return ['M08', 'M09', 'M10'];
  }
}

function presentationSpec(change: LessonChange): PresentationSpec {
  return change.kind === 'presentation_only'
    ? { fontScale: change.fontScale, paperSize: change.paperSize, theme: change.theme }
    : { ...DEFAULT_PRESENTATION_SPEC };
}

function specHash(spec: PresentationSpec): string {
  return createHash('sha256')
    .update(JSON.stringify({ fontScale: spec.fontScale, paperSize: spec.paperSize, theme: spec.theme }))
    .digest('hex');
}

function proposalFor(base: LessonPlan, change: LessonChange, changeId: string, modules: ReturnModule[]): ChangeProposal {
  const action = {
    change_duration: '重排课堂活动以适配新课时',
    increase_independent_time: '增加指定学生独立活动时间',
    remove_link: '移除指定联读及其专属任务与活动',
    edit_task: '更新指定任务及其合理答案范围',
    edit_rubric: '更新指定评价量规的合理答案范围',
    presentation_only: '仅调整成品呈现规格'
  }[change.kind];
  return {
    change_id: changeId,
    plan_revision_id: base.revision_id,
    observation_ids: [],
    hypothesis: `教师主动修改：${action}。`,
    replacement_action: action,
    removed_or_reduced:
      change.kind === 'change_duration' || change.kind === 'increase_independent_time' || change.kind === 'remove_link'
        ? '仅缩减或移除受影响的课堂活动，不新增课后作业。'
        : '未改变无关教学语义。',
    predicted_evidence: '新版本的结构、时间与五份成品应保持一致。',
    disconfirming_evidence: '若教师审查发现核心动作缺失或成品不一致，则拒绝接纳。',
    next_normal_task: '由教师审查差异后决定是否接纳。',
    return_modules: modules,
    status: 'proposed'
  };
}

function applySemanticChange(candidate: LessonPlan, change: Exclude<LessonChange, { kind: 'presentation_only' }>): ChangeDiffEntry[] {
  if (change.kind === 'change_duration') {
    const before = candidate.declared_duration_sec;
    candidate.activities = fitSchedule(candidate.activities, change.durationSec);
    candidate.declared_duration_sec = change.durationSec;
    return [{ path: 'declared_duration_sec', before, after: change.durationSec, label: '课时时长' }];
  }
  if (change.kind === 'increase_independent_time') {
    const before = candidate.activities.find((activity) => activity.activity_id === change.activityId);
    candidate.activities = addIndependentTime(candidate.activities, change.activityId, change.addedSec);
    const after = candidate.activities.find((activity) => activity.activity_id === change.activityId);
    return [{ path: `activities.${change.activityId}`, before, after, label: '学生独立时间' }];
  }
  if (change.kind === 'remove_link') {
    const link = candidate.links.find((item) => item.link_id === change.linkId);
    if (!link) throw new ChangeBlockedError('TARGET_NOT_FOUND');
    const removedTaskId = link.return_to_text_task_id;
    const removedTask = candidate.tasks.find((task) => task.task_id === removedTaskId);
    candidate.links = candidate.links.filter((item) => item.link_id !== change.linkId);
    candidate.tasks = candidate.tasks.filter((task) => task.task_id !== removedTaskId);
    if (removedTask && !candidate.tasks.some((task) => task.rubric_id === removedTask.rubric_id)) {
      candidate.rubrics = candidate.rubrics.filter((rubric) => rubric.rubric_id !== removedTask.rubric_id);
    }
    const removedActivities = new Set(link.replaces_activity_ids);
    candidate.activities = repack(
      candidate.activities
        .filter((activity) => !removedActivities.has(activity.activity_id))
        .map((activity) => ({
          ...activity,
          task_ids: activity.task_ids.filter((taskId) => taskId !== removedTaskId)
        }))
    );
    candidate.objectives = candidate.objectives.map((objective) => ({
      ...objective,
      independent_task_ids: objective.independent_task_ids.filter((taskId) => taskId !== removedTaskId)
    }));
    return [{ path: `links.${change.linkId}`, before: link, after: null, label: '联读卡片' }];
  }
  if (change.kind === 'edit_task') {
    const task = candidate.tasks.find((item) => item.task_id === change.taskId);
    if (!task) throw new ChangeBlockedError('TARGET_NOT_FOUND');
    const before = { prompt: task.prompt, acceptableVariants: [] as string[] };
    task.prompt = change.prompt;
    const rubric = candidate.rubrics.find((item) => item.rubric_id === task.rubric_id);
    if (!rubric) throw new ChangeBlockedError('TARGET_NOT_FOUND');
    before.acceptableVariants = [...rubric.criteria[0].acceptable_variants];
    rubric.criteria[0].acceptable_variants = [...change.acceptableVariants];
    rubric.allows_alternatives = change.acceptableVariants.length > 1;
    return [
      {
        path: `tasks.${change.taskId}`,
        before,
        after: { prompt: task.prompt, acceptableVariants: [...change.acceptableVariants] },
        label: '任务与合理答案'
      }
    ];
  }
  const rubric = candidate.rubrics.find((item) => item.rubric_id === change.rubricId);
  if (!rubric) throw new ChangeBlockedError('TARGET_NOT_FOUND');
  const before = rubric.criteria.map((criterion) => [...criterion.acceptable_variants]);
  rubric.criteria.forEach((criterion) => {
    criterion.acceptable_variants = [...change.acceptableVariants];
  });
  rubric.allows_alternatives = change.acceptableVariants.length > 1;
  return [
    {
      path: `rubrics.${change.rubricId}.acceptable_variants`,
      before,
      after: [...change.acceptableVariants],
      label: '合理答案范围'
    }
  ];
}

export function previewLessonChange(base: LessonPlan, change: LessonChange, ids: ChangeIds): ChangePreview {
  const errors = validateLessonChange(change);
  if (errors.length) throw new ChangeValidationError(errors);
  const candidate = structuredClone(base);
  const semanticRevisionChanged = change.kind !== 'presentation_only';
  let diff: ChangeDiffEntry[];

  if (semanticRevisionChanged) {
    diff = applySemanticChange(candidate, change);
    candidate.revision_id = ids.revisionId;
    candidate.previous_revision_id = base.revision_id;
    candidate.software_review_state = 'not_reviewed';
  } else {
    diff = [
      {
        path: 'presentation_spec',
        before: DEFAULT_PRESENTATION_SPEC,
        after: presentationSpec(change),
        label: '成品呈现规格'
      }
    ];
  }

  const modules = invalidatedModules(change);
  const spec = presentationSpec(change);
  return {
    proposal: proposalFor(base, change, ids.changeId, modules),
    candidatePlan: candidate,
    semanticRevisionChanged,
    invalidatedModules: modules,
    presentationSpec: spec,
    presentationSpecHash: specHash(spec),
    diff
  };
}

export function validateChangeProposal(value: unknown): string[] {
  if (!isRecord(value)) return ['proposal:type'];
  const errors = exactKeys(value, PROPOSAL_FIELDS, 'proposal');
  const ids = ['change_id', 'plan_revision_id'];
  for (const field of ids) {
    const item = value[field];
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 128) errors.push(`proposal:${field}`);
  }
  const strings = [
    'hypothesis',
    'replacement_action',
    'removed_or_reduced',
    'predicted_evidence',
    'disconfirming_evidence',
    'next_normal_task'
  ];
  for (const field of strings) {
    const item = value[field];
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 4000) errors.push(`proposal:${field}`);
  }
  if (
    !stringArray(value.observation_ids) ||
    value.observation_ids.some((item) => item.length < 1 || item.length > 128)
  ) {
    errors.push('proposal:observation_ids');
  }
  if (
    !Array.isArray(value.return_modules) ||
    !value.return_modules.every((item) => RETURN_MODULES.includes(item as ReturnModule))
  ) {
    errors.push('proposal:return_modules');
  }
  if (!PROPOSAL_STATUSES.includes(value.status as ChangeProposal['status'])) errors.push('proposal:status');
  return errors;
}
