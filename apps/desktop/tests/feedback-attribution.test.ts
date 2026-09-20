import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { createObservationRecord } from '../src/main/feedback/observation';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { reviewMeasurement } from '../src/main/feedback/measurement';
import {
  buildAttributionContext,
  validateAttributionResult,
  validateTeachingAttributionModelOutput
} from '../src/main/feedback/attribution';
import type { AttributionModelOutput, AttributionResult } from '../src/main/feedback/types';

function fixture() {
  const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_1' }));
  const teachingEvent = createTeachingEvent(
    {
      workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
      implementationState: 'completed', adjustmentSummary: ''
    },
    { eventId: () => 'teaching_1', now: () => '2026-09-20T08:00:00.000Z' }
  );
  const record = createObservationRecord(
    {
      workspaceId: 'workspace_default', planRevisionId: plan.revision_id,
      teachingEventId: teachingEvent.event_id, taskId: plan.tasks[0].task_id,
      sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
      outcome: 'needed_prompt', supportLevel: 'partial_prompt', materialRelation: 'similar_new',
      delayDays: 2, sampleCount: 6, populationCount: 42, selection: 'typical_cases',
      coverageCaveat: '典型样本，不推算全班比例',
      summary: '这段仅供本地教师查看，绝不能进入模型上下文'
    },
    { observationId: () => 'observation_1' }
  );
  const observations = [record.observation];
  const outcomes = [record.outcome];
  const measurement = reviewMeasurement(
    { plan, teachingEvent, observations: [{ teachingEventId: teachingEvent.event_id, ...record }], rubricMode: 'versioned' },
    { reviewId: () => 'measurement_1', now: () => '2026-09-20T08:15:00.000Z' }
  );
  return { plan, teachingEvent, observations, outcomes, measurement };
}

const validModelOutput: AttributionModelOutput = {
  hypotheses: [
    {
      kind: 'support_mismatch',
      summary: '待验证：当前提示程度可能遮蔽独立作答表现。',
      observation_ids: ['observation_1'],
      evidence_basis: ['记录显示在部分提示条件下完成。'],
      limitations: ['典型样本不能外推全班。'],
      disconfirming_evidence: ['若相似新题在无提示下仍稳定完成，则该假设不成立。'],
      return_modules: ['M11']
    }
  ],
  is_effectiveness_proof: false
};

describe('G08 attribution privacy and strict output boundary', () => {
  it('constructs a field-by-field context without the local observation summary', () => {
    const input = fixture();
    const context = buildAttributionContext(input);

    expect(JSON.stringify(context)).not.toContain(input.observations[0].summary);
    expect(context.observations[0]).toEqual({
      observationId: input.observations[0].observation_id,
      outcome: 'needed_prompt',
      supportLevel: 'partial_prompt',
      materialRelation: 'similar_new',
      delayDays: 2,
      sampleCount: 6,
      populationCount: 42,
      selection: 'typical_cases',
      coverageCaveatCode: 'non_representative_sample'
    });
    expect(JSON.stringify(context)).not.toContain('adjustment_summary');
    expect(JSON.stringify(context)).not.toContain('coverage_caveat');
  });

  it('accepts bounded hypotheses and rejects extra, prohibited, or fabricated claims', () => {
    expect(validateTeachingAttributionModelOutput(validModelOutput, ['observation_1'])).toEqual([]);
    expect(
      validateTeachingAttributionModelOutput({ ...validModelOutput, class_error_rate: 0.6 }, ['observation_1'])
    ).toContain('extra:class_error_rate');
    const personality = structuredClone(validModelOutput);
    personality.hypotheses[0].summary = '学生懒惰导致表现不佳。';
    expect(validateTeachingAttributionModelOutput(personality, ['observation_1'])).toContain('prohibited_attribution');
    const fabricated = structuredClone(validModelOutput);
    fabricated.hypotheses[0].observation_ids = ['observation_missing'];
    expect(validateTeachingAttributionModelOutput(fabricated, ['observation_1'])).toContain('unknown_observation_id');
    const percentage = structuredClone(validModelOutput);
    percentage.hypotheses[0].evidence_basis = ['全班有60%未掌握。'];
    expect(validateTeachingAttributionModelOutput(percentage, ['observation_1'])).toContain('prohibited_attribution');
  });

  it('strictly validates the persisted wrapper and preserves the non-proof marker', () => {
    const result: AttributionResult = {
      attribution_run_id: 'attribution_1',
      plan_revision_id: 'revision_1',
      teaching_event_id: 'teaching_1',
      measurement_review_id: 'measurement_1',
      model_job_id: 'job_1',
      content_origin: 'simulated',
      hypotheses: validModelOutput.hypotheses,
      not_executed_checks: ['real_api_validation', 'professional_teaching_review'],
      is_effectiveness_proof: false
    };
    expect(validateAttributionResult(result)).toEqual([]);
    expect(validateAttributionResult({ ...result, is_effectiveness_proof: true })).toContain('is_effectiveness_proof');
    expect(validateAttributionResult({ ...result, confidence: 0.9 })).toContain('extra:confidence');
  });
});
