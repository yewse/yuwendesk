import React, { useEffect, useMemo, useState } from 'react';
import type { LessonPlan } from '../../main/lesson/types';
import type { PreparationSession, TeachingContext } from '../../main/preparation/types';
import type { ReviewReport } from '../../main/review/types';
import type {
  IpcResponse,
  PreparationContextPayload,
  PreparationSessionSummaryDTO,
  PreparationSourcePayload,
  SourceHitDTO,
  SourceListItemDTO
} from '../../shared/ipc';
import { AiPreparationResult, preparationStatusLabel } from './AiPreparationResult';
import { AiPreparationStart } from './AiPreparationStart';
import { BuildStep } from './BuildStep';
import type { ContextDraft } from './ContextStep';
import { confirmAndExport, runAiPlanning, type AiFlowGateway } from './aiFlow';
import { resolveLessonExcerpt } from './sourceExcerpt';
import type { PreparationArtifactView, PreparationResumeDTO, SourceCandidateView } from './types';

void React;

const EMPTY_CONTEXT: ContextDraft = {
  classDisplayName: '当前班级', grade: 'grade7', textbookTitle: '', textbookEdition: '', unitTitle: '',
  lessonTitle: '', durationSec: 2700, durationMinutes: 45, notes: ''
};

const TEXT_EXT: Record<string, string> = { txt: 'txt', md: 'md', markdown: 'md', csv: 'csv' };
const BINARY_EXT: Record<string, string> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

function requestKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取这个文件。'));
    reader.onload = () => {
      const value = String(reader.result);
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '');
}

function unwrap<T>(response: IpcResponse<T>): T {
  if (response.ok) return response.data;
  throw new Error(`${response.error.message_zh} ${response.error.next_action}`.trim());
}

function windowGateway(): AiFlowGateway {
  return {
    saveContext: async (payload, expectedRevision, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationContextSave(payload, expectedRevision, idempotencyKey)) as { context: TeachingContext };
      return data.context;
    },
    createSession: async (contextId, mode, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationSessionCreate(contextId, mode, idempotencyKey)) as { session: PreparationSession };
      return data.session;
    },
    setSources: async (sessionId, sources, expectedRevision, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationSourcesSet(sessionId, sources, expectedRevision, idempotencyKey)) as { session: PreparationSession };
      return data.session;
    },
    build: async (sessionId, guidance, expectedRevision, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationBuild(
        { sessionId, focus: guidance, coreTask: '', answerScope: '' },
        expectedRevision,
        idempotencyKey
      )) as { session: PreparationSession };
      return data.session;
    },
    review: async (sessionId, expectedRevision, idempotencyKey) => {
      return unwrap(await window.yuwen.preparationReview(sessionId, expectedRevision, idempotencyKey)) as {
        session: PreparationSession;
        report: ReviewReport;
      };
    },
    confirm: async (sessionId, expectedRevision, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationConfirm(sessionId, expectedRevision, idempotencyKey)) as { session: PreparationSession };
      return data.session;
    },
    exportFiles: async (sessionId, expectedRevision, idempotencyKey) => {
      const data = unwrap(await window.yuwen.preparationExport(sessionId, expectedRevision, idempotencyKey)) as { session: PreparationSession };
      return data.session;
    }
  };
}

