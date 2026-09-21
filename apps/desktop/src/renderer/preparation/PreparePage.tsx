import React, { useEffect, useMemo, useState } from 'react';
import type { LessonPlan } from '../../main/lesson/types';
import type { PreparationSession, TeachingContext } from '../../main/preparation/types';
import type { ReviewReport } from '../../main/review/types';
import type { PreparationContextPayload, PreparationSessionSummaryDTO, SourceListItemDTO } from '../../shared/ipc';
import { BuildStep } from './BuildStep';
import { ContextStep, type ContextDraft } from './ContextStep';
import { ExportStep } from './ExportStep';
import { PlanReviewStep } from './PlanReviewStep';
import { SourceSelectionStep } from './SourceSelectionStep';
import type { PreparationArtifactView, PreparationResumeDTO, SourceCandidateView } from './types';
import { buildPreparationView } from './viewModel';

void React;

const EMPTY_CONTEXT: ContextDraft = {
  classDisplayName: '', grade: 'grade7', textbookTitle: '', textbookEdition: '', unitTitle: '',
  lessonTitle: '', durationSec: 2700, durationMinutes: 45, notes: ''
};

function requestKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function PreparePage({ onOpenCourses }: { onOpenCourses: () => void }): JSX.Element {
  const [session, setSession] = useState<PreparationSession | null>(null);
  const [context, setContext] = useState<TeachingContext | null>(null);
  const [contextDraft, setContextDraft] = useState<ContextDraft>(EMPTY_CONTEXT);
  const [mode, setMode] = useState<'local_authored' | 'model_assisted'>('model_assisted');
  const [plan, setPlan] = useState<LessonPlan | null>(null);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [artifacts, setArtifacts] = useState<PreparationArtifactView[]>([]);
  const [sessions, setSessions] = useState<PreparationSessionSummaryDTO[]>([]);
  const [candidates, setCandidates] = useState<SourceCandidateView[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [importTitle, setImportTitle] = useState('教材节选');
  const [importText, setImportText] = useState('');
  const [approvedForModel, setApprovedForModel] = useState(false);
  const [focus, setFocus] = useState('');
  const [coreTask, setCoreTask] = useState('');
  const [answerScope, setAnswerScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const view = useMemo(() => buildPreparationView({ session, plan, report, artifacts }), [session, plan, report, artifacts]);

  async function resume(sessionId: string): Promise<void> {
    const response = await window.yuwen.preparationResume(sessionId);
    if (!response.ok) {
      setMessage(`${response.error.message_zh} ${response.error.next_action}`);
      return;
    }
    const data = response.data as PreparationResumeDTO;
    setSession(data.session);
    setContext(data.context);
    setContextDraft({ ...data.context, durationMinutes: Math.round(data.context.durationSec / 60) });
    setMode(data.session.mode);
    setFocus(data.session.focus);
    setCoreTask(data.session.coreTask);
    setAnswerScope(data.session.answerScope);
    setPlan(data.plan);
    setReport(data.report);
    setArtifacts(data.artifacts);
    setMessage(`已恢复 ${data.context.classDisplayName} · ${data.context.lessonTitle}`);
  }

  async function loadSessions(): Promise<void> {
    const response = await window.yuwen.preparationSessionList();
    if (!response.ok) return;
    setSessions(response.data.sessions);
    if (!session && response.data.sessions[0]) await resume(response.data.sessions[0].sessionId);
  }

  async function loadCandidates(): Promise<void> {
    const response = await window.yuwen.listSources();
    if (!response.ok) return;
    const next: SourceCandidateView[] = [];
    for (const source of response.data.sources.filter((item: SourceListItemDTO) => item.status === 'active')) {
      const versions = await window.yuwen.sourceVersions(source.documentId);
      if (!versions.ok) continue;
      const current = versions.data.versions.find((item) => item.isCurrent);
      if (!current) continue;
      const read = await window.yuwen.readSource(current.versionId);
      if (!read.ok || !read.data.text) continue;
      next.push({
        documentId: source.documentId,
        versionId: current.versionId,
        title: source.title,
        version: current.version,
        classification: source.classification,
        preview: read.data.text,
        previewTruncated: read.data.truncated
      });
    }
    setCandidates(next);
    if (!selectedVersionId && next[0]) setSelectedVersionId(next[0].versionId);
  }

  useEffect(() => { void loadSessions(); }, []);
  useEffect(() => {
    if (session?.status === 'CONTEXT_DRAFT') void loadCandidates();
  }, [session?.status]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try { await action(); } catch { setMessage('操作未完成；现有内容保持不变，请重试。'); } finally { setBusy(false); }
  }

  async function saveContext(): Promise<void> {
    await run(async () => {
      const payload: PreparationContextPayload = {
        ...(context?.contextId ? { contextId: context.contextId } : {}),
        classDisplayName: contextDraft.classDisplayName.trim(),
        grade: contextDraft.grade,
        textbookTitle: contextDraft.textbookTitle.trim(),
        textbookEdition: contextDraft.textbookEdition.trim(),
        unitTitle: contextDraft.unitTitle.trim(),
        lessonTitle: contextDraft.lessonTitle.trim(),
        durationSec: Math.round(contextDraft.durationMinutes * 60),
        notes: contextDraft.notes.trim()
      };
      const saved = await window.yuwen.preparationContextSave(payload, context?.revision ?? 0, requestKey('context'));
      if (!saved.ok) { setMessage(`${saved.error.message_zh} ${saved.error.next_action}`); return; }
      const savedContext = (saved.data as { context: TeachingContext }).context;
      const created = await window.yuwen.preparationSessionCreate(savedContext.contextId, mode, requestKey('session'));
      if (!created.ok) { setMessage(`${created.error.message_zh} ${created.error.next_action}`); return; }
      const createdSession = (created.data as { session: PreparationSession }).session;
      setContext(savedContext);
      setSession(createdSession);
      setSessions((current) => [{
        sessionId: createdSession.sessionId, contextId: createdSession.contextId, status: createdSession.status,
        mode: createdSession.mode, revision: createdSession.revision, updatedAt: createdSession.updatedAt
      }, ...current]);
      await loadCandidates();
      setMessage('教学上下文已保存。请选择一段当前资料。');
    });
  }

  async function selectSource(): Promise<void> {
    if (!session) return;
    await run(async () => {
      let versionId = selectedVersionId;
      if (importText.trim()) {
        const imported = await window.yuwen.importSource({ title: importTitle.trim() || '备课资料', format: 'txt', content: importText.trim() });
        if (!imported.ok || !imported.data.versionId) {
          setMessage(imported.ok ? '资料未导入，请检查是否与已有资料重复。' : imported.error.message_zh);
          return;
        }
        versionId = imported.data.versionId;
      }
      const exact = await window.yuwen.readSource(versionId);
      if (!exact.ok || !exact.data.text) { setMessage('无法读取当前资料片段，请刷新资料。'); return; }
      const selected = await window.yuwen.preparationSourcesSet(session.sessionId, [{
        ordinal: 0,
        sourceVersionId: versionId,
        charStart: 0,
        charEnd: exact.data.text.length,
        purpose: 'textbook',
        approvedForModel: session.mode === 'model_assisted' && approvedForModel,
        textSha256: await sha256(exact.data.text)
      }], session.revision, requestKey('sources'));
      if (!selected.ok) { setMessage(`${selected.error.message_zh} ${selected.error.next_action}`); return; }
      setImportText('');
      setSession((selected.data as { session: PreparationSession }).session);
      setMessage('资料片段已核验并绑定。');
    });
  }

  async function build(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const response = await window.yuwen.preparationBuild({ sessionId: session.sessionId, focus, coreTask, answerScope }, session.revision, requestKey('build'));
      if (!response.ok) {
        setMessage(`${response.error.message_zh} ${response.error.next_action}`);
        const current = await window.yuwen.preparationSessionGet(session.sessionId);
        if (current.ok) setSession((current.data as { session: PreparationSession }).session);
        return;
      }
      await resume(session.sessionId);
      setMessage('已生成一个方案，请检查任务、未知项和内容来源。');
    });
  }

  async function useLocalFallback(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const created = await window.yuwen.preparationSessionCreate(session.contextId, 'local_authored', requestKey('local-fallback'));
      if (!created.ok) { setMessage(created.error.message_zh); return; }
      const local = (created.data as { session: PreparationSession }).session;
      const selected = await window.yuwen.preparationSourcesSet(local.sessionId, session.sources.map((source) => ({
        ordinal: source.ordinal, sourceVersionId: source.sourceVersionId, charStart: source.charStart,
        charEnd: source.charEnd, purpose: source.purpose, approvedForModel: false, textSha256: source.textSha256
      })), local.revision, requestKey('local-sources'));
      if (!selected.ok) { setMessage(selected.error.message_zh); return; }
      setSession((selected.data as { session: PreparationSession }).session);
      setMode('local_authored');
      setFocus('');
      setCoreTask('');
      setAnswerScope('');
      setMessage('已创建本地自拟会话，资料未重复导入。');
    });
  }

  async function review(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const response = await window.yuwen.preparationReview(session.sessionId, session.revision, requestKey('review'));
      if (!response.ok) { setMessage(`${response.error.message_zh} ${response.error.next_action}`); return; }
      const data = response.data as { session: PreparationSession; report: ReviewReport };
      setSession(data.session);
      setReport(data.report);
      setMessage(data.report.disposition === 'ready_for_teacher' ? '软件审查通过，等待教师确认。' : '方案仍有需修正项目。');
    });
  }

  async function confirm(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const response = await window.yuwen.preparationConfirm(session.sessionId, session.revision, requestKey('confirm'));
      if (!response.ok) { setMessage(`${response.error.message_zh} ${response.error.next_action}`); return; }
      await resume(session.sessionId);
      setMessage('教师确认已记录，可以生成五文件。');
    });
  }

  async function exportFiles(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const response = await window.yuwen.preparationExport(session.sessionId, session.revision, requestKey('export'));
      if (!response.ok) { setMessage(`${response.error.message_zh} ${response.error.next_action}`); return; }
      await resume(session.sessionId);
      setMessage('五文件已原子生成、回读校验并登记。');
    });
  }

  async function openPresentation(): Promise<void> {
    if (!session) return;
    const response = await window.yuwen.presentationOpen(session.sessionId);
    setMessage(response.ok ? '课堂展示窗口已打开；提示和答案默认隐藏。' : `${response.error.message_zh} ${response.error.next_action}`);
  }

  return (
    <div className="page preparation-page">
      <div className="row prep-heading"><div><h1>备下一课</h1><p className="lead">导入资料 → 生成方案 → 软件审查 → 教师确认 → 五文件 → 课堂展示与一处修改。</p></div>{sessions.length > 0 && <label><span className="small muted">恢复备课</span><select className="search-input" value={session?.sessionId ?? ''} onChange={(event) => void resume(event.target.value)}>{sessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.status} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</option>)}</select></label>}</div>
      <ol className="prep-progress" aria-label="备课进度">{['上下文', '资料', '生成', '审查', '导出', '完成'].map((label, index) => <li className={index <= view.progressIndex ? 'active' : ''} key={label}>{label}</li>)}</ol>
      {message && <div className="notice" role="status" aria-live="polite">{message}</div>}
      {view.step === 'context' && <ContextStep value={contextDraft} mode={mode} busy={busy} onChange={setContextDraft} onModeChange={setMode} onSave={() => void saveContext()} />}
      {view.step === 'sources' && <SourceSelectionStep candidates={candidates} selectedVersionId={selectedVersionId} importTitle={importTitle} importText={importText} approvedForModel={approvedForModel} modelMode={session?.mode === 'model_assisted'} busy={busy} onRefresh={() => void loadCandidates()} onSelect={setSelectedVersionId} onImportTitle={setImportTitle} onImportText={setImportText} onApproval={setApprovedForModel} onContinue={() => void selectSource()} />}
      {view.step === 'build' && <BuildStep focus={focus} coreTask={coreTask} answerScope={answerScope} mode={session?.mode ?? mode} busy={busy || session?.status === 'BUILDING'} localFallback={view.localFallbackAvailable} onFocus={setFocus} onCoreTask={setCoreTask} onAnswerScope={setAnswerScope} onBuild={() => void build()} onUseLocal={() => void useLocalFallback()} />}
      {view.step === 'review' && <PlanReviewStep plan={plan} report={report} originLabel={view.originLabel} busy={busy} onReview={() => void review()} onConfirm={() => void confirm()} />}
      {(view.step === 'export' || view.step === 'complete') && <ExportStep exported={view.step === 'complete'} artifacts={artifacts} planId={view.planId} revisionId={view.revisionId} bundleId={view.bundleId} busy={busy || session?.status === 'EXPORTING'} onExport={() => void exportFiles()} onPresent={() => void openPresentation()} onChange={onOpenCourses} />}
    </div>
  );
}
