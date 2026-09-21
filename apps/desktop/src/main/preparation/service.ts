import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildLessonPlan, validateLessonPlan } from '../lesson/build';
import type { LessonPlan } from '../lesson/types';
import { reviewLessonPlan } from '../review/review';
import type { ReviewReport } from '../review/types';
import type { LessonStore, SourceStore } from '../store';
import type { MaterialArtifactRecord, MaterialBundleRecord, ReviewReportRecord } from '../store';
import { buildMaterialSet } from '../materials/generate';
import { nodeBundleIo, promoteStagedBundle, stageMaterialSet, type PublishedBundle } from '../materials/publish';
import { reviewMaterialSet } from '../review/bundleReview';
import { buildLocalLessonPlanSpec, type VerifiedPreparationSource } from './localBuilder';
import { parseModelLessonPlanSpec, type AllowedModelAnchor } from './modelSpec';
import type {
  PreparationErrorCode,
  PreparationSession,
  PreparationStore
} from './types';

export type PreparationModelRunResult =
  | { status: 'succeeded' | 'cached'; jobId: string; result: unknown }
  | { status: 'failed' | 'blocked' | 'uncertain'; jobId?: string; code?: string }
  | { status: 'cancelled'; jobId: string };

export interface PreparationModelRunner {
  run(input: {
    task: 'lesson_plan_spec';
    instructionExtra: string;
    fragments: Array<{ versionId: string; charStart: number; charEnd: number; approved: true }>;
  }): Promise<PreparationModelRunResult>;
}

export interface PreparationBuildInput {
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  focus: string;
  coreTask: string;
  answerScope: string;
}

export class PreparationServiceError extends Error {
  constructor(public readonly code: PreparationErrorCode) {
    super(code);
    this.name = 'PreparationServiceError';
  }
}

type Store = PreparationStore & SourceStore & LessonStore;

export interface PreparationServiceOptions {
  store: Store;
  model?: PreparationModelRunner;
  exportPlan?: (planId: string) => Promise<{ bundleId: string }>;
  now?: () => string;
}

export async function exportPreparedMaterials(
  store: LessonStore,
  root: string,
  planId: string
): Promise<{ bundleId: string }> {
  const revision = store.getLessonRevision(planId);
  if (!revision) throw new PreparationServiceError('PREPARATION_STALE');
  const bundleId = `bundle_${randomUUID()}`;
  let published: PublishedBundle | null = null;
  const stagingDirectory = join(root, '.staging', bundleId);
  try {
    const plan = JSON.parse(revision.contentJson) as LessonPlan;
    const set = await buildMaterialSet(plan, revision.contentOrigin);
    const baseReport = reviewLessonPlan(plan, {
      ids: {
        reportId: () => `report_${randomUUID()}`,
        issueId: () => `issue_${randomUUID()}`
      }
    });
    const bundleIssues = await reviewMaterialSet(plan, set);
    const report: ReviewReport = {
      ...baseReport,
      issues: [...baseReport.issues, ...bundleIssues],
      executed_checks: [...new Set([...baseReport.executed_checks, 'material_bundle_consistency'])]
    };
    if (report.issues.some((issue) => issue.severity === 'blocking')) report.disposition = 'blocked';
    else if (report.issues.some((issue) => issue.severity === 'fix')) report.disposition = 'needs_fix';
    if (report.disposition !== 'ready_for_teacher') throw new PreparationServiceError('PREPARATION_REVIEW_REQUIRED');

    const staged = await stageMaterialSet(root, bundleId, set, nodeBundleIo);
    published = await promoteStagedBundle(root, staged, nodeBundleIo);
    const now = new Date().toISOString();
    const artifacts: MaterialArtifactRecord[] = published.files.map((file) => ({
      id: randomUUID(),
      planId: set.planId,
      revisionId: set.revisionId,
      role: file.role,
      format: file.format,
      filename: file.filename,
      path: join(published!.directory, file.filename),
      sha256: file.sha256,
      byteSize: file.byteSize,
      contentOrigin: set.contentOrigin,
      createdAt: now,
      bundleId
    }));
    const bundle: MaterialBundleRecord = {
      bundleId,
      planId: set.planId,
      revisionId: set.revisionId,
      presentationSpecHash: createHash('sha256')
        .update(JSON.stringify({ fontScale: 1, paperSize: 'A4', theme: 'light' }))
        .digest('hex'),
      directory: published.directory,
      status: 'published',
      createdAt: now
    };
    const review: ReviewReportRecord = {
      reportId: report.report_id,
      planId: set.planId,
      revisionId: set.revisionId,
      report,
      createdAt: now
    };
    store.commitMaterialBundle({ bundle, artifacts, review });
    return { bundleId };
  } catch (error) {
    await nodeBundleIo.rm(published?.directory ?? stagingDirectory).catch(() => undefined);
    throw error;
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function modelPayload(value: unknown): { parsed: unknown; contentOrigin: unknown; isTestDouble: unknown } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'parsed')) return null;
  return { parsed: record.parsed, contentOrigin: record.contentOrigin, isTestDouble: record.isTestDouble };
}

