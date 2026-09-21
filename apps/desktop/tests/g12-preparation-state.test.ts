import { describe, expect, it } from 'vitest';
import { canTransition, reconcileInterruptedStatus } from '../src/main/preparation/stateMachine';

describe('G12 preparation state machine', () => {
  it('allows only the documented forward path', () => {
    expect(canTransition('CONTEXT_DRAFT', 'SOURCES_SELECTED')).toBe(true);
    expect(canTransition('SOURCES_SELECTED', 'BUILDING')).toBe(true);
    expect(canTransition('BUILDING', 'PLAN_REVIEW')).toBe(true);
    expect(canTransition('PLAN_REVIEW', 'READY_TO_EXPORT')).toBe(true);
    expect(canTransition('READY_TO_EXPORT', 'EXPORTING')).toBe(true);
    expect(canTransition('EXPORTING', 'EXPORTED')).toBe(true);
    expect(canTransition('CONTEXT_DRAFT', 'EXPORTED')).toBe(false);
    expect(canTransition('EXPORTED', 'CONTEXT_DRAFT')).toBe(false);
  });

  it('returns interrupted work to the last safe state', () => {
    expect(reconcileInterruptedStatus('BUILDING')).toEqual({
      status: 'SOURCES_SELECTED',
      errorCode: 'PREPARATION_INTERRUPTED'
    });
    expect(reconcileInterruptedStatus('EXPORTING')).toEqual({
      status: 'READY_TO_EXPORT',
      errorCode: 'PREPARATION_INTERRUPTED'
    });
    expect(reconcileInterruptedStatus('PLAN_REVIEW')).toEqual({ status: 'PLAN_REVIEW', errorCode: null });
  });
});
