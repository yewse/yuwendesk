import type { LessonPlan } from '../../main/lesson/types';
import type { PreparationSession } from '../../main/preparation/types';
import type { ReviewReport } from '../../main/review/types';
import type { TeachingContext } from '../../main/preparation/types';

export type PreparationStep = 'context' | 'sources' | 'build' | 'review' | 'export' | 'complete';
export type PreparationPrimaryAction =
  | 'save_context'
  | 'select_sources'
  | 'build_plan'
  | 'run_review'
  | 'confirm_plan'
  | 'export_files'
  | 'open_presentation'
  | 'wait';

export interface PreparationArtifactView {
  role: string;
  format: string;
  filename: string;
  sha256: string;
  byteSize: number;
}

export interface PreparationViewInput {
  session: PreparationSession | null;
  plan: LessonPlan | null;
  report: ReviewReport | null;
  artifacts: PreparationArtifactView[];
}

export interface PreparationView {
  step: PreparationStep;
  primaryActions: [PreparationPrimaryAction];
  progressIndex: number;
  originLabel: string;
  unknowns: string[];
  canExport: boolean;
  localFallbackAvailable: boolean;
  sessionId: string | null;
  planId: string | null;
  revisionId: string | null;
  bundleId: string | null;
  title: string;
  reviewDisposition: ReviewReport['disposition'] | null;
  notExecutedChecks: string[];
  artifacts: PreparationArtifactView[];
}

export interface PreparationResumeDTO {
  session: PreparationSession;
  context: TeachingContext;
  plan: LessonPlan | null;
  report: ReviewReport | null;
  artifacts: PreparationArtifactView[];
}

export interface SourceCandidateView {
  documentId: string;
  versionId: string;
  title: string;
  version: number;
  classification: string;
  preview: string;
  previewTruncated: boolean;
}
