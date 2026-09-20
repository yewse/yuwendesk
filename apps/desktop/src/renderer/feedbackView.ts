import type {
  CorrectionRecord,
  EffectEvidenceState,
  FeedbackAnalysisResult,
  ImplementationState,
  ObservationOutcomeValue,
  TeachingEvent
} from '../main/feedback/types';

export interface TeachingStatusInput {
  adopted: boolean;
  events: TeachingEvent[];
}

export interface TeachingStatusView {
  adoptionLabel: '已采用' | '尚未采用';
  teachingLabel: string;
  canRecordTeaching: boolean;
}

const IMPLEMENTATION_LABELS: Record<ImplementationState, string> = {
  completed: '完整实施',
  partial: '部分实施',
  stopped: '中止'
};

export function buildTeachingStatus(input: TeachingStatusInput): TeachingStatusView {
  const latest = input.events.at(-1);
  return {
    adoptionLabel: input.adopted ? '已采用' : '尚未采用',
    teachingLabel: latest ? `已记录授课（${IMPLEMENTATION_LABELS[latest.implementation_state]}）` : '尚未记录授课',
    canRecordTeaching: true
  };
}

export interface TeachingSubmissionShape {
  planId: string;
  planRevisionId: string;
  taughtAt: string;
  actualDurationSec: number;
  implementationState: ImplementationState;
  adjustmentSummary: string;
}

export function teachingSubmissionKey(input: TeachingSubmissionShape): string {
  const source = JSON.stringify([
    input.planId,
    input.planRevisionId,
    input.taughtAt,
    input.actualDurationSec,
    input.implementationState,
    input.adjustmentSummary.trim()
  ]);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `teach-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export const OBSERVATION_OUTCOME_OPTIONS: ReadonlyArray<{ value: ObservationOutcomeValue; label: string }> = [
  { value: 'met_expectation', label: '达到要求' },
  { value: 'needed_prompt', label: '仍需提示' },
  { value: 'clear_difficulty', label: '明显困难' },
  { value: 'insufficient_evidence', label: '证据不足' }
];

export interface ObservationPromptInput {
  teachingEvents: TeachingEvent[];
  observedTeachingEventIds: string[];
  dismissedTeachingEventIds: string[];
}

export interface ObservationPromptView {
  visible: boolean;
  teachingEventId: string | null;
  knowledgeLabel: '尚无反馈' | '已有反馈';
}

export function buildObservationPrompt(input: ObservationPromptInput): ObservationPromptView {
  const latest = input.teachingEvents.at(-1);
  if (!latest) return { visible: false, teachingEventId: null, knowledgeLabel: '尚无反馈' };
  const observed = input.observedTeachingEventIds.includes(latest.event_id);
  const dismissed = input.dismissedTeachingEventIds.includes(latest.event_id);
  return {
    visible: !observed && !dismissed,
    teachingEventId: latest.event_id,
    knowledgeLabel: observed ? '已有反馈' : '尚无反馈'
  };
}

export interface AnalysisView {
  statusLabel: string;
  originLabel: string | null;
  measurementChecks: Array<{ id: string; status: 'pass' | 'fail' | 'unknown'; evidence: string; returnModule: string }>;
  hypotheses: Array<{ kind: string; summary: string; limitations: string[]; disconfirmingEvidence: string[]; returnModules: string[] }>;
  notExecutedLabels: string[];
  proofDisclaimer: '这些是待验证假设，不是教学有效性证明。';
}

const ORIGIN_LABELS = {
  real: '真实 API（仍需专业复核）',
  'offline-injected': '离线注入（模拟内容）',
  simulated: '模拟（测试替身）'
} as const;

export function buildAnalysisView(result: FeedbackAnalysisResult): AnalysisView {
  const attribution = result.status === 'attributed' ? result.attribution : null;
  const notExecutedLabels = attribution?.not_executed_checks.map((check) =>
    check === 'real_api_validation' ? '真实 API 质量验证未执行' : '教学专业复核未执行'
  ) ?? [];
  return {
    statusLabel:
      result.status === 'needs_measurement_review'
        ? '需先复核测量条件'
        : result.status === 'attributed'
          ? '已生成待验证假设'
          : result.status === 'uncertain'
            ? '模型请求结果不确定'
            : '模型辅助归因被阻断',
    originLabel: attribution ? ORIGIN_LABELS[attribution.content_origin] : null,
    measurementChecks: result.measurement.checks.map((check) => ({
      id: check.check_id,
      status: check.status,
      evidence: check.evidence,
      returnModule: check.return_module
    })),
    hypotheses: attribution?.hypotheses.map((hypothesis) => ({
      kind: hypothesis.kind,
      summary: hypothesis.summary,
      limitations: [...hypothesis.limitations],
      disconfirmingEvidence: [...hypothesis.disconfirming_evidence],
      returnModules: [...hypothesis.return_modules]
    })) ?? [],
    notExecutedLabels,
    proofDisclaimer: '这些是待验证假设，不是教学有效性证明。'
  };
}

export interface CorrectionCardView {
  proposalId: string;
  status: CorrectionRecord['currentStatus'];
  stateRevision: number;
  hypothesis: string;
  replacementAction: string;
  removedOrReduced: string;
  predictedEvidence: string;
  disconfirmingEvidence: string;
  nextNormalTask: string;
  returnModules: string[];
  canAccept: boolean;
  canReject: boolean;
  canRevert: boolean;
}

export function buildCorrectionCard(record: CorrectionRecord): CorrectionCardView {
  return {
    proposalId: record.proposal.change_id,
    status: record.currentStatus,
    stateRevision: record.stateRevision,
    hypothesis: record.proposal.hypothesis,
    replacementAction: record.proposal.replacement_action,
    removedOrReduced: record.proposal.removed_or_reduced,
    predictedEvidence: record.proposal.predicted_evidence,
    disconfirmingEvidence: record.proposal.disconfirming_evidence,
    nextNormalTask: record.proposal.next_normal_task,
    returnModules: [...record.proposal.return_modules],
    canAccept: record.currentStatus === 'proposed',
    canReject: record.currentStatus === 'proposed',
    canRevert: record.currentStatus === 'accepted'
  };
}

const EFFECT_LABELS: Record<EffectEvidenceState, string> = {
  unknown: '尚无效果证据',
  initial_support: '有限条件下的初步证据（非效果证明）',
  repeated_support: '多个可比观察中的重复支持（仍非因果证明）',
  disconfirmed: '后续观察不支持该纠偏'
};

export function buildEvidenceTrackView(input: {
  preferenceState: Record<string, string | null>;
  effectState: EffectEvidenceState;
}): { preferenceLabel: string; effectLabel: string } {
  const entries = Object.entries(input.preferenceState).filter((entry): entry is [string, string] => entry[1] !== null);
  return {
    preferenceLabel: entries.length
      ? `表达偏好：${entries.map(([key, value]) => `${key}=${value}`).join('；')}`
      : '尚无表达偏好',
    effectLabel: EFFECT_LABELS[input.effectState]
  };
}
