import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  LessonChangeApplyOutcome,
  LessonChangeApplyResult,
  LessonRevisionRecord,
  LessonStore,
  MaterialArtifactRecord,
  MaterialBundleRecord,
  ReviewReportRecord,
  StoredChangeProposal
} from '../store';
import { LessonChangeConflictError, LessonChangeKeyReuseError, StoreProtectedError } from '../store';
import { buildMaterialSet, FontMissingError, type MaterialSet } from '../materials/generate';
import {
  nodeBundleIo,
  promoteStagedBundle,
  stageMaterialSet,
  type BundleIo,
  type PublishedBundle
} from '../materials/publish';
import { reviewLessonPlan } from '../review/review';
import { reviewMaterialSet } from '../review/bundleReview';
import type { ReviewIssue } from '../review/types';
import type { LessonPlan } from '../lesson/types';
import { ChangeBlockedError, ChangeValidationError, previewLessonChange } from './change';
import type { ChangePreview, LessonChange } from './types';

export { LessonChangeConflictError, LessonChangeKeyReuseError } from '../store';

export interface LessonChangeIds {
  changeId(): string;
  revisionId(): string;
  bundleId(): string;
  reportId(): string;
  issueId(ruleId: string, objectIds: string[]): string;
  artifactId(): string;
  now(): string;
}

export interface LessonChangeServiceOptions {
  rootDir: string;
  io?: BundleIo;
  ids?: LessonChangeIds;
  buildSet?: typeof buildMaterialSet;
}

export interface LessonChangeRequest {
  planId: string;
  baseRevisionId: string;
  idempotencyKey: string;
  change: LessonChange;
}

export class LessonChangeSourceMissingError extends Error {
  constructor() {
    super('LESSON_CHANGE_SOURCE_MISSING');
    this.name = 'LessonChangeSourceMissingError';
  }
}

export class LessonChangeReviewError extends Error {
  constructor(
    public readonly disposition: 'needs_fix' | 'blocked',
    public readonly issues: ReviewIssue[] = []
  ) {
    const rules = [...new Set(issues.map((issue) => issue.rule_id))];
    super(`LESSON_CHANGE_REVIEW_${disposition.toUpperCase()}${rules.length ? `:${rules.join(',')}` : ''}`);
    this.name = 'LessonChangeReviewError';
  }
}

export class LessonChangeDiskError extends Error {
  constructor(public readonly originalError: unknown) {
    super('LESSON_CHANGE_BUNDLE_IO_FAILED');
    this.name = 'LessonChangeDiskError';
  }
}

