import type { LessonPlan } from '../lesson/types';
import type {
  AttributionContext,
  AttributionHypothesis,
  AttributionHypothesisKind,
  AttributionObservationContext,
  MeasurementReview,
  Observation,
  ObservationOutcome,
  TeachingEvent
} from './types';
import { extraKeys, isBoundedString, isRecord } from './validation';
import { validateMeasurementReview } from './measurement';

export const ATTRIBUTION_HYPOTHESIS_KINDS: readonly AttributionHypothesisKind[] = [
  'prerequisite_gap',
  'support_mismatch',
  'activity_mismatch',
  'retention_gap',
  'expression_gap',
  'time_constraint'
];

const MODEL_OUTPUT_KEYS = ['hypotheses', 'is_effectiveness_proof'] as const;
const HYPOTHESIS_KEYS = [
  'kind',
  'summary',
  'observation_ids',
  'evidence_basis',
  'limitations',
  'disconfirming_evidence',
  'return_modules'
] as const;
const RESULT_KEYS = [
  'attribution_run_id',
  'plan_revision_id',
  'teaching_event_id',
  'measurement_review_id',
  'model_job_id',
  'content_origin',
  'hypotheses',
  'not_executed_checks',
  'is_effectiveness_proof'
] as const;
const RETURN_MODULES = ['M07', 'M08', 'M11', 'M12'] as const;
const CONTENT_ORIGINS = ['real', 'offline-injected', 'simulated'] as const;
const NOT_EXECUTED_CHECKS = ['real_api_validation', 'professional_teaching_review'] as const;
const PROHIBITED = /(?:\d+(?:\.\d+)?\s*%|百分之|全班.{0,8}(?:掌握|错误|未掌握|能力)|排名|懒惰|智力|人格|家庭|父母|天赋|永久标签|能力低|因果证明|证明了|必然导致|一定是|就是因为|教学有效(?:性)?已?证明)/u;
const CONTEXT_KEYS = [
  'planId', 'planRevisionId', 'teachingEventId', 'actualDurationSec', 'implementationState',
  'adjustmentCategory', 'objectives', 'tasks', 'rubrics', 'observations', 'measurement',
  'allowedHypothesisKinds', 'prohibitedClaims'
] as const;

export interface BuildAttributionContextInput {
  plan: LessonPlan;
  teachingEvent: TeachingEvent;
  observations: Observation[];
  outcomes: ObservationOutcome[];
  measurement: MeasurementReview;
}

function coverageCode(observation: Observation): AttributionObservationContext['coverageCaveatCode'] {
  if (
    observation.sample_count === null ||
    observation.population_count === null ||
    observation.selection === 'unknown'
  ) return 'coverage_unknown';
  if (observation.selection !== 'all_available') return 'non_representative_sample';
  return observation.sample_count === observation.population_count ? 'complete_available_set' : 'partial_available_set';
}

function adjustmentCategory(event: TeachingEvent): AttributionContext['adjustmentCategory'] {
  if (event.implementation_state === 'partial') return 'scope_reduced';
  if (event.implementation_state === 'stopped') return 'stopped_early';
  return event.adjustment_summary.trim() ? 'other_adjustment' : 'none_recorded';
}

