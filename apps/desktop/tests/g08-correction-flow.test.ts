import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, type FeedbackCommitFaultHooks } from '../src/main/db/sqliteStore';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { createObservationRecord } from '../src/main/feedback/observation';
import { ModelService } from '../src/main/model/service';
import { FeedbackService } from '../src/main/feedback/service';
import { CorrectionVersionConflictError, FeedbackKeyReuseError } from '../src/main/feedback/types';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g08-correction-'));
}

async function openStore(dir = tempDir(), feedbackFaults?: FeedbackCommitFaultHooks): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { feedbackFaults });
  stores.add(store);
  await store.load();
  return store;
}

async function seedAttributed(store: SqliteStore, suffix = '1') {
  const plan = buildLessonPlan(demoLessonSpec({ plan_id: `plan_correction_${suffix}` }));
  store.saveLessonRevision({
    revisionId: plan.revision_id, planId: plan.plan_id, previousRevisionId: null,
    title: plan.title, contentJson: JSON.stringify(plan), contentOrigin: 'authored', valid: true,
    createdAt: '2026-09-20T00:00:00.000Z'
  }, true);
  const teachingEvent = createTeachingEvent({
    workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
    taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
    implementationState: 'completed', adjustmentSummary: ''
  }, { eventId: () => `teaching_correction_${suffix}`, now: () => '2026-09-20T08:00:00.000Z' });
  store.recordTeaching({
    workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
    expectedRevision: 0, idempotencyKey: `teach-${suffix}`, fingerprint: `teach-${suffix}`, event: teachingEvent
  });
  const observation = createObservationRecord({
    workspaceId: 'workspace_default', planRevisionId: plan.revision_id,
    teachingEventId: teachingEvent.event_id, taskId: plan.tasks[0].task_id,
    sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
    outcome: 'needed_prompt', supportLevel: 'partial_prompt', materialRelation: 'similar_new',
    delayDays: 2, sampleCount: 6, populationCount: 42, selection: 'typical_cases',
    coverageCaveat: '典型样本，不推算全班比例', summary: '虚构测试摘要'
  }, { observationId: () => `observation_correction_${suffix}` });
  store.addObservation({
    workspaceId: 'workspace_default', planId: plan.plan_id, teachingEventId: teachingEvent.event_id,
    expectedRevision: 1, idempotencyKey: `observation-${suffix}`, fingerprint: `observation-${suffix}`,
    observation: observation.observation, outcome: observation.outcome, createdAt: '2026-09-20T08:11:00.000Z'
  });
  const model = new ModelService(store);
  model.configure({ provider: 'test-double' });
  const feedback = new FeedbackService(store, store, model, {
    reviewId: () => `measurement_correction_${suffix}`,
    runId: () => `attribution_correction_${suffix}`,
    proposalId: () => `correction_${suffix}`,
    eventId: () => `event_${suffix}_${Math.random().toString(16).slice(2)}`,
    now: () => '2026-09-20T08:20:00.000Z'
  });
  const analysis = await feedback.analyze({
    workspaceId: 'workspace_default', planId: plan.plan_id, teachingEventId: teachingEvent.event_id,
    observationIds: [observation.observation.observation_id], dispatchConsent: false,
    expectedRevision: 2, idempotencyKey: `analysis-${suffix}`
  });
  expect(analysis.status).toBe('attributed');
  const history = store.getFeedbackCorrectionHistory(plan.plan_id);
  expect(history.corrections).toHaveLength(1);
  return { plan, teachingEvent, observation: observation.observation, feedback, history };
}

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* keep original assertion */ }
  }
  stores.clear();
});

