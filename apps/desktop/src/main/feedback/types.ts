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
