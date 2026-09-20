import { describe, expect, it } from 'vitest';
import {
  ObservationPrivacyError,
  createObservationRecord,
  observationCoverageSummary,
  validateObservation,
  validateObservationOutcome
} from '../src/main/feedback/observation';

const ids = {
  observationId: () => 'observation_1'
};

function validInput() {
  return {
    workspaceId: 'workspace_default',
    planRevisionId: 'revision_1',
    teachingEventId: 'teaching_1',
    taskId: 'task_1',
    sourceKind: 'teacher_observation' as const,
    observedAt: '2026-09-20T08:10:00.000Z',
    outcome: 'needed_prompt' as const,
    supportLevel: 'partial_prompt' as const,
    materialRelation: 'same_item' as const,
    delayDays: 0,
    sampleCount: 6,
    populationCount: 42,
    selection: 'typical_cases' as const,
    coverageCaveat: '六份为教师刻意选择的典型作答，不能推算全班比例',
    summary: '部分作答能指出关键词，但书面证据联系仍需提示'
  };
}

describe('G08-T02 Observation domain', () => {
  it('creates a local-only bounded observation and separate four-choice outcome', () => {
    const result = createObservationRecord(validInput(), ids);

    expect(result.observation).toMatchObject({
      observation_id: 'observation_1',
      sensitive_payload_ref: null,
      cloud_allowed: false,
      quality_state: 'usable_with_limits'
    });
    expect(result.observation).not.toHaveProperty('teaching_event_id');
    expect(result.outcome).toEqual({ observation_id: 'observation_1', outcome: 'needed_prompt' });
    expect(validateObservation(result.observation)).toEqual([]);
    expect(validateObservationOutcome(result.outcome)).toEqual([]);
    expect(observationCoverageSummary(result.observation)).toContain('典型样本 6/42');
    expect(observationCoverageSummary(result.observation)).not.toContain('%');
  });

  it('keeps insufficient evidence in measurement review instead of success or failure', () => {
    const result = createObservationRecord(
      { ...validInput(), outcome: 'insufficient_evidence', summary: '现有记录不足以判断表现' },
      ids
    );

    expect(result.observation.quality_state).toBe('needs_measurement_review');
    expect(result.outcome.outcome).toBe('insufficient_evidence');
  });

  it('only computes a percentage for complete all-available coverage', () => {
    const complete = createObservationRecord(
      {
        ...validInput(),
        sampleCount: 42,
        populationCount: 42,
        selection: 'all_available',
        coverageCaveat: '本次已查看全部 42 份可用记录'
      },
      ids
    );
    expect(observationCoverageSummary(complete.observation)).toContain('100%');

    expect(() => createObservationRecord({ ...validInput(), sampleCount: 43 }, ids)).toThrow(
      'invalid_observation:sample_count'
    );
    expect(() =>
      createObservationRecord({ ...validInput(), coverageCaveat: '典型样本显示全班 80% 已掌握' }, ids)
    ).toThrow('observation_percentage_claim_not_allowed');
    expect(() => createObservationRecord({ ...validInput(), coverageCaveat: '' }, ids)).toThrow(
      'invalid_observation:coverage_caveat'
    );
  });

  it('blocks forbidden identity/raw-work/path fields and obvious contact or ID patterns', () => {
    expect(() =>
      createObservationRecord({ ...validInput(), filePath: 'C:/fictional/work.txt' } as ReturnType<typeof validInput>, ids)
    ).toThrow(new ObservationPrivacyError('forbidden_field:filePath'));
    expect(() =>
      createObservationRecord({ ...validInput(), studentName: '虚构姓名' } as ReturnType<typeof validInput>, ids)
    ).toThrow(new ObservationPrivacyError('forbidden_field:studentName'));
    expect(() => createObservationRecord({ ...validInput(), summary: '联系电话 13800138000' }, ids)).toThrow(
      new ObservationPrivacyError('summary_contains_contact_or_id')
    );
    expect(() => createObservationRecord({ ...validInput(), summary: '证件号 110101200001011234' }, ids)).toThrow(
      new ObservationPrivacyError('summary_contains_contact_or_id')
    );
  });

  it('strict validators reject extra fields and cloud/raw-payload escalation', () => {
    const result = createObservationRecord(validInput(), ids);
    expect(validateObservation({ ...result.observation, extra: true })).toContain('extra:extra');
    expect(validateObservation({ ...result.observation, cloud_allowed: true })).toContain('cloud_allowed');
    expect(validateObservation({ ...result.observation, sensitive_payload_ref: 'raw_1' })).toContain('sensitive_payload_ref');
    expect(validateObservationOutcome({ ...result.outcome, extra: true })).toContain('extra:extra');
  });
});
