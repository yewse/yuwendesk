import React from 'react';
import type { SourceCandidateView } from './types';

void React;

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
      <div className="card-title" id="prep-source-title">2. 导入并选择核验资料</div>
      <p className="muted small">可粘贴合法的教材节选或教师资料；生成只使用你选中的当前版本片段。</p>
      <div className="prep-form-grid">
        <label><span>资料标题</span><input className="search-input" value={importTitle} onChange={(event) => onImportTitle(event.target.value)} /></label>
        <label className="wide"><span>新资料文字（可选；填写后将先导入）</span><textarea className="draft compact" value={importText} onChange={(event) => onImportText(event.target.value)} /></label>
      </div>
      <div className="row prep-toolbar"><b>已导入资料</b><button className="btn small" disabled={busy} onClick={onRefresh}>刷新</button></div>
      <div className="prep-source-list">
        {candidates.map((source) => (
          <label className={`prep-source ${selectedVersionId === source.versionId ? 'selected' : ''}`} key={source.versionId}>
            <input type="radio" name="preparation-source" checked={selectedVersionId === source.versionId} onChange={() => onSelect(source.versionId)} />
            <span><b>{source.title}</b> · v{source.version} · {source.classification}<small>{source.preview}{source.previewTruncated ? '…' : ''}</small></span>
          </label>
        ))}
        {candidates.length === 0 && <p className="muted small">暂无资料。可在上方粘贴一段合成或获授权文字后继续。</p>}
      </div>
      {modelMode && <label className="prep-consent"><input type="checkbox" checked={approvedForModel} onChange={(event) => onApproval(event.target.checked)} /> 允许把本次选中的必要片段发送给已配置模型</label>}
      <button className="btn primary" disabled={busy || (!selectedVersionId && !importText.trim())} onClick={onContinue}>{busy ? '核验中…' : '核验资料并继续'}</button>
    </section>
  );
}