export function buildAttributionContext(input: BuildAttributionContextInput): AttributionContext {
  if (input.measurement.disposition !== 'ready_for_attribution') throw new Error('measurement_not_ready');
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.observation_id, outcome.outcome]));
  const observations = input.observations.map((observation): AttributionObservationContext => {
    const outcome = outcomes.get(observation.observation_id);
    if (!outcome) throw new Error(`observation_outcome_missing:${observation.observation_id}`);
    return {
      observationId: observation.observation_id,
      outcome,
      supportLevel: observation.support_level,
      materialRelation: observation.material_relation,
      delayDays: observation.delay_days,
      sampleCount: observation.sample_count,
      populationCount: observation.population_count,
      selection: observation.selection,
      coverageCaveatCode: coverageCode(observation)
    };
  });

  return {
    planId: input.plan.plan_id,
    planRevisionId: input.plan.revision_id,
    teachingEventId: input.teachingEvent.event_id,
    actualDurationSec: input.teachingEvent.actual_duration_sec,
    implementationState: input.teachingEvent.implementation_state,
    adjustmentCategory: adjustmentCategory(input.teachingEvent),
    objectives: input.plan.objectives.map((objective) => ({
      objectiveId: objective.objective_id,
      cognitiveDemand: objective.cognitive_demand
    })),
    tasks: input.plan.tasks.map((task) => ({
      taskId: task.task_id,
      objectiveIds: [...task.objective_ids],
      cognitiveDemand: task.cognitive_demand,
      rubricId: task.rubric_id
    })),
    rubrics: input.plan.rubrics.map((rubric) => ({
      rubricId: rubric.rubric_id,
      kind: rubric.kind,
      criteriaCount: rubric.criteria.length,
      allowsAlternatives: rubric.allows_alternatives,
      professionalCalibration: rubric.professional_calibration
    })),
    observations,
    measurement: {
      checks: input.measurement.checks.map((item) => ({
        checkId: item.check_id,
        status: item.status,
        objectIds: [...item.object_ids]
      })),
      inferenceLimits: [...input.measurement.inference_limits]
    },
    allowedHypothesisKinds: [...ATTRIBUTION_HYPOTHESIS_KINDS],
    prohibitedClaims: [
      'effectiveness_proof',
      'class_percentage_or_ranking',
      'permanent_student_label',
      'personality_intelligence_or_family_attribution',
      'causal_guarantee'
    ]
  };
}

