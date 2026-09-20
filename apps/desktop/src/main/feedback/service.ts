import { createHash, randomUUID } from 'node:crypto';
import type { LessonStore, FeedbackStore } from '../store';
import { StoreProtectedError } from '../store';
import { validateLessonPlan } from '../lesson/build';
import type { LessonPlan } from '../lesson/types';
import type { RunResult } from '../model/service';
import type {
  AttributionContentOrigin,
  AttributionModelOutput,
  AttributionResult,
  FeedbackAnalysisResult
} from './types';
import { FeedbackSourceMissingError, FeedbackVersionConflictError } from './types';
import { reviewMeasurement } from './measurement';
import {
  buildAttributionContext,
  validateAttributionResult,
  validateFeedbackAnalysisResult,
  validateTeachingAttributionModelOutput
} from './attribution';

export interface StructuredAttributionModel {
  runStructuredAttribution(input: {
    context: ReturnType<typeof buildAttributionContext>;
    dispatchConsent: boolean;
  }): Promise<RunResult>;
}

export interface FeedbackAnalyzeInput {
  workspaceId: string;
  planId: string;
  teachingEventId: string;
  expectedRevision: number;
  idempotencyKey: string;
  dispatchConsent: boolean;
  observationIds?: string[];
}

export interface FeedbackServiceIds {
  reviewId(): string;
  runId(): string;
  now(): string;
}

function parsePlan(contentJson: string): LessonPlan {
  let value: unknown;
  try { value = JSON.parse(contentJson) as unknown; } catch { throw new StoreProtectedError('invalid_feedback_lesson_plan:json'); }
  const validation = validateLessonPlan(value as LessonPlan);
  if (!validation.ok) throw new StoreProtectedError(`invalid_feedback_lesson_plan:${validation.errors.join('|')}`);
  return value as LessonPlan;
}

function parseReplay(value: unknown): FeedbackAnalysisResult {
  const errors = validateFeedbackAnalysisResult(value);
  if (errors.length) throw new StoreProtectedError(`invalid_feedback_analysis_replay:${errors.join('|')}`);
  return value as FeedbackAnalysisResult;
}

function modelPayload(result: RunResult): { output: AttributionModelOutput; origin: AttributionContentOrigin; jobId: string } | null {
  if (result.status !== 'succeeded' && result.status !== 'cached') return null;
  if (typeof result.result !== 'object' || result.result === null) return null;
  const wrapped = result.result as { parsed?: unknown; contentOrigin?: unknown };
  if (!['real', 'offline-injected', 'simulated'].includes(String(wrapped.contentOrigin))) return null;
  return { output: wrapped.parsed as AttributionModelOutput, origin: wrapped.contentOrigin as AttributionContentOrigin, jobId: result.jobId };
}

export class FeedbackService {
  private readonly ids: FeedbackServiceIds;
  private readonly inflight = new Map<string, Promise<FeedbackAnalysisResult>>();

  constructor(
    private readonly feedbackStore: FeedbackStore,
    private readonly lessonStore: LessonStore,
    private readonly modelService: StructuredAttributionModel,
    ids: Partial<FeedbackServiceIds> = {}
  ) {
    this.ids = {
      reviewId: ids.reviewId ?? (() => `measurement_${randomUUID()}`),
      runId: ids.runId ?? (() => `attribution_${randomUUID()}`),
      now: ids.now ?? (() => new Date().toISOString())
    };
  }

