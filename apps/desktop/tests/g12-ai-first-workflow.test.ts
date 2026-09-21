import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PreparationSession, TeachingContext } from '../src/main/preparation/types';
import type { ReviewReport } from '../src/main/review/types';
import { App } from '../src/renderer/App';
import { AiPreparationResult, preparationStatusLabel } from '../src/renderer/preparation/AiPreparationResult';
import { AiPreparationStart } from '../src/renderer/preparation/AiPreparationStart';
import {
  composeAiGuidance,
  confirmAndExport,
  runAiPlanning,
  type AiFlowGateway
} from '../src/renderer/preparation/aiFlow';
import { resolveLessonExcerpt } from '../src/renderer/preparation/sourceExcerpt';

function session(status: PreparationSession['status'], revision: number): PreparationSession {
  return {
    sessionId: 'session-1', contextId: 'context-1', mode: 'model_assisted', status, revision,
    sources: [], focus: '', coreTask: '', answerScope: '', planId: status === 'CONTEXT_DRAFT' || status === 'SOURCES_SELECTED' ? null : 'plan-1',
    revisionId: status === 'CONTEXT_DRAFT' || status === 'SOURCES_SELECTED' ? null : 'revision-1', reviewReportId: null,
    bundleId: null, modelJobId: null, contentOrigin: 'model_assisted_real', lastErrorCode: null,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z'
  };
}

const context: TeachingContext = {
  contextId: 'context-1', classDisplayName: '当前班级', grade: 'grade7', textbookTitle: '七年级上册',
  textbookEdition: '', unitTitle: '', lessonTitle: '春', durationSec: 2700, notes: '', revision: 1,
  createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z'
};

const report: ReviewReport = {
  report_id: 'report-1', plan_revision_id: 'revision-1', issues: [], disposition: 'ready_for_teacher',
  executed_checks: ['lesson_plan_schema'], not_executed_checks: ['human_pedagogy_review'], is_effectiveness_proof: false
};

function strictGateway(): AiFlowGateway & { finalizedCount: () => number } {
  let finalized = 0;
  return {
    finalizedCount: () => finalized,
    saveContext: async (_payload, expectedRevision) => {
      expect(expectedRevision).toBe(0);
      return context;
    },
    createSession: async (contextId, mode) => {
      expect(contextId).toBe('context-1');
      expect(mode).toBe('model_assisted');
      return session('CONTEXT_DRAFT', 1);
    },
    setSources: async (_sessionId, sources, expectedRevision) => {
      expect(expectedRevision).toBe(1);
      expect(sources).toEqual([expect.objectContaining({ sourceVersionId: 'version-1', approvedForModel: true })]);
      return { ...session('SOURCES_SELECTED', 2), sources };
    },
    build: async (_sessionId, guidance, expectedRevision) => {
      expect(expectedRevision).toBe(2);
      expect(guidance).toContain('AI 补充参考，需教师核实');
      expect(guidance).toContain('重视朗读体验');
      return session('PLAN_REVIEW', 4);
    },
    review: async (_sessionId, expectedRevision) => {
      expect(expectedRevision).toBe(4);
      return { session: session('PLAN_REVIEW', 4), report };
    },
    confirm: async (_sessionId, expectedRevision) => {
      finalized += 1;
      expect(expectedRevision).toBe(4);
      return session('READY_TO_EXPORT', 5);
    },
    exportFiles: async (_sessionId, expectedRevision) => {
      finalized += 1;
      expect(expectedRevision).toBe(5);
      return { ...session('EXPORTED', 7), bundleId: 'bundle-1' };
    }
  };
}

