import type { LessonChange } from '../main/change/types';
import type { ReturnModule } from '../main/review/types';

export interface LessonChangeViewDiff {
  objectId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface LessonChangeSummaryInput {
  changeKind: LessonChange['kind'];
  invalidatedModules: ReturnModule[];
  diff: LessonChangeViewDiff[];
  affectedOutputs: string[];
}

export const PRINTED_COPY_WARNING = '旧纸本不会自动更新：请重印新讲义，或课堂上统一使用旧版。';

const kindLabels: Record<LessonChange['kind'], string> = {
  change_duration: '改变实际课时',
  increase_independent_time: '增加独立学习时间',
  remove_link: '减少联结',
  edit_task: '修改题目与合理答案范围',
  edit_rubric: '修改合理答案范围',
  presentation_only: '只调整版式'
};

const PRINT_SENSITIVE_FIELDS = new Set([
  'prompt',
  'task_order',
  'task_removed',
  'acceptable_variants',
  'rubric_answer',
  'material_anchor_ids',
  'material_anchor',
  'link_removed'
]);

export function needsPrintedCopyWarning(diff: LessonChangeViewDiff[]): boolean {
  return diff.some(
    (entry) =>
      PRINT_SENSITIVE_FIELDS.has(entry.field) ||
      (entry.objectId.startsWith('task_') && entry.field !== 'fontScale') ||
      (entry.objectId.startsWith('link_') && entry.after === null)
  );
}

export function buildChangeSummary(input: LessonChangeSummaryInput): string {
  const modules = input.invalidatedModules.join('、');
  const outputs = input.affectedOutputs.join('、');
  return `${kindLabels[input.changeKind]}：${input.diff.length} 处差异；返回 ${modules} 重算。${outputs}。三类五文件将同步更新，无需逐文件选择。`;
}
