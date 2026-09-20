import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { reviewLessonPlan, validateReviewReport } from '../src/main/review/review';
import type { ReviewIssue } from '../src/main/review/types';

const ids = {
  reportId: () => 'report_test',
  issueId: (rule: string, objectIds: string[]) => `issue_${rule}_${objectIds.join('_') || 'plan'}`
};

describe('G07-T01 ReviewReport', () => {
  it('separates software readiness from teaching effectiveness', () => {
    const report = reviewLessonPlan(buildLessonPlan(demoLessonSpec()), { ids });

    expect(report.disposition).toBe('ready_for_teacher');
    expect(report.is_effectiveness_proof).toBe(false);
    expect(report.not_executed_checks).toEqual(
      expect.arrayContaining(['model_semantic_review', 'teacher_professional_review', 'office_wps_fidelity'])
    );
    expect(validateReviewReport(report)).toEqual([]);
  });

  it('routes a conflicting source anchor to M03 and blocks publication', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.source_anchors[0].verification = 'conflict';

    const report = reviewLessonPlan(plan, { ids });

    expect(report.disposition).toBe('blocked');
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: 'blocking',
        return_module: 'M03',
        object_ids: [plan.source_anchors[0].anchor_id]
      })
    );
  });

  it('routes schedule overflow to M08 without claiming a measured duration', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.activities[0].end_sec = plan.declared_duration_sec + 1;

    const report = reviewLessonPlan(plan, { ids });

    expect(report.disposition).toBe('needs_fix');
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        return_module: 'M08',
        verification_type: 'deterministic',
        evidence: expect.stringContaining('activity_overtime')
      })
    );
    expect(report.issues.every((item) => !item.evidence.includes('observed'))).toBe(true);
  });

  it('keeps supported alternative interpretations for teacher review instead of keyword rejection', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.rubrics[0].criteria[0].acceptable_variants = ['从反复和语气说明急切期盼'];

    const report = reviewLessonPlan(plan, { ids });

    expect(report.issues.some((item) => item.rule_id === 'preset_personality_keyword')).toBe(false);
  });

  it('includes supplied model findings without presenting them as deterministic checks', () => {
    const modelIssue: ReviewIssue = {
      issue_id: 'model_issue_1',
      severity: 'teacher_review',
      rule_id: 'model_semantic_ambiguity',
      object_ids: ['task_1'],
      message: '任务表述可能存在歧义，需教师判断。',
      evidence: 'model:semantic-review:task_1',
      return_module: 'M07',
      verification_type: 'model_assisted',
      status: 'open'
    };

    const report = reviewLessonPlan(buildLessonPlan(demoLessonSpec()), { ids, modelIssues: [modelIssue] });

    expect(report.issues).toContainEqual(modelIssue);
    expect(report.executed_checks).toContain('model_semantic_review');
    expect(report.not_executed_checks).not.toContain('model_semantic_review');
    expect(report.not_executed_checks).toContain('teacher_professional_review');
  });

  it('rejects extra keys, invalid enums, and effectiveness claims', () => {
    const report = reviewLessonPlan(buildLessonPlan(demoLessonSpec()), { ids });
    const invalid = {
      ...report,
      disposition: 'approved',
      is_effectiveness_proof: true,
      extra: true
    };

    expect(validateReviewReport(invalid)).toEqual(
      expect.arrayContaining([
        'report:extra_key:extra',
        'report:disposition',
        'report:is_effectiveness_proof'
      ])
    );
  });
});