  analyze(input: FeedbackAnalyzeInput): Promise<FeedbackAnalysisResult> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.workspaceId, input.planId, input.teachingEventId, input.expectedRevision, input.dispatchConsent, input.observationIds ?? null]))
      .digest('hex');
    const existing = this.inflight.get(`${input.idempotencyKey}:${fingerprint}`);
    if (existing) return existing;
    const pending = this.analyzeInternal(input, fingerprint);
    this.inflight.set(`${input.idempotencyKey}:${fingerprint}`, pending);
    return pending.finally(() => this.inflight.delete(`${input.idempotencyKey}:${fingerprint}`));
  }

  private async analyzeInternal(input: FeedbackAnalyzeInput, fingerprint: string): Promise<FeedbackAnalysisResult> {
    if (!input.workspaceId.trim() || !input.planId.trim() || !input.teachingEventId.trim() || !input.idempotencyKey.trim()) throw new Error('invalid_feedback_analysis_input');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_feedback_revision');
    if (typeof input.dispatchConsent !== 'boolean') throw new Error('invalid_dispatch_consent');

    const feedbackHistory = this.feedbackStore.getFeedbackHistory(input.planId);
    const teachingEvent = feedbackHistory.teachingEvents.find((event) => event.event_id === input.teachingEventId);
    if (!teachingEvent || teachingEvent.workspace_id !== input.workspaceId) throw new FeedbackSourceMissingError();
    const revision = this.lessonStore.getLessonRevision(input.planId, teachingEvent.plan_revision_id);
    if (!revision) throw new FeedbackSourceMissingError();
    const plan = parsePlan(revision.contentJson);
    const allObservationRecords = this.feedbackStore
      .listObservations(input.planId)
      .filter((record) => record.teachingEventId === input.teachingEventId);
    const selectedIds = input.observationIds === undefined ? null : new Set(input.observationIds);
    if (selectedIds && (selectedIds.size !== input.observationIds?.length || [...selectedIds].some((id) => !allObservationRecords.some((record) => record.observation.observation_id === id)))) {
      throw new FeedbackSourceMissingError();
    }
    const observationRecords = selectedIds
      ? allObservationRecords.filter((record) => selectedIds.has(record.observation.observation_id))
      : allObservationRecords;
    const createdAt = this.ids.now();
    const measurement = reviewMeasurement(
      {
        plan,
        teachingEvent,
        observations: observationRecords,
        rubricMode: plan.rubrics.length > 0 ? 'versioned' : 'missing'
      },
      { reviewId: this.ids.reviewId, now: () => createdAt }
    );
    const context = measurement.disposition === 'ready_for_attribution'
      ? buildAttributionContext({
          plan,
          teachingEvent,
          observations: observationRecords.map((record) => record.observation),
          outcomes: observationRecords.map((record) => record.outcome),
          measurement
        })
      : null;
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ planRevisionId: plan.revision_id, teachingEventId: teachingEvent.event_id, measurement, context }))
      .digest('hex');
    const runId = this.ids.runId();
    const begun = this.feedbackStore.beginFeedbackAnalysis({
      workspaceId: input.workspaceId,
      planId: input.planId,
      teachingEventId: input.teachingEventId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      inputHash,
      runId,
      measurement,
      createdAt
    });
    if (begun.kind === 'replayed') return parseReplay(begun.result);
    if (begun.kind === 'in_progress') throw new FeedbackVersionConflictError();

    if (!context) {
      const result: FeedbackAnalysisResult = {
        status: 'needs_measurement_review',
        streamRevision: begun.streamRevision,
        measurement
      };
      this.finish(input, fingerprint, inputHash, null, begun.streamRevision, 'blocked', null, result, null, null, false);
      return result;
    }

    const model = await this.modelService.runStructuredAttribution({ context, dispatchConsent: input.dispatchConsent });
    const payload = modelPayload(model);
    if (payload) {
      const allowedIds = context.observations.map((observation) => observation.observationId);
      const outputErrors = validateTeachingAttributionModelOutput(payload.output, allowedIds);
      if (outputErrors.length === 0) {
        const attribution: AttributionResult = {
          attribution_run_id: runId,
          plan_revision_id: plan.revision_id,
          teaching_event_id: teachingEvent.event_id,
          measurement_review_id: measurement.review_id,
          model_job_id: payload.jobId,
          content_origin: payload.origin,
          hypotheses: payload.output.hypotheses,
          not_executed_checks: payload.origin === 'real'
            ? ['professional_teaching_review']
            : ['real_api_validation', 'professional_teaching_review'],
          is_effectiveness_proof: false
        };
        const attributionErrors = validateAttributionResult(attribution);
        if (attributionErrors.length === 0) {
          const result: FeedbackAnalysisResult = {
            status: 'attributed',
            streamRevision: begun.streamRevision + 1,
            measurement,
            attribution
          };
          const committed = this.finish(input, fingerprint, inputHash, runId, begun.streamRevision, 'succeeded', attribution, result, payload.jobId, payload.origin, true);
          if (!committed) throw new FeedbackVersionConflictError();
          return result;
        }
      }
    }

    if (model.status === 'uncertain') {
      const result: FeedbackAnalysisResult = {
        status: 'uncertain', streamRevision: begun.streamRevision, measurement,
        jobId: model.jobId, code: 'REQUEST_UNCERTAIN', note: model.note
      };
      const committed = this.finish(input, fingerprint, inputHash, runId, begun.streamRevision, 'uncertain', null, result, model.jobId, null, false);
      if (!committed) throw new FeedbackVersionConflictError();
      return result;
    }

    const blockedCode = model.status === 'blocked' && model.code === 'PRIVACY_BLOCKED'
      ? 'PRIVACY_BLOCKED'
      : model.status === 'blocked' && model.code === 'BUDGET_EXCEEDED'
        ? 'BUDGET_EXCEEDED'
        : 'MODEL_NOT_AVAILABLE';
    const note = 'note' in model ? model.note : '模型输出未通过严格归因合同，未生成可用改进依据。';
    const result: FeedbackAnalysisResult = {
      status: 'blocked', streamRevision: begun.streamRevision, measurement,
      code: blockedCode, note
    };
    const runStatus = model.status === 'blocked' ? 'blocked' : 'failed';
    const jobId = 'jobId' in model ? model.jobId : null;
    const committed = this.finish(input, fingerprint, inputHash, runId, begun.streamRevision, runStatus, null, result, jobId, null, false);
    if (!committed) throw new FeedbackVersionConflictError();
    return result;
  }

  private finish(
    input: FeedbackAnalyzeInput,
    fingerprint: string,
    inputHash: string,
    runId: string | null,
    expectedRevision: number,
    runStatus: 'succeeded' | 'blocked' | 'failed' | 'uncertain',
    attribution: AttributionResult | null,
    result: FeedbackAnalysisResult,
    modelJobId: string | null,
    contentOrigin: AttributionContentOrigin | null,
    advanceRevision: boolean
  ): boolean {
    return this.feedbackStore.finishFeedbackAnalysis({
      workspaceId: input.workspaceId,
      planId: input.planId,
      runId,
      expectedRevision,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      inputHash,
      runStatus,
      attribution,
      result,
      modelJobId,
      contentOrigin,
      advanceRevision,
      updatedAt: this.ids.now()
    }).committed;
  }
}