function defaultIds(): LessonChangeIds {
  return {
    changeId: () => `change_${randomUUID()}`,
    revisionId: () => `rev_${randomUUID()}`,
    bundleId: () => `bundle_${randomUUID()}`,
    reportId: () => `report_${randomUUID()}`,
    issueId: () => `issue_${randomUUID()}`,
    artifactId: () => `artifact_${randomUUID()}`,
    now: () => new Date().toISOString()
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(request: LessonChangeRequest): string {
  return createHash('sha256')
    .update(
      canonical({
        planId: request.planId,
        baseRevisionId: request.baseRevisionId,
        change: request.change
      })
    )
    .digest('hex');
}

function parsePlan(record: LessonRevisionRecord): LessonPlan {
  try {
    return JSON.parse(record.contentJson) as LessonPlan;
  } catch {
    throw new LessonChangeSourceMissingError();
  }
}

function parseStoredResult(value: string): LessonChangeApplyResult {
  const parsed = JSON.parse(value) as Partial<LessonChangeApplyResult>;
  if (
    typeof parsed.changeId !== 'string' ||
    typeof parsed.planId !== 'string' ||
    typeof parsed.revisionId !== 'string' ||
    typeof parsed.bundleId !== 'string' ||
    typeof parsed.reviewReportId !== 'string' ||
    typeof parsed.semanticRevisionChanged !== 'boolean' ||
    typeof parsed.presentationSpecHash !== 'string' ||
    typeof parsed.reviewReport !== 'object' ||
    parsed.reviewReport === null ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error('invalid_stored_lesson_change_result');
  }
  return { ...(parsed as LessonChangeApplyResult), status: 'succeeded' };
}

function failureCode(error: unknown): string | null {
  if (error instanceof LessonChangeConflictError || error instanceof LessonChangeKeyReuseError) return null;
  if (error instanceof LessonChangeSourceMissingError || error instanceof LessonChangeReviewError) return null;
  if (error instanceof ChangeBlockedError || error instanceof ChangeValidationError || error instanceof FontMissingError) return null;
  if (error instanceof LessonChangeDiskError) return 'DISK_FULL';
  if (error instanceof StoreProtectedError) return 'DATABASE_LOCKED';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS') return 'DISK_FULL';
  return 'DATABASE_LOCKED';
}

function mergeBundleReview(
  report: ReturnType<typeof reviewLessonPlan>,
  issues: Awaited<ReturnType<typeof reviewMaterialSet>>
): ReturnType<typeof reviewLessonPlan> {
  const merged = {
    ...report,
    issues: [...report.issues, ...issues],
    executed_checks: [...new Set([...report.executed_checks, 'material_bundle_consistency'])]
  };
  if (merged.issues.some((item) => item.severity === 'blocking')) merged.disposition = 'blocked';
  else if (merged.issues.some((item) => item.severity === 'fix')) merged.disposition = 'needs_fix';
  return merged;
}

export class LessonChangeService {
  private readonly io: BundleIo;
  private readonly ids: LessonChangeIds;
  private readonly buildSet: (plan: LessonPlan, contentOrigin: string, presentationSpec?: Parameters<typeof buildMaterialSet>[2]) => Promise<MaterialSet>;

  constructor(
    private readonly store: LessonStore,
    private readonly options: LessonChangeServiceOptions
  ) {
    this.io = options.io ?? nodeBundleIo;
    this.ids = options.ids ?? defaultIds();
    this.buildSet = options.buildSet ?? buildMaterialSet;
  }

  preview(planId: string, baseRevisionId: string, change: LessonChange): ChangePreview {
    const record = this.store.getLessonRevision(planId, baseRevisionId);
    if (!record) throw new LessonChangeSourceMissingError();
    return previewLessonChange(parsePlan(record), change, {
      changeId: this.ids.changeId(),
      revisionId: this.ids.revisionId()
    });
  }

  history(planId: string): ReturnType<LessonStore['listLessonChangeHistory']> {
    return this.store.listLessonChangeHistory(planId);
  }

  async apply(request: LessonChangeRequest): Promise<LessonChangeApplyOutcome> {
    const requestFingerprint = fingerprint(request);
    const existing = this.store.findLessonChangeIdempotency(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) throw new LessonChangeKeyReuseError();
      if (existing.status === 'succeeded' && existing.resultJson) return parseStoredResult(existing.resultJson);
      if (existing.status === 'failed_final' || existing.failureCount >= 3) {
        return {
          status: 'failed_final',
          planId: request.planId,
          revisionId: request.baseRevisionId,
          failureCount: 3,
          errorCode: existing.errorCode ?? 'UNKNOWN'
        };
      }
    }

    const baseRecord = this.store.getLessonRevision(request.planId, request.baseRevisionId);
    if (!baseRecord) throw new LessonChangeSourceMissingError();
    const bundleId = this.ids.bundleId();
    const stagingDirectory = join(this.options.rootDir, '.staging', bundleId);
    let published: PublishedBundle | null = null;
    try {
      const preview = previewLessonChange(parsePlan(baseRecord), request.change, {
        changeId: this.ids.changeId(),
        revisionId: this.ids.revisionId()
      });
      let report = reviewLessonPlan(preview.candidatePlan, {
        ids: {
          reportId: this.ids.reportId,
          issueId: this.ids.issueId
        }
      });
      if (report.disposition !== 'ready_for_teacher') throw new LessonChangeReviewError(report.disposition, report.issues);
      const materialSet = await this.buildSet(
        preview.candidatePlan,
        baseRecord.contentOrigin,
        preview.presentationSpec
      );
      report = mergeBundleReview(report, await reviewMaterialSet(preview.candidatePlan, materialSet));
      if (report.disposition !== 'ready_for_teacher') throw new LessonChangeReviewError(report.disposition, report.issues);
      try {
        const staged = await stageMaterialSet(this.options.rootDir, bundleId, materialSet, this.io);
        published = await promoteStagedBundle(this.options.rootDir, staged, this.io);
      } catch (error) {
        throw new LessonChangeDiskError(error);
      }
      const acceptedAt = this.ids.now();
      const proposal = { ...preview.proposal, status: 'accepted' as const };
      const revision: LessonRevisionRecord | null = preview.semanticRevisionChanged
        ? {
            revisionId: preview.candidatePlan.revision_id,
            planId: preview.candidatePlan.plan_id,
            previousRevisionId: preview.candidatePlan.previous_revision_id,
            title: preview.candidatePlan.title,
            contentJson: JSON.stringify(preview.candidatePlan),
            contentOrigin: baseRecord.contentOrigin,
            valid: true,
            createdAt: acceptedAt
          }
        : null;
      const proposalRecord: StoredChangeProposal = {
        changeId: proposal.change_id,
        planId: request.planId,
        baseRevisionId: request.baseRevisionId,
        candidateRevisionId: preview.candidatePlan.revision_id,
        changeKind: request.change.kind,
        proposal,
        status: 'accepted',
        createdAt: acceptedAt,
        acceptedAt
      };
      const reportRecord: ReviewReportRecord = {
        reportId: report.report_id,
        planId: request.planId,
        revisionId: preview.candidatePlan.revision_id,
        report,
        createdAt: acceptedAt
      };
      const bundle: MaterialBundleRecord = {
        bundleId,
        planId: request.planId,
        revisionId: preview.candidatePlan.revision_id,
        presentationSpecHash: preview.presentationSpecHash,
        directory: published.directory,
        status: 'published',
        createdAt: acceptedAt
      };
      const artifacts: MaterialArtifactRecord[] = published.files.map((file) => ({
        id: this.ids.artifactId(),
        planId: request.planId,
        revisionId: preview.candidatePlan.revision_id,
        role: file.role,
        format: file.format,
        filename: file.filename,
        path: join(published!.directory, file.filename),
        sha256: file.sha256,
        byteSize: file.byteSize,
        contentOrigin: baseRecord.contentOrigin,
        createdAt: acceptedAt,
        bundleId
      }));
      const result: LessonChangeApplyResult = {
        status: 'succeeded',
        changeId: proposal.change_id,
        planId: request.planId,
        revisionId: preview.candidatePlan.revision_id,
        bundleId,
        reviewReportId: report.report_id,
        semanticRevisionChanged: preview.semanticRevisionChanged,
        presentationSpecHash: preview.presentationSpecHash,
        reviewReport: report,
        files: artifacts.map((artifact) => ({
          role: artifact.role,
          format: artifact.format,
          filename: artifact.filename,
          path: artifact.path,
          sha256: artifact.sha256,
          byteSize: artifact.byteSize
        }))
      };
      return this.store.commitLessonChange({
        idempotencyKey: request.idempotencyKey,
        fingerprint: requestFingerprint,
        baseRevisionId: request.baseRevisionId,
        revision,
        proposal: proposalRecord,
        report: reportRecord,
        bundle,
        artifacts,
        result
      });
    } catch (error) {
      await this.io.rm(published?.directory ?? stagingDirectory).catch(() => undefined);
      const code = failureCode(error);
      if (code) {
        try {
          this.store.recordLessonChangeFailure(request.idempotencyKey, requestFingerprint, code, this.ids.now());
        } catch {
          // 失败计数本身不能掩盖更接近根因的原始错误；调用方仍收到本次失败。
        }
      }
      throw error;
    }
  }
}
