import React, { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuildStep } from '../src/renderer/preparation/BuildStep';
import { PreparePage } from '../src/renderer/preparation/PreparePage';
import { SourceSelectionStep } from '../src/renderer/preparation/SourceSelectionStep';

void React;

const noop = (): void => undefined;

describe('G12-T06 preparation interface keeps AI primary and teacher input small', () => {
  it('summarizes imported sources instead of rendering the OCR dump', () => {
    const hiddenTail = '这段尾部不应出现在资料卡片中';
    const html = renderToStaticMarkup(createElement(SourceSelectionStep, {
      candidates: [{
        documentId: 'document-1', versionId: 'version-1', title: '语文七年级上册.pdf', version: 1,
        classification: 'teacher_private', preview: `目录和课文开头${'甲'.repeat(240)}${hiddenTail}`,
        previewTruncated: true
      }],
      selectedVersionId: 'version-1', importTitle: '教材节选', importText: '', approvedForModel: true,
      modelMode: true, busy: false, onRefresh: noop, onSelect: noop, onImportTitle: noop,
      onImportText: noop, onApproval: noop, onContinue: noop
    }));

    expect(html).toContain('已选择');
    expect(html).toContain('目录和课文开头');
    expect(html).not.toContain(hiddenTail);
    expect(html).toContain('<details');
    expect(html).toContain('没有合适资料？粘贴一小段');
  });

  it('lets AI generate from the selected material with no mandatory teaching prose', () => {
    const html = renderToStaticMarkup(createElement(BuildStep as ComponentType<Record<string, unknown>>, {
      focus: '', coreTask: '', answerScope: '', mode: 'model_assisted', modeLabel: '模型辅助', busy: false,
      localFallback: false, onFocus: noop, onCoreTask: noop, onAnswerScope: noop, onBuild: noop,
      onUseLocal: noop
    }));

    expect(html).toContain('AI 生成完整方案');
    expect(html).toContain('补充要求（可选）');
    expect((html.match(/<textarea/gu) ?? [])).toHaveLength(1);
    expect(html).toMatch(/<button class="btn primary">让 AI 生成完整方案<\/button>/u);
  });

  it('explains and blocks continuing until the selected AI fragment is explicitly authorized', () => {
    const html = renderToStaticMarkup(createElement(SourceSelectionStep, {
      candidates: [{
        documentId: 'document-1', versionId: 'version-1', title: '语文七年级上册.pdf', version: 1,
        classification: 'licensed_reference', preview: '课文摘要', previewTruncated: false
      }],
      selectedVersionId: 'version-1', importTitle: '教材节选', importText: '', approvedForModel: false,
      modelMode: true, busy: false, onRefresh: noop, onSelect: noop, onImportTitle: noop,
      onImportText: noop, onApproval: noop, onContinue: noop
    }));

    expect(html).toContain('勾选授权后才能使用 AI');
    expect(html).toMatch(/<button class="btn primary" disabled="">使用所选资料继续<\/button>/u);
  });

  it('keeps the three teaching judgements required only for the offline fallback', () => {
    const html = renderToStaticMarkup(createElement(BuildStep as ComponentType<Record<string, unknown>>, {
      focus: '', coreTask: '', answerScope: '', mode: 'local_authored', modeLabel: '本地自拟', busy: false,
      localFallback: false, onFocus: noop, onCoreTask: noop, onAnswerScope: noop, onBuild: noop,
      onUseLocal: noop
    }));

    expect(html).toContain('教学重点');
    expect(html).toContain('核心任务');
    expect(html).toContain('合理答案范围');
    expect((html.match(/<textarea/gu) ?? [])).toHaveLength(3);
    expect(html).toMatch(/<button class="btn primary" disabled="">生成本地方案<\/button>/u);
  });

  it('starts directly in the AI workflow without asking teachers to choose an implementation mode', () => {
    const html = renderToStaticMarkup(createElement(PreparePage, { onOpenCourses: noop }));
    expect(html).toContain('把资料交给 AI，备好这一课');
    expect(html).toContain('让 AI 完成备课');
    expect(html).not.toContain('生成方式');
    expect(html).not.toContain('本地自拟');
  });
});
