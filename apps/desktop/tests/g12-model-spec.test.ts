import { describe, expect, it } from 'vitest';
import { parseModelLessonPlanSpec } from '../src/main/preparation/modelSpec';
import { isKnownTask, taskContract, validateContract } from '../src/main/model/prompt';

const allowedAnchors = [{
  id: 'source-1',
  anchor: {
    source_version_id: 'version_1',
    locator: { char_start: 0, char_end: 12 },
    quote: '经核验的教材片段。',
    source_class: 'licensed_reference' as const,
    verification: 'exact_checked' as const
  }
}];

function validOutput(): Record<string, unknown> {
  return {
    title: '消息二则',
    objectives: [{ description: '把握消息结构', cognitive_demand: 'understand' }],
    tasks: [{
      prompt: '依据材料梳理消息要素。',
      cognitive_demand: 'explain',
      support_level: 'independent',
      teacher_notes: '核对材料依据。',
      acceptable_variants: ['要素完整且有材料依据。'],
      insufficient_examples: ['没有材料依据。'],
      anchor_ids: ['source-1']
    }],
    activities: [{
      title: '独立研读',
      start_sec: 0,
      end_sec: 2700,
      actor: 'student',
      student_action: '阅读并作答。',
      teacher_action: '巡视并记录问题。',
      priority: 'essential',
      task_indexes: [0]
    }],
    teacher_summary: '围绕材料依据组织学习。',
    unknowns: ['本班学情需教师核实。']
  };
}

const parse = (value: unknown) => parseModelLessonPlanSpec(value, allowedAnchors, {
  taskContextId: 'context_1',
  declaredDurationSec: 2700
});

describe('G12 strict lesson_plan_spec parser', () => {
  it('registers the fixed model task and rejects contract-level extra fields', () => {
    expect(isKnownTask('lesson_plan_spec')).toBe(true);
    expect(taskContract('lesson_plan_spec')).toBe('lesson_plan_spec.v1');
    expect(validateContract('lesson_plan_spec.v1', JSON.stringify(validOutput()), 1).ok).toBe(true);
    expect(validateContract('lesson_plan_spec.v1', JSON.stringify({ ...validOutput(), command: 'cmd.exe' }), 1)).toEqual({
      ok: false,
      reason: expect.stringContaining('PREPARATION_MODEL_INVALID')
    });
  });

  it('resolves only verified selected anchor IDs into LessonPlanSpec indexes', () => {
    const spec = parse(validOutput());
    expect(spec.anchors).toEqual([allowedAnchors[0].anchor]);
    expect(spec.tasks[0].anchorIndexes).toEqual([1]);
    expect(spec.activities[0].taskIndexes).toEqual([1]);
    expect(spec.declared_duration_sec).toBe(2700);
    expect(spec.task_context_id).toBe('context_1');
  });

  it.each([
    ['extra top-level key', { ...validOutput(), script: 'ignored' }],
    ['unknown anchor', { ...validOutput(), tasks: [{ ...(validOutput().tasks as Record<string, unknown>[])[0], anchor_ids: ['source-2'] }] }],
    ['copied local path', { ...validOutput(), teacher_summary: '读取 C:\\Users\\teacher\\secret.docx' }],
    ['missing answer scope', { ...validOutput(), tasks: [{ ...(validOutput().tasks as Record<string, unknown>[])[0], acceptable_variants: [] }] }],
    ['overlong title', { ...validOutput(), title: '课'.repeat(161) }],
    ['invalid duration', { ...validOutput(), activities: [{ ...(validOutput().activities as Record<string, unknown>[])[0], end_sec: 2701 }] }],
    ['executable-looking content', { ...validOutput(), teacher_summary: '<script>alert(1)</script>' }]
  ])('rejects %s', (_name, value) => {
    expect(() => parse(value)).toThrow('PREPARATION_MODEL_INVALID');
  });
});
