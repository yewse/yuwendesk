import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { createObservationRecord } from '../src/main/feedback/observation';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { reviewMeasurement } from '../src/main/feedback/measurement';

const ids = {
  reviewId: () => 'measurement_1',
  now: () => '2026-09-20T08:15:00.000Z'
};

function fixture() {
  const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_1' }));
  const teachingEvent = createTeachingEvent(
    {
      workspaceId: 'workspace_default',
      planId: plan.plan_id,
      planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z',
      actualDurationSec: 2400,
      implementationState: 'completed',
      adjustmentSummary: ''
    },
    { eventId: () => 'teaching_1', now: () => '2026-09-20T08:00:00.000Z' }
  );
  const record = createObservationRecord(
    {
      workspaceId: 'workspace_default',
      planRevisionId: plan.revision_id,
      teachingEventId: teachingEvent.event_id,
      taskId: plan.tasks[0].task_id,
      sourceKind: 'teacher_observation',
      observedAt: '2026-09-20T08:10:00.000Z',
      outcome: 'needed_prompt',
      supportLevel: 'partial_prompt',
      materialRelation: 'similar_new',
      delayDays: 2,
      sampleCount: 6,
      populationCount: 42,
      selection: 'typical_cases',
      coverageCaveat: '典型样本，不推算全班比例',
      summary: '虚构测试摘要'
    },
    { observationId: () => 'observation_1' }
  );
  return { plan, teachingEvent, observations: [{ teachingEventId: teachingEvent.event_id, ...record }] };
}

describe('G08 deterministic measurement gate', () => {
  it('passes exactly the five required checks when local conditions are explicit', () => {
    const input = fixture();
    const ready = reviewMeasurement({ ...input, rubricMode: 'versioned' }, ids);

    expect(ready.disposition).toBe('ready_for_attribution');
    expect(ready.checks.map((check) => [check.check_id, check.status])).toEqual([
      ['target_alignment', 'pass'],
      ['scoring_available', 'pass'],
      ['task_comparability', 'pass'],
      ['sample_coverage', 'pass'],
      ['implementation_conditions', 'pass']
    ]);
    expect(ready.is_effectiveness_proof).toBe(false);
  });

  it('returns to measurement modules when scoring or implementation evidence is absent', () => {
    const input = fixture();
    const blocked = reviewMeasurement(
      {
        ...input,
        teachingEvent: { ...input.teachingEvent, actual_duration_sec: 0 },
        rubricMode: 'missing'
      },
      ids
    );

    expect(blocked.disposition).toBe('needs_measurement_review');
    expect(blocked.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check_id: 'scoring_available', status: 'fail', return_module: 'M07' }),
        expect.objectContaining({ check_id: 'implementation_conditions', status: 'unknown', return_module: 'M11' })
      ])
    );
  });

  it('does not turn same-item, fully modelled performance into transfer or retention evidence', () => {
    const input = fixture();
    input.observations[0].observation.material_relation = 'same_item';
    input.observations[0].observation.support_level = 'full_model';
    input.observations[0].observation.delay_days = 0;

    const review = reviewMeasurement({ ...input, rubricMode: 'versioned' }, ids);

    expect(review.disposition).toBe('ready_for_attribution');
    expect(review.inference_limits).toEqual(
      expect.arrayContaining(['transfer_not_measured', 'delayed_retention_not_measured', 'independent_performance_not_measured'])
    );
    expect(review.is_effectiveness_proof).toBe(false);
  });
});
