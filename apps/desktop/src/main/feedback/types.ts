export type ImplementationState = 'completed' | 'partial' | 'stopped';

export interface TeachingEvent {
  event_id: string;
  workspace_id: string;
  plan_id: string;
  plan_revision_id: string;
  taught_at: string;
  actual_duration_sec: number;
  implementation_state: ImplementationState;
  adjustment_summary: string;
  created_at: string;
}

export interface FeedbackWriteResult<T> {
  streamRevision: number;
  value: T;
  replayed: boolean;
}

export interface RecordTeachingInput {
  workspaceId: string;
  planId: string;
  planRevisionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  fingerprint: string;
  event: TeachingEvent;
}

export interface FeedbackHistory {
  streamRevision: number;
  teachingEvents: TeachingEvent[];
  knowledgeState: FeedbackKnowledgeState;
}

export type ObservationSourceKind = 'teacher_observation' | 'student_work' | 'existing_exam';
export type ObservationSupportLevel = 'full_model' | 'partial_prompt' | 'independent' | 'unknown';
export type ObservationMaterialRelation = 'same_item' | 'similar_new' | 'different_context' | 'unknown';
export type ObservationSelection = 'all_available' | 'planned_sample' | 'typical_cases' | 'voluntary' | 'unknown';
export type ObservationQualityState = 'unreviewed' | 'usable_with_limits' | 'needs_measurement_review';
export type ObservationOutcomeValue =
  | 'met_expectation'
  | 'needed_prompt'
  | 'clear_difficulty'
  | 'insufficient_evidence';

export interface Observation {
  observation_id: string;
  workspace_id: string;
  plan_revision_id: string;
  task_id: string | null;
  source_kind: ObservationSourceKind;
  observed_at: string;
  support_level: ObservationSupportLevel;
  material_relation: ObservationMaterialRelation;
  delay_days: number | null;
  sample_count: number | null;
  population_count: number | null;
  selection: ObservationSelection;
  coverage_caveat: string;
  summary: string;
  sensitive_payload_ref: null;
  cloud_allowed: false;
  quality_state: ObservationQualityState;
}

export interface ObservationOutcome {
  observation_id: string;
  outcome: ObservationOutcomeValue;
}

export interface ObservationRecord {
  teachingEventId: string;
  observation: Observation;
  outcome: ObservationOutcome;
}

export type FeedbackKnowledgeState = 'unknown' | 'observed' | 'deleted';

export interface AddObservationInput {
  workspaceId: string;
  planId: string;
  teachingEventId: string;
  expectedRevision: number;
  idempotencyKey: string;
  fingerprint: string;
  observation: Observation;
  outcome: ObservationOutcome;
  createdAt: string;
}

export interface ObservationDeleteResult {
  observationId: string;
  planId: string;
  deletedAt: string;
  backupScopesNotCovered: string[];
}

export interface DeleteObservationInput {
  workspaceId: string;
  planId: string;
  observationId: string;
  expectedRevision: number;
  idempotencyKey: string;
  fingerprint: string;
  confirmationToken: string;
  deletedAt: string;
  backupScopesNotCovered: string[];
}

export type MeasurementCheckId =
  | 'target_alignment'
  | 'scoring_available'
  | 'task_comparability'
  | 'sample_coverage'
  | 'implementation_conditions';
export type MeasurementCheckStatus = 'pass' | 'fail' | 'unknown';
export type MeasurementDisposition = 'ready_for_attribution' | 'needs_measurement_review';
export type MeasurementInferenceLimit =
  | 'class_inference_not_allowed'
  | 'transfer_not_measured'
  | 'delayed_retention_not_measured'
  | 'independent_performance_not_measured';

export interface MeasurementCheck {
  check_id: MeasurementCheckId;
  status: MeasurementCheckStatus;
  evidence: string;
  object_ids: string[];
  return_module: 'M07' | 'M08' | 'M11';
}

export interface MeasurementReview {
  review_id: string;
  workspace_id: string;
  plan_id: string;
  plan_revision_id: string;
  teaching_event_id: string;
  checks: MeasurementCheck[];
  disposition: MeasurementDisposition;
  inference_limits: MeasurementInferenceLimit[];
  is_effectiveness_proof: false;
  created_at: string;
}

export type AttributionHypothesisKind =
  | 'prerequisite_gap'
  | 'support_mismatch'
  | 'activity_mismatch'
  | 'retention_gap'
  | 'expression_gap'
  | 'time_constraint';
export type AttributionReturnModule = 'M07' | 'M08' | 'M11' | 'M12';
export type AttributionContentOrigin = 'real' | 'offline-injected' | 'simulated';
export type AttributionNotExecutedCheck = 'real_api_validation' | 'professional_teaching_review';

export interface AttributionHypothesis {
  kind: AttributionHypothesisKind;
  summary: string;
  observation_ids: string[];
  evidence_basis: string[];
  limitations: string[];
  disconfirming_evidence: string[];
  return_modules: AttributionReturnModule[];
}

