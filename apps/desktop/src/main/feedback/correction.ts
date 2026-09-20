import type {
  AttributionHypothesis,
  CorrectionDecisionEvent,
  CorrectionRecord,
  CorrectionProposal,
  CorrectionStatus,
  EffectEvidenceEvent,
  EffectEvidenceState,
  EvidenceTrackState,
  FeedbackReturnModule,
  ObservationRecord,
  PreferenceEvent
} from './types';
import type { LessonChange } from '../change/types';
import type { LessonPlan } from '../lesson/types';
import { extraKeys, isBoundedString, isIsoDateTime, isRecord } from './validation';

const RETURN_MODULES: readonly FeedbackReturnModule[] = [
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06',
  'M07', 'M08', 'M09', 'M10', 'M11', 'M12'
];
const PROPOSAL_KEYS = [
  'change_id', 'plan_revision_id', 'observation_ids', 'hypothesis', 'replacement_action',
  'removed_or_reduced', 'predicted_evidence', 'disconfirming_evidence', 'next_normal_task',
  'return_modules', 'status'
] as const;
const PREFERENCE_KEYS = ['event_id', 'proposal_id', 'action', 'preference_key', 'value', 'reason', 'created_at'] as const;
const EFFECT_KEYS = ['event_id', 'proposal_id', 'state', 'observation_ids', 'conditions', 'is_effectiveness_proof', 'created_at'] as const;
const DECISION_KEYS = ['event_id', 'proposal_id', 'action', 'reason', 'state_revision', 'created_at'] as const;
const PROHIBITED_CLAIMS = /(?:全班.{0,8}(?:排名|掌握率|错误率)|教学有效(?:性)?(?:已)?(?:证明|确定)|效果证明|永久标签|必然导致|因果证明)/u;
const ADDED_LOAD = /(?:再加|增加|新增|额外).{0,12}(?:题|作业|练习|任务|时长)|(?:十|\d+)道题/u;
const REDUCTION = /(?:减少|替换|删除|删去|缩短|取消|压缩|不增加|移除)/u;

export interface BuildCorrectionInput {
  planRevisionId: string;
  observationIds: string[];
  hypothesis: AttributionHypothesis;
  replacementAction: string;
  removedOrReduced: string;
  predictedEvidence: string;
  disconfirmingEvidence: string;
  nextNormalTask: string;
  returnModules: readonly FeedbackReturnModule[];
}

export interface CorrectionIds {
  proposalId(): string;
}

function strictStringArray(value: unknown, min: number, max: number, itemMax: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => isBoundedString(item, 1, itemMax));
}

export function validateCorrectionProposal(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, PROPOSAL_KEYS);
  if (!isBoundedString(value.change_id, 1, 128)) errors.push('change_id');
  if (!isBoundedString(value.plan_revision_id, 1, 128)) errors.push('plan_revision_id');
  if (!strictStringArray(value.observation_ids, 1, 100, 128)) errors.push('observation_ids');
  for (const key of ['hypothesis', 'replacement_action', 'removed_or_reduced', 'predicted_evidence', 'disconfirming_evidence', 'next_normal_task'] as const) {
    if (!isBoundedString(value[key], 1, 4000)) errors.push(key);
  }
  if (!Array.isArray(value.return_modules) || value.return_modules.length < 1 || value.return_modules.some((item) => !RETURN_MODULES.includes(item as FeedbackReturnModule))) errors.push('return_modules');
  if (!['proposed', 'accepted', 'rejected', 'reverted', 'supported_with_limits'].includes(String(value.status))) errors.push('status');
  if (typeof value.removed_or_reduced === 'string' && !REDUCTION.test(value.removed_or_reduced)) errors.push('removed_or_reduced');
  if (typeof value.replacement_action === 'string' && ADDED_LOAD.test(value.replacement_action) && (typeof value.removed_or_reduced !== 'string' || !REDUCTION.test(value.removed_or_reduced))) errors.push('added_load_without_reduction');
  const claimText = ['hypothesis', 'replacement_action', 'removed_or_reduced', 'predicted_evidence', 'disconfirming_evidence', 'next_normal_task']
    .flatMap((key) => typeof value[key] === 'string' ? [value[key] as string] : [])
    .join('\n');
  if (PROHIBITED_CLAIMS.test(claimText)) errors.push('prohibited_claim');
  return [...new Set(errors)];
}

