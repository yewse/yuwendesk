import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  LessonChangeApplyResult,
  LessonRevisionRecord,
  LessonStore,
  MaterialArtifactRecord,
  MaterialBundleRecord,
  ReviewReportRecord,
  StoredChangeProposal
} from '../store';
import { LessonChangeConflictError, LessonChangeKeyReuseError } from '../store';
import { buildMaterialSet } from '../materials/generate';
import {
  nodeBundleIo,
  promoteStagedBundle,
  stageMaterialSet,
  type BundleIo,
  type PublishedBundle
} from '../materials/publish';
import { reviewLessonPlan } from '../review/review';
import type { LessonPlan } from '../lesson/types';
import { previewLessonChange } from './change';
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
  constructor(public readonly disposition: 'needs_fix' | 'blocked') {
    super(`LESSON_CHANGE_REVIEW_${disposition.toUpperCase()}`);
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
    !Array.isArray(parsed.files)
  ) {
    throw new Error('invalid_stored_lesson_change_result');
  }
  return parsed as LessonChangeApplyResult;
}

export class LessonChangeService {
  private readonly io: BundleIo;
  private readonly ids: LessonChangeIds;

  constructor(
    private readonly store: LessonStore,
    private readonly options: LessonChangeServiceOptions
  ) {
    this.io = options.io ?? nodeBundleIo;
    this.ids = options.ids ?? defaultIds();
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

  async apply(request: LessonChangeRequest): Promise<LessonChangeApplyResult> {
    const requestFingerprint = fingerprint(request);
    const existing = this.store.findLessonChangeIdempotency(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) throw new LessonChangeKeyReuseError();
      if (existing.status === 'succeeded' && existing.resultJson) return parseStoredResult(existing.resultJson);
      throw new LessonChangeConflictError();
    }

    const baseRecord = this.store.getLessonRevision(request.planId, request.baseRevisionId);
    if (!baseRecord) throw new LessonChangeSourceMissingError();
    const preview = previewLessonChange(parsePlan(baseRecord), request.change, {
      changeId: this.ids.changeId(),
      revisionId: this.ids.revisionId()
    });
    const report = reviewLessonPlan(preview.candidatePlan, {
      ids: {
        reportId: this.ids.reportId,
        issueId: this.ids.issueId
      }
    });
    if (report.disposition !== 'ready_for_teacher') throw new LessonChangeReviewError(report.disposition);

    const bundleId = this.ids.bundleId();
    const stagingDirectory = join(this.options.rootDir, '.staging', bundleId);
    let published: PublishedBundle | null = null;
    const materialSet = await buildMaterialSet(
      preview.candidatePlan,
      baseRecord.contentOrigin,
      preview.presentationSpec
    );
    try {
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
        changeId: proposal.change_id,
        planId: request.planId,
        revisionId: preview.candidatePlan.revision_id,
        bundleId,
        reviewReportId: report.report_id,
        semanticRevisionChanged: preview.semanticRevisionChanged,
        presentationSpecHash: preview.presentationSpecHash,
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
      throw error;
    }
  }
}
