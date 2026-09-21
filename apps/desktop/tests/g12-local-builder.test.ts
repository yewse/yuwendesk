import { describe, expect, it } from 'vitest';
import { buildLocalLessonPlanSpec } from '../src/main/preparation/localBuilder';
import { buildLessonPlan } from '../src/main/lesson/build';
import { versionStamp } from '../src/main/materials/generate';
import type { PreparationSession, TeachingContext } from '../src/main/preparation/types';

const context: TeachingContext = {
  contextId: 'context_1',
  classDisplayName: '八年级一班',
  grade: 'grade8',
  textbookTitle: '语文八年级上册',
  textbookEdition: '',
  unitTitle: '第一单元',
  lessonTitle: '消息二则',
  durationSec: 2700,
  notes: '',
  revision: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z'
};

const session: PreparationSession = {
  sessionId: 'session_1',
  contextId: context.contextId,
  status: 'SOURCES_SELECTED',
  mode: 'local_authored',
  focus: '把握消息结构与语言准确性',
  coreTask: '依据片段梳理消息六要素，并说明标题如何概括内容。',
  answerScope: '答案必须落在所选片段可支持的范围内；不补写片段外史实。',
  planId: null,
  revisionId: null,
  reviewReportId: null,
  bundleId: null,
  modelJobId: null,
  contentOrigin: 'teacher_authored',
  lastErrorCode: null,
  revision: 2,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  sources: []
};

describe('G12 deterministic local lesson-plan builder', () => {
  it('uses the exact verified quote and teacher-authored fields without inventing facts', () => {
    const quote = '新华社长江前线二十二日二十二时电。';
    const spec = buildLocalLessonPlanSpec({
      context,
      session,
      sources: [{
        sourceVersionId: 'version_1',
        quote,
        sourceClass: 'licensed_reference',
        locator: { char_start: 0, char_end: quote.length },
        purpose: 'textbook'
      }]
    });

    expect(spec.title).toBe('消息二则');
    expect(spec.task_context_id).toBe(context.contextId);
    expect(spec.declared_duration_sec).toBe(2700);
    expect(spec.anchors).toEqual([{
      source_version_id: 'version_1',
      quote,
      source_class: 'licensed_reference',
      locator: { char_start: 0, char_end: quote.length },
      verification: 'exact_checked'
    }]);
    expect(spec.objectives[0].description).toBe(session.focus);
    expect(spec.tasks[0]).toMatchObject({
      prompt: session.coreTask,
      acceptable_variants: [session.answerScope],
      anchorIndexes: [1]
    });
    expect(spec.activities[spec.activities.length - 1].end_sec).toBe(context.durationSec);
    expect(spec.unknowns).toContain('教材版本未填写，需教师核实。');
    expect(spec.unknowns).toContain('课程标准映射未提供，需教师核实。');
    expect(spec.unknowns).toContain('本班学情未提供，需教师核实。');
    expect(spec.anchors.flatMap((anchor) => anchor.quote)).toEqual([quote]);
  });

  it('requires at least one verified source', () => {
    expect(() => buildLocalLessonPlanSpec({ context, session, sources: [] })).toThrow('PREPARATION_SOURCE_REQUIRED');
  });

  it('labels teacher, real-model, and simulated-model origins exactly', () => {
    const plan = buildLessonPlan({
      ...buildLocalLessonPlanSpec({
        context,
        session,
        sources: [{
          sourceVersionId: 'version_1', quote: '经核验片段。', sourceClass: 'teacher_private',
          locator: { char_start: 0, char_end: 6 }, purpose: 'textbook'
        }]
      })
    });
    expect(versionStamp(plan, 'teacher_authored')).toContain('内容来源 教师自拟');
    expect(versionStamp(plan, 'model_assisted_real')).toContain('内容来源 模型辅助（真实服务）');
    expect(versionStamp(plan, 'model_assisted_simulated')).toContain('内容来源 模型辅助（模拟）');
  });
});
