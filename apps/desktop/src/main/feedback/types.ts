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
  knowledgeState: 'unknown';
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
