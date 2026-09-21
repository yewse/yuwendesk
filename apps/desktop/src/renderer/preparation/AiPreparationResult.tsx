import React from 'react';
import type { LessonPlan } from '../../main/lesson/types';
import type { PreparationSession } from '../../main/preparation/types';
import type { ReviewReport } from '../../main/review/types';
import type { PreparationArtifactView } from './types';

void React;

const STATUS_LABELS: Record<PreparationSession['status'], string> = {
  CONTEXT_DRAFT: '等待选择资料',
  SOURCES_SELECTED: '可以开始 AI 备课',
  BUILDING: 'AI 正在生成方案',
  PLAN_REVIEW: 'AI 方案待确认',
  READY_TO_EXPORT: '可以生成教学文件',
  EXPORTING: '正在生成教学文件',
  EXPORTED: '教学文件已生成'
};

export function preparationStatusLabel(status: PreparationSession['status']): string {
  return STATUS_LABELS[status];
}

const OUTPUT_LABELS: Record<string, string> = {
  presentation: '课堂课件',
  student: '学生讲义',
  teacher: '教师教案'
};

export function AiPreparationResult({ session, plan, report, artifacts, busy, onConfirmAndExport, onPresent, onChange, onRetry }: {
  session: PreparationSession;
  plan: LessonPlan | null;
  report: ReviewReport | null;
  artifacts: PreparationArtifactView[];
  busy: boolean;
  onConfirmAndExport: () => void;
  onPresent: () => void;
  onChange: () => void;
  onRetry: () => void;
}): JSX.Element {
  const exported = session.status === 'EXPORTED';
  const ready = report?.disposition === 'ready_for_teacher';
  if (exported) {
    const roles = ['presentation', 'student', 'teacher'];
    return (
      <section className="card ai-result" aria-labelledby="ai-result-title">
        <div className="ai-result-success" aria-hidden="true">✓</div>
        <h2 id="ai-result-title">备课完成，可以上课了</h2>
        <p className="lead">AI 已生成课堂使用材料。你可以直接打开课堂展示，或先调整方案。</p>
        <div className="ai-output-groups">
          {roles.map((role) => {
            const files = artifacts.filter((artifact) => artifact.role === role);
            return (
              <div className="ai-output-group" key={role}>
                <h3>{OUTPUT_LABELS[role]}</h3>
                {files.length === 0 ? <p className="muted small">尚未读取到文件清单</p> : <ul>{files.map((file) => <li key={`${file.role}:${file.format}`}>{file.filename}</li>)}</ul>}
              </div>
            );
          })}
        </div>
        <div className="confirm-actions"><button className="btn primary" onClick={onPresent}>打开课堂展示</button><button className="btn" onClick={onChange}>调整方案</button></div>
        <details className="ai-technical-details"><summary>查看文件校验信息</summary><ul>{artifacts.map((file) => <li key={`${file.role}:${file.format}`}><span>{file.filename}</span><code>{file.sha256}</code></li>)}</ul></details>
      </section>
    );
  }

  return (
    <section className="card ai-result" aria-labelledby="ai-result-title">
      <span className="tag">{preparationStatusLabel(session.status)}</span>
      <h2 id="ai-result-title">AI 已完成备课方案</h2>
      <h3>{plan?.title ?? '正在读取方案'}</h3>
      <p className="lead">{plan?.teacher_summary}</p>
      <div className="ai-plan-columns">
        <div><h3>课堂核心任务</h3><ol>{plan?.tasks.map((task) => <li key={task.task_id}>{task.prompt}</li>)}</ol></div>
        <div><h3>确认前请留意</h3>{plan?.unknowns.length ? <ul>{plan.unknowns.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">没有额外待核实事项。</p>}</div>
      </div>
      {ready ? (
        <><p className="notice ok small">方案结构和引用已完成完整性检查。请确认它适合你的班级后生成教学文件。</p><button className="btn primary ai-primary-action" disabled={busy} onClick={onConfirmAndExport}>{busy ? '正在生成教学文件…' : '确认方案并生成教学文件'}</button></>
      ) : (
        <><p className="notice warn small">方案没有通过完整性检查，未生成教学文件。请调整补充要求后重新生成。</p><button className="btn" disabled={busy} onClick={onRetry}>返回修改要求</button></>
      )}
      <details className="ai-technical-details"><summary>查看生成与检查说明</summary><p className="small">内容来源：{session.contentOrigin === 'model_assisted_real' ? '已配置 AI 服务' : session.contentOrigin === 'model_assisted_simulated' ? '模拟 AI（非真实服务）' : '本地自拟'}</p><p className="small">未执行的外部检查：{report?.not_executed_checks.join('、') || '无'}</p></details>
    </section>
  );
}
