import { describe, expect, it } from 'vitest';
import { createTeachingEvent, validateTeachingEvent } from '../src/main/feedback/teaching';

const ids = {
  eventId: () => 'teach_1',
  now: () => '2026-09-20T08:00:00.000Z'
};

describe('G08-T01 TeachingEvent domain', () => {
  it('records actual teaching without changing adoption or claiming effectiveness', () => {
    const event = createTeachingEvent(
      {
        workspaceId: 'workspace_default',
        planId: 'plan_1',
        planRevisionId: 'revision_1',
        taughtAt: '2026-09-20T07:30:00.000Z',
        actualDurationSec: 2340,
        implementationState: 'partial',
        adjustmentSummary: '临时删去教师补充说明，核心学生任务已完成'
      },
      ids
    );

    expect(event).toEqual({
      event_id: 'teach_1',
      workspace_id: 'workspace_default',
      plan_id: 'plan_1',
      plan_revision_id: 'revision_1',
      taught_at: '2026-09-20T07:30:00.000Z',
      actual_duration_sec: 2340,
      implementation_state: 'partial',
      adjustment_summary: '临时删去教师补充说明，核心学生任务已完成',
      created_at: '2026-09-20T08:00:00.000Z'
    });
    expect(event).not.toHaveProperty('effectiveness');
    expect(event).not.toHaveProperty('plan_status');
    expect(validateTeachingEvent(event)).toEqual([]);
  });

  it('rejects extra fields and an implausible duration', () => {
    expect(
      validateTeachingEvent({
        event_id: 'teach_1',
        workspace_id: 'workspace_default',
        plan_id: 'plan_1',
        plan_revision_id: 'revision_1',
        taught_at: '2026-09-20T07:30:00.000Z',
        actual_duration_sec: 0,
        implementation_state: 'completed',
        adjustment_summary: '',
        created_at: '2026-09-20T08:00:00.000Z',
        effectiveness: 'proved'
      })
    ).toEqual(expect.arrayContaining(['actual_duration_sec', 'extra:effectiveness']));
  });

  it('rejects unknown implementation state and invalid timestamps', () => {
    expect(
      validateTeachingEvent({
        event_id: 'teach_1',
        workspace_id: 'workspace_default',
        plan_id: 'plan_1',
        plan_revision_id: 'revision_1',
        taught_at: 'today',
        actual_duration_sec: 1800,
        implementation_state: 'successful',
        adjustment_summary: '',
        created_at: 'later'
      })
    ).toEqual(expect.arrayContaining(['taught_at', 'implementation_state', 'created_at']));
  });
});
