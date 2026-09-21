import React from 'react';
import type { PreparationContextPayload } from '../../shared/ipc';

void React;

export interface ContextDraft extends PreparationContextPayload {
  durationMinutes: number;
}

export function ContextStep({ value, mode, busy, onChange, onModeChange, onSave }: {
  value: ContextDraft;
  mode: 'local_authored' | 'model_assisted';
  busy: boolean;
  onChange: (value: ContextDraft) => void;
  onModeChange: (mode: 'local_authored' | 'model_assisted') => void;
  onSave: () => void;
}): JSX.Element {
  const field = (key: keyof ContextDraft, label: string, required = false): JSX.Element => (
    <label>
      <span>{label}</span>
      <input
        className="search-input"
        required={required}
        value={String(value[key] ?? '')}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <section className="card prep-step" aria-labelledby="prep-context-title">
      <div className="card-title" id="prep-context-title">1. 班级、教材与课时</div>
      <div className="prep-form-grid">
        {field('classDisplayName', '班级简称（不填学生姓名）', true)}
        <label><span>年级</span><select className="search-input" value={value.grade} onChange={(event) => onChange({ ...value, grade: event.target.value as ContextDraft['grade'] })}><option value="grade7">七年级</option><option value="grade8">八年级</option><option value="grade9">九年级</option><option value="other">其他</option></select></label>
        {field('textbookTitle', '教材', true)}
        {field('textbookEdition', '教材版本（不确定可留空）')}
        {field('unitTitle', '单元')}
        {field('lessonTitle', '课题', true)}
        <label><span>课时（分钟）</span><input className="search-input" type="number" min={5} max={240} value={value.durationMinutes} onChange={(event) => onChange({ ...value, durationMinutes: Number(event.target.value) })} /></label>
        <label className="wide"><span>本地备注（可选）</span><textarea className="draft compact" value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} /></label>
      </div>
      <fieldset className="prep-mode">
        <legend>生成方式</legend>
        <label><input type="radio" checked={mode === 'local_authored'} onChange={() => onModeChange('local_authored')} /> 本地自拟（离线可完成）</label>
        <label><input type="radio" checked={mode === 'model_assisted'} onChange={() => onModeChange('model_assisted')} /> 模型辅助（只发送逐片段授权内容）</label>
      </fieldset>
      <button className="btn primary" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存并选择资料'}</button>
    </section>
  );
}
