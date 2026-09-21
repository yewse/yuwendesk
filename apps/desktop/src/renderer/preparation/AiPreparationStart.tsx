import React from 'react';
import type { ContextDraft } from './ContextStep';
import type { SourceCandidateView } from './types';

void React;

const ACCEPT = '.txt,.md,.markdown,.csv,.pdf,.docx,.xlsx,.pptx';

function summary(text: string, truncated: boolean): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  return `${compact.slice(0, 120)}${compact.length > 120 || truncated ? '…' : ''}`;
}

function classificationLabel(value: string): string {
  return ({
    public_reference: '公开参考',
    licensed_reference: '已授权资料',
    teacher_private: '教师私有',
    student_sensitive: '学生敏感资料'
  } as Record<string, string>)[value] ?? '教师资料';
}

export function AiPreparationStart({
  candidates,
  selectedVersionId,
  context,
  guidance,
  approvedForModel,
  busy,
  stageMessage,
  onFiles,
  onSelect,
  onContext,
  onGuidance,
  onApproval,
  onStart
}: {
  candidates: SourceCandidateView[];
  selectedVersionId: string;
  context: ContextDraft;
  guidance: string;
  approvedForModel: boolean;
  busy: boolean;
  stageMessage: string;
  onFiles: (files: FileList | File[]) => void;
  onSelect: (versionId: string) => void;
  onContext: (value: ContextDraft) => void;
  onGuidance: (value: string) => void;
  onApproval: (approved: boolean) => void;
  onStart: () => void;
}): JSX.Element {
  const ready = Boolean(selectedVersionId && context.lessonTitle.trim() && approvedForModel && !busy);
  return (
    <section className="ai-start" aria-labelledby="ai-start-title">
      <div className="ai-section card">
        <div className="ai-section-number" aria-hidden="true">1</div>
        <div className="ai-section-body">
          <h2 id="ai-start-title">导入资料</h2>
          <p className="muted">拖入教材或教师资料，AI 会以你选择的资料为主要依据。</p>
          <label
            className="ai-file-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
            }}
          >
            <span>拖入教材或教师资料</span>
            <span className="btn">选择文件</span>
            <small>支持 PDF、Word、PPT、Excel、TXT、Markdown、CSV</small>
            <input
              type="file"
              multiple
              accept={ACCEPT}
              aria-label="选择备课资料文件"
              onChange={(event) => {
                if (event.target.files?.length) onFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          {candidates.length > 0 && (
            <div className="ai-source-choices" role="radiogroup" aria-label="选择本课主要资料">
              {candidates.map((source) => (
                <label className={`ai-source-choice ${selectedVersionId === source.versionId ? 'selected' : ''}`} key={source.versionId}>
                  <input
                    type="radio"
                    name="ai-primary-source"
                    checked={selectedVersionId === source.versionId}
                    onChange={() => onSelect(source.versionId)}
                  />
                  <span>
                    <b>{source.title}</b>
                    <small>第 {source.version} 版 · {classificationLabel(source.classification)}</small>
                    <small>{summary(source.preview, source.previewTruncated)}</small>
                  </span>
                  {selectedVersionId === source.versionId && <strong>已选</strong>}
                </label>
              ))}
            </div>
          )}
          {candidates.length === 0 && <p className="notice small">还没有资料。选择一个教材或教师文件后即可继续。</p>}
        </div>
      </div>

      <div className="ai-section card">
        <div className="ai-section-number" aria-hidden="true">2</div>
        <div className="ai-section-body">
          <h2>填写本课信息</h2>
          <p className="muted">只填这节课必须知道的信息，教学方案由 AI 完成。</p>
          <div className="ai-essential-fields">
            <label><span>年级</span><select className="search-input" value={context.grade} onChange={(event) => onContext({ ...context, grade: event.target.value as ContextDraft['grade'] })}><option value="grade7">七年级</option><option value="grade8">八年级</option><option value="grade9">九年级</option><option value="other">其他</option></select></label>
            <label><span>课题</span><input className="search-input" required value={context.lessonTitle} placeholder="例如：春" onChange={(event) => onContext({ ...context, lessonTitle: event.target.value })} /></label>
            <label><span>课时</span><div className="ai-duration"><input className="search-input" type="number" min={5} max={240} value={context.durationMinutes} onChange={(event) => onContext({ ...context, durationMinutes: Number(event.target.value) })} /><span>分钟</span></div></label>
          </div>
          <label className="ai-guidance"><span>补充要求（可选）</span><textarea className="draft compact" value={guidance} placeholder="例如：突出朗读体验；照顾基础薄弱学生。不填也可以。" onChange={(event) => onGuidance(event.target.value)} /></label>
          <details className="ai-more-settings">
            <summary>更多设置</summary>
            <div className="prep-form-grid">
              <label><span>班级</span><input className="search-input" value={context.classDisplayName} onChange={(event) => onContext({ ...context, classDisplayName: event.target.value })} /></label>
              <label><span>教材名称</span><input className="search-input" value={context.textbookTitle} placeholder="默认使用所选资料名称" onChange={(event) => onContext({ ...context, textbookTitle: event.target.value })} /></label>
              <label><span>教材版本</span><input className="search-input" value={context.textbookEdition} onChange={(event) => onContext({ ...context, textbookEdition: event.target.value })} /></label>
              <label><span>单元</span><input className="search-input" value={context.unitTitle} onChange={(event) => onContext({ ...context, unitTitle: event.target.value })} /></label>
            </div>
          </details>
        </div>
      </div>

      <div className="ai-action-card card">
        <div><h2>交给 AI 完成</h2><p className="muted small">AI 将规划教学目标、课堂任务、活动、答案范围，并生成可确认的完整方案。没有导入课标或考试说明时，相关内容只会标为“AI 补充参考，需教师核实”。</p></div>
        <label className="prep-consent"><input type="checkbox" checked={approvedForModel} onChange={(event) => onApproval(event.target.checked)} /> 同意将本次选中资料的必要片段发送给已配置的 AI 服务</label>
        {!approvedForModel && <p className="muted small">只有勾选后才会发送；应用不会自动重试或扩大资料范围。</p>}
        {stageMessage && <p className="notice small" role="status" aria-live="polite">{stageMessage}</p>}
        <button className="btn primary ai-primary-action" disabled={!ready} onClick={onStart}>{busy ? 'AI 正在备课…' : '让 AI 完成备课'}</button>
      </div>
    </section>
  );
}
