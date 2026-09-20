import { describe, expect, it } from 'vitest';
import { buildChangeSummary, needsPrintedCopyWarning } from '../src/renderer/lessonChangeView';

describe('G07-T03 one-change view model', () => {
  it('summarizes one proposal without asking for per-file choices', () => {
    const summary = buildChangeSummary({
      changeKind: 'increase_independent_time',
      invalidatedModules: ['M08', 'M09', 'M10'],
      diff: [{ objectId: 'act_2', field: 'duration', before: '600', after: '900' }],
      affectedOutputs: ['课堂PPT', '学生讲义DOCX/PDF', '教师讲解版DOCX/PDF']
    });

    expect(summary).toContain('增加独立学习时间');
    expect(summary).toContain('三类五文件将同步更新');
    expect(summary).not.toContain('选择字体');
  });

  it('warns when task numbering or prompt changes can invalidate printed handouts', () => {
    expect(
      needsPrintedCopyWarning([{ objectId: 'task_1', field: 'prompt', before: '旧题', after: '新题' }])
    ).toBe(true);
    expect(
      needsPrintedCopyWarning([{ objectId: 'bundle', field: 'fontScale', before: '1', after: '1.25' }])
    ).toBe(false);
  });

  it('warns for removed links, answer ranges, task order, and material anchors', () => {
    for (const field of ['link_removed', 'acceptable_variants', 'task_order', 'material_anchor_ids']) {
      expect(needsPrintedCopyWarning([{ objectId: 'changed', field, before: 'a', after: 'b' }])).toBe(true);
    }
  });
});
