import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { ModelService } from '../src/main/model/service';
import type { AttributionContext, AttributionModelOutput } from '../src/main/feedback/types';
import type { ModelProvider, ModelResult, PricingConfig } from '../src/main/model/types';
import type { HttpTransport } from '../src/main/model/types';
import { createDeepseekProvider } from '../src/main/model/providers';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { createObservationRecord } from '../src/main/feedback/observation';
import { FeedbackService } from '../src/main/feedback/service';
import { FeedbackVersionConflictError } from '../src/main/feedback/types';
import { IpcService } from '../src/main/ipc';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';
import { StoreProtectedError } from '../src/main/store';

const stores = new Set<SqliteStore>();
const pricing: PricingConfig = {
  currency: 'SIM', per1kInputCents: 0, per1kOutputCents: 0,
  source: 'simulated', effectiveDate: 'N/A', isEstimate: true
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g08-attribution-'));
}

function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}

async function openStore(dir = tempDir()): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { safeStorage: fakeSafe() });
  stores.add(store);
  await store.load();
  return store;
}

function seedPlan(store: SqliteStore) {
  const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_service' }));
  store.saveLessonRevision({
    revisionId: plan.revision_id, planId: plan.plan_id, previousRevisionId: null,
    title: plan.title, contentJson: JSON.stringify(plan), contentOrigin: 'authored',
    valid: true, createdAt: '2026-09-20T00:00:00.000Z'
  }, true);
  const teachingEvent = createTeachingEvent({
    workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
    taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
    implementationState: 'completed', adjustmentSummary: ''
  }, { eventId: () => 'teaching_service', now: () => '2026-09-20T08:00:00.000Z' });
  store.recordTeaching({
    workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
    expectedRevision: 0, idempotencyKey: 'seed-teaching', fingerprint: 'seed-teaching', event: teachingEvent
  });
  return { plan, teachingEvent };
}

function seedObservation(store: SqliteStore, seeded: ReturnType<typeof seedPlan>, expectedRevision = 1, suffix = '1') {
  const record = createObservationRecord({
    workspaceId: 'workspace_default', planRevisionId: seeded.plan.revision_id,
    teachingEventId: seeded.teachingEvent.event_id, taskId: seeded.plan.tasks[0].task_id,
    sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
    outcome: 'needed_prompt', supportLevel: 'partial_prompt', materialRelation: 'similar_new',
    delayDays: 2, sampleCount: 6, populationCount: 42, selection: 'typical_cases',
    coverageCaveat: '典型样本，不推算全班比例', summary: '虚构测试摘要'
  }, { observationId: () => `observation_service_${suffix}` });
  return store.addObservation({
    workspaceId: 'workspace_default', planId: seeded.plan.plan_id,
    teachingEventId: seeded.teachingEvent.event_id, expectedRevision,
    idempotencyKey: `seed-observation-${suffix}`, fingerprint: `seed-observation-${suffix}`,
    observation: record.observation, outcome: record.outcome, createdAt: `2026-09-20T08:1${suffix}:00.000Z`
  });
}

const context: AttributionContext = {
  planId: 'plan_1',
  planRevisionId: 'revision_1',
  teachingEventId: 'teaching_1',
  actualDurationSec: 2400,
  implementationState: 'completed',
  adjustmentCategory: 'none_recorded',
  objectives: [{ objectiveId: 'objective_1', cognitiveDemand: 'explain' }],
  tasks: [{ taskId: 'task_1', objectiveIds: ['objective_1'], cognitiveDemand: 'explain', rubricId: 'rubric_1' }],
  rubrics: [{ rubricId: 'rubric_1', kind: 'teacher_defined', criteriaCount: 1, allowsAlternatives: true, professionalCalibration: 'not_calibrated' }],
  observations: [{
    observationId: 'observation_1', outcome: 'needed_prompt', supportLevel: 'partial_prompt',
    materialRelation: 'similar_new', delayDays: 2, sampleCount: 6, populationCount: 42,
    selection: 'typical_cases', coverageCaveatCode: 'non_representative_sample'
  }],
  measurement: {
    checks: [
      { checkId: 'target_alignment', status: 'pass', objectIds: ['task_1', 'observation_1'] },
      { checkId: 'scoring_available', status: 'pass', objectIds: ['rubric_1'] },
      { checkId: 'task_comparability', status: 'pass', objectIds: ['observation_1'] },
      { checkId: 'sample_coverage', status: 'pass', objectIds: ['observation_1'] },
      { checkId: 'implementation_conditions', status: 'pass', objectIds: ['teaching_1'] }
    ],
    inferenceLimits: ['class_inference_not_allowed']
  },
  allowedHypothesisKinds: ['prerequisite_gap', 'support_mismatch', 'activity_mismatch', 'retention_gap', 'expression_gap', 'time_constraint'],
  prohibitedClaims: ['effectiveness_proof', 'class_percentage_or_ranking', 'permanent_student_label', 'personality_intelligence_or_family_attribution', 'causal_guarantee']
};

