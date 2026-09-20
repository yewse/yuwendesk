import type { ImplementationState, ObservationOutcomeValue, TeachingEvent } from '../main/feedback/types';

export interface TeachingStatusInput {
  adopted: boolean;
  events: TeachingEvent[];
}

export interface TeachingStatusView {
  adoptionLabel: '已采用' | '尚未采用';
  teachingLabel: string;
  canRecordTeaching: boolean;
}

const IMPLEMENTATION_LABELS: Record<ImplementationState, string> = {
  completed: '完整实施',
  partial: '部分实施',
  stopped: '中止'
};

export function buildTeachingStatus(input: TeachingStatusInput): TeachingStatusView {
  const latest = input.events.at(-1);
  return {
    adoptionLabel: input.adopted ? '已采用' : '尚未采用',
    teachingLabel: latest ? `已记录授课（${IMPLEMENTATION_LABELS[latest.implementation_state]}）` : '尚未记录授课',
    canRecordTeaching: true
  };
}

export interface TeachingSubmissionShape {
  planId: string;
  planRevisionId: string;
  taughtAt: string;
  actualDurationSec: number;
  implementationState: ImplementationState;
  adjustmentSummary: string;
}

export function teachingSubmissionKey(input: TeachingSubmissionShape): string {
  const source = JSON.stringify([
    input.planId,
    input.planRevisionId,
    input.taughtAt,
    input.actualDurationSec,
    input.implementationState,
    input.adjustmentSummary.trim()
  ]);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `teach-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export const OBSERVATION_OUTCOME_OPTIONS: ReadonlyArray<{ value: ObservationOutcomeValue; label: string }> = [
  { value: 'met_expectation', label: '达到要求' },
  { value: 'needed_prompt', label: '仍需提示' },
  { value: 'clear_difficulty', label: '明显困难' },
  { value: 'insufficient_evidence', label: '证据不足' }
];

export interface ObservationPromptInput {
  teachingEvents: TeachingEvent[];
  observedTeachingEventIds: string[];
  dismissedTeachingEventIds: string[];
}

export interface ObservationPromptView {
  visible: boolean;
  teachingEventId: string | null;
  knowledgeLabel: '尚无反馈' | '已有反馈';
}

export function buildObservationPrompt(input: ObservationPromptInput): ObservationPromptView {
  const latest = input.teachingEvents.at(-1);
  if (!latest) return { visible: false, teachingEventId: null, knowledgeLabel: '尚无反馈' };
  const observed = input.observedTeachingEventIds.includes(latest.event_id);
  const dismissed = input.dismissedTeachingEventIds.includes(latest.event_id);
  return {
    visible: !observed && !dismissed,
    teachingEventId: latest.event_id,
    knowledgeLabel: observed ? '已有反馈' : '尚无反馈'
  };
}