export class PreparationService {
  private readonly now: () => string;

  constructor(private readonly options: PreparationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private verifiedSources(session: PreparationSession): VerifiedPreparationSource[] {
    return session.sources.map((selected) => {
      const meta = this.options.store.getVersionMeta(selected.sourceVersionId);
      const exact = this.options.store.readExactRange(selected.sourceVersionId, selected.charStart, selected.charEnd);
      if (!meta || !meta.isCurrent || meta.status !== 'active' || !exact || selected.charEnd > exact.fullLength) {
        throw new PreparationServiceError('PREPARATION_SOURCE_CHANGED');
      }
      if (createHash('sha256').update(exact.text).digest('hex') !== selected.textSha256) {
        throw new PreparationServiceError('PREPARATION_SOURCE_CHANGED');
      }
      return {
        sourceVersionId: selected.sourceVersionId,
        quote: exact.text,
        sourceClass: meta.classification,
        locator: { char_start: selected.charStart, char_end: selected.charEnd },
        purpose: selected.purpose
      };
    });
  }

  private currentAfterReplay(started: PreparationSession): PreparationSession | null {
    const current = this.options.store.getPreparationSession(started.sessionId);
    if (!current || current.revision <= started.revision || !current.planId || !current.revisionId) return null;
    return ['PLAN_REVIEW', 'READY_TO_EXPORT', 'EXPORTING', 'EXPORTED'].includes(current.status) ? current : null;
  }

  private rollbackBuild(started: PreparationSession, code: PreparationErrorCode, key: string): void {
    const current = this.options.store.getPreparationSession(started.sessionId);
    if (!current || current.status !== 'BUILDING') return;
    this.options.store.transitionPreparationSession(
      current.sessionId,
      current.revision,
      'SOURCES_SELECTED',
      { lastErrorCode: code },
      `${key}:rollback`
    );
  }

  async build(input: PreparationBuildInput): Promise<PreparationSession> {
    const started = this.options.store.transitionPreparationSession(
      input.sessionId,
      input.expectedRevision,
      'BUILDING',
      {
        focus: input.focus,
        coreTask: input.coreTask,
        answerScope: input.answerScope,
        lastErrorCode: null
      },
      `${input.idempotencyKey}:start`
    );
    const replay = this.currentAfterReplay(started);
    if (replay) return replay;

    try {
      const context = this.options.store.getTeachingContext(started.contextId);
      if (!context) throw new PreparationServiceError('PREPARATION_STALE');
      const sources = this.verifiedSources(started);
      if (sources.length === 0) throw new PreparationServiceError('PREPARATION_SOURCE_REQUIRED');

      let spec;
      let contentOrigin: PreparationSession['contentOrigin'] = 'teacher_authored';
      let modelJobId: string | null = null;
      if (started.mode === 'local_authored') {
        spec = buildLocalLessonPlanSpec({ context, session: started, sources });
      } else {
        if (!this.options.model) throw new PreparationServiceError('PREPARATION_MODEL_UNAVAILABLE');
        const approved = started.sources
          .map((selected, index) => ({ selected, source: sources[index] }))
          .filter((item) => item.selected.approvedForModel);
        if (approved.length === 0) throw new PreparationServiceError('PREPARATION_MODEL_UNAVAILABLE');
        const result = await this.options.model.run({
          task: 'lesson_plan_spec',
          instructionExtra: JSON.stringify({
            classDisplayName: context.classDisplayName,
            grade: context.grade,
            textbookTitle: context.textbookTitle,
            textbookEdition: context.textbookEdition,
            unitTitle: context.unitTitle,
            lessonTitle: context.lessonTitle,
            durationSec: context.durationSec,
            focus: started.focus,
            coreTask: started.coreTask,
            answerScope: started.answerScope
          }),
          fragments: approved.map(({ selected }) => ({
            versionId: selected.sourceVersionId,
            charStart: selected.charStart,
            charEnd: selected.charEnd,
            approved: true as const
          }))
        });
        if (result.status !== 'succeeded' && result.status !== 'cached') {
          throw new PreparationServiceError(
            'code' in result && result.code === 'EXPORT_INVALID'
              ? 'PREPARATION_MODEL_INVALID'
              : 'PREPARATION_MODEL_UNAVAILABLE'
          );
        }
        const payload = modelPayload(result.result);
        if (!payload) throw new PreparationServiceError('PREPARATION_MODEL_INVALID');
        const allowed: AllowedModelAnchor[] = approved.map(({ source }, index) => ({
          id: `source-${index + 1}`,
          anchor: {
            source_version_id: source.sourceVersionId,
            locator: { ...source.locator },
            quote: source.quote,
            source_class: source.sourceClass,
            verification: 'exact_checked'
          }
        }));
        try {
          spec = parseModelLessonPlanSpec(payload.parsed, allowed, {
            taskContextId: context.contextId,
            declaredDurationSec: context.durationSec
          });
        } catch {
          throw new PreparationServiceError('PREPARATION_MODEL_INVALID');
        }
        modelJobId = result.jobId;
        contentOrigin = payload.contentOrigin === 'real' && payload.isTestDouble === false
          ? 'model_assisted_real'
          : 'model_assisted_simulated';
      }

      const plan = buildLessonPlan(spec);
      const validation = validateLessonPlan(plan);
      if (!validation.ok) throw new PreparationServiceError('PREPARATION_MODEL_INVALID');
      this.options.store.saveLessonRevision({
        revisionId: plan.revision_id,
        planId: plan.plan_id,
        previousRevisionId: plan.previous_revision_id,
        title: plan.title,
        contentJson: JSON.stringify(plan),
        contentOrigin,
        valid: true,
        createdAt: this.now()
      }, true);
      return this.options.store.transitionPreparationSession(
        started.sessionId,
        started.revision,
        'PLAN_REVIEW',
        {
          planId: plan.plan_id,
          revisionId: plan.revision_id,
          reviewReportId: null,
          bundleId: null,
          modelJobId,
          contentOrigin,
          lastErrorCode: null
        },
        `${input.idempotencyKey}:complete`
      );
    } catch (error) {
      const code = error instanceof PreparationServiceError ? error.code : 'PREPARATION_MODEL_INVALID';
      this.rollbackBuild(started, code, input.idempotencyKey);
      if (error instanceof PreparationServiceError) throw error;
      throw new PreparationServiceError(code);
    }
  }

  review(sessionId: string, expectedRevision: number, idempotencyKey: string): { session: PreparationSession; report: ReviewReport } {
    const session = this.options.store.getPreparationSession(sessionId);
    if (!session || session.revision !== expectedRevision || session.status !== 'PLAN_REVIEW' || !session.planId || !session.revisionId) {
      throw new PreparationServiceError('PREPARATION_STALE');
    }
    const existing = this.options.store.getLatestReviewReport(session.planId, session.revisionId);
    const reportId = stableId('report', `${sessionId}:${expectedRevision}:${idempotencyKey}`);
    if (existing?.reportId === reportId) return { session, report: existing.report };
    const revision = this.options.store.getLessonRevision(session.planId, session.revisionId);
    if (!revision || !revision.valid) throw new PreparationServiceError('PREPARATION_STALE');
    let plan: LessonPlan;
    try { plan = JSON.parse(revision.contentJson) as LessonPlan; } catch { throw new PreparationServiceError('PREPARATION_STALE'); }
    const report = reviewLessonPlan(plan, {
      ids: {
        reportId: () => reportId,
        issueId: (ruleId, objectIds) => stableId('issue', `${reportId}:${ruleId}:${objectIds.join(',')}`)
      }
    });
    this.options.store.saveReviewReport({
      reportId,
      planId: session.planId,
      revisionId: session.revisionId,
      report,
      createdAt: this.now()
    });
    return { session, report };
  }

  confirm(sessionId: string, expectedRevision: number, idempotencyKey: string): PreparationSession {
    const session = this.options.store.getPreparationSession(sessionId);
    if (!session || session.revision !== expectedRevision || session.status !== 'PLAN_REVIEW' || session.lastErrorCode === 'PREPARATION_STALE' ||
        !session.planId || !session.revisionId) {
      throw new PreparationServiceError('PREPARATION_STALE');
    }
    const report = this.options.store.getLatestReviewReport(session.planId, session.revisionId);
    if (!report || report.report.plan_revision_id !== session.revisionId || report.report.disposition !== 'ready_for_teacher') {
      throw new PreparationServiceError('PREPARATION_REVIEW_REQUIRED');
    }
    return this.options.store.transitionPreparationSession(
      sessionId,
      expectedRevision,
      'READY_TO_EXPORT',
      { reviewReportId: report.reportId, lastErrorCode: null },
      idempotencyKey
    );
  }

  async export(sessionId: string, expectedRevision: number, idempotencyKey: string): Promise<PreparationSession> {
    const started = this.options.store.transitionPreparationSession(
      sessionId,
      expectedRevision,
      'EXPORTING',
      { lastErrorCode: null },
      `${idempotencyKey}:start`
    );
    const current = this.options.store.getPreparationSession(sessionId);
    if (current && current.revision > started.revision && current.status === 'EXPORTED') return current;
    try {
      if (!started.planId || !this.options.exportPlan) throw new PreparationServiceError('PREPARATION_EXPORT_FAILED');
      const exported = await this.options.exportPlan(started.planId);
      return this.options.store.transitionPreparationSession(
        sessionId,
        started.revision,
        'EXPORTED',
        { bundleId: exported.bundleId, lastErrorCode: null },
        `${idempotencyKey}:complete`
      );
    } catch (error) {
      const active = this.options.store.getPreparationSession(sessionId);
      if (active?.status === 'EXPORTING') {
        this.options.store.transitionPreparationSession(
          sessionId,
          active.revision,
          'READY_TO_EXPORT',
          { lastErrorCode: 'PREPARATION_EXPORT_FAILED' },
          `${idempotencyKey}:rollback`
        );
      }
      if (error instanceof PreparationServiceError) throw error;
      throw new PreparationServiceError('PREPARATION_EXPORT_FAILED');
    }
  }
}
