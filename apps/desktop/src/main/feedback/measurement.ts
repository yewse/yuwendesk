import type { LessonPlan } from '../lesson/types';
import type {
  MeasurementCheck,
  MeasurementInferenceLimit,
  MeasurementReview,
  ObservationRecord,
  TeachingEvent
} from './types';
import { extraKeys, isBoundedString, isIsoDateTime, isRecord } from './validation';

export type RubricMode = 'versioned' | 'non_scored' | 'missing';

export interface MeasurementInput {
  plan: LessonPlan;
  teachingEvent: TeachingEvent;
  observations: ObservationRecord[];
  rubricMode: RubricMode;
}

export interface MeasurementIds {
  reviewId(): string;
  now(): string;
}

const REVIEW_KEYS = [
  'review_id', 'workspace_id', 'plan_id', 'plan_revision_id', 'teaching_event_id',
  'checks', 'disposition', 'inference_limits', 'is_effectiveness_proof', 'created_at'
] as const;
const CHECK_KEYS = ['check_id', 'status', 'evidence', 'object_ids', 'return_module'] as const;
const CHECK_IDS = ['target_alignment', 'scoring_available', 'task_comparability', 'sample_coverage', 'implementation_conditions'] as const;
const INFERENCE_LIMITS = ['class_inference_not_allowed', 'transfer_not_measured', 'delayed_retention_not_measured', 'independent_performance_not_measured'] as const;

export function validateMeasurementReview(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, REVIEW_KEYS);
  for (const key of ['review_id', 'workspace_id', 'plan_id', 'plan_revision_id', 'teaching_event_id'] as const) {
    if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  }
  if (!Array.isArray(value.checks) || value.checks.length !== CHECK_IDS.length) errors.push('checks');
  else {
    value.checks.forEach((item, index) => {
      if (!isRecord(item)) { errors.push('check_object'); return; }
      errors.push(...extraKeys(item, CHECK_KEYS));
      if (item.check_id !== CHECK_IDS[index]) errors.push('check_id');
      if (!['pass', 'fail', 'unknown'].includes(String(item.status))) errors.push('check_status');
      if (!isBoundedString(item.evidence, 1, 1000)) errors.push('check_evidence');
      if (!Array.isArray(item.object_ids) || item.object_ids.some((id) => !isBoundedString(id, 1, 128))) errors.push('check_object_ids');
      if (!['M07', 'M08', 'M11'].includes(String(item.return_module))) errors.push('check_return_module');
    });
  }
  if (!['ready_for_attribution', 'needs_measurement_review'].includes(String(value.disposition))) errors.push('disposition');
  if (!Array.isArray(value.inference_limits) || value.inference_limits.some((item) => !INFERENCE_LIMITS.includes(item as (typeof INFERENCE_LIMITS)[number]))) errors.push('inference_limits');
  if (value.is_effectiveness_proof !== false) errors.push('is_effectiveness_proof');
  if (!isIsoDateTime(value.created_at)) errors.push('created_at');
  return [...new Set(errors)];
}

function check(
  check_id: MeasurementCheck['check_id'],
  status: MeasurementCheck['status'],
  evidence: string,
  object_ids: string[],
  return_module: MeasurementCheck['return_module']
): MeasurementCheck {
  return { check_id, status, evidence, object_ids: [...new Set(object_ids)], return_module };
}

