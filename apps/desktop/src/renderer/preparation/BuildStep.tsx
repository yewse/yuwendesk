import React from 'react';

void React;

export function BuildStep({ focus, coreTask, answerScope, modeLabel, busy, localFallback, onFocus, onCoreTask, onAnswerScope, onBuild, onUseLocal }: {
  focus: string;
  coreTask: string;
  answerScope: string;
  modeLabel: string;
  busy: boolean;
  localFallback: boolean;
  onFocus: (value: string) => void;
  onCoreTask: (value: string) => void;
  onAnswerScope: (value: string) => void;
  onBuild: () => void;
  onUseLocal: () => void;
}): JSX.Element {
  return (
    <section className="card prep-step" aria-labelledby="prep-build-title">
      <div className="card-title" id="prep-build-title">3. 生成方案 · {modeLabel}</div>
      <p className="muted small">这里填写教学判断，不填写模型提示词。本地模式不会访问网络。</p>
      <div className="prep-form-grid">
        <label className="wide"><span>教学重点</span><textarea className="draft compact" value={focus} onChange={(event) => onFocus(event.target.value)} /></label>
        <label className="wide"><span>核心任务</span><textarea className="draft compact" value={coreTask} onChange={(event) => onCoreTask(event.target.value)} /></label>
        <label className="wide"><span>合理答案范围</span><textarea className="draft compact" value={answerScope} onChange={(event) => onAnswerScope(event.target.value)} /></label>
      </div>
      {localFallback && <div className="notice warn small">模型未形成可用方案，没有自动重试或保存半成品。<button className="btn small" disabled={busy} onClick={onUseLocal}>改用本地自拟</button></div>}
      <button className="btn primary" disabled={busy || !focus.trim() || !coreTask.trim() || !answerScope.trim()} onClick={onBuild}>{busy ? '正在生成…' : '生成一个可审查方案'}</button>
    </section>
  );
}