describe('G12-T07 AI-led teacher workflow', () => {
  it('adds clearly labelled AI-only curriculum and exam guidance without pretending it is an official source', () => {
    const guidance = composeAiGuidance('重视朗读体验');
    expect(guidance).toContain('AI 补充参考，需教师核实');
    expect(guidance).toContain('不得虚构文件名称、版本、条款编号或考试范围');
    expect(guidance).toContain('重视朗读体验');
  });

  it('locates the lesson body instead of sending a whole textbook or table of contents', async () => {
    const fullText = `${'序'.repeat(1000)}目录 1 春 / 朱自清 2 济南的冬天${'目'.repeat(2000)}第一单元\n春\n朱自清\n${'盼望着，东风来了。'.repeat(500)}`;
    const excerpt = await resolveLessonExcerpt({
      search: async () => [
        {
          documentId: 'document-1', title: '七年级上册.pdf', version: 1, versionId: 'version-1',
          classification: 'licensed_reference', anchor: { char_start: 1005, char_end: 1006, line: 0 },
          context: '目录 1 春 / 朱自清 2 济南的冬天', locator: { kind: 'pdf_page', page: 3 }, reliable: true,
          locatorLabel: '第 3 页', matchKind: 'body'
        },
        {
          documentId: 'document-1', title: '七年级上册.pdf', version: 1, versionId: 'version-1',
          classification: 'licensed_reference', anchor: { char_start: 3035, char_end: 3036, line: 0 },
          context: '第一单元 春 朱自清 盼望着，东风来了', locator: { kind: 'pdf_page', page: 8 }, reliable: true,
          locatorLabel: '第 8 页', matchKind: 'body'
        }
      ],
      read: async (_versionId, start, end) => {
        if (typeof start !== 'number' || typeof end !== 'number') {
          return { title: '七年级上册.pdf', version: 1, text: fullText.slice(0, 8000), char_start: null, char_end: null, truncated: fullText.length > 8000, full_length: fullText.length };
        }
        return {
          title: '七年级上册.pdf', version: 1,
          text: fullText.slice(Math.max(0, start - 40), Math.min(fullText.length, end + 40)),
          char_start: start, char_end: end, truncated: false, full_length: fullText.length
        };
      }
    }, 'version-1', '春');

    expect(excerpt.text).toContain('盼望着，东风来了');
    expect(excerpt.text).not.toContain('目录 1 春');
    expect(excerpt.text.length).toBeLessThanOrEqual(4000);
    expect(excerpt.locatorLabel).toBe('第 8 页');
  });

  it('explains the product from the real App entry without engineering support cards', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('把资料交给 AI，备好这一课');
    expect(html).toContain('导入资料');
    expect(html).toContain('填写本课信息');
    expect(html).toContain('AI 生成结果');
    expect(html).not.toContain('备课草稿（本地保存）');
    expect(html).not.toContain('系统状态');
    expect(html).not.toContain('软件审查');
  });

  it('plans and checks the lesson in one AI operation without impersonating teacher confirmation', async () => {
    const gateway = strictGateway();
    const planned = await runAiPlanning(gateway, {
      context: {
        classDisplayName: '当前班级', grade: 'grade7', textbookTitle: '七年级上册', textbookEdition: '',
        unitTitle: '', lessonTitle: '春', durationSec: 2700, notes: ''
      },
      contextRevision: 0,
      source: {
        ordinal: 0, sourceVersionId: 'version-1', charStart: 0, charEnd: 1200,
        purpose: 'textbook', approvedForModel: true,
        textSha256: 'a'.repeat(64)
      },
      guidance: '重视朗读体验',
      idempotencyPrefix: 'test-plan'
    });

    expect(planned.session.status).toBe('PLAN_REVIEW');
    expect(planned.report.disposition).toBe('ready_for_teacher');
    expect(gateway.finalizedCount()).toBe(0);
  });

  it('uses the confirmed revision for export in one teacher action', async () => {
    const gateway = strictGateway();
    const exported = await confirmAndExport(gateway, session('PLAN_REVIEW', 4), 'test-export');
    expect(exported.status).toBe('EXPORTED');
    expect(exported.bundleId).toBe('bundle-1');
    expect(gateway.finalizedCount()).toBe(2);
  });

  it('asks only for material, necessary lesson information, optional guidance, and consent', () => {
    const html = renderToStaticMarkup(createElement(AiPreparationStart, {
      candidates: [{
        documentId: 'document-1', versionId: 'version-1', title: '语文七年级上册.pdf', version: 1,
        classification: 'licensed_reference', preview: '第一单元 春', previewTruncated: false
      }],
      selectedVersionId: 'version-1',
      context: {
        classDisplayName: '当前班级', grade: 'grade7', textbookTitle: '', textbookEdition: '',
        unitTitle: '', lessonTitle: '春', durationSec: 2700, durationMinutes: 45, notes: ''
      },
      guidance: '', approvedForModel: true, busy: false, stageMessage: '',
      onFiles: () => undefined, onSelect: () => undefined, onContext: () => undefined,
      onGuidance: () => undefined, onApproval: () => undefined, onStart: () => undefined
    }));

    expect(html).toContain('拖入教材或教师资料');
    expect(html).toContain('选择文件');
    expect(html).toContain('年级');
    expect(html).toContain('课题');
    expect(html).toContain('课时');
    expect(html).toContain('补充要求（可选）');
    expect(html).toContain('让 AI 完成备课');
    expect(html).not.toContain('教学重点');
    expect(html).not.toContain('核心任务');
    expect(html).not.toContain('合理答案范围');
  });

  it('shows teacher-facing results while keeping identifiers and hashes out of the main view', () => {
    const plan = {
      plan_id: 'plan-internal-id', revision_id: 'revision-internal-id', title: '《春》第一课时',
      teacher_summary: '通过朗读与语言品味感受春景。',
      tasks: [{ task_id: 'task-1', prompt: '圈画并朗读最能表现春意的句子。' }],
      unknowns: ['请教师核对本班朗读基础']
    } as never;
    const html = renderToStaticMarkup(createElement(AiPreparationResult, {
      session: { ...session('READY_TO_EXPORT', 5), planId: 'plan-internal-id', revisionId: 'revision-internal-id' },
      plan, report, artifacts: [], busy: false,
      onConfirmAndExport: () => undefined, onPresent: () => undefined, onChange: () => undefined,
      onRetry: () => undefined
    }));

    expect(html).toContain('AI 已完成备课方案');
    expect(html).toContain('确认方案并生成教学文件');
    expect(html).toContain('请教师核对本班朗读基础');
    expect(html).not.toContain('READY_TO_EXPORT');
    expect(html).not.toContain('plan-internal-id');
    expect(html).not.toContain('revision-internal-id');
    expect(html).not.toContain('软件审查');

    for (const status of ['CONTEXT_DRAFT', 'SOURCES_SELECTED', 'PLAN_REVIEW', 'READY_TO_EXPORT', 'EXPORTED'] as const) {
      expect(preparationStatusLabel(status)).not.toContain(status);
    }
  });

  it('groups completed files by classroom purpose and hides integrity details by default', () => {
    const html = renderToStaticMarkup(createElement(AiPreparationResult, {
      session: { ...session('EXPORTED', 7), bundleId: 'bundle-internal-id' },
      plan: { plan_id: 'plan-internal-id', revision_id: 'revision-internal-id', title: '《春》', teacher_summary: '摘要', tasks: [], unknowns: [] } as never,
      report, busy: false,
      artifacts: [
        { role: 'presentation', format: 'pptx', filename: '课堂课件.pptx', sha256: 'b'.repeat(64), byteSize: 100 },
        { role: 'student', format: 'docx', filename: '学生讲义.docx', sha256: 'c'.repeat(64), byteSize: 200 },
        { role: 'teacher', format: 'pdf', filename: '教师教案.pdf', sha256: 'd'.repeat(64), byteSize: 300 }
      ],
      onConfirmAndExport: () => undefined, onPresent: () => undefined, onChange: () => undefined,
      onRetry: () => undefined
    }));

    expect(html).toContain('备课完成，可以上课了');
    expect(html).toContain('课堂课件');
    expect(html).toContain('学生讲义');
    expect(html).toContain('教师教案');
    expect(html).toContain('查看文件校验信息');
    expect(html).not.toContain('bundle-internal-id');
    expect(html.indexOf('查看文件校验信息')).toBeLessThan(html.indexOf('bbbbbbbbbbbb'));
  });
});
