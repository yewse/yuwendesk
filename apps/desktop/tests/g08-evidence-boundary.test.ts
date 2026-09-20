import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { createObservationRecord, observationCoverageSummary } from '../src/main/feedback/observation';
import { reviewMeasurement } from '../src/main/feedback/measurement';
import { applyPreferenceEvent, buildCorrectionProposal } from '../src/main/feedback/correction';
import { FeedbackService } from '../src/main/feedback/service';
import { ModelService } from '../src/main/model/service';
import { FeedbackSourceMissingError, type FeedbackAnalysisResult } from '../src/main/feedback/types';
import { buildAnalysisView, buildObservationPrompt, buildTeachingStatus } from '../src/renderer/feedbackView';

const stores = new Set<SqliteStore>();

async function store(): Promise<SqliteStore> {
  const result = new SqliteStore(mkdtempSync(join(tmpdir(), 'yuwendesk-g08-boundary-')));
  stores.add(result);
  await result.load();
  return result;
}

afterEach(() => {
  stores.forEach((item) => item.close());
  stores.clear();
});

describe('G08 cross-stage evidence boundaries', () => {
  it('keeps adoption, teaching, skipped feedback, observation, and effect as separate states', async () => {
    const db = await store();
    const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_boundaries' }));
    db.saveLessonRevision({
      revisionId: plan.revision_id, planId: plan.plan_id, previousRevisionId: null,
      title: plan.title, contentJson: JSON.stringify(plan), contentOrigin: 'authored', valid: true,
      createdAt: '2026-09-20T00:00:00.000Z'
    }, true);
    expect(buildTeachingStatus({ adopted: true, events: [] }).teachingLabel).toBe('尚未记录授课');
    expect(db.listObservations(plan.plan_id)).toEqual([]);

    const teaching = createTeachingEvent({
      workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
      implementationState: 'completed', adjustmentSummary: ''
    }, { eventId: () => 'teaching_boundaries', now: () => '2026-09-20T08:00:00.000Z' });
    db.recordTeaching({
      workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      expectedRevision: 0, idempotencyKey: 'teach-boundaries', fingerprint: 'teach-boundaries', event: teaching
    });
    expect(buildObservationPrompt({
      teachingEvents: [teaching], observedTeachingEventIds: [], dismissedTeachingEventIds: [teaching.event_id]
    })).toEqual({ visible: false, teachingEventId: teaching.event_id, knowledgeLabel: '尚无反馈' });
    expect(db.feedbackKnowledgeState(plan.plan_id)).toBe('unknown');
    expect(db.getFeedbackCorrectionHistory(plan.plan_id).effectState).toBe('unknown');
  });

  it('does not turn a typical six-case or same-item/full-model observation into class, transfer, retention, or independence claims', () => {
    const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_limits' }));
    const teaching = createTeachingEvent({
      workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
      implementationState: 'completed', adjustmentSummary: ''
    }, { eventId: () => 'teaching_limits', now: () => '2026-09-20T08:00:00.000Z' });
    const created = createObservationRecord({
      workspaceId: 'workspace_default', planRevisionId: plan.revision_id, teachingEventId: teaching.event_id,
      taskId: plan.tasks[0].task_id, sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
      outcome: 'met_expectation', supportLevel: 'full_model', materialRelation: 'same_item', delayDays: 0,
      sampleCount: 6, populationCount: 42, selection: 'typical_cases',
      coverageCaveat: '典型样本，不推算全班比例', summary: '测试摘要'
    }, { observationId: () => 'observation_limits' });
    const coverage = observationCoverageSummary(created.observation);
    expect(coverage).toContain('6/42');
    expect(coverage).not.toMatch(/%|百分之/);
    const measurement = reviewMeasurement({
      plan, teachingEvent: teaching, observations: [{ teachingEventId: teaching.event_id, ...created }], rubricMode: 'versioned'
    }, { reviewId: () => 'measurement_limits', now: () => '2026-09-20T08:20:00.000Z' });
    expect(measurement.inference_limits).toEqual(expect.arrayContaining([
      'class_inference_not_allowed', 'transfer_not_measured', 'delayed_retention_not_measured', 'independent_performance_not_measured'
    ]));
  });

  it('allows a provider hypothesis to create only a proposal, and blocks a deleted observation from a new active result', async () => {
    const db = await store();
    const plan = buildLessonPlan(demoLessonSpec({ plan_id: 'plan_provider_boundary' }));
    db.saveLessonRevision({
      revisionId: plan.revision_id, planId: plan.plan_id, previousRevisionId: null,
      title: plan.title, contentJson: JSON.stringify(plan), contentOrigin: 'authored', valid: true,
      createdAt: '2026-09-20T00:00:00.000Z'
    }, true);
    const teaching = createTeachingEvent({
      workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z', actualDurationSec: 2400,
      implementationState: 'completed', adjustmentSummary: ''
    }, { eventId: () => 'teaching_provider', now: () => '2026-09-20T08:00:00.000Z' });
    db.recordTeaching({ workspaceId: 'workspace_default', planId: plan.plan_id, planRevisionId: plan.revision_id,
      expectedRevision: 0, idempotencyKey: 'teach-provider', fingerprint: 'teach-provider', event: teaching });
    const created = createObservationRecord({
      workspaceId: 'workspace_default', planRevisionId: plan.revision_id, teachingEventId: teaching.event_id,
      taskId: plan.tasks[0].task_id, sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
      outcome: 'needed_prompt', supportLevel: 'partial_prompt', materialRelation: 'similar_new', delayDays: 2,
      sampleCount: 6, populationCount: 42, selection: 'typical_cases', coverageCaveat: '典型样本，不推算全班比例', summary: '测试摘要'
    }, { observationId: () => 'observation_provider' });
    db.addObservation({ workspaceId: 'workspace_default', planId: plan.plan_id, teachingEventId: teaching.event_id,
      expectedRevision: 1, idempotencyKey: 'obs-provider', fingerprint: 'obs-provider', ...created,
      createdAt: '2026-09-20T08:11:00.000Z' });
    const model = new ModelService(db);
    model.configure({ provider: 'test-double' });
    const feedback = new FeedbackService(db, db, model, {
      reviewId: () => 'measurement_provider', runId: () => 'run_provider', proposalId: () => 'correction_provider',
      eventId: () => 'event_provider', now: () => '2026-09-20T08:20:00.000Z'
    });
    const before = db.getLessonRevision(plan.plan_id)?.revisionId;
    const analyzed = await feedback.analyze({ workspaceId: 'workspace_default', planId: plan.plan_id,
      teachingEventId: teaching.event_id, observationIds: [created.observation.observation_id], dispatchConsent: false,
      expectedRevision: 2, idempotencyKey: 'analyze-provider' });
    expect(analyzed.status).toBe('attributed');
    expect(db.getLessonRevision(plan.plan_id)?.revisionId).toBe(before);
    expect(db.listMaterialArtifacts(plan.plan_id)).toEqual([]);
    expect(db.getFeedbackCorrectionHistory(plan.plan_id).corrections).toHaveLength(1);

    db.deleteObservation({ workspaceId: 'workspace_default', planId: plan.plan_id,
      observationId: created.observation.observation_id, expectedRevision: 4, idempotencyKey: 'delete-provider',
      fingerprint: 'delete-provider', confirmationToken: 'confirmed', deletedAt: '2026-09-20T08:30:00.000Z',
      backupScopesNotCovered: ['external_or_offline_backups'] });
    expect(db.getFeedbackCorrectionHistory(plan.plan_id).observationTombstones).toEqual([{
      observationId: created.observation.observation_id,
      planId: plan.plan_id,
      deletedAt: '2026-09-20T08:30:00.000Z',
      backupScopesNotCovered: ['external_or_offline_backups']
    }]);
    expect(() => feedback.decideCorrection({
      workspaceId: 'workspace_default', planId: plan.plan_id, proposalId: 'correction_provider',
      decision: 'accept', reason: '不应接受已删除证据支撑的提案', expectedRevision: 5,
      expectedProposalRevision: 0, idempotencyKey: 'accept-deleted'
    })).toThrow(FeedbackSourceMissingError);
    await expect(feedback.analyze({ workspaceId: 'workspace_default', planId: plan.plan_id,
      teachingEventId: teaching.event_id, observationIds: [created.observation.observation_id], dispatchConsent: false,
      expectedRevision: 5, idempotencyKey: 'reanalyze-deleted' })).rejects.toBeInstanceOf(FeedbackSourceMissingError);
  });

  it('keeps repeated presentation preference separate and rejects success-only added homework', () => {
    const first = applyPreferenceEvent({ preferenceState: {}, effectState: 'unknown', preferenceEvents: [], effectEvents: [] }, {
      event_id: 'preference_1', proposal_id: 'correction_1', action: 'set', preference_key: 'presentation_density',
      value: 'reduced', reason: '减少版面拥挤', created_at: '2026-09-20T09:00:00.000Z'
    });
    const second = applyPreferenceEvent(first, {
      event_id: 'preference_2', proposal_id: 'correction_1', action: 'set', preference_key: 'presentation_density',
      value: 'minimal', reason: '再次减少投影内容', created_at: '2026-09-20T09:01:00.000Z'
    });
    expect(second.effectState).toBe('unknown');
    expect(() => buildCorrectionProposal({
      planRevisionId: 'revision_1', observationIds: ['observation_1'],
      hypothesis: { kind: 'time_constraint', summary: '待验证：练习时间可能不足。', observation_ids: ['observation_1'],
        evidence_basis: ['一次观察'], limitations: ['不能外推'], disconfirming_evidence: ['正常任务中无改善'], return_modules: ['M11'] },
      replacementAction: '再加十道题作为课后作业', removedOrReduced: '保持原有安排不变',
      predictedEvidence: '下一次全部成功', disconfirmingEvidence: '没有成功则撤回', nextNormalTask: '下一次正常任务',
      returnModules: ['M11', 'M12']
    }, { proposalId: () => 'correction_cost' })).toThrow(/added_load_without_reduction/);
  });

  it('retains origin labels for renderer-visible simulated/offline results and preserves frozen acceptance JSON', () => {
    const base: FeedbackAnalysisResult = {
      status: 'attributed', streamRevision: 4,
      measurement: {
        review_id: 'measurement_1', workspace_id: 'workspace_default', plan_id: 'plan_1', plan_revision_id: 'revision_1',
        teaching_event_id: 'teaching_1', checks: [
          ['target_alignment', 'M07'], ['scoring_available', 'M07'], ['task_comparability', 'M11'],
          ['sample_coverage', 'M11'], ['implementation_conditions', 'M11']
        ].map(([check_id, return_module]) => ({ check_id, status: 'pass', evidence: 'fixture', object_ids: ['fixture'], return_module })) as FeedbackAnalysisResult['measurement']['checks'],
        disposition: 'ready_for_attribution', inference_limits: [], is_effectiveness_proof: false,
        created_at: '2026-09-20T08:00:00.000Z'
      },
      attribution: {
        attribution_run_id: 'run_1', plan_revision_id: 'revision_1', teaching_event_id: 'teaching_1',
        measurement_review_id: 'measurement_1', model_job_id: 'job_1', content_origin: 'simulated',
        hypotheses: [], not_executed_checks: ['real_api_validation', 'professional_teaching_review'], is_effectiveness_proof: false
      }
    };
    expect(buildAnalysisView(base).originLabel).toBe('模拟（测试替身）');
    expect(buildAnalysisView({ ...base, attribution: { ...base.attribution, content_origin: 'offline-injected' } }).originLabel)
      .toBe('离线注入（模拟内容）');

    const casesPath = fileURLToPath(new URL('../../../acceptance/cases.json', import.meta.url));
    const addendumPath = fileURLToPath(new URL('../../../acceptance/addenda/classroom-delivery.cases.json', import.meta.url));
    const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(sha256(casesPath)).toBe('cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5');
    expect(sha256(addendumPath)).toBe('f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06');
  });
});
