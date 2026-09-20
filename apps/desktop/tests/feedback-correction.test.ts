import { describe, expect, it } from 'vitest';
import type { AttributionHypothesis, EffectEvidenceEvent, EvidenceTrackState, PreferenceEvent } from '../src/main/feedback/types';
import {
  applyEffectEvidence,
  applyPreferenceEvent,
  buildCorrectionProposal,
  canPromoteEffect,
  createEffectEvidenceEvent,
  validateCorrectionProposal
} from '../src/main/feedback/correction';

const hypothesis: AttributionHypothesis = {
  kind: 'support_mismatch',
  summary: '待验证：连续提示可能遮蔽独立找证据的表现。',
  observation_ids: ['obs_1'],
  evidence_basis: ['部分提示条件下仍需提示。'],
  limitations: ['典型样本不能外推全班。'],
  disconfirming_evidence: ['无提示条件下稳定完成则撤回。'],
  return_modules: ['M11']
};
const ids = { proposalId: () => 'correction_1' };

const baseInput = {
  planRevisionId: 'revision_1',
  observationIds: ['obs_1'],
  hypothesis,
  replacementAction: '把教师连续讲解替换为一轮独立找证据后同伴核对',
  removedOrReduced: '减少三分钟重复讲解，不增加课后作业',
  predictedEvidence: '下一次相似新材料中能独立指出证据并说明联系',
  disconfirmingEvidence: '撤去提示后仍无法定位证据，或总负担增加',
  nextNormalTask: '下一篇正常阅读任务中的证据联系题',
  returnModules: ['M06', 'M07', 'M08'] as const
};

function effect(overrides: Partial<EffectEvidenceEvent> = {}): EffectEvidenceEvent {
  return {
    event_id: 'effect_1', proposal_id: 'correction_1', state: 'initial_support',
    observation_ids: ['obs_1'],
    conditions: 'material_relation=same_item;delay_days=0;support_level=full_model',
    is_effectiveness_proof: false, created_at: '2026-09-20T09:00:00.000Z',
    ...overrides
  };
}

const emptyHistory: EvidenceTrackState = {
  preferenceState: {}, effectState: 'unknown', preferenceEvents: [], effectEvents: []
};

describe('G08 minimal correction and dual-track evidence', () => {
  it('builds one strict replacement-first correction without claiming effectiveness', () => {
    const proposal = buildCorrectionProposal(baseInput, ids);

    expect(proposal.status).toBe('proposed');
    expect(proposal.removed_or_reduced).toContain('减少');
    expect(proposal.hypothesis).toContain('待验证');
    expect(validateCorrectionProposal(proposal)).toEqual([]);
    expect(JSON.stringify(proposal)).not.toMatch(/教学有效|全班排名/);
  });

  it('rejects added load without a real reduction, class ranking, and effect-proof wording', () => {
    expect(() => buildCorrectionProposal({ ...baseInput, removedOrReduced: '' }, ids)).toThrow(/removed_or_reduced/);
    expect(() => buildCorrectionProposal({
      ...baseInput,
      replacementAction: '再加十道题作为课后作业',
      removedOrReduced: '保持原有课堂安排不变'
    }, ids)).toThrow(/added_load_without_reduction/);
    expect(validateCorrectionProposal({
      ...buildCorrectionProposal(baseInput, ids),
      predicted_evidence: '证明教学有效并提高全班排名'
    })).toContain('prohibited_claim');
  });

  it('keeps delivery preference and effect evidence on separate append-only tracks', () => {
    const preference: PreferenceEvent = {
      event_id: 'preference_1', proposal_id: 'correction_1', action: 'set',
      preference_key: 'default_link_count', value: '1', reason: '减少默认联结数量',
      created_at: '2026-09-20T09:00:00.000Z'
    };
    const afterPreference = applyPreferenceEvent(emptyHistory, preference);
    expect(afterPreference.effectState).toBe('unknown');
    expect(afterPreference.preferenceState).toEqual({ default_link_count: '1' });

    const initial = effect();
    const afterEffect = applyEffectEvidence(afterPreference, initial);
    expect(afterEffect.preferenceState).toEqual(afterPreference.preferenceState);
    expect(afterEffect.effectState).toBe('initial_support');
  });

  it('requires two comparable observations including transfer/delay evidence before repeated support', () => {
    const initial = effect();
    const comparableLater = effect({
      event_id: 'effect_2', observation_ids: ['obs_2'],
      conditions: 'material_relation=similar_new;delay_days=2;support_level=independent'
    });
    expect(canPromoteEffect([initial])).toBe(false);
    expect(canPromoteEffect([initial, comparableLater])).toBe(true);
    expect(canPromoteEffect([initial, { ...comparableLater, proposal_id: 'correction_2' }])).toBe(false);
    expect(() => createEffectEvidenceEvent({
      proposalId: 'correction_1', state: 'repeated_support', observationIds: ['obs_1'],
      conditions: 'material_relation=same_item;delay_days=0;support_level=full_model',
      priorEvents: [initial]
    }, { eventId: () => 'effect_repeated', now: () => '2026-09-20T09:05:00.000Z' })).toThrow(/repeated_support_not_supported/);
  });
});
