import { describe, expect, it } from 'vitest';
import type { CorrectionRecord, FeedbackAnalysisResult, MeasurementReview, TeachingEvent } from '../src/main/feedback/types';
import {
  OBSERVATION_OUTCOME_OPTIONS,
  buildAnalysisView,
  buildCorrectionCard,
  buildEvidenceTrackView,
  buildObservationPrompt,
  buildTeachingStatus,
  teachingSubmissionKey
} from '../src/renderer/feedbackView';

const event: TeachingEvent = {
  event_id: 'teach_1',
  workspace_id: 'workspace_default',
  plan_id: 'plan_1',
  plan_revision_id: 'revision_1',
  taught_at: '2026-09-20T07:30:00.000Z',
  actual_duration_sec: 2400,
  implementation_state: 'partial',
  adjustment_summary: '临时删减教师讲解',
  created_at: '2026-09-20T08:20:00.000Z'
};

describe('G08 feedback renderer view model', () => {
  it('keeps adopted and taught states separate', () => {
    expect(buildTeachingStatus({ adopted: true, events: [] })).toEqual({
      adoptionLabel: '已采用',
      teachingLabel: '尚未记录授课',
      canRecordTeaching: true
    });
    expect(buildTeachingStatus({ adopted: true, events: [event] })).toEqual({
      adoptionLabel: '已采用',
      teachingLabel: '已记录授课（部分实施）',
      canRecordTeaching: true
    });
  });

  it('shows measurement checks before bounded hypotheses and keeps origin/blockers visible', () => {
    const measurement: MeasurementReview = {
      review_id: 'measurement_1', workspace_id: 'workspace_default', plan_id: 'plan_1',
      plan_revision_id: 'revision_1', teaching_event_id: 'teach_1',
      checks: [
        { check_id: 'target_alignment', status: 'pass', evidence: 'aligned', object_ids: ['task_1'], return_module: 'M07' },
        { check_id: 'scoring_available', status: 'pass', evidence: 'rubric', object_ids: ['rubric_1'], return_module: 'M07' },
        { check_id: 'task_comparability', status: 'pass', evidence: 'conditions', object_ids: ['observation_1'], return_module: 'M11' },
        { check_id: 'sample_coverage', status: 'pass', evidence: 'bounded', object_ids: ['observation_1'], return_module: 'M11' },
        { check_id: 'implementation_conditions', status: 'pass', evidence: 'duration', object_ids: ['teach_1'], return_module: 'M11' }
      ],
      disposition: 'ready_for_attribution', inference_limits: ['class_inference_not_allowed'],
      is_effectiveness_proof: false, created_at: '2026-09-20T08:15:00.000Z'
    };
    const result: FeedbackAnalysisResult = {
      status: 'attributed', streamRevision: 4, measurement,
      attribution: {
        attribution_run_id: 'run_1', plan_revision_id: 'revision_1', teaching_event_id: 'teach_1',
        measurement_review_id: 'measurement_1', model_job_id: 'job_1', content_origin: 'simulated',
        hypotheses: [{
          kind: 'support_mismatch', summary: '待验证：提示程度可能遮蔽独立表现。',
          observation_ids: ['observation_1'], evidence_basis: ['结构化观察'], limitations: ['不能外推全班'],
          disconfirming_evidence: ['无提示稳定完成则撤回'], return_modules: ['M11']
        }],
        not_executed_checks: ['real_api_validation', 'professional_teaching_review'],
        is_effectiveness_proof: false
      }
    };

    expect(buildAnalysisView(result)).toMatchObject({
      originLabel: '模拟（测试替身）',
      measurementChecks: expect.arrayContaining([expect.objectContaining({ id: 'target_alignment', status: 'pass' })]),
      hypotheses: [expect.objectContaining({ summary: '待验证：提示程度可能遮蔽独立表现。' })],
      notExecutedLabels: ['真实 API 质量验证未执行', '教学专业复核未执行'],
      proofDisclaimer: '这些是待验证假设，不是教学有效性证明。'
    });
  });

  it('does not claim adoption or effectiveness for an unadopted course', () => {
    const status = buildTeachingStatus({ adopted: false, events: [event] });
    expect(status.adoptionLabel).toBe('尚未采用');
    expect(status.teachingLabel).toBe('已记录授课（部分实施）');
    expect(JSON.stringify(status)).not.toMatch(/有效|成功/);
  });

  it('reuses one submission key for unchanged form data and rotates it after a change', () => {
    const base = {
      planId: 'plan_1',
      planRevisionId: 'revision_1',
      taughtAt: '2026-09-20T07:30:00.000Z',
      actualDurationSec: 2400,
      implementationState: 'completed' as const,
      adjustmentSummary: ''
    };
    expect(teachingSubmissionKey(base)).toBe(teachingSubmissionKey({ ...base }));
    expect(teachingSubmissionKey(base)).not.toBe(teachingSubmissionKey({ ...base, actualDurationSec: 2100 }));
  });

  it('offers four bounded optional outcomes only after teaching and never turns skip into a result', () => {
    expect(OBSERVATION_OUTCOME_OPTIONS.map((item) => item.value)).toEqual([
      'met_expectation',
      'needed_prompt',
      'clear_difficulty',
      'insufficient_evidence'
    ]);
    expect(buildObservationPrompt({ teachingEvents: [], observedTeachingEventIds: [], dismissedTeachingEventIds: [] })).toEqual({
      visible: false,
      teachingEventId: null,
      knowledgeLabel: '尚无反馈'
    });
    expect(buildObservationPrompt({ teachingEvents: [event], observedTeachingEventIds: [], dismissedTeachingEventIds: [] })).toEqual({
      visible: true,
      teachingEventId: 'teach_1',
      knowledgeLabel: '尚无反馈'
    });
    expect(buildObservationPrompt({ teachingEvents: [event], observedTeachingEventIds: [], dismissedTeachingEventIds: ['teach_1'] })).toEqual({
      visible: false,
      teachingEventId: 'teach_1',
      knowledgeLabel: '尚无反馈'
    });
  });

  it('renders all correction fields and keeps preference separate from effect evidence', () => {
    const correction: CorrectionRecord = {
      proposal: {
        change_id: 'correction_1', plan_revision_id: 'revision_1', observation_ids: ['observation_1'],
        hypothesis: '待验证：提示可能遮蔽独立表现。', replacement_action: '替换为先独立找证据再核对',
        removed_or_reduced: '减少一次完整示范', predicted_evidence: '相似新材料中独立完成',
        disconfirming_evidence: '撤去提示后仍不能完成', next_normal_task: '下一篇正常阅读任务',
        return_modules: ['M06', 'M11', 'M12'], status: 'proposed'
      },
      decisionEvents: [], currentStatus: 'proposed', stateRevision: 0,
      createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z'
    };
    expect(buildCorrectionCard(correction)).toMatchObject({
      hypothesis: correction.proposal.hypothesis,
      replacementAction: correction.proposal.replacement_action,
      removedOrReduced: correction.proposal.removed_or_reduced,
      predictedEvidence: correction.proposal.predicted_evidence,
      disconfirmingEvidence: correction.proposal.disconfirming_evidence,
      nextNormalTask: correction.proposal.next_normal_task,
      canAccept: true,
      canReject: true,
      canRevert: false
    });
    expect(buildEvidenceTrackView({ preferenceState: { default_link_count: '1' }, effectState: 'initial_support' })).toEqual({
      preferenceLabel: '表达偏好：default_link_count=1',
      effectLabel: '有限条件下的初步证据（非效果证明）'
    });
    expect(buildEvidenceTrackView({ preferenceState: { default_link_count: '2' }, effectState: 'initial_support' }).effectLabel)
      .toBe('有限条件下的初步证据（非效果证明）');
  });
});
