import {
  ObservationPrivacyError,
  type Observation,
  type ObservationMaterialRelation,
  type ObservationOutcome,
  type ObservationOutcomeValue,
  type ObservationSelection,
  type ObservationSourceKind,
  type ObservationSupportLevel
} from './types';
import { extraKeys, isBoundedString, isIsoDateTime, isRecord } from './validation';

const SOURCE_KINDS: readonly ObservationSourceKind[] = ['teacher_observation', 'student_work', 'existing_exam'];
const SUPPORT_LEVELS: readonly ObservationSupportLevel[] = ['full_model', 'partial_prompt', 'independent', 'unknown'];
const MATERIAL_RELATIONS: readonly ObservationMaterialRelation[] = ['same_item', 'similar_new', 'different_context', 'unknown'];
const SELECTIONS: readonly ObservationSelection[] = ['all_available', 'planned_sample', 'typical_cases', 'voluntary', 'unknown'];
const OUTCOMES: readonly ObservationOutcomeValue[] = ['met_expectation', 'needed_prompt', 'clear_difficulty', 'insufficient_evidence'];

const OBSERVATION_KEYS = [
  'observation_id',
  'workspace_id',
  'plan_revision_id',
  'task_id',
  'source_kind',
  'observed_at',
  'support_level',
  'material_relation',
  'delay_days',
  'sample_count',
  'population_count',
  'selection',
  'coverage_caveat',
  'summary',
  'sensitive_payload_ref',
  'cloud_allowed',
  'quality_state'
] as const;
const OUTCOME_KEYS = ['observation_id', 'outcome'] as const;
const INPUT_KEYS = [
  'workspaceId',
  'planRevisionId',
  'teachingEventId',
  'taskId',
  'sourceKind',
  'observedAt',
  'outcome',
  'supportLevel',
  'materialRelation',
  'delayDays',
  'sampleCount',
  'populationCount',
  'selection',
  'coverageCaveat',
  'summary'
] as const;
const FORBIDDEN_INPUT_KEYS = new Set(['name', 'studentname', 'phone', 'contact', 'rawtext', 'filepath', 'originalwork']);
const PERCENTAGE_CLAIM = /(?:\d+(?:\.\d+)?\s*%|百分之\s*[零〇一二两三四五六七八九十百\d]+|\d+(?:\.\d+)?\s*成)/u;
const OBVIOUS_PHONE = /\b1[3-9]\d{9}\b/u;
const OBVIOUS_ID_NUMBER = /\b\d{17}[\dXx]\b/u;

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

export interface CreateObservationInput {
  workspaceId: string;
  planRevisionId: string;
  teachingEventId: string;
  taskId: string | null;
  sourceKind: ObservationSourceKind;
  observedAt: string;
  outcome: ObservationOutcomeValue;
  supportLevel: ObservationSupportLevel;
  materialRelation: ObservationMaterialRelation;
  delayDays: number | null;
  sampleCount: number | null;
  populationCount: number | null;
  selection: ObservationSelection;
  coverageCaveat: string;
  summary: string;
}

export interface ObservationIds {
  observationId(): string;
}

export { ObservationPrivacyError };

export function validateObservation(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, OBSERVATION_KEYS);
  if (!isBoundedString(value.observation_id, 1, 128)) errors.push('observation_id');
  if (!isBoundedString(value.workspace_id, 1, 128)) errors.push('workspace_id');
  if (!isBoundedString(value.plan_revision_id, 1, 128)) errors.push('plan_revision_id');
  if (value.task_id !== null && !isBoundedString(value.task_id, 1, 128)) errors.push('task_id');
  if (typeof value.source_kind !== 'string' || !SOURCE_KINDS.includes(value.source_kind as ObservationSourceKind)) errors.push('source_kind');
  if (!isIsoDateTime(value.observed_at)) errors.push('observed_at');
  if (typeof value.support_level !== 'string' || !SUPPORT_LEVELS.includes(value.support_level as ObservationSupportLevel)) errors.push('support_level');
  if (typeof value.material_relation !== 'string' || !MATERIAL_RELATIONS.includes(value.material_relation as ObservationMaterialRelation)) errors.push('material_relation');
  if (!isNullableSafeInteger(value.delay_days)) errors.push('delay_days');
  if (!isNullableSafeInteger(value.sample_count)) errors.push('sample_count');
  if (!isNullableSafeInteger(value.population_count)) errors.push('population_count');
  if (typeof value.selection !== 'string' || !SELECTIONS.includes(value.selection as ObservationSelection)) errors.push('selection');
  if (!isBoundedString(value.coverage_caveat, 0, 4_000)) errors.push('coverage_caveat');
  if (!isBoundedString(value.summary, 0, 4_000)) errors.push('summary');
  if (value.sensitive_payload_ref !== null) errors.push('sensitive_payload_ref');
  if (value.cloud_allowed !== false) errors.push('cloud_allowed');
  if (!['unreviewed', 'usable_with_limits', 'needs_measurement_review'].includes(String(value.quality_state))) errors.push('quality_state');
  if (
    typeof value.sample_count === 'number' &&
    typeof value.population_count === 'number' &&
    value.sample_count > value.population_count
  ) errors.push('sample_count');
  return errors;
}

