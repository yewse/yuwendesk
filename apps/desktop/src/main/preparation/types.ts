export const PREPARATION_STATUSES = [
  'CONTEXT_DRAFT',
  'SOURCES_SELECTED',
  'BUILDING',
  'PLAN_REVIEW',
  'READY_TO_EXPORT',
  'EXPORTING',
  'EXPORTED'
] as const;

export type StablePreparationStatus =
  | 'CONTEXT_DRAFT'
  | 'SOURCES_SELECTED'
  | 'PLAN_REVIEW'
  | 'READY_TO_EXPORT'
  | 'EXPORTED';
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

export const PREPARATION_MODES = ['local_authored', 'model_assisted'] as const;
export type PreparationMode = (typeof PREPARATION_MODES)[number];

export const PREPARATION_CONTENT_ORIGINS = [
  'teacher_authored',
  'model_assisted_real',
  'model_assisted_simulated'
] as const;
export type PreparationContentOrigin = (typeof PREPARATION_CONTENT_ORIGINS)[number];

export const PREPARATION_ERROR_CODES = [
  'PREPARATION_INTERRUPTED',
  'PREPARATION_STALE',
  'PREPARATION_SOURCE_REQUIRED',
  'PREPARATION_SOURCE_CHANGED',
  'PREPARATION_MODEL_UNAVAILABLE',
  'PREPARATION_MODEL_INVALID',
  'PREPARATION_REVIEW_REQUIRED',
  'PREPARATION_EXPORT_FAILED'
] as const;
export type PreparationErrorCode = (typeof PREPARATION_ERROR_CODES)[number];

export const TEACHING_GRADES = ['grade7', 'grade8', 'grade9', 'other'] as const;
export type TeachingGrade = (typeof TEACHING_GRADES)[number];

export const PREPARATION_SOURCE_PURPOSES = ['textbook', 'curriculum', 'teacher_reference'] as const;
export type PreparationSourcePurpose = (typeof PREPARATION_SOURCE_PURPOSES)[number];

export interface TeachingContextInput {
  contextId?: string;
  classDisplayName: string;
  grade: TeachingGrade;
  textbookTitle: string;
  textbookEdition: string;
  unitTitle: string;
  lessonTitle: string;
  durationSec: number;
  notes: string;
}

export interface TeachingContext extends Omit<TeachingContextInput, 'contextId'> {
  contextId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PreparationSourceInput {
  sourceVersionId: string;
  charStart: number;
  charEnd: number;
  purpose: PreparationSourcePurpose;
  approvedForModel: boolean;
  textSha256: string;
}

export interface PreparationSourceSelection extends PreparationSourceInput {
  sessionId: string;
  ordinal: number;
}

export interface PreparationSessionPatch {
  focus?: string;
  coreTask?: string;
  answerScope?: string;
  planId?: string | null;
  revisionId?: string | null;
  reviewReportId?: string | null;
  bundleId?: string | null;
  modelJobId?: string | null;
  contentOrigin?: PreparationContentOrigin;
  lastErrorCode?: PreparationErrorCode | null;
}

export interface PreparationSession {
  sessionId: string;
  contextId: string;
  status: PreparationStatus;
  mode: PreparationMode;
  focus: string;
  coreTask: string;
  answerScope: string;
  planId: string | null;
  revisionId: string | null;
  reviewReportId: string | null;
  bundleId: string | null;
  modelJobId: string | null;
  contentOrigin: PreparationContentOrigin;
  lastErrorCode: PreparationErrorCode | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sources: PreparationSourceSelection[];
}

export interface PreparationStore {
  saveTeachingContext(
    input: TeachingContextInput,
    expectedRevision: number,
    idempotencyKey: string
  ): TeachingContext;
  getTeachingContext(contextId: string): TeachingContext | null;
  createPreparationSession(
    contextId: string,
    mode: PreparationMode,
    idempotencyKey: string
  ): PreparationSession;
  replacePreparationSources(
    sessionId: string,
    sources: PreparationSourceInput[],
    expectedRevision: number,
    idempotencyKey: string
  ): PreparationSession;
  transitionPreparationSession(
    sessionId: string,
    fromRevision: number,
    nextStatus: PreparationStatus,
    patch: PreparationSessionPatch,
    idempotencyKey: string
  ): PreparationSession;
  getPreparationSession(sessionId: string): PreparationSession | null;
  listPreparationSessions(): PreparationSession[];
  syncPreparationAfterPublishedChange?(input: {
    planId: string;
    baseRevisionId: string;
    revisionId: string;
    reviewReportId: string;
    bundleId: string;
  }): number;
}

export class PreparationVersionConflictError extends Error {
  constructor() {
    super('PREPARATION_VERSION_CONFLICT');
    this.name = 'PreparationVersionConflictError';
  }
}

export class PreparationKeyReuseError extends Error {
  constructor() {
    super('PREPARATION_IDEMPOTENCY_KEY_REUSE');
    this.name = 'PreparationKeyReuseError';
  }
}

export class PreparationTransitionError extends Error {
  constructor() {
    super('PREPARATION_TRANSITION_INVALID');
    this.name = 'PreparationTransitionError';
  }
}