const validOutput: AttributionModelOutput = {
  hypotheses: [{
    kind: 'support_mismatch',
    summary: '待验证：提示程度可能遮蔽独立作答表现。',
    observation_ids: ['observation_1'],
    evidence_basis: ['部分提示条件下记录到需要提示。'],
    limitations: ['典型样本不能外推全班。'],
    disconfirming_evidence: ['相似新题无提示下稳定完成时应撤回该假设。'],
    return_modules: ['M11']
  }],
  is_effectiveness_proof: false
};

function provider(
  id: string,
  requiresKey: boolean,
  output: string,
  onComplete: () => void = () => undefined,
  finishReason = 'stop'
): ModelProvider {
  return {
    id,
    defaultModel: `${id}-model`,
    requiresKey,
    pricing,
    contentOrigin: 'simulated',
    async probe({ model }) {
      return { ok: true, provider: id, model, isTestDouble: !requiresKey, note: 'test' };
    },
    async complete(req, ctx): Promise<ModelResult> {
      onComplete();
      return {
        text: output,
        usage: { promptTokens: Math.ceil((req.system.length + req.user.length) / 4), completionTokens: 10 },
        usageKnown: true,
        costCents: 0,
        provider: id,
        model: ctx.model,
        isTestDouble: !requiresKey,
        contentOrigin: 'simulated',
        finishReason,
        pricing
      };
    }
  };
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe('G08 structured attribution through the existing model protections', () => {
  it('runs the deterministic test double under teaching_attribution.v1', async () => {
    const store = await openStore();
    const service = new ModelService(store);
    service.configure({ provider: 'test-double' });

    const result = await service.runStructuredAttribution({ context, dispatchConsent: false });

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect((result.result as { contentOrigin: string }).contentOrigin).toBe('simulated');
      expect((result.result as { parsed: AttributionModelOutput }).parsed.is_effectiveness_proof).toBe(false);
    }
  });

  it('does not call a credentialed provider without per-run dispatch consent', async () => {
    const store = await openStore();
    let calls = 0;
    const realLike = provider('real-like', true, JSON.stringify(validOutput), () => calls++);
    const service = new ModelService(store, { providers: { 'real-like': realLike } });
    service.configure({ provider: 'real-like', apiKey: 'secret', allowRealNetwork: true });

    const result = await service.runStructuredAttribution({ context, dispatchConsent: false });

    expect(result).toMatchObject({ status: 'blocked', code: 'PRIVACY_BLOCKED' });
    expect(calls).toBe(0);
  });

  it('rejects unknown context fields and invalid provider output without a usable cache entry', async () => {
    const store = await openStore();
    let calls = 0;
    const invalid = provider('invalid', false, JSON.stringify({ hypotheses: [], is_effectiveness_proof: false }), () => calls++);
    const service = new ModelService(store, { providers: { invalid } });
    service.configure({ provider: 'invalid' });

    const privacy = await service.runStructuredAttribution({
      context: { ...context, rawObservationJson: '{"summary":"private"}' } as AttributionContext,
      dispatchConsent: true
    });
    expect(privacy).toMatchObject({ status: 'blocked', code: 'PRIVACY_BLOCKED' });
    expect(calls).toBe(0);

    const first = await service.runStructuredAttribution({ context, dispatchConsent: true });
    const second = await service.runStructuredAttribution({ context, dispatchConsent: true });
    expect(first).toMatchObject({ status: 'failed', code: 'EXPORT_INVALID' });
    expect(second).toMatchObject({ status: 'failed', code: 'EXPORT_INVALID' });
    expect(calls).toBe(2);
  });

  it.each([
    ['invalid JSON', '{"hypotheses":'],
    ['forbidden percentage', JSON.stringify({
      ...validOutput,
      hypotheses: [{ ...validOutput.hypotheses[0], evidence_basis: ['全班有60%未掌握。'] }]
    })],
    ['fabricated observation', JSON.stringify({
      ...validOutput,
      hypotheses: [{ ...validOutput.hypotheses[0], observation_ids: ['observation_fabricated'] }]
    })]
  ])('rejects %s and does not cache it', async (_label, output) => {
    const store = await openStore();
    let calls = 0;
    const invalid = provider('invalid-case', false, output, () => calls++);
    const service = new ModelService(store, { providers: { 'invalid-case': invalid } });
    service.configure({ provider: 'invalid-case' });

    await expect(service.runStructuredAttribution({ context, dispatchConsent: true })).resolves.toMatchObject({ status: 'failed', code: 'EXPORT_INVALID' });
    await expect(service.runStructuredAttribution({ context, dispatchConsent: true })).resolves.toMatchObject({ status: 'failed', code: 'EXPORT_INVALID' });
    expect(calls).toBe(2);
  });

  it('rejects a length-truncated finish reason before usable attribution', async () => {
    const store = await openStore();
    const truncated = provider('truncated', false, JSON.stringify(validOutput), () => undefined, 'length');
    const service = new ModelService(store, { providers: { truncated } });
    service.configure({ provider: 'truncated' });

    await expect(service.runStructuredAttribution({ context, dispatchConsent: true })).resolves.toMatchObject({ status: 'failed', code: 'EXPORT_INVALID' });
  });

  it('runs the DeepSeek protocol only through an offline injected transport and preserves that origin', async () => {
    const store = await openStore();
    let sentBody = '';
    const transport: HttpTransport = async (request) => {
      sentBody = request.body;
      return {
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validOutput) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
      };
    };
    const deepseek = createDeepseekProvider(transport, { contentOrigin: 'offline-injected' });
    const service = new ModelService(store, { providers: { deepseek } });
    service.configure({ provider: 'deepseek', apiKey: 'offline-secret', allowRealNetwork: true });

    const result = await service.runStructuredAttribution({ context, dispatchConsent: true });

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect((result.result as { contentOrigin: string }).contentOrigin).toBe('offline-injected');
    expect(sentBody).toContain('teachingEventId');
    expect(sentBody).not.toContain('observation summary');
  });

  it('keeps timeout execution and cost uncertain instead of retrying it as a free failure', async () => {
    const store = await openStore();
    const costly: ModelProvider = {
      ...provider('costly', false, JSON.stringify(validOutput)),
      pricing: { currency: 'SIM', per1kInputCents: 1, per1kOutputCents: 1, source: 'simulated', effectiveDate: 'N/A', isEstimate: true },
      async complete(req, ctx) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return provider('costly', false, JSON.stringify(validOutput)).complete(req, ctx);
      }
    };
    const service = new ModelService(store, { providers: { costly }, timeoutMs: 5 });
    service.configure({ provider: 'costly' });

    const result = await service.runStructuredAttribution({ context, dispatchConsent: true });

    expect(result).toMatchObject({ status: 'uncertain', code: 'REQUEST_UNCERTAIN' });
    if (result.status === 'uncertain') expect(store.getModelJob(result.jobId)?.costCents).toBeGreaterThan(0);
  });
});