export function buildCorrectionProposal(input: BuildCorrectionInput, ids: CorrectionIds): CorrectionProposal {
  if (ADDED_LOAD.test(input.replacementAction) && !REDUCTION.test(input.removedOrReduced)) throw new Error('added_load_without_reduction');
  const proposal: CorrectionProposal = {
    change_id: ids.proposalId().trim(),
    plan_revision_id: input.planRevisionId.trim(),
    observation_ids: [...new Set(input.observationIds.map((id) => id.trim()))],
    hypothesis: input.hypothesis.summary.trim(),
    replacement_action: input.replacementAction.trim(),
    removed_or_reduced: input.removedOrReduced.trim(),
    predicted_evidence: input.predictedEvidence.trim(),
    disconfirming_evidence: input.disconfirmingEvidence.trim(),
    next_normal_task: input.nextNormalTask.trim(),
    return_modules: [...new Set(input.returnModules)],
    status: 'proposed'
  };
  const allowed = new Set(input.hypothesis.observation_ids);
  if (proposal.observation_ids.some((id) => !allowed.has(id))) throw new Error('correction_unknown_observation');
  const errors = validateCorrectionProposal(proposal);
  if (errors.length) throw new Error(`invalid_correction_proposal:${errors.join('|')}`);
  return proposal;
}

export function validatePreferenceEvent(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, PREFERENCE_KEYS);
  for (const key of ['event_id', 'proposal_id', 'preference_key'] as const) if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  if (!['set', 'revert'].includes(String(value.action))) errors.push('action');
  if (value.value !== null && !isBoundedString(value.value, 1, 1000)) errors.push('value');
  if (!isBoundedString(value.reason, 1, 2000)) errors.push('reason');
  if (!isIsoDateTime(value.created_at)) errors.push('created_at');
  if (value.action === 'set' && value.value === null) errors.push('value');
  if (value.action === 'revert' && value.value !== null) errors.push('value');
  return [...new Set(errors)];
}

export function validateEffectEvidenceEvent(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, EFFECT_KEYS);
  for (const key of ['event_id', 'proposal_id'] as const) if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  if (!['unknown', 'initial_support', 'repeated_support', 'disconfirmed'].includes(String(value.state))) errors.push('state');
  if (!strictStringArray(value.observation_ids, 1, 100, 128)) errors.push('observation_ids');
  if (!isBoundedString(value.conditions, 1, 2000)) errors.push('conditions');
  if (value.is_effectiveness_proof !== false) errors.push('is_effectiveness_proof');
  if (!isIsoDateTime(value.created_at)) errors.push('created_at');
  if (typeof value.conditions === 'string' && PROHIBITED_CLAIMS.test(value.conditions)) errors.push('prohibited_claim');
  return [...new Set(errors)];
}

function comparableCondition(conditions: string): boolean {
  const relation = /material_relation=(similar_new|different_context)/u.test(conditions);
  const delay = /delay_days=([1-9]\d*)/u.test(conditions);
  const independent = /support_level=independent/u.test(conditions);
  return relation && delay && independent;
}

export function canPromoteEffect(events: EffectEvidenceEvent[]): boolean {
  const proposalId = events.at(-1)?.proposal_id;
  if (!proposalId) return false;
  const supporting = events.filter((event) =>
    event.proposal_id === proposalId && (event.state === 'initial_support' || event.state === 'repeated_support')
  );
  const observationIds = new Set(supporting.flatMap((event) => event.observation_ids));
  return observationIds.size >= 2 && supporting.some((event) => comparableCondition(event.conditions));
}

export function applyPreferenceEvent(history: EvidenceTrackState, event: PreferenceEvent): EvidenceTrackState {
  const errors = validatePreferenceEvent(event);
  if (errors.length) throw new Error(`invalid_preference_event:${errors.join('|')}`);
  const preferenceState = { ...history.preferenceState };
  preferenceState[event.preference_key] = event.action === 'set' ? event.value : null;
  return {
    preferenceState,
    effectState: history.effectState,
    preferenceEvents: [...history.preferenceEvents, event],
    effectEvents: [...history.effectEvents]
  };
}

export function applyEffectEvidence(history: EvidenceTrackState, event: EffectEvidenceEvent): EvidenceTrackState {
  const errors = validateEffectEvidenceEvent(event);
  if (errors.length) throw new Error(`invalid_effect_evidence_event:${errors.join('|')}`);
  if (event.state === 'repeated_support' && !canPromoteEffect([...history.effectEvents, event])) throw new Error('repeated_support_not_supported');
  const effectState: EffectEvidenceState = event.state === 'unknown' ? history.effectState : event.state;
  return {
    preferenceState: { ...history.preferenceState },
    effectState,
    preferenceEvents: [...history.preferenceEvents],
    effectEvents: [...history.effectEvents, event]
  };
}

