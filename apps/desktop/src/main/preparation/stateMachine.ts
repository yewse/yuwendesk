import type { PreparationErrorCode, PreparationStatus } from './types';

const TRANSITIONS: Record<PreparationStatus, readonly PreparationStatus[]> = {
  CONTEXT_DRAFT: ['SOURCES_SELECTED'],
  SOURCES_SELECTED: ['BUILDING'],
  BUILDING: ['PLAN_REVIEW', 'SOURCES_SELECTED'],
  PLAN_REVIEW: ['READY_TO_EXPORT', 'BUILDING'],
  READY_TO_EXPORT: ['EXPORTING', 'PLAN_REVIEW', 'BUILDING'],
  EXPORTING: ['EXPORTED', 'READY_TO_EXPORT'],
  EXPORTED: ['PLAN_REVIEW', 'BUILDING']
};

export function canTransition(from: PreparationStatus, to: PreparationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function reconcileInterruptedStatus(status: PreparationStatus): {
  status: PreparationStatus;
  errorCode: PreparationErrorCode | null;
} {
  if (status === 'BUILDING') {
    return { status: 'SOURCES_SELECTED', errorCode: 'PREPARATION_INTERRUPTED' };
  }
  if (status === 'EXPORTING') {
    return { status: 'READY_TO_EXPORT', errorCode: 'PREPARATION_INTERRUPTED' };
  }
  return { status, errorCode: null };
}
