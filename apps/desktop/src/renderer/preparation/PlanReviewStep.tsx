import React from 'react';
import type { LessonPlan } from '../../main/lesson/types';
import type { ReviewReport } from '../../main/review/types';

void React;

export function PlanReviewStep({ plan, report, originLabel, busy, onReview, onConfirm }: {
  plan: LessonPlan | null;
  report: ReviewReport | null;
  originLabel: string;
  busy: boolean;
  onReview: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const ready = report?.disposition === 'ready_for_teacher';
  return (
    <section className="card prep-step" aria-labelledby="prep-review-title">
      <div className="card-title" id="prep-review-title">4. 审查并由教师确认</div>
      <div className="row prep-toolbar"><span className="tag">{originLabel}</span><span className="mono small">{plan?.revision_id}</span></div>
      <h2>{plan?.title ?? '读取方案中…'}</h2>
      <p>{plan?.teacher_summary}</p>
      <h3>学习任务</h3>
      <ol>{plan?.tasks.map((task) => <li key={task.task_id}>{task.prompt}</li>)}</ol>
      <h3>待教师核实</h3>
      <ul>{plan?.unknowns.map((item) => <li key={item}>{item}</li>)}</ul>
      {report && <div className={`notice ${ready ? 'ok' : 'warn'}`}><b>软件审查：{report.disposition}</b><div className="small">未执行：{report.not_executed_checks.join('、') || '无'}</div><div className="small">软件审查不是教学有效性或真人专业复核证明。</div></div>}
      <button className="btn primary" disabled={busy || !plan} onClick={ready ? onConfirm : onReview}>{busy ? '处理中…' : ready ? '教师确认当前方案' : '运行软件审查'}</button>
    </section>
  );
}
