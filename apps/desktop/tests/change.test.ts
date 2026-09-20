import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import type { LessonPlan } from '../src/main/lesson/types';
import {
  ChangeBlockedError,
  previewLessonChange,
  validateChangeProposal,
  validateLessonChange
} from '../src/main/change/change';

const ids = { changeId: 'chg_1', revisionId: 'rev_2' };

// All prose in this fixture is fictional, authored test content.
function linkedPlanFixture(): LessonPlan {
  const plan = buildLessonPlan(demoLessonSpec());
  plan.tasks[1].task_id = 'task_link';
  plan.activities[2].activity_id = 'act_link';
  plan.activities[2].task_ids = ['task_link'];
  plan.activities[2].priority = 'optional';
  plan.links = [
    {
      link_id: 'link_1',
      current_anchor_ids: ['anc_1'],
      related_anchor_ids: ['anc_1'],
      relation_type: 'same_topic_difference',
      similarities: ['均写春日景象（自拟测试）'],
      differences: ['观察角度不同（自拟测试）'],
      purpose: '比较观察角度后返回本篇语言',
      author_timeline: [],
      text_timeline: ['先比较，再返回当前文本'],
      student_learning_status: 'current',
      prerequisite_support: '提供当前段落',
      student_action: '比较两处景物描写',
      return_to_text_task_id: 'task_link',
      estimated_sec: 300,
      replaces_activity_ids: ['act_link'],
      next_recurrence: null,
      disconfirming_observation: '比较未帮助解释当前文本时删除',
      decision: 'include'
    }
  ];
  return plan;
}

describe('G07-T02 dependency-aware lesson changes', () => {
  it('shortens a lesson by removing optional work before compressible work and never adds homework', () => {
    const base = linkedPlanFixture();
    const beforeHomework = structuredClone(base.homework);

    const out = previewLessonChange(base, { kind: 'change_duration', durationSec: 2100 }, ids);

    expect(out.invalidatedModules).toEqual(['M08', 'M09', 'M10']);
    expect(out.candidatePlan.revision_id).toBe('rev_2');
    expect(out.candidatePlan.previous_revision_id).toBe(base.revision_id);
    expect(out.candidatePlan.activities.every((activity) => activity.end_sec <= 2100)).toBe(true);
    expect(out.candidatePlan.activities.some((activity) => activity.activity_id === 'act_link')).toBe(false);
    expect(out.candidatePlan.homework).toEqual(beforeHomework);
  });

  it('adds independent time once by taking time from optional/compressible activity, not homework', () => {
    const base = linkedPlanFixture();
    const target = base.activities.find((activity) => activity.actor === 'student')!;
    const originalDuration = target.end_sec - target.start_sec;

    const out = previewLessonChange(
      base,
      { kind: 'increase_independent_time', activityId: target.activity_id, addedSec: 300 },
      ids
    );
    const changed = out.candidatePlan.activities.find((activity) => activity.activity_id === target.activity_id)!;

    expect(changed.end_sec - changed.start_sec).toBe(originalDuration + 300);
    expect(out.candidatePlan.declared_duration_sec).toBe(base.declared_duration_sec);
    expect(out.candidatePlan.homework).toEqual(base.homework);
    expect(out.invalidatedModules).toEqual(['M08', 'M09', 'M10']);
  });

  it('removes one link, its return task, rubric, and replacement activities without renumbering unaffected IDs', () => {
    const base = linkedPlanFixture();
    const keepTaskId = base.tasks[0].task_id;
    const removedRubricId = base.tasks.find((task) => task.task_id === 'task_link')!.rubric_id;

    const out = previewLessonChange(base, { kind: 'remove_link', linkId: 'link_1' }, ids);

    expect(out.candidatePlan.links.some((link) => link.link_id === 'link_1')).toBe(false);
    expect(out.candidatePlan.tasks.some((task) => task.task_id === 'task_link')).toBe(false);
    expect(out.candidatePlan.rubrics.some((rubric) => rubric.rubric_id === removedRubricId)).toBe(false);
    expect(out.candidatePlan.activities.some((activity) => activity.activity_id === 'act_link')).toBe(false);
    expect(out.candidatePlan.tasks.some((task) => task.task_id === keepTaskId)).toBe(true);
    expect(out.invalidatedModules).toEqual(['M05', 'M06', 'M07', 'M08', 'M09', 'M10']);
  });

  it('updates a task and its answer range while preserving unrelated semantics', () => {
    const base = linkedPlanFixture();
    const untouchedTask = structuredClone(base.tasks[1]);

    const out = previewLessonChange(
      base,
      {
        kind: 'edit_task',
        taskId: base.tasks[0].task_id,
        prompt: '新的题意',
        acceptableVariants: ['有文本依据的答案']
      },
      ids
    );

    expect(out.candidatePlan.tasks[0].prompt).toBe('新的题意');
    expect(out.candidatePlan.rubrics[0].criteria[0].acceptable_variants).toEqual(['有文本依据的答案']);
    expect(out.candidatePlan.tasks[1]).toEqual(untouchedTask);
    expect(out.proposal.plan_revision_id).toBe(base.revision_id);
    expect(out.proposal.observation_ids).toEqual([]);
    expect(out.proposal.hypothesis).toContain('教师主动修改');
    expect(validateChangeProposal(out.proposal)).toEqual([]);
  });

  it('presentation-only change keeps semantic revision and creates a new presentation spec hash', () => {
    const base = linkedPlanFixture();

    const out = previewLessonChange(
      base,
      { kind: 'presentation_only', fontScale: 1.25, paperSize: 'A4', theme: 'light' },
      ids
    );

    expect(out.semanticRevisionChanged).toBe(false);
    expect(out.candidatePlan.revision_id).toBe(base.revision_id);
    expect(out.invalidatedModules).toEqual(['M09', 'M10']);
    expect(out.presentationSpecHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects uncontrolled fields and refuses a duration that cannot fit essential actions', () => {
    expect(validateLessonChange({ kind: 'change_duration', durationSec: 2100, hidden: true })).toContain(
      'change:extra_key:hidden'
    );
    const base = linkedPlanFixture();
    expect(() => previewLessonChange(base, { kind: 'change_duration', durationSec: 300 }, ids)).toThrow(
      ChangeBlockedError
    );
  });
});
