import type { LessonAnchorInput, LessonPlanSpec } from '../lesson/build';
import type { Activity, CognitiveDemand, Task } from '../lesson/types';

export const MODEL_LESSON_PLAN_TASK = 'lesson_plan_spec' as const;
export const MODEL_LESSON_PLAN_CONTRACT = 'lesson_plan_spec.v1' as const;

export interface AllowedModelAnchor {
  id: string;
  anchor: LessonAnchorInput;
}

export interface ModelLessonPlanParseContext {
  taskContextId: string;
  declaredDurationSec: number;
}

const TOP_KEYS = ['title', 'objectives', 'tasks', 'activities', 'teacher_summary', 'unknowns'] as const;
const OBJECTIVE_KEYS = ['description', 'cognitive_demand'] as const;
const TASK_KEYS = [
  'prompt', 'cognitive_demand', 'support_level', 'teacher_notes', 'acceptable_variants',
  'insufficient_examples', 'anchor_ids'
] as const;
const ACTIVITY_KEYS = [
  'title', 'start_sec', 'end_sec', 'actor', 'student_action', 'teacher_action', 'priority', 'task_indexes'
] as const;
const COGNITIVE_DEMANDS: CognitiveDemand[] = [
  'recall', 'understand', 'summarize', 'explain', 'compare', 'evaluate', 'create', 'communicate', 'aesthetic_response'
];
const SUPPORT_LEVELS: Task['support_level'][] = ['full_model', 'partial_prompt', 'independent'];
const ACTORS: Activity['actor'][] = ['teacher', 'student', 'both'];
const PRIORITIES: Activity['priority'][] = ['essential', 'compressible', 'optional'];
const UNSAFE_TEXT = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:home|Users|etc)\/|<script|javascript:|powershell(?:\.exe)?|cmd\.exe|child_process|shell\.exec)/iu;

