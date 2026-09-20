import type { LessonPlan } from '../lesson/types';
import type { ReturnModule } from '../review/types';

export type LessonChange =
  | { kind: 'change_duration'; durationSec: number }
  | { kind: 'increase_independent_time'; activityId: string; addedSec: number }
  | { kind: 'remove_link'; linkId: string }
  | { kind: 'edit_task'; taskId: string; prompt: string; acceptableVariants: string[] }
  | { kind: 'edit_rubric'; rubricId: string; acceptableVariants: string[] }
  | {
      kind: 'presentation_only';
      fontScale: number;
      paperSize: 'A4' | 'Letter';
      theme: 'light' | 'high_contrast';
    };

export interface ChangeProposal {
  change_id: string;
  plan_revision_id: string;
  observation_ids: string[];
  hypothesis: string;
  replacement_action: string;
  removed_or_reduced: string;
  predicted_evidence: string;
  disconfirming_evidence: string;
  next_normal_task: string;
  return_modules: ReturnModule[];
  status: 'proposed' | 'accepted' | 'rejected' | 'reverted' | 'supported_with_limits';
}

export interface ChangeIds {
  changeId: string;
  revisionId: string;
}

export interface PresentationSpec {
  fontScale: number;
  paperSize: 'A4' | 'Letter';
  theme: 'light' | 'high_contrast';
}

export interface ChangeDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
  label: string;
}

export interface ChangePreview {
  proposal: ChangeProposal;
  candidatePlan: LessonPlan;
  semanticRevisionChanged: boolean;
  invalidatedModules: ReturnModule[];
  presentationSpec: PresentationSpec;
  presentationSpecHash: string;
  diff: ChangeDiffEntry[];
}
