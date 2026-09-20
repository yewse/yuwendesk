import type { ImplementationState, TeachingEvent } from '../main/feedback/types';

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