export function PreparePage({ onOpenCourses }: { onOpenCourses: () => void }): JSX.Element {
  const [session, setSession] = useState<PreparationSession | null>(null);
  const [context, setContext] = useState<TeachingContext | null>(null);
  const [contextDraft, setContextDraft] = useState<ContextDraft>(EMPTY_CONTEXT);
  const [plan, setPlan] = useState<LessonPlan | null>(null);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [artifacts, setArtifacts] = useState<PreparationArtifactView[]>([]);
  const [sessions, setSessions] = useState<PreparationSessionSummaryDTO[]>([]);
  const [candidates, setCandidates] = useState<SourceCandidateView[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [approvedForModel, setApprovedForModel] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [localFocus, setLocalFocus] = useState('');
  const [localCoreTask, setLocalCoreTask] = useState('');
  const [localAnswerScope, setLocalAnswerScope] = useState('');
  const [localFallback, setLocalFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [stageMessage, setStageMessage] = useState('');

  const gateway = useMemo(() => windowGateway(), []);
  const resultVisible = Boolean(session && ['PLAN_REVIEW', 'READY_TO_EXPORT', 'EXPORTING', 'EXPORTED'].includes(session.status));
  const progressIndex = resultVisible ? 2 : selectedVersionId ? 1 : 0;

  function applyResume(data: PreparationResumeDTO): void {
    setSession(data.session);
    setContext(data.context);
    setContextDraft({ ...data.context, durationMinutes: Math.round(data.context.durationSec / 60) });
    setGuidance(data.session.focus);
    setPlan(data.plan);
    setReport(data.report);
    setArtifacts(data.artifacts);
    setLocalFallback(false);
  }

  async function resume(sessionId: string, announce = true): Promise<void> {
    const response = await window.yuwen.preparationResume(sessionId);
    if (!response.ok) {
      setMessage(`${response.error.message_zh} ${response.error.next_action}`);
      return;
    }
    applyResume(response.data as PreparationResumeDTO);
    if (announce) setMessage(`已打开上次的“${response.data.context.lessonTitle}”：${preparationStatusLabel(response.data.session.status)}`);
  }

  async function loadSessions(): Promise<void> {
    const response = await window.yuwen.preparationSessionList();
    if (response.ok) setSessions(response.data.sessions);
  }

  async function loadCandidates(preferredVersionId = ''): Promise<void> {
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
    const selected = preferredVersionId || selectedVersionId || next[0]?.versionId || '';
    setSelectedVersionId(next.some((item) => item.versionId === selected) ? selected : next[0]?.versionId ?? '');
  }

  useEffect(() => {
    void loadSessions();
    void loadCandidates();
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成，资料和本课信息仍然保留。');
    } finally {
      setBusy(false);
      setStageMessage('');
    }
  }

  async function importFiles(files: FileList | File[]): Promise<void> {
    await run(async () => {
      const list = Array.from(files);
      let preferredVersionId = '';
      const notes: string[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        setStageMessage(`正在导入 ${index + 1}/${list.length}：${file.name}`);
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        const textFormat = TEXT_EXT[extension];
        const binaryFormat = BINARY_EXT[extension];
        if (!textFormat && !binaryFormat) {
          notes.push(`“${file.name}”格式暂不支持`);
          continue;
        }
        const response = textFormat
          ? await window.yuwen.importSource({ title: file.name, format: textFormat, content: await file.text() })
          : await window.yuwen.importFile({
            title: file.name,
            format: binaryFormat,
            base64: await readAsBase64(file),
            jobId: `prepare-${Date.now()}-${index}`
          });
        if (!response.ok) {
          notes.push(`“${file.name}”未导入：${response.error.message_zh}`);
          continue;
        }
        if (response.data.status === 'needs_confirmation') {
          notes.push(`“${file.name}”与已有资料同名，请在“资料”页确认它是新版本还是独立文件`);
          continue;
        }
        if (response.data.status === 'cancelled') {
          notes.push(`“${file.name}”已取消`);
          continue;
        }
        if (response.data.versionId) preferredVersionId = response.data.versionId;
        notes.push(response.data.status === 'duplicate' ? `“${file.name}”已存在，继续使用已有版本` : `“${file.name}”已导入`);
        setContextDraft((current) => ({
          ...current,
          textbookTitle: current.textbookTitle.trim() ? current.textbookTitle : stripExtension(file.name)
        }));
      }
      await loadCandidates(preferredVersionId);
      setMessage(notes.join('；'));
    });
  }

  async function startAiPreparation(): Promise<void> {
    const source = candidates.find((item) => item.versionId === selectedVersionId);
    if (!source || !approvedForModel || !contextDraft.lessonTitle.trim()) return;
    await run(async () => {
      setStageMessage('正在核验所选资料…');
      const excerpt = await resolveLessonExcerpt({
        search: async (query) => {
          const data = unwrap(await window.yuwen.searchSources(query)) as { hits: SourceHitDTO[] };
          return data.hits;
        },
        read: async (versionId, charStart, charEnd) => unwrap(
          await window.yuwen.readSource(versionId, charStart, charEnd)
        )
      }, source.versionId, contextDraft.lessonTitle);
      setStageMessage(`已定位${excerpt.locatorLabel}，正在准备 AI 所需正文…`);
      const payload: PreparationContextPayload = {
        ...(context?.contextId ? { contextId: context.contextId } : {}),
        classDisplayName: contextDraft.classDisplayName.trim() || '当前班级',
        grade: contextDraft.grade,
        textbookTitle: contextDraft.textbookTitle.trim() || stripExtension(source.title),
        textbookEdition: contextDraft.textbookEdition.trim(),
        unitTitle: contextDraft.unitTitle.trim(),
        lessonTitle: contextDraft.lessonTitle.trim(),
        durationSec: Math.round(contextDraft.durationMinutes * 60),
        notes: contextDraft.notes.trim()
      };
      const selectedSource: PreparationSourcePayload = {
        ordinal: 0,
        sourceVersionId: source.versionId,
        charStart: excerpt.charStart,
        charEnd: excerpt.charEnd,
        purpose: 'textbook',
        approvedForModel: true,
        textSha256: await sha256(excerpt.text)
      };
      setStageMessage('AI 正在规划教学目标、课堂任务和活动…');
      let activeSessionId = '';
      let planned: { session: PreparationSession; report: ReviewReport };
      try {
        planned = await runAiPlanning(gateway, {
          context: payload,
          contextRevision: context?.revision ?? 0,
          source: selectedSource,
          guidance: guidance.trim(),
          idempotencyPrefix: requestKey('ai-plan'),
          onSession: (nextSession) => {
            activeSessionId = nextSession.sessionId;
            setSession(nextSession);
          }
        });
      } catch (error) {
        if (activeSessionId) {
          const current = await window.yuwen.preparationSessionGet(activeSessionId);
          if (current.ok) setSession((current.data as { session: PreparationSession }).session);
        }
        throw error;
      }
      setStageMessage('正在检查方案完整性…');
      await resume(planned.session.sessionId, false);
      await loadSessions();
      setMessage(planned.report.disposition === 'ready_for_teacher'
        ? 'AI 方案已经准备好，请确认是否适合你的班级。'
        : 'AI 方案未通过完整性检查，未生成教学文件。');
    });
  }

  async function confirmAndGenerate(): Promise<void> {
    if (!session) return;
    await run(async () => {
      setStageMessage('正在生成课堂课件、学生讲义和教师教案…');
      const exported = session.status === 'READY_TO_EXPORT'
        ? await gateway.exportFiles(session.sessionId, session.revision, requestKey('ai-export'))
        : await confirmAndExport(gateway, session, requestKey('ai-finalize'));
      await resume(exported.sessionId, false);
      await loadSessions();
      setMessage('教学文件已经生成并完成一致性检查。');
    });
  }

  async function buildLocal(): Promise<void> {
    if (!session) return;
    await run(async () => {
      const data = unwrap(await window.yuwen.preparationBuild({
        sessionId: session.sessionId,
        focus: localFocus,
        coreTask: localCoreTask,
        answerScope: localAnswerScope
      }, session.revision, requestKey('local-build'))) as { session: PreparationSession };
      const reviewed = unwrap(await window.yuwen.preparationReview(data.session.sessionId, data.session.revision, requestKey('local-review'))) as {
        session: PreparationSession;
        report: ReviewReport;
      };
      await resume(reviewed.session.sessionId, false);
      setMessage('离线方案已形成，请确认后生成教学文件。');
    });
  }

  async function openPresentation(): Promise<void> {
    if (!session) return;
    const response = await window.yuwen.presentationOpen(session.sessionId);
    setMessage(response.ok ? '课堂展示已打开，提示和答案默认隐藏。' : `${response.error.message_zh} ${response.error.next_action}`);
  }

  function startFresh(): void {
    setSession(null);
    setContext(null);
    setPlan(null);
    setReport(null);
    setArtifacts([]);
    setLocalFallback(false);
    setMessage('');
  }

  return (
    <div className="page preparation-page ai-preparation-page">
      <div className="ai-hero">
        <div><p className="eyebrow">AI 语文备课助手</p><h1>把资料交给 AI，备好这一课</h1><p className="lead">导入教材或教师资料，填写年级、课题和课时；AI 自动规划教案、课堂课件、学生讲义和教师用稿。</p></div>
        {sessions.length > 0 && <details className="prep-resume"><summary>继续上次备课</summary><div className="prep-resume-list"><select className="search-input" aria-label="选择上次备课" value={session?.sessionId ?? ''} onChange={(event) => void resume(event.target.value)}><option value="">请选择</option>{sessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{preparationStatusLabel(item.status as PreparationSession['status'])} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</option>)}</select><button className="btn small" onClick={startFresh}>开始新备课</button></div></details>}
      </div>
      <ol className="ai-progress" aria-label="备课只需三步">{['导入资料', '填写本课信息', 'AI 生成结果'].map((label, index) => <li className={index <= progressIndex ? 'active' : ''} key={label}><span>{index + 1}</span>{label}</li>)}</ol>
      {message && <div className="notice" role="status" aria-live="polite">{message}</div>}
      {resultVisible && session ? (
        <AiPreparationResult session={session} plan={plan} report={report} artifacts={artifacts} busy={busy} onConfirmAndExport={() => void confirmAndGenerate()} onPresent={() => void openPresentation()} onChange={onOpenCourses} onRetry={startFresh} />
      ) : localFallback && session ? (
        <BuildStep focus={localFocus} coreTask={localCoreTask} answerScope={localAnswerScope} mode="local_authored" busy={busy} localFallback={false} onFocus={setLocalFocus} onCoreTask={setLocalCoreTask} onAnswerScope={setLocalAnswerScope} onBuild={() => void buildLocal()} onUseLocal={() => undefined} />
      ) : (
        <AiPreparationStart candidates={candidates} selectedVersionId={selectedVersionId} context={contextDraft} guidance={guidance} approvedForModel={approvedForModel} busy={busy} stageMessage={stageMessage} onFiles={(files) => void importFiles(files)} onSelect={setSelectedVersionId} onContext={setContextDraft} onGuidance={setGuidance} onApproval={setApprovedForModel} onStart={() => void startAiPreparation()} />
      )}
      {session?.mode === 'model_assisted' && ['PREPARATION_MODEL_UNAVAILABLE', 'PREPARATION_MODEL_INVALID'].includes(session.lastErrorCode ?? '') && !localFallback && (
        <div className="notice warn small">AI 暂时没有形成可用方案。资料和本课信息已经保留；可在“帮助与设置”检查 AI 连接，或<button className="btn small" onClick={() => setLocalFallback(true)}>改用离线手动方案</button></div>
      )}
    </div>
  );
}