function invalid(reason: string): never {
  throw new Error(`PREPARATION_MODEL_INVALID:${reason}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path}:object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path}:prototype`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${path}:extra_key`);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalid(`${path}:missing_key`);
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || UNSAFE_TEXT.test(value)) {
    invalid(`${path}:text`);
  }
  return value;
}

function stringArray(value: unknown, path: string, maxItems: number, requireNonEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > maxItems || (requireNonEmpty && value.length === 0)) invalid(`${path}:array`);
  return value.map((item, index) => text(item, `${path}:${index}`, 2_000));
}

function indexArray(value: unknown, path: string, maxExclusive: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) invalid(`${path}:array`);
  const indexes = value.map((item) => {
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) >= maxExclusive) invalid(`${path}:index`);
    return item as number;
  });
  if (new Set(indexes).size !== indexes.length) invalid(`${path}:duplicate`);
  return indexes;
}

export function parseModelLessonPlanSpec(
  value: unknown,
  allowedAnchors: AllowedModelAnchor[],
  context: ModelLessonPlanParseContext
): LessonPlanSpec {
  if (!Number.isSafeInteger(context.declaredDurationSec) || context.declaredDurationSec < 300 || context.declaredDurationSec > 14_400) {
    invalid('declared_duration');
  }
  if (!context.taskContextId || context.taskContextId.length > 80 || allowedAnchors.length === 0 || allowedAnchors.length > 50) {
    invalid('context');
  }
  const anchorMap = new Map<string, number>();
  allowedAnchors.forEach((item, index) => {
    if (!item.id || item.id.length > 80 || anchorMap.has(item.id)) invalid('allowed_anchor');
    anchorMap.set(item.id, index + 1);
  });

  const root = record(value, 'root');
  exactKeys(root, TOP_KEYS, 'root');
  const title = text(root.title, 'title', 160);

  if (!Array.isArray(root.objectives) || root.objectives.length === 0 || root.objectives.length > 20) invalid('objectives');
  const objectives = root.objectives.map((item, index) => {
    const objective = record(item, `objectives:${index}`);
    exactKeys(objective, OBJECTIVE_KEYS, `objectives:${index}`);
    if (!COGNITIVE_DEMANDS.includes(objective.cognitive_demand as CognitiveDemand)) invalid(`objectives:${index}:demand`);
    return {
      description: text(objective.description, `objectives:${index}:description`, 500),
      cognitive_demand: objective.cognitive_demand as CognitiveDemand
    };
  });

  if (!Array.isArray(root.tasks) || root.tasks.length === 0 || root.tasks.length > 30) invalid('tasks');
  const tasks = root.tasks.map((item, index) => {
    const task = record(item, `tasks:${index}`);
    exactKeys(task, TASK_KEYS, `tasks:${index}`);
    if (!COGNITIVE_DEMANDS.includes(task.cognitive_demand as CognitiveDemand)) invalid(`tasks:${index}:demand`);
    if (!SUPPORT_LEVELS.includes(task.support_level as Task['support_level'])) invalid(`tasks:${index}:support`);
    const anchorIds = stringArray(task.anchor_ids, `tasks:${index}:anchor_ids`, 50, true);
    const anchorIndexes = anchorIds.map((id) => anchorMap.get(id) ?? invalid(`tasks:${index}:anchor_unknown`));
    if (new Set(anchorIndexes).size !== anchorIndexes.length) invalid(`tasks:${index}:anchor_duplicate`);
    return {
      prompt: text(task.prompt, `tasks:${index}:prompt`, 4_000),
      cognitive_demand: task.cognitive_demand as CognitiveDemand,
      support_level: task.support_level as Task['support_level'],
      teacher_notes: text(task.teacher_notes, `tasks:${index}:teacher_notes`, 4_000),
      acceptable_variants: stringArray(task.acceptable_variants, `tasks:${index}:acceptable_variants`, 20, true),
      insufficient_examples: stringArray(task.insufficient_examples, `tasks:${index}:insufficient_examples`, 20),
      anchorIndexes
    };
  });

  if (!Array.isArray(root.activities) || root.activities.length === 0 || root.activities.length > 40) invalid('activities');
  const activities = root.activities.map((item, index) => {
    const activity = record(item, `activities:${index}`);
    exactKeys(activity, ACTIVITY_KEYS, `activities:${index}`);
    if (!Number.isSafeInteger(activity.start_sec) || !Number.isSafeInteger(activity.end_sec) ||
        (activity.start_sec as number) < 0 || (activity.end_sec as number) <= (activity.start_sec as number) ||
        (activity.end_sec as number) > context.declaredDurationSec) invalid(`activities:${index}:time`);
    if (!ACTORS.includes(activity.actor as Activity['actor'])) invalid(`activities:${index}:actor`);
    if (!PRIORITIES.includes(activity.priority as Activity['priority'])) invalid(`activities:${index}:priority`);
    return {
      title: text(activity.title, `activities:${index}:title`, 200),
      start_sec: activity.start_sec as number,
      end_sec: activity.end_sec as number,
      actor: activity.actor as Activity['actor'],
      student_action: text(activity.student_action, `activities:${index}:student_action`, 2_000),
      teacher_action: text(activity.teacher_action, `activities:${index}:teacher_action`, 2_000),
      priority: activity.priority as Activity['priority'],
      taskIndexes: indexArray(activity.task_indexes, `activities:${index}:task_indexes`, tasks.length).map((taskIndex) => taskIndex + 1)
    };
  });

  return {
    title,
    declared_duration_sec: context.declaredDurationSec,
    task_context_id: context.taskContextId,
    objectives,
    anchors: allowedAnchors.map((item) => ({ ...item.anchor, locator: { ...item.anchor.locator } })),
    tasks,
    activities,
    teacher_summary: text(root.teacher_summary, 'teacher_summary', 4_000),
    unknowns: stringArray(root.unknowns, 'unknowns', 30)
  };
}