export function validateObservationOutcome(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, OUTCOME_KEYS);
  if (!isBoundedString(value.observation_id, 1, 128)) errors.push('observation_id');
  if (typeof value.outcome !== 'string' || !OUTCOMES.includes(value.outcome as ObservationOutcomeValue)) errors.push('outcome');
  return errors;
}

function checkInputPrivacy(value: unknown): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (FORBIDDEN_INPUT_KEYS.has(normalized)) throw new ObservationPrivacyError(`forbidden_field:${key}`);
  }
  if (typeof value.summary === 'string' && (OBVIOUS_PHONE.test(value.summary) || OBVIOUS_ID_NUMBER.test(value.summary))) {
    throw new ObservationPrivacyError('summary_contains_contact_or_id');
  }
}

export function createObservationRecord(
  input: CreateObservationInput,
  ids: ObservationIds
): { observation: Observation; outcome: ObservationOutcome } {
  checkInputPrivacy(input);
  if (!isRecord(input)) throw new Error('invalid_observation_input:object');
  const extras = extraKeys(input, INPUT_KEYS);
  if (extras.length) throw new Error(`invalid_observation_input:${extras.join('|')}`);
  if (!isBoundedString(input.teachingEventId, 1, 128)) throw new Error('invalid_observation:teaching_event_id');
  if (!input.coverageCaveat.trim()) throw new Error('invalid_observation:coverage_caveat');
  if (
    input.selection !== 'all_available' &&
    (PERCENTAGE_CLAIM.test(input.coverageCaveat) || PERCENTAGE_CLAIM.test(input.summary))
  ) {
    throw new Error('observation_percentage_claim_not_allowed');
  }

  const needsMeasurementReview =
    input.outcome === 'insufficient_evidence' ||
    input.supportLevel === 'unknown' ||
    input.materialRelation === 'unknown' ||
    input.delayDays === null ||
    input.sampleCount === null ||
    input.populationCount === null ||
    input.selection === 'unknown';
  const observation: Observation = {
    observation_id: ids.observationId().trim(),
    workspace_id: input.workspaceId.trim(),
    plan_revision_id: input.planRevisionId.trim(),
    task_id: input.taskId === null ? null : input.taskId.trim(),
    source_kind: input.sourceKind,
    observed_at: input.observedAt,
    support_level: input.supportLevel,
    material_relation: input.materialRelation,
    delay_days: input.delayDays,
    sample_count: input.sampleCount,
    population_count: input.populationCount,
    selection: input.selection,
    coverage_caveat: input.coverageCaveat.trim(),
    summary: input.summary.trim(),
    sensitive_payload_ref: null,
    cloud_allowed: false,
    quality_state: needsMeasurementReview ? 'needs_measurement_review' : 'usable_with_limits'
  };
  const outcome: ObservationOutcome = { observation_id: observation.observation_id, outcome: input.outcome };
  const errors = validateObservation(observation);
  if (errors.length) throw new Error(`invalid_observation:${errors.join('|')}`);
  const outcomeErrors = validateObservationOutcome(outcome);
  if (outcomeErrors.length) throw new Error(`invalid_observation_outcome:${outcomeErrors.join('|')}`);
  return { observation, outcome };
}

export function observationCoverageSummary(
  observation: Pick<Observation, 'sample_count' | 'population_count' | 'selection' | 'coverage_caveat'>
): string {
  const count = observation.sample_count === null ? '未知' : String(observation.sample_count);
  const population = observation.population_count === null ? '未知' : String(observation.population_count);
  const labels: Record<ObservationSelection, string> = {
    all_available: '全部可用记录',
    planned_sample: '预先计划样本',
    typical_cases: '典型样本',
    voluntary: '自愿样本',
    unknown: '选择方式未知'
  };
  const ratio =
    observation.selection === 'all_available' &&
    observation.sample_count !== null &&
    observation.population_count !== null &&
    observation.population_count > 0 &&
    observation.sample_count === observation.population_count
      ? `（${Math.round((observation.sample_count / observation.population_count) * 100)}%）`
      : '';
  return `${labels[observation.selection]} ${count}/${population}${ratio}；${observation.coverage_caveat}`;
}