describe('G08 atomic correction decisions and revert', () => {
  it('appends acceptance while preserving the original proposed JSON and only suggests a G07 preview', async () => {
    const store = await openStore();
    const seeded = await seedAttributed(store);
    const original = structuredClone(seeded.history.corrections[0].proposal);

    const result = seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_1',
      decision: 'accept', reason: '教师愿意先在下一正常任务试行', expectedRevision: 4,
      expectedProposalRevision: 0, idempotencyKey: 'decision-accept'
    });

    expect(result).toMatchObject({ currentStatus: 'accepted', stateRevision: 1, streamRevision: 5, replayed: false });
    expect(result.lessonChangeSuggestion).toMatchObject({ kind: 'increase_independent_time', activityId: 'act_2' });
    const history = store.getFeedbackCorrectionHistory(seeded.plan.plan_id);
    expect(history.corrections[0].proposal).toEqual(original);
    expect(history.corrections[0].decisionEvents).toHaveLength(1);
    expect(store.getLessonRevision(seeded.plan.plan_id)?.revisionId).toBe(seeded.plan.revision_id);
    expect(store.listMaterialArtifacts(seeded.plan.plan_id)).toEqual([]);
  });

  it('rejects a stale attempt to accept after rejection', async () => {
    const store = await openStore();
    const seeded = await seedAttributed(store, 'reject');
    seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_reject',
      decision: 'reject', reason: '不适合本班当前安排', expectedRevision: 4,
      expectedProposalRevision: 0, idempotencyKey: 'decision-reject'
    });

    expect(() => seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_reject',
      decision: 'accept', reason: '过期操作', expectedRevision: 5,
      expectedProposalRevision: 0, idempotencyKey: 'decision-stale'
    })).toThrow(CorrectionVersionConflictError);
  });

  it('reverts an accepted decision by appending a reverse event without deleting history', async () => {
    const store = await openStore();
    const seeded = await seedAttributed(store, 'revert');
    seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_revert',
      decision: 'accept', reason: '先试行', expectedRevision: 4,
      expectedProposalRevision: 0, idempotencyKey: 'decision-revert-accept'
    });
    const result = seeded.feedback.revertCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_revert',
      reason: '后续正常任务未出现预期证据', expectedRevision: 5,
      expectedProposalRevision: 1, idempotencyKey: 'decision-revert'
    });

    expect(result).toMatchObject({ currentStatus: 'reverted', stateRevision: 2, streamRevision: 6 });
    const history = store.getFeedbackCorrectionHistory(seeded.plan.plan_id);
    expect(history.corrections[0].decisionEvents.map((event) => event.action)).toEqual(['accept', 'revert']);
    expect(history.corrections[0].proposal.status).toBe('proposed');
  });

  it('replays the same decision across restart and rejects same-key different intent', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = await seedAttributed(store, 'idem');
    const input = {
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_idem',
      decision: 'accept' as const, reason: '试行', expectedRevision: 4,
      expectedProposalRevision: 0, idempotencyKey: 'decision-idem'
    };
    const first = seeded.feedback.decideCorrection(input);
    store.close();
    stores.delete(store);
    const reopened = await openStore(dir);
    const model = new ModelService(reopened);
    const service = new FeedbackService(reopened, reopened, model);

    expect(service.decideCorrection(input)).toEqual({ ...first, replayed: true });
    expect(() => service.decideCorrection({ ...input, decision: 'reject', reason: '不同意图' })).toThrow(FeedbackKeyReuseError);
  });

  it.each([
    'afterCorrectionProposalUpdate',
    'afterPreferenceInsert',
    'afterEffectInsert',
    'afterFeedbackStreamIncrement',
    'beforeFeedbackIdempotency'
  ] as const)('rolls back proposal/evidence/stream/idempotency at %s', async (hook) => {
    const faults: FeedbackCommitFaultHooks = { [hook]: () => { throw new Error(`fault:${hook}`); } };
    const store = await openStore(tempDir(), faults);
    const seeded = await seedAttributed(store, hook);
    const before = store.getFeedbackHistory(seeded.plan.plan_id).streamRevision;

    expect(() => seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: `correction_${hook}`,
      decision: 'accept', reason: '事务故障测试', expectedRevision: before,
      expectedProposalRevision: 0, idempotencyKey: `decision-${hook}`,
      preference: { preferenceKey: 'default_link_count', value: '1', reason: '减少默认联结' },
      effect: { state: 'initial_support', observationIds: [seeded.observation.observation_id] }
    })).toThrow(`fault:${hook}`);
    expect(store.getFeedbackHistory(seeded.plan.plan_id).streamRevision).toBe(before);
    const history = store.getFeedbackCorrectionHistory(seeded.plan.plan_id);
    expect(history.corrections[0]).toMatchObject({ currentStatus: 'proposed', stateRevision: 0, decisionEvents: [] });
    expect(history.preferenceEvents).toEqual([]);
    expect(history.effectEvents).toEqual([]);
  });

  it('persists preference and effect evidence without cross-track promotion', async () => {
    const store = await openStore();
    const seeded = await seedAttributed(store, 'tracks');
    const result = seeded.feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id, proposalId: 'correction_tracks',
      decision: 'accept', reason: '有限试行', expectedRevision: 4,
      expectedProposalRevision: 0, idempotencyKey: 'decision-tracks',
      preference: { preferenceKey: 'default_link_count', value: '1', reason: '减少默认联结' },
      effect: { state: 'initial_support', observationIds: [seeded.observation.observation_id] }
    });

    expect(result).toMatchObject({ preferenceState: { default_link_count: '1' }, effectState: 'initial_support' });
    const history = store.getFeedbackCorrectionHistory(seeded.plan.plan_id);
    expect(history.preferenceEvents).toHaveLength(1);
    expect(history.effectEvents).toHaveLength(1);
  });
});
