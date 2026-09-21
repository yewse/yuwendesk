import type { LessonAnchorInput, LessonPlanSpec } from '../lesson/build';
import type { SourceAnchor } from '../lesson/types';
import type { PreparationSession, PreparationSourcePurpose, TeachingContext } from './types';

export interface VerifiedPreparationSource {
  sourceVersionId: string;
  quote: string;
  sourceClass: SourceAnchor['source_class'];
  locator: Record<string, number | string>;
  purpose: PreparationSourcePurpose;
}

export interface LocalLessonPlanInput {
  context: TeachingContext;
  session: PreparationSession;
  sources: VerifiedPreparationSource[];
}

export function buildLocalLessonPlanSpec(input: LocalLessonPlanInput): LessonPlanSpec {
  if (input.sources.length === 0) throw new Error('PREPARATION_SOURCE_REQUIRED');
  if (!input.session.focus.trim() || !input.session.coreTask.trim() || !input.session.answerScope.trim()) {
    throw new Error('PREPARATION_LOCAL_FIELDS_REQUIRED');
  }

  const anchors: LessonAnchorInput[] = input.sources.map((source) => ({
    source_version_id: source.sourceVersionId,
    locator: { ...source.locator },
    quote: source.quote,
    source_class: source.sourceClass,
    verification: 'exact_checked'
  }));
  const anchorIndexes = anchors.map((_anchor, index) => index + 1);
  const firstEnd = Math.max(1, Math.floor(input.context.durationSec * 0.2));
  const secondEnd = Math.max(firstEnd + 1, Math.floor(input.context.durationSec * 0.8));
  const unknowns = ['本班学情未提供，需教师核实。'];
  if (!input.context.textbookEdition.trim()) unknowns.unshift('教材版本未填写，需教师核实。');
  if (!input.sources.some((source) => source.purpose === 'curriculum')) {
    unknowns.push('课程标准映射未提供，需教师核实。');
  }

  return {
    title: input.context.lessonTitle,
    declared_duration_sec: input.context.durationSec,
    task_context_id: input.context.contextId,
    objectives: [{
      description: input.session.focus,
      cognitive_demand: 'understand'
    }],
    anchors,
    tasks: [{
      prompt: input.session.coreTask,
      cognitive_demand: 'explain',
      support_level: 'independent',
      teacher_notes: `教学重点：${input.session.focus}`,
      acceptable_variants: [input.session.answerScope],
      insufficient_examples: ['回答超出所选材料支持范围。'],
      anchorIndexes
    }],
    activities: [
      {
        title: '核对材料与任务',
        start_sec: 0,
        end_sec: firstEnd,
        actor: 'both',
        student_action: '阅读所选材料，确认任务要求。',
        teacher_action: '说明任务范围和材料边界。',
        priority: 'essential',
        taskIndexes: [1]
      },
      {
        title: '独立完成核心任务',
        start_sec: firstEnd,
        end_sec: secondEnd,
        actor: 'student',
        student_action: '依据所选材料完成核心任务。',
        teacher_action: '观察完成过程，只对任务要求作必要澄清。',
        priority: 'essential',
        taskIndexes: [1]
      },
      {
        title: '交流与核对答案范围',
        start_sec: secondEnd,
        end_sec: input.context.durationSec,
        actor: 'both',
        student_action: '说明材料依据并修订回答。',
        teacher_action: '按教师设定的答案范围组织核对。',
        priority: 'essential',
        taskIndexes: [1]
      }
    ],
    teacher_summary: `围绕“${input.session.focus}”组织一项有材料依据的核心任务。`,
    unknowns
  };
}