export function validateAttributionContext(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, CONTEXT_KEYS);
  for (const key of ['planId', 'planRevisionId', 'teachingEventId'] as const) {
    if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  }
  if (!Number.isSafeInteger(value.actualDurationSec) || (value.actualDurationSec as number) < 60 || (value.actualDurationSec as number) > 14_400) errors.push('actualDurationSec');
  if (!['completed', 'partial', 'stopped'].includes(String(value.implementationState))) errors.push('implementationState');
  if (!['none_recorded', 'scope_reduced', 'stopped_early', 'other_adjustment'].includes(String(value.adjustmentCategory))) errors.push('adjustmentCategory');

  if (!Array.isArray(value.objectives) || value.objectives.length < 1) errors.push('objectives');
  else for (const item of value.objectives) {
    if (!isRecord(item)) { errors.push('objective_object'); continue; }
    errors.push(...extraKeys(item, ['objectiveId', 'cognitiveDemand']));
    if (!isBoundedString(item.objectiveId, 1, 128) || !isBoundedString(item.cognitiveDemand, 1, 64)) errors.push('objective');
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1) errors.push('tasks');
  else for (const item of value.tasks) {
    if (!isRecord(item)) { errors.push('task_object'); continue; }
    errors.push(...extraKeys(item, ['taskId', 'objectiveIds', 'cognitiveDemand', 'rubricId']));
    if (!isBoundedString(item.taskId, 1, 128) || !isBoundedString(item.cognitiveDemand, 1, 64) || !isBoundedString(item.rubricId, 1, 128) || !stringArray(item.objectiveIds, 1, 50, 128)) errors.push('task');
  }
  if (!Array.isArray(value.rubrics) || value.rubrics.length < 1) errors.push('rubrics');
  else for (const item of value.rubrics) {
    if (!isRecord(item)) { errors.push('rubric_object'); continue; }
    errors.push(...extraKeys(item, ['rubricId', 'kind', 'criteriaCount', 'allowsAlternatives', 'professionalCalibration']));
    if (!isBoundedString(item.rubricId, 1, 128) || !isBoundedString(item.kind, 1, 64) || !Number.isSafeInteger(item.criteriaCount) || (item.criteriaCount as number) < 1 || typeof item.allowsAlternatives !== 'boolean' || !isBoundedString(item.professionalCalibration, 1, 64)) errors.push('rubric');
  }
  if (!Array.isArray(value.observations) || value.observations.length < 1) errors.push('observations');
  else for (const item of value.observations) {
    if (!isRecord(item)) { errors.push('observation_object'); continue; }
    errors.push(...extraKeys(item, ['observationId', 'outcome', 'supportLevel', 'materialRelation', 'delayDays', 'sampleCount', 'populationCount', 'selection', 'coverageCaveatCode']));
    if (!isBoundedString(item.observationId, 1, 128)) errors.push('observationId');
    if (!['met_expectation', 'needed_prompt', 'clear_difficulty', 'insufficient_evidence'].includes(String(item.outcome))) errors.push('outcome');
    if (!['full_model', 'partial_prompt', 'independent', 'unknown'].includes(String(item.supportLevel))) errors.push('supportLevel');
    if (!['same_item', 'similar_new', 'different_context', 'unknown'].includes(String(item.materialRelation))) errors.push('materialRelation');
    for (const key of ['delayDays', 'sampleCount', 'populationCount'] as const) if (item[key] !== null && (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0)) errors.push(key);
    if (!['all_available', 'planned_sample', 'typical_cases', 'voluntary', 'unknown'].includes(String(item.selection))) errors.push('selection');
    if (!['complete_available_set', 'partial_available_set', 'non_representative_sample', 'coverage_unknown'].includes(String(item.coverageCaveatCode))) errors.push('coverageCaveatCode');
  }
  if (!isRecord(value.measurement)) errors.push('measurement');
  else {
    errors.push(...extraKeys(value.measurement, ['checks', 'inferenceLimits']));
    if (!Array.isArray(value.measurement.checks) || value.measurement.checks.length !== 5) errors.push('measurement.checks');
    else for (const item of value.measurement.checks) {
      if (!isRecord(item)) { errors.push('measurement.check'); continue; }
      errors.push(...extraKeys(item, ['checkId', 'status', 'objectIds']));
      if (!['target_alignment', 'scoring_available', 'task_comparability', 'sample_coverage', 'implementation_conditions'].includes(String(item.checkId)) || item.status !== 'pass' || !stringArray(item.objectIds, 0, 100, 128)) errors.push('measurement.check');
    }
    if (!Array.isArray(value.measurement.inferenceLimits) || value.measurement.inferenceLimits.some((item) => !['class_inference_not_allowed', 'transfer_not_measured', 'delayed_retention_not_measured', 'independent_performance_not_measured'].includes(String(item)))) errors.push('measurement.inferenceLimits');
  }
  if (!Array.isArray(value.allowedHypothesisKinds) || value.allowedHypothesisKinds.length !== ATTRIBUTION_HYPOTHESIS_KINDS.length || value.allowedHypothesisKinds.some((item) => !ATTRIBUTION_HYPOTHESIS_KINDS.includes(item as AttributionHypothesisKind))) errors.push('allowedHypothesisKinds');
  if (!stringArray(value.prohibitedClaims, 5, 5, 128)) errors.push('prohibitedClaims');
  return [...new Set(errors)];
}

function stringArray(value: unknown, min: number, max: number, itemMax = 1000): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => isBoundedString(item, 1, itemMax));
}

function hasProhibitedText(value: AttributionHypothesis): boolean {
  return [value.summary, ...value.evidence_basis, ...value.limitations, ...value.disconfirming_evidence].some((text) => PROHIBITED.test(text));
}

function validateHypothesis(value: unknown, allowedObservationIds: Set<string>): string[] {
  if (!isRecord(value)) return ['hypothesis_object'];
  const errors = extraKeys(value, HYPOTHESIS_KEYS);
  if (typeof value.kind !== 'string' || !ATTRIBUTION_HYPOTHESIS_KINDS.includes(value.kind as AttributionHypothesisKind)) errors.push('kind');
  if (!isBoundedString(value.summary, 1, 1000)) errors.push('summary');
  if (!stringArray(value.observation_ids, 1, 50, 128)) errors.push('observation_ids');
  else if (value.observation_ids.some((id) => !allowedObservationIds.has(id))) errors.push('unknown_observation_id');
  if (!stringArray(value.evidence_basis, 1, 20)) errors.push('evidence_basis');
  if (!stringArray(value.limitations, 1, 20)) errors.push('limitations');
  if (!stringArray(value.disconfirming_evidence, 1, 20)) errors.push('disconfirming_evidence');
  if (!Array.isArray(value.return_modules) || value.return_modules.length < 1 || value.return_modules.length > 4 || value.return_modules.some((item) => !RETURN_MODULES.includes(item as (typeof RETURN_MODULES)[number]))) errors.push('return_modules');
  if (errors.length === 0 && hasProhibitedText(value as unknown as AttributionHypothesis)) errors.push('prohibited_attribution');
  return errors;
}

