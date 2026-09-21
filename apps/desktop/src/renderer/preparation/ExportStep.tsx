import React from 'react';
import type { PreparationArtifactView } from './types';

void React;

export function ExportStep({ exported, artifacts, planId, revisionId, bundleId, busy, onExport, onPresent, onChange }: {
  exported: boolean;
  artifacts: PreparationArtifactView[];
  planId: string | null;
  revisionId: string | null;
  bundleId: string | null;
  busy: boolean;
  onExport: () => void;
  onPresent: () => void;
  onChange: () => void;
}): JSX.Element {
  return (
    <section className="card prep-step" aria-labelledby="prep-export-title">
      <div className="card-title" id="prep-export-title">5. 五文件与课堂使用</div>
      <p className="mono small">计划 {planId} · 修订 {revisionId}{bundleId ? ` · 成品包 ${bundleId}` : ''}</p>
      {!exported && <button className="btn primary" disabled={busy} onClick={onExport}>{busy ? '正在原子生成并复核…' : '生成并登记三类五文件'}</button>}
      {exported && <>
        <ul className="prep-artifacts">{artifacts.map((artifact) => <li key={`${artifact.role}:${artifact.format}`}><b>{artifact.filename}</b><span>{artifact.byteSize.toLocaleString('zh-CN')} bytes</span><code>{artifact.sha256}</code></li>)}</ul>
        <div className="confirm-actions"><button className="btn primary" onClick={onPresent}>打开课堂展示</button><button className="btn" onClick={onChange}>去“一处修改”</button></div>
      </>}
    </section>
  );
}