describe('G08 feedback analysis persistence and concurrency', () => {
  it('persists measurement review and never calls the provider when an observation is absent', async () => {
    const store = await openStore();
    const seeded = seedPlan(store);
    let calls = 0;
    const spy = provider('spy', false, JSON.stringify(validOutput), () => calls++);
    const model = new ModelService(store, { providers: { spy } });
    model.configure({ provider: 'spy' });
    const feedback = new FeedbackService(store, store, model, {
      reviewId: () => 'measurement_no_observation',
      runId: () => 'run_no_observation',
      now: () => '2026-09-20T08:20:00.000Z'
    });

    const result = await feedback.analyze({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id,
      teachingEventId: seeded.teachingEvent.event_id, expectedRevision: 1,
      idempotencyKey: 'analysis-no-observation', dispatchConsent: true
    });

    expect(result.status).toBe('needs_measurement_review');
    expect(calls).toBe(0);
    expect(store.getFeedbackAnalysisHistory(seeded.plan.plan_id).measurementReviews).toHaveLength(1);
  });

  it('exposes only a strict feedback.analyze payload and includes analysis in feedback.history', async () => {
    const store = await openStore();
    const seeded = seedPlan(store);
    const model = new ModelService(store, { providers: { spy: provider('spy', false, JSON.stringify(validOutput)) } });
    model.configure({ provider: 'spy' });
    const feedbackService = new FeedbackService(store, store, model, {
      reviewId: () => 'measurement_ipc', runId: () => 'run_ipc',
      now: () => '2026-09-20T08:20:00.000Z'
    });
    const ipc = new IpcService({
      store, lessonStore: store, feedbackStore: store, feedbackService,
      appVersion: '0.1.0', appNameZh: 'test', platformSupported: true,
      httpListeners: 0, online: false, buildMode: 'production', sandboxEnabled: true,
      platformDevOverride: false, platformTargetSupported: true, platformIdentity: 'win11'
    });
    const envelope = {
      schema_version: IPC_SCHEMA_VERSION, request_id: 'request-analysis', operation: 'feedback.analyze' as const,
      workspace_id: 'workspace_default', expected_revision: 1, idempotency_key: 'analysis-ipc',
      payload: { planId: seeded.plan.plan_id, teachingEventId: seeded.teachingEvent.event_id, observationIds: [], dispatchConsent: false }
    };

    await expect(ipc.handle('feedback.analyze', { ...envelope, payload: { ...envelope.payload, rawObservationJson: '{}' } })).resolves.toMatchObject({
      ok: false, error: { code: 'INPUT_INVALID' }
    });
    await expect(ipc.handle('feedback.analyze', envelope)).resolves.toMatchObject({
      ok: true, data: { status: 'needs_measurement_review', streamRevision: 2 }
    });
    await expect(ipc.handle('feedback.history', {
      schema_version: IPC_SCHEMA_VERSION, request_id: 'request-history', operation: 'feedback.history',
      workspace_id: 'workspace_default', payload: { planId: seeded.plan.plan_id }
    })).resolves.toMatchObject({
      ok: true,
      data: { measurementReviews: [expect.objectContaining({ review_id: 'measurement_ipc' })], attributionRuns: [] }
    });
  });

  it('persists and replays one simulated attribution across reopen', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedPlan(store);
    seedObservation(store, seeded);
    let calls = 0;
    const serviceOutput = structuredClone(validOutput);
    serviceOutput.hypotheses[0].observation_ids = ['observation_service_1'];
    const valid = provider('valid', false, JSON.stringify(serviceOutput), () => calls++);
    const model = new ModelService(store, { providers: { valid } });
    model.configure({ provider: 'valid' });
    const feedback = new FeedbackService(store, store, model, {
      reviewId: () => 'measurement_success', runId: () => 'run_success',
      now: () => '2026-09-20T08:20:00.000Z'
    });
    const input = {
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id,
      teachingEventId: seeded.teachingEvent.event_id, expectedRevision: 2,
      idempotencyKey: 'analysis-success', dispatchConsent: true
    };

    const first = await feedback.analyze(input);
    expect(first).toMatchObject({ status: 'attributed', streamRevision: 4 });
    const replay = await feedback.analyze(input);
    expect(replay).toEqual(first);
    expect(calls).toBe(1);

    store.close();
    stores.delete(store);
    const reopened = await openStore(dir);
    const history = reopened.getFeedbackAnalysisHistory(seeded.plan.plan_id);
    expect(history.measurementReviews).toHaveLength(1);
    expect(history.attributionRuns).toEqual([
      expect.objectContaining({ runId: 'run_success', status: 'succeeded', result: expect.objectContaining({ content_origin: 'simulated' }) })
    ]);
    reopened.withTransaction((db) => db.prepare("UPDATE attribution_run SET result_json='{}' WHERE run_id='run_success'").run());
    expect(() => reopened.getFeedbackAnalysisHistory(seeded.plan.plan_id)).toThrow(StoreProtectedError);
  });

  it('marks a late model result stale when the feedback stream changes during the call', async () => {
    const store = await openStore();
    const seeded = seedPlan(store);
    seedObservation(store, seeded);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const staleOutput = structuredClone(validOutput);
    staleOutput.hypotheses[0].observation_ids = ['observation_service_1'];
    const slow = provider('slow', false, JSON.stringify(staleOutput));
    const baseComplete = slow.complete.bind(slow);
    slow.complete = async (req, ctx) => { await gate; return baseComplete(req, ctx); };
    const model = new ModelService(store, { providers: { slow } });
    model.configure({ provider: 'slow' });
    const feedback = new FeedbackService(store, store, model, {
      reviewId: () => 'measurement_stale', runId: () => 'run_stale',
      now: () => '2026-09-20T08:20:00.000Z'
    });

    const pending = feedback.analyze({
      workspaceId: 'workspace_default', planId: seeded.plan.plan_id,
      teachingEventId: seeded.teachingEvent.event_id, expectedRevision: 2,
      idempotencyKey: 'analysis-stale', dispatchConsent: true
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    seedObservation(store, seeded, 3, '2');
    release();

    await expect(pending).rejects.toBeInstanceOf(FeedbackVersionConflictError);
    expect(store.getFeedbackAnalysisHistory(seeded.plan.plan_id).attributionRuns[0]).toMatchObject({ status: 'stale' });
  });
});