export function validateTeachingAttributionModelOutput(value: unknown, allowedObservationIds: string[]): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, MODEL_OUTPUT_KEYS);
  if (value.is_effectiveness_proof !== false) errors.push('is_effectiveness_proof');
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length < 1 || value.hypotheses.length > 6) {
    errors.push('hypotheses');
  } else {
    const allowed = new Set(allowedObservationIds);
    for (const hypothesis of value.hypotheses) errors.push(...validateHypothesis(hypothesis, allowed));
  }
  return [...new Set(errors)];
}

export function validateAttributionResult(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, RESULT_KEYS);
  for (const key of ['attribution_run_id', 'plan_revision_id', 'teaching_event_id', 'measurement_review_id', 'model_job_id'] as const) {
    if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  }
  if (typeof value.content_origin !== 'string' || !CONTENT_ORIGINS.includes(value.content_origin as (typeof CONTENT_ORIGINS)[number])) errors.push('content_origin');
  if (value.is_effectiveness_proof !== false) errors.push('is_effectiveness_proof');
  if (!Array.isArray(value.not_executed_checks) || value.not_executed_checks.some((item) => !NOT_EXECUTED_CHECKS.includes(item as (typeof NOT_EXECUTED_CHECKS)[number]))) errors.push('not_executed_checks');
  if (!Array.isArray(value.hypotheses)) {
    errors.push('hypotheses');
  } else {
    const observationIds = value.hypotheses.flatMap((hypothesis) =>
      isRecord(hypothesis) && Array.isArray(hypothesis.observation_ids)
        ? hypothesis.observation_ids.filter((item): item is string => typeof item === 'string')
        : []
    );
    const modelErrors = validateTeachingAttributionModelOutput(
      { hypotheses: value.hypotheses, is_effectiveness_proof: value.is_effectiveness_proof },
      observationIds
    );
    errors.push(...modelErrors.filter((error) => error !== 'is_effectiveness_proof'));
  }
  return [...new Set(errors)];
}

export function validateFeedbackAnalysisResult(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const status = value.status;
  const common = ['status', 'streamRevision', 'measurement'];
  const allowed = status === 'attributed'
    ? [...common, 'attribution']
    : status === 'blocked'
      ? [...common, 'code', 'note']
      : status === 'uncertain'
        ? [...common, 'jobId', 'code', 'note']
        : common;
  const errors = extraKeys(value, allowed);
  if (!['needs_measurement_review', 'attributed', 'blocked', 'uncertain'].includes(String(status))) errors.push('status');
  if (!Number.isSafeInteger(value.streamRevision) || (value.streamRevision as number) < 1) errors.push('streamRevision');
  errors.push(...validateMeasurementReview(value.measurement).map((error) => `measurement:${error}`));
  if (status === 'attributed') errors.push(...validateAttributionResult(value.attribution).map((error) => `attribution:${error}`));
  if (status === 'blocked') {
    if (!['PRIVACY_BLOCKED', 'MODEL_NOT_AVAILABLE', 'BUDGET_EXCEEDED'].includes(String(value.code))) errors.push('code');
    if (!isBoundedString(value.note, 1, 2000)) errors.push('note');
  }
  if (status === 'uncertain') {
    if (value.code !== 'REQUEST_UNCERTAIN') errors.push('code');
    if (!isBoundedString(value.jobId, 1, 128)) errors.push('jobId');
    if (!isBoundedString(value.note, 1, 2000)) errors.push('note');
  }
  return [...new Set(errors)];
}
