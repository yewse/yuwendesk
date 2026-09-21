import React from 'react';
import type { SourceCandidateView } from './types';

void React;

const CLASSIFICATION_LABELS: Record<string, string> = {
  teacher_private: '教师私有',
  licensed_reference: '已授权资料',
  student_sensitive: '学生敏感资料'
};

function sourceSummary(preview: string, truncated: boolean): string {
  const compact = preview.replace(/\s+/gu, ' ').trim();
  const shortened = compact.length > 140;
  return `${compact.slice(0, 140)}${shortened || truncated ? '…' : ''}`;
}

export function SourceSelectionStep({ candidates, selectedVersionId, importTitle, importText, approvedForModel, modelMode, busy, onRefresh, onSelect, onImportTitle, onImportText, onApproval, onContinue }: {
  candidates: SourceCandidateView[];
  selectedVersionId: string;
  importTitle: string;
  importText: string;
  approvedForModel: boolean;
  modelMode: boolean;
  busy: boolean;
  onRefresh: () => void;
  onSelect: (versionId: string) => void;
  onImportTitle: (value: string) => void;
  onImportText: (value: string) => void;
  onApproval: (value: boolean) => void;
  onContinue: () => void;
}): JSX.Element {
  return (
    <section className="card prep-step" aria-labelledby="prep-source-title">
      <div className="card-title" id="prep-source-title">2. 选择本课资料</div>
      <p className="muted small">选择一本已导入资料即可。这里只显示短摘要，生成时使用核验后的当前版本片段。</p>
      <div className="row prep-toolbar"><b>可用资料</b><button className="btn small" disabled={busy} onClick={onRefresh}>刷新列表</button></div>
      <div className="prep-source-list">
        {candidates.map((source) => (
          <label className={`prep-source ${selectedVersionId === source.versionId ? 'selected' : ''}`} key={source.versionId}>
            <input
              type="radio"
              name="preparation-source"
              aria-label={`选择 ${source.title}`}
              checked={selectedVersionId === source.versionId}
              onChange={() => onSelect(source.versionId)}
            />
            <span>
              <span className="prep-source-head">
                <b>{source.title}</b>
                {selectedVersionId === source.versionId && <span className="prep-selected">已选择</span>}
              </span>
              <span className="muted small">第 {source.version} 版 · {CLASSIFICATION_LABELS[source.classification] ?? source.classification}</span>
              <small className="prep-source-preview">摘要：{sourceSummary(source.preview, source.previewTruncated)}</small>
            </span>
          </label>
        ))}
        {candidates.length === 0 && <p className="muted small">暂无可用资料。请先在“资料”页导入文件，或在下方粘贴一小段已授权文字。</p>}
      </div>
      <details className="prep-paste">
        <summary>没有合适资料？粘贴一小段</summary>
        <div className="prep-form-grid">
          <label><span>资料标题</span><input className="search-input" value={importTitle} onChange={(event) => onImportTitle(event.target.value)} /></label>
          <label className="wide"><span>已授权的教材节选或教师资料</span><textarea className="draft compact" value={importText} onChange={(event) => onImportText(event.target.value)} /></label>
        </div>
      </details>
      {modelMode && <label className="prep-consent"><input type="checkbox" checked={approvedForModel} onChange={(event) => onApproval(event.target.checked)} /> 我同意将本次选中的必要片段发送给已配置的 AI 服务</label>}
      {modelMode && !approvedForModel && <p className="muted small prep-consent-hint">勾选授权后才能使用 AI；不授权可返回上一步选择本地自拟。</p>}
      <button className="btn primary" disabled={busy || (!selectedVersionId && !importText.trim()) || (modelMode && !approvedForModel)} onClick={onContinue}>{busy ? '核验中…' : '使用所选资料继续'}</button>
    </section>
  );
}