export interface AttributionModelOutput {
  hypotheses: AttributionHypothesis[];
  is_effectiveness_proof: false;
}

export interface AttributionResult {
  attribution_run_id: string;
  plan_revision_id: string;
  teaching_event_id: string;
  measurement_review_id: string;
  model_job_id: string;
  content_origin: AttributionContentOrigin;
  hypotheses: AttributionHypothesis[];
  not_executed_checks: AttributionNotExecutedCheck[];
  is_effectiveness_proof: false;
}

export interface AttributionObservationContext {
  observationId: string;
  outcome: ObservationOutcomeValue;
  supportLevel: ObservationSupportLevel;
  materialRelation: ObservationMaterialRelation;
  delayDays: number | null;
  sampleCount: number | null;
  populationCount: number | null;
  selection: ObservationSelection;
  coverageCaveatCode: 'complete_available_set' | 'partial_available_set' | 'non_representative_sample' | 'coverage_unknown';
}

export interface AttributionContext {
  planId: string;
  planRevisionId: string;
  teachingEventId: string;
  actualDurationSec: number;
  implementationState: ImplementationState;
  adjustmentCategory: 'none_recorded' | 'scope_reduced' | 'stopped_early' | 'other_adjustment';
  objectives: Array<{ objectiveId: string; cognitiveDemand: string }>;
  tasks: Array<{ taskId: string; objectiveIds: string[]; cognitiveDemand: string; rubricId: string }>;
  rubrics: Array<{
    rubricId: string;
    kind: string;
    criteriaCount: number;
    allowsAlternatives: boolean;
    professionalCalibration: string;
  }>;
  observations: AttributionObservationContext[];
  measurement: {
    checks: Array<{ checkId: MeasurementCheckId; status: MeasurementCheckStatus; objectIds: string[] }>;
    inferenceLimits: MeasurementInferenceLimit[];
  };
  allowedHypothesisKinds: AttributionHypothesisKind[];
  prohibitedClaims: string[];
}

export type FeedbackAnalysisResult =
  | { status: 'needs_measurement_review'; streamRevision: number; measurement: MeasurementReview }
  | { status: 'attributed'; streamRevision: number; measurement: MeasurementReview; attribution: AttributionResult }
  | {
      status: 'blocked';
      streamRevision: number;
      measurement: MeasurementReview;
      code: 'PRIVACY_BLOCKED' | 'MODEL_NOT_AVAILABLE' | 'BUDGET_EXCEEDED';
      note: string;
    }
  | {
      status: 'uncertain';
      streamRevision: number;
      measurement: MeasurementReview;
      jobId: string;
      code: 'REQUEST_UNCERTAIN';
      note: string;
    };

export type AttributionRunStatus = 'running' | 'succeeded' | 'blocked' | 'failed' | 'uncertain' | 'stale';

export interface AttributionRunRecord {
  runId: string;
  workspaceId: string;
  planId: string;
  teachingEventId: string;
  inputHash: string;
  status: AttributionRunStatus;
  result: AttributionResult | null;
  modelJobId: string | null;
  contentOrigin: AttributionContentOrigin | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackAnalysisHistory {
  measurementReviews: MeasurementReview[];
  attributionRuns: AttributionRunRecord[];
}

export interface BeginFeedbackAnalysisInput {
  workspaceId: string;
  planId: string;
  teachingEventId: string;
  expectedRevision: number;
  idempotencyKey: string;
  fingerprint: string;
  inputHash: string;
  runId: string;
  measurement: MeasurementReview;
  createdAt: string;
}

export type BeginFeedbackAnalysisResult =
  | { kind: 'started'; streamRevision: number }
  | { kind: 'replayed'; result: unknown }
  | { kind: 'in_progress'; streamRevision: number };

export interface FinishFeedbackAnalysisInput {
  workspaceId: string;
  planId: string;
  runId: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  fingerprint: string;
  inputHash: string;
  runStatus: Exclude<AttributionRunStatus, 'running' | 'stale'>;
  attribution: AttributionResult | null;
  result: FeedbackAnalysisResult;
  modelJobId: string | null;
  contentOrigin: AttributionContentOrigin | null;
  advanceRevision: boolean;
  updatedAt: string;
}

export class ObservationPrivacyError extends Error {
  constructor(public readonly reason: string) {
    super(`OBSERVATION_PRIVACY_BLOCKED:${reason}`);
    this.name = 'ObservationPrivacyError';
  }
}

export class FeedbackVersionConflictError extends Error {
  constructor() {
    super('FEEDBACK_VERSION_CONFLICT');
    this.name = 'FeedbackVersionConflictError';
  }
}

export class FeedbackKeyReuseError extends Error {
  constructor() {
    super('FEEDBACK_IDEMPOTENCY_KEY_REUSE');
    this.name = 'FeedbackKeyReuseError';
  }
}

export class FeedbackSourceMissingError extends Error {
  constructor() {
    super('FEEDBACK_SOURCE_MISSING');
    this.name = 'FeedbackSourceMissingError';
  }
}