export function createEffectEvidenceEvent(
  input: {
    proposalId: string;
    state: EffectEvidenceState;
    observationIds: string[];
    conditions: string;
    priorEvents: EffectEvidenceEvent[];
  },
  ids: { eventId(): string; now(): string }
): EffectEvidenceEvent {
  const event: EffectEvidenceEvent = {
    event_id: ids.eventId().trim(),
    proposal_id: input.proposalId.trim(),
    state: input.state,
    observation_ids: [...new Set(input.observationIds.map((id) => id.trim()))],
    conditions: input.conditions.trim(),
    is_effectiveness_proof: false,
    created_at: ids.now()
  };
  const errors = validateEffectEvidenceEvent(event);
  if (errors.length) throw new Error(`invalid_effect_evidence_event:${errors.join('|')}`);
  if (event.state === 'repeated_support' && !canPromoteEffect([...input.priorEvents, event])) throw new Error('repeated_support_not_supported');
  return event;
}

export function validateCorrectionDecisionEvent(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, DECISION_KEYS);
  for (const key of ['event_id', 'proposal_id'] as const) if (!isBoundedString(value[key], 1, 128)) errors.push(key);
  if (!['accept', 'reject', 'revert'].includes(String(value.action))) errors.push('action');
  if (!isBoundedString(value.reason, 1, 2000)) errors.push('reason');
  if (!Number.isSafeInteger(value.state_revision) || (value.state_revision as number) < 1) errors.push('state_revision');
  if (!isIsoDateTime(value.created_at)) errors.push('created_at');
  return [...new Set(errors)];
}

export function deriveCorrectionStatus(events: CorrectionDecisionEvent[]): CorrectionStatus {
  let status: CorrectionStatus = 'proposed';
  events.forEach((event, index) => {
    const errors = validateCorrectionDecisionEvent(event);
    if (errors.length || event.state_revision !== index + 1) throw new Error('invalid_correction_decision_history');
    if (event.action === 'accept' && status === 'proposed') status = 'accepted';
    else if (event.action === 'reject' && status === 'proposed') status = 'rejected';
    else if (event.action === 'revert' && status === 'accepted') status = 'reverted';
    else throw new Error('invalid_correction_transition');
  });
  return status;
}

export function validateCorrectionRecord(value: unknown): string[] {
  if (!isRecord(value)) return ['object'];
  const errors = extraKeys(value, ['proposal', 'decisionEvents', 'currentStatus', 'stateRevision', 'createdAt', 'updatedAt']);
  errors.push(...validateCorrectionProposal(value.proposal).map((item) => `proposal.${item}`));
  if (!Array.isArray(value.decisionEvents)) errors.push('decisionEvents');
  else value.decisionEvents.forEach((event, index) => errors.push(...validateCorrectionDecisionEvent(event).map((item) => `decisionEvents.${index}.${item}`)));
  if (!Number.isSafeInteger(value.stateRevision) || (value.stateRevision as number) < 0) errors.push('stateRevision');
  if (!isIsoDateTime(value.createdAt)) errors.push('createdAt');
  if (!isIsoDateTime(value.updatedAt)) errors.push('updatedAt');
  if (errors.length === 0) {
    try {
      const record = value as unknown as CorrectionRecord;
      if (record.proposal.status !== 'proposed') errors.push('proposal.status');
      if (record.stateRevision !== record.decisionEvents.length) errors.push('stateRevision');
      if (deriveCorrectionStatus(record.decisionEvents) !== record.currentStatus) errors.push('currentStatus');
    } catch { errors.push('decisionEvents.transition'); }
  }
  return [...new Set(errors)];
}

export function buildLessonChangeSuggestion(
  proposal: CorrectionProposal,
  plan: LessonPlan,
  observations: ObservationRecord[]
): LessonChange | null {
  const proposalObservationIds = new Set(proposal.observation_ids);
  const taskIds = new Set(observations
    .filter((record) => proposalObservationIds.has(record.observation.observation_id))
    .flatMap((record) => record.observation.task_id ? [record.observation.task_id] : []));
  const activity = plan.activities.find((candidate) =>
    candidate.actor === 'student' && candidate.task_ids.some((taskId) => taskIds.has(taskId))
  );
  return activity ? { kind: 'increase_independent_time', activityId: activity.activity_id, addedSec: 180 } : null;
}
