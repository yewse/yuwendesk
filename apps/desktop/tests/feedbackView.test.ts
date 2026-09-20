import { describe, expect, it } from 'vitest';
import type { TeachingEvent } from '../src/main/feedback/types';
import {
  OBSERVATION_OUTCOME_OPTIONS,
  buildObservationPrompt,
  buildTeachingStatus,
  teachingSubmissionKey
} from '../src/renderer/feedbackView';

const event: TeachingEvent = {
  event_id: 'teach_1',
  workspace_id: 'workspace_default',
  plan_id: 'plan_1',
  plan_revision_id: 'revision_1',
  taught_at: '2026-09-20T07:30:00.000Z',
  actual_duration_sec: 2400,
  implementation_state: 'partial',
  adjustment_summary: '临时删减教师讲解',
  created_at: '2026-09-20T08:20:00.000Z'
};

describe('G08 feedback renderer view model', () => {
  it('keeps adopted and taught states separate', () => {
    expect(buildTeachingStatus({ adopted: true, events: [] })).toEqual({
      adoptionLabel: '已采用',
      teachingLabel: '尚未记录授课',
      canRecordTeaching: true
    });
    expect(buildTeachingStatus({ adopted: true, events: [event] })).toEqual({
      adoptionLabel: '已采用',
      teachingLabel: '已记录授课（部分实施）',
      canRecordTeaching: true
    });
  });

  it('does not claim adoption or effectiveness for an unadopted course', () => {
    const status = buildTeachingStatus({ adopted: false, events: [event] });
    expect(status.adoptionLabel).toBe('尚未采用');
    expect(status.teachingLabel).toBe('已记录授课（部分实施）');
    expect(JSON.stringify(status)).not.toMatch(/有效|成功/);
  });

  it('reuses one submission key for unchanged form data and rotates it after a change', () => {
    const base = {
      planId: 'plan_1',
      planRevisionId: 'revision_1',
      taughtAt: '2026-09-20T07:30:00.000Z',
      actualDurationSec: 2400,
      implementationState: 'completed' as const,
      adjustmentSummary: ''
    };
    expect(teachingSubmissionKey(base)).toBe(teachingSubmissionKey({ ...base }));
    expect(teachingSubmissionKey(base)).not.toBe(teachingSubmissionKey({ ...base, actualDurationSec: 2100 }));
  });

  it('offers four bounded optional outcomes only after teaching and never turns skip into a result', () => {
    expect(OBSERVATION_OUTCOME_OPTIONS.map((item) => item.value)).toEqual([
      'met_expectation',
      'needed_prompt',
      'clear_difficulty',
      'insufficient_evidence'
    ]);
    expect(buildObservationPrompt({ teachingEvents: [], observedTeachingEventIds: [], dismissedTeachingEventIds: [] })).toEqual({
      visible: false,
      teachingEventId: null,
      knowledgeLabel: '尚无反馈'
    });
    expect(buildObservationPrompt({ teachingEvents: [event], observedTeachingEventIds: [], dismissedTeachingEventIds: [] })).toEqual({
      visible: true,
      teachingEventId: 'teach_1',
      knowledgeLabel: '尚无反馈'
    });
    expect(buildObservationPrompt({ teachingEvents: [event], observedTeachingEventIds: [], dismissedTeachingEventIds: ['teach_1'] })).toEqual({
      visible: false,
      teachingEventId: 'teach_1',
      knowledgeLabel: '尚无反馈'
    });
  });
});
