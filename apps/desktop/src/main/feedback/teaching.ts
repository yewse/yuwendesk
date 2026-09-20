import type { ImplementationState, TeachingEvent } from './types';
import { extraKeys, isBoundedString, isIsoDateTime, isRecord } from './validation';

const IMPLEMENTATION_STATES: readonly ImplementationState[] = ['completed', 'partial', 'stopped'];
const TEACHING_EVENT_KEYS = [
  'event_id',
  'workspace_id',
  'plan_id',
  'plan_revision_id',
  'taught_at',
  'actual_duration_sec',
  'implementation_state',
  'adjustment_summary',
  'created_at'
] as const;

export interface CreateTeachingEventInput {
  workspaceId: string;
  planId: string;
  planRevisionId: string;
  taughtAt: string;
  actualDurationSec: number;
  implementationState: ImplementationState;
  adjustmentSummary: string;
}

export interface TeachingEventIds {
  eventId(): string;
  now(): string;
}

export function validateTeachingEvent(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, TEACHING_EVENT_KEYS);
  if (!isBoundedString(value.event_id, 1, 128)) errors.push('event_id');
  if (!isBoundedString(value.workspace_id, 1, 128)) errors.push('workspace_id');
  if (!isBoundedString(value.plan_id, 1, 128)) errors.push('plan_id');
  if (!isBoundedString(value.plan_revision_id, 1, 128)) errors.push('plan_revision_id');
  if (!isIsoDateTime(value.taught_at)) errors.push('taught_at');
  if (!Number.isSafeInteger(value.actual_duration_sec) || (value.actual_duration_sec as number) < 60 || (value.actual_duration_sec as number) > 14_400) {
    errors.push('actual_duration_sec');
  }
  if (typeof value.implementation_state !== 'string' || !IMPLEMENTATION_STATES.includes(value.implementation_state as ImplementationState)) {
    errors.push('implementation_state');
  }
  if (!isBoundedString(value.adjustment_summary, 0, 4_000)) errors.push('adjustment_summary');
  if (!isIsoDateTime(value.created_at)) errors.push('created_at');
  return errors;
}

export function createTeachingEvent(input: CreateTeachingEventInput, ids: TeachingEventIds): TeachingEvent {
  const event: TeachingEvent = {
    event_id: ids.eventId().trim(),
    workspace_id: input.workspaceId.trim(),
    plan_id: input.planId.trim(),
    plan_revision_id: input.planRevisionId.trim(),
    taught_at: input.taughtAt,
    actual_duration_sec: input.actualDurationSec,
    implementation_state: input.implementationState,
    adjustment_summary: input.adjustmentSummary.trim(),
    created_at: ids.now()
  };
  const errors = validateTeachingEvent(event);
  if (errors.length) throw new Error(`invalid_teaching_event:${errors.join(',')}`);
  return event;
}