export function reviewMeasurement(input: MeasurementInput, ids: MeasurementIds): MeasurementReview {
  const taskIds = new Set(input.plan.tasks.map((task) => task.task_id));
  const rubricIds = new Set(input.plan.rubrics.map((rubric) => rubric.rubric_id));
  const observations = input.observations.map((record) => record.observation);

  const aligned = observations.length > 0 && observations.every((observation) => observation.task_id !== null && taskIds.has(observation.task_id));
  const targetStatus: MeasurementCheck['status'] = observations.length === 0 ? 'unknown' : aligned ? 'pass' : 'fail';
  const targetObjectIds = observations.flatMap((observation) => [observation.observation_id, ...(observation.task_id ? [observation.task_id] : [])]);

  const observedTaskIds = observations.flatMap((observation) => (observation.task_id ? [observation.task_id] : []));
  const linkedRubrics = input.plan.tasks
    .filter((task) => observedTaskIds.includes(task.task_id))
    .map((task) => task.rubric_id);
  const scoringAvailable =
    input.rubricMode === 'non_scored' ||
    (input.rubricMode === 'versioned' && linkedRubrics.length > 0 && linkedRubrics.every((rubricId) => rubricIds.has(rubricId)));
  const scoringStatus: MeasurementCheck['status'] = input.rubricMode === 'missing' ? 'fail' : scoringAvailable ? 'pass' : 'unknown';

  const comparable =
    observations.length > 0 &&
    observations.every(
      (observation) =>
        observation.material_relation !== 'unknown' && observation.support_level !== 'unknown' && observation.delay_days !== null
    );
  const comparabilityStatus: MeasurementCheck['status'] = observations.length === 0 ? 'unknown' : comparable ? 'pass' : 'unknown';

  const coverageKnown =
    observations.length > 0 &&
    observations.every(
      (observation) =>
        observation.sample_count !== null &&
        observation.population_count !== null &&
        observation.population_count > 0 &&
        observation.sample_count <= observation.population_count &&
        observation.selection !== 'unknown' &&
        observation.coverage_caveat.trim().length > 0
    );
  const coverageStatus: MeasurementCheck['status'] = observations.length === 0 ? 'unknown' : coverageKnown ? 'pass' : 'unknown';

  const implementationKnown =
    Number.isSafeInteger(input.teachingEvent.actual_duration_sec) &&
    input.teachingEvent.actual_duration_sec >= 60 &&
    input.teachingEvent.actual_duration_sec <= 14_400 &&
    typeof input.teachingEvent.adjustment_summary === 'string';

  const checks: MeasurementCheck[] = [
    check('target_alignment', targetStatus, aligned ? 'observation_task_matches_plan_revision' : 'task_alignment_missing_or_invalid', targetObjectIds, 'M07'),
    check(
      'scoring_available',
      scoringStatus,
      input.rubricMode === 'non_scored' ? 'explicit_non_scored_observation' : scoringAvailable ? 'linked_rubric_available' : 'linked_rubric_missing',
      linkedRubrics,
      'M07'
    ),
    check('task_comparability', comparabilityStatus, comparable ? 'support_material_delay_recorded' : 'comparison_conditions_unknown', observations.map((o) => o.observation_id), 'M11'),
    check('sample_coverage', coverageStatus, coverageKnown ? 'sample_scope_and_caveat_recorded' : 'sample_scope_incomplete', observations.map((o) => o.observation_id), 'M11'),
    check('implementation_conditions', implementationKnown ? 'pass' : 'unknown', implementationKnown ? 'actual_duration_and_adjustment_recorded' : 'implementation_conditions_incomplete', [input.teachingEvent.event_id], 'M11')
  ];

  const inferenceLimits = new Set<MeasurementInferenceLimit>();
  if (observations.some((observation) => observation.selection !== 'all_available')) inferenceLimits.add('class_inference_not_allowed');
  if (observations.some((observation) => observation.material_relation === 'same_item')) inferenceLimits.add('transfer_not_measured');
  if (observations.some((observation) => observation.delay_days === 0)) inferenceLimits.add('delayed_retention_not_measured');
  if (observations.some((observation) => observation.support_level !== 'independent')) inferenceLimits.add('independent_performance_not_measured');

  return {
    review_id: ids.reviewId().trim(),
    workspace_id: input.teachingEvent.workspace_id,
    plan_id: input.plan.plan_id,
    plan_revision_id: input.plan.revision_id,
    teaching_event_id: input.teachingEvent.event_id,
    checks,
    disposition: checks.every((item) => item.status === 'pass') ? 'ready_for_attribution' : 'needs_measurement_review',
    inference_limits: [...inferenceLimits],
    is_effectiveness_proof: false,
    created_at: ids.now()
  };
}
