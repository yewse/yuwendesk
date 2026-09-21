import React from 'react';

void React;

export function BuildStep({ focus, coreTask, answerScope, mode, busy, localFallback, onFocus, onCoreTask, onAnswerScope, onBuild, onUseLocal }: {
  focus: string;
  coreTask: string;
  answerScope: string;
  mode: 'local_authored' | 'model_assisted';
  busy: boolean;
  localFallback: boolean;
  onFocus: (value: string) => void;
  onCoreTask: (value: string) => void;
  onAnswerScope: (value: string) => void;
  onBuild: () => void;
  onUseLocal: () => void;
}): JSX.Element {
  const modelMode = mode === 'model_assisted';
  return (
    <section className="card prep-step" aria-labelledby="prep-build-title">
      <div className="card-title" id="prep-build-title">3. {modelMode ? 'AI 生成完整方案' : '本地自拟方案'}</div>
      {modelMode ? (
        <>
          <p className="muted small">AI 将依据已核验资料生成教学重点、核心任务、合理答案范围和课堂活动。教师只需补充特别要求，也可以直接生成。</p>
          <div className="prep-form-grid">
            <label className="wide"><span>补充要求（可选）</span><textarea className="draft compact" placeholder="例如：照顾基础薄弱学生；突出朗读；不填也可以直接生成" value={focus} onChange={(event) => onFocus(event.target.value)} /></label>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">离线本地自拟不会访问网络，需要教师提供三项教学判断。</p>
          <div className="prep-form-grid">
            <label className="wide"><span>教学重点</span><textarea className="draft compact" value={focus} onChange={(event) => onFocus(event.target.value)} /></label>
            <label className="wide"><span>核心任务</span><textarea className="draft compact" value={coreTask} onChange={(event) => onCoreTask(event.target.value)} /></label>
            <label className="wide"><span>合理答案范围</span><textarea className="draft compact" value={answerScope} onChange={(event) => onAnswerScope(event.target.value)} /></label>
          </div>
        </>
      )}
      {localFallback && <div className="notice warn small">模型未形成可用方案，没有自动重试或保存半成品。<button className="btn small" disabled={busy} onClick={onUseLocal}>改用本地自拟</button></div>}
      <button className="btn primary" disabled={busy || (!modelMode && (!focus.trim() || !coreTask.trim() || !answerScope.trim()))} onClick={onBuild}>{busy ? '正在生成…' : modelMode ? '让 AI 生成完整方案' : '生成本地方案'}</button>
    </section>
  );
}
