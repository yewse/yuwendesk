import { useEffect, useRef, useState } from 'react';
import type { BackupRecordDTO, BootstrapData, HealthData, RestorePreviewDTO, SourceHitDTO, SourceListItemDTO, SourceReadDTO, SourceVersionDTO } from '../shared/ipc';
import type { ChangePreview, LessonChange } from '../main/change/types';
import type {
  CorrectionRecord,
  EffectEvidenceState,
  FeedbackAnalysisResult,
  ImplementationState,
  ObservationMaterialRelation,
  ObservationOutcomeValue,
  ObservationRecord,
  ObservationSelection,
  ObservationSourceKind,
  ObservationSupportLevel,
  TeachingEvent
} from '../main/feedback/types';
import { observationCoverageSummary } from '../main/feedback/observation';
import type { LessonPlan } from '../main/lesson/types';
import type { LessonChangeApplyResult } from '../main/store';
import type { UpdateSummary } from '../main/update/types';
import { DraftController, DraftSnapshot, getDraftController } from './draftController';
import {
  OBSERVATION_OUTCOME_OPTIONS,
  buildAnalysisView,
  buildCorrectionCard,
  buildEvidenceTrackView,
  buildObservationPrompt,
  buildTeachingStatus,
  teachingSubmissionKey
} from './feedbackView';
import {
  buildChangeSummary,
  needsPrintedCopyWarning,
  PRINTED_COPY_WARNING,
  type LessonChangeViewDiff
} from './lessonChangeView';
import { buildUpdateSummaryRows, canStageUpdate, updateReadyNotice, updateTrustNotice } from './updateView';
import { buildBackupRows, portableBackupNotice, restorePreviewNotice } from './protectionView';
import { buildSourceDeleteSummary, sensitiveSourceNotice, type SourceDeleteSummary } from './sourcePrivacyView';
import type { DiagnosticsPreview } from '../main/protection/diagnostics';
import { diagnosticsPreviewText, diagnosticsSaveEnabled, diagnosticsScopeNotice } from './diagnosticsView';

type NavKey = 'prepare' | 'courses' | 'resources' | 'settings';

const NAV: { key: NavKey; label: string; hint: string }[] = [
  { key: 'prepare', label: '备下一课', hint: '当前单元 · 下一任务' },
  { key: 'courses', label: '我的课程', hint: '单元与课时 · 版本' },
  { key: 'resources', label: '资料', hint: '导入 · 来源 · 覆盖' },
  { key: 'settings', label: '帮助与设置', hint: '连接 · 备份 · 诊断' }
];

function useBootstrap(): { boot: BootstrapData | null; health: HealthData | null } {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const b = await window.yuwen.bootstrap();
      if (mounted && b.ok) setBoot(b.data);
      const h = await window.yuwen.health();
      if (mounted && h.ok) setHealth(h.data);
    })();
    return () => {
      mounted = false;
    };
  }, []);
  return { boot, health };
}

function StatusPill({ online }: { online: boolean }): JSX.Element {
  return (
    <span className={`pill ${online ? 'pill-on' : 'pill-off'}`}>
      <span className="dot" />
      {online ? '已连接 AI' : '离线可用'}
    </span>
  );
}

function useDraftController(): [DraftSnapshot, DraftController] {
  const controller = getDraftController();
  const [snap, setSnap] = useState<DraftSnapshot>(() => controller.snapshot());
  useEffect(() => {
    const unsub = controller.subscribe(() => setSnap(controller.snapshot()));
    void controller.load();
    return unsub;
  }, [controller]);
  return [snap, controller];
}

function DraftNote(): JSX.Element {
  const [snap, controller] = useDraftController();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChange = (text: string): void => {
    controller.setContent(text);
    if (timer.current) clearTimeout(timer.current);
    // 防抖仅决定何时触发；真正的等待/串行由控制器保证（关闭刷新会等待在途与后续 dirty）。
    timer.current = setTimeout(() => void controller.save(), 500);
  };

  return (
    <div className="card">
      <div className="card-title">备课草稿（本地保存）</div>
      <p className="muted small">
        随手记录本课思路；内容仅保存在本机，自动保存并保留版本。退出前会先完成保存。
      </p>
      <textarea
        className="draft"
        value={snap.content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如：本课《春》——朗读中体会比喻与排比，学生尝试仿写一句…"
        spellCheck={false}
      />
      <div className="row small muted">
        <span>版本 v{snap.revision}</span>
        <span>
          {snap.saving
            ? '保存中…'
            : snap.updatedAt
              ? `已保存 ${new Date(snap.updatedAt).toLocaleString('zh-CN')}`
              : '尚未保存'}
        </span>
      </div>
      {snap.conflict && (
        <div className="notice warn small">
          本地草稿与本机较新版本冲突。已保留你的本地内容，未自动覆盖；继续打字不会覆盖。请明确选择：
          <div className="row" style={{ marginTop: 8, gap: 8, justifyContent: 'flex-start' }}>
            <button className="btn" onClick={() => void controller.resolveKeepLocal()}>
              保留我的内容并覆盖
            </button>
            <button className="btn" onClick={() => controller.resolveUseRemote()}>
              采用较新版本
            </button>
          </div>
          {snap.remoteContent !== null && (
            <div className="muted small" style={{ marginTop: 6 }}>
              较新版本预览：{snap.remoteContent.slice(0, 80)}
            </div>
          )}
        </div>
      )}
      {!snap.conflict && snap.lastError && (
        <div className="notice warn small">保存未完成：{snap.lastError}。已保留本地内容，可继续编辑重试。</div>
      )}
    </div>
  );
}

function platformIdentityText(identity: string, targetSupported: boolean): string {
  switch (identity) {
    case 'win11':
      return 'Windows 11 x64 工作站（正式目标）';
    case 'windows-server':
      return 'Windows Server（可运行，非正式目标）';
    case 'windows-domain-controller':
      return 'Windows 域控（非正式目标）';
    case 'windows-other':
      return '较旧 Windows 工作站（非正式目标）';
    case 'windows-unknown':
      return 'Windows 身份未确认（不冒称 Win11）';
    case 'dev-override':
      return '开发放行（非正式发布）';
    default:
      return targetSupported ? '正式目标平台' : '非正式目标平台';
  }
}

function HealthPanel({ health }: { health: HealthData | null }): JSX.Element {
  const rows: { label: string; ok: boolean; text: string }[] = health
    ? [
        { label: '主进程', ok: health.main_process === 'ok', text: '正常' },
        {
          label: '本地存储',
          ok: health.storage_probe === 'ok',
          text: health.storage_probe === 'ok' ? '可写（实测写入探针）' : '写入失败'
        },
        {
          label: '本地服务',
          ok: true,
          text: '未启动（设计保证；INS-008 以系统级证据为准）'
        },
        { label: '离线能力', ok: health.offline_capable_by_design, text: '支持（设计能力）' },
        {
          label: '运行模式',
          ok: health.build_mode === 'production',
          text: health.build_mode === 'production' ? '生产（打包）' : '开发验证（非正式发布）'
        },
        {
          label: 'OS 沙箱',
          ok: health.sandbox_enabled,
          text: health.sandbox_enabled ? '启用（仅启动参数指示）' : '已禁用（仅开发验证）'
        },
        {
          label: '平台身份',
          ok: health.platform_target_supported,
          text: platformIdentityText(health.platform_identity, health.platform_target_supported)
        },
        {
          label: '数据保护',
          ok: !health.storage_protected,
          text: health.storage_protected ? '已暂停写入（源文件待恢复）' : '正常'
        },
        {
          label: '凭据加密',
          ok: health.credential_encryption === 'available',
          text: health.credential_encryption === 'available' ? '可用（safeStorage）' : '不可用（将拒绝落明文密钥）'
        }
      ]
    : [];
  return (
    <div className="card">
      <div className="card-title">系统状态</div>
      {!health && <p className="muted small">读取中…</p>}
      <ul className="status-list">
        {rows.map((r) => (
          <li key={r.label}>
            <span className={`tick ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '✓' : '!'}</span>
            <span className="status-label">{r.label}</span>
            <span className="muted">{r.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreparePage({ boot, health }: { boot: BootstrapData | null; health: HealthData | null }): JSX.Element {
  return (
    <div className="page">
      <h1>备下一课</h1>
      <p className="lead">
        围绕当前单元和下一课完成资料核对、内容解读、任务设计与课时安排。常态下你只需确认推荐方案或提出一处修改。
      </p>
      <div className="grid">
        <div className="card">
          <div className="card-title">当前班级</div>
          <p className="muted">尚未设置班级与教材。首次向导将引导你确认班级、教材与实际课时。</p>
          <button className="btn" disabled>
            开始准备（需先完成资料导入 · 后续版本开放）
          </button>
        </div>
        <div className="card">
          <div className="card-title">需处理的关键问题</div>
          <p className="muted">暂无。只有当答案会改变核心安排时才会向你提问。</p>
        </div>
        <DraftNote />
        <HealthPanel health={health} />
      </div>
      {boot && !boot.platform_supported && (
        <div className="notice warn">当前系统非受支持平台，仅用于工程验证。</div>
      )}
    </div>
  );
}

interface PlanItem {
  planId: string;
  title: string;
  currentRevisionId: string | null;
  updatedAt: string;
}
interface ArtifactItem {
  role: string;
  format: string;
  filename: string;
  path: string;
  sha256: string;
  byteSize: number;
}
interface LessonHistory {
  revisions: Array<{ revisionId: string; previousRevisionId: string | null; title: string; createdAt: string }>;
  proposals: Array<{ changeId: string; changeKind: LessonChange['kind']; status: string; createdAt: string }>;
  bundles: Array<{ bundleId: string; revisionId: string; presentationSpecHash: string; createdAt: string }>;
}

const AFFECTED_OUTPUTS = ['课堂PPT', '学生讲义DOCX/PDF', '教师讲解版DOCX/PDF'];

function changeViewDiff(preview: ChangePreview): LessonChangeViewDiff[] {
  return preview.diff.map((entry) => {
    const parts = entry.path.split('.');
    const objectId = parts.length > 1 ? parts[1] : parts[0];
    let field = parts.at(-1) ?? entry.path;
    if (entry.path.startsWith('tasks.')) field = 'prompt';
    else if (entry.path.startsWith('rubrics.')) field = 'acceptable_variants';
    else if (entry.path.startsWith('links.')) field = 'link_removed';
    else if (entry.path.startsWith('activities.')) field = 'duration';
    else if (entry.path === 'presentation_spec') field = 'fontScale';
    return { objectId, field, before: entry.before, after: entry.after };
  });
}

function displayValue(value: unknown): string {
  if (value === null) return '无';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function localDateTimeValue(date = new Date()): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function CoursesPage(): JSX.Element {
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [manifest, setManifest] = useState<{ planId: string; revisionId: string; contentOrigin: string; versionStamp: string; files: ArtifactItem[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<LessonPlan | null>(null);
  const [history, setHistory] = useState<LessonHistory | null>(null);
  const [changeKind, setChangeKind] = useState<LessonChange['kind']>('change_duration');
  const [durationMinutes, setDurationMinutes] = useState('45');
  const [activityId, setActivityId] = useState('');
  const [linkId, setLinkId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [rubricId, setRubricId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [variants, setVariants] = useState('');
  const [fontScale, setFontScale] = useState('1');
  const [paperSize, setPaperSize] = useState<'A4' | 'Letter'>('A4');
  const [theme, setTheme] = useState<'light' | 'high_contrast'>('light');
  const [previewed, setPreviewed] = useState<{ preview: ChangePreview; change: LessonChange } | null>(null);
  const [applyResult, setApplyResult] = useState<LessonChangeApplyResult | null>(null);
  const [changeMessage, setChangeMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [teachingEvents, setTeachingEvents] = useState<TeachingEvent[]>([]);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const [taughtAt, setTaughtAt] = useState(() => localDateTimeValue());
  const [teachingDurationMinutes, setTeachingDurationMinutes] = useState('45');
  const [implementationState, setImplementationState] = useState<ImplementationState>('completed');
  const [adjustmentSummary, setAdjustmentSummary] = useState('');
  const [teachingMessage, setTeachingMessage] = useState<string | null>(null);
  const [recordingTeaching, setRecordingTeaching] = useState(false);
  const [observations, setObservations] = useState<ObservationRecord[]>([]);
  const [dismissedTeachingEventIds, setDismissedTeachingEventIds] = useState<string[]>([]);
  const [observationOutcome, setObservationOutcome] = useState<ObservationOutcomeValue>('met_expectation');
  const [observationSummary, setObservationSummary] = useState('');
  const [observationObservedAt, setObservationObservedAt] = useState(() => localDateTimeValue());
  const [observationSourceKind, setObservationSourceKind] = useState<ObservationSourceKind>('teacher_observation');
  const [observationSupport, setObservationSupport] = useState<ObservationSupportLevel>('independent');
  const [observationMaterial, setObservationMaterial] = useState<ObservationMaterialRelation>('same_item');
  const [observationDelayDays, setObservationDelayDays] = useState('0');
  const [observationSampleCount, setObservationSampleCount] = useState('0');
  const [observationPopulationCount, setObservationPopulationCount] = useState('0');
  const [observationSelection, setObservationSelection] = useState<ObservationSelection>('unknown');
  const [observationCaveat, setObservationCaveat] = useState('尚未确认样本覆盖，不能推算全班比例');
  const [observationMessage, setObservationMessage] = useState<string | null>(null);
  const [savingObservation, setSavingObservation] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<FeedbackAnalysisResult | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [dispatchConsent, setDispatchConsent] = useState(false);
  const [corrections, setCorrections] = useState<CorrectionRecord[]>([]);
  const [preferenceState, setPreferenceState] = useState<Record<string, string | null>>({});
  const [effectState, setEffectState] = useState<EffectEvidenceState>('unknown');
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);
  const [correctionInFlight, setCorrectionInFlight] = useState<string | null>(null);
  const applyKeyRef = useRef<string | null>(null);
  const applyingRef = useRef(false);
  const teachingRequestRef = useRef<{ signature: string; key: string } | null>(null);
  const recordingTeachingRef = useRef(false);
  const observationRequestRef = useRef<{ signature: string; key: string } | null>(null);
  const savingObservationRef = useRef(false);
  const observationDeleteKeysRef = useRef(new Map<string, string>());
  const analysisRequestRef = useRef<{ signature: string; key: string } | null>(null);
  const analyzingRef = useRef(false);
  const correctionKeysRef = useRef(new Map<string, string>());

  async function reload(): Promise<void> {
    const r = await window.yuwen.lessonList();
    if (r.ok) setPlans(r.data.plans);
  }
  useEffect(() => {
    void reload();
  }, []);

  async function buildDemo(): Promise<void> {
    const r = await window.yuwen.lessonBuildDemo();
    setMsg(r.ok ? `已组建自拟课时计划（${r.data.title}，修订 ${r.data.revisionId.slice(0, 12)}…，内容来源 ${r.data.contentOrigin}）` : `组建失败：${r.error.message_zh}`);
    await reload();
  }
  async function generate(planId: string): Promise<void> {
    const r = await window.yuwen.materialsGenerate(planId);
    if (r.ok) setManifest(r.data);
    else setMsg(`生成失败：${r.error.message_zh}`);
  }

  function invalidatePreview(): void {
    setPreviewed(null);
    setApplyResult(null);
    setChangeMessage(null);
    applyKeyRef.current = null;
  }

  async function loadHistory(planId: string): Promise<void> {
    const response = await window.yuwen.changeHistory(planId);
    if (response.ok) setHistory(response.data as LessonHistory);
  }

  async function loadFeedbackHistory(planId: string): Promise<void> {
    const response = await window.yuwen.feedbackHistory(planId);
    if (!response.ok) {
      setTeachingMessage(`授课历史读取失败：${response.error.message_zh}`);
      return;
    }
    setTeachingEvents(response.data.teachingEvents);
    setFeedbackRevision(response.data.streamRevision);
    setCorrections(response.data.corrections ?? []);
    setPreferenceState(response.data.preferenceState ?? {});
    setEffectState(response.data.effectState ?? 'unknown');
    const latestMeasurement = response.data.measurementReviews?.at(-1);
    const latestRun = response.data.attributionRuns?.at(-1);
    if (latestMeasurement && latestRun?.status === 'succeeded' && latestRun.result) {
      setAnalysisResult({
        status: 'attributed',
        streamRevision: response.data.streamRevision,
        measurement: latestMeasurement,
        attribution: latestRun.result
      });
    } else if (latestMeasurement && latestRun?.status === 'uncertain' && latestRun.modelJobId) {
      setAnalysisResult({
        status: 'uncertain',
        streamRevision: response.data.streamRevision,
        measurement: latestMeasurement,
        jobId: latestRun.modelJobId,
        code: 'REQUEST_UNCERTAIN',
        note: '历史模型请求的执行或费用状态不确定，未自动重试。'
      });
    } else if (latestMeasurement && latestRun && ['blocked', 'failed', 'stale'].includes(latestRun.status)) {
      setAnalysisResult({
        status: 'blocked',
        streamRevision: response.data.streamRevision,
        measurement: latestMeasurement,
        code: 'MODEL_NOT_AVAILABLE',
        note: latestRun.status === 'stale' ? '归因返回时反馈流已经变化，结果仅保留为历史，未用于当前纠正。' : '历史归因未形成可用结果。'
      });
    } else if (latestMeasurement && !latestRun) {
      setAnalysisResult({
        status: 'needs_measurement_review',
        streamRevision: response.data.streamRevision,
        measurement: latestMeasurement
      });
    }
  }

  async function loadObservations(planId: string): Promise<void> {
    const response = await window.yuwen.listObservations(planId);
    if (!response.ok) {
      setObservationMessage(`课堂观察读取失败：${response.error.message_zh}`);
      return;
    }
    setObservations(response.data.observations);
  }

  async function openPlan(planId: string): Promise<void> {
    const response = await window.yuwen.lessonGet(planId);
    if (!response.ok) {
      setChangeMessage(`读取失败：${response.error.message_zh}`);
      return;
    }
    const plan = response.data.plan as LessonPlan;
    setSelectedPlan(plan);
    setDurationMinutes(String(Math.round(plan.declared_duration_sec / 60)));
    setTeachingDurationMinutes(String(Math.round(plan.declared_duration_sec / 60)));
    setTaughtAt(localDateTimeValue());
    setImplementationState('completed');
    setAdjustmentSummary('');
    setTeachingMessage(null);
    teachingRequestRef.current = null;
    setObservations([]);
    setDismissedTeachingEventIds([]);
    setObservationOutcome('met_expectation');
    setObservationSummary('');
    setObservationObservedAt(localDateTimeValue());
    setObservationSourceKind('teacher_observation');
    setObservationSupport('independent');
    setObservationMaterial('same_item');
    setObservationDelayDays('0');
    setObservationSampleCount('0');
    setObservationPopulationCount('0');
    setObservationSelection('unknown');
    setObservationCaveat('尚未确认样本覆盖，不能推算全班比例');
    setObservationMessage(null);
    setAnalysisResult(null);
    setAnalysisMessage(null);
    setDispatchConsent(false);
    analysisRequestRef.current = null;
    observationRequestRef.current = null;
    observationDeleteKeysRef.current.clear();
    const studentActivity = plan.activities.find((activity) => activity.actor === 'student');
    setActivityId(studentActivity?.activity_id ?? '');
    setLinkId(plan.links.find((link) => link.decision === 'include')?.link_id ?? '');
    const firstTask = plan.tasks[0];
    setTaskId(firstTask?.task_id ?? '');
    setRubricId(firstTask?.rubric_id ?? plan.rubrics[0]?.rubric_id ?? '');
    setPrompt(firstTask?.prompt ?? '');
    const rubric = plan.rubrics.find((item) => item.rubric_id === firstTask?.rubric_id);
    setVariants(rubric?.criteria[0]?.acceptable_variants.join('；') ?? '');
    invalidatePreview();
    await Promise.all([loadHistory(planId), loadFeedbackHistory(planId), loadObservations(planId)]);
  }

  async function recordTeaching(): Promise<void> {
    if (!selectedPlan || recordingTeachingRef.current) return;
    const minutes = Number(teachingDurationMinutes);
    const localTime = new Date(taughtAt);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      setTeachingMessage('实际时长须为 1–240 分钟的整数。');
      return;
    }
    if (Number.isNaN(localTime.getTime())) {
      setTeachingMessage('请填写有效的授课时间。');
      return;
    }
    const payload = {
      planId: selectedPlan.plan_id,
      planRevisionId: selectedPlan.revision_id,
      taughtAt: localTime.toISOString(),
      actualDurationSec: minutes * 60,
      implementationState,
      adjustmentSummary
    };
    const signature = teachingSubmissionKey(payload);
    if (teachingRequestRef.current?.signature !== signature) {
      teachingRequestRef.current = { signature, key: `${signature}-${crypto.randomUUID()}` };
    }
    recordingTeachingRef.current = true;
    setRecordingTeaching(true);
    setTeachingMessage(null);
    try {
      const response = await window.yuwen.recordTeaching(
        payload,
        feedbackRevision,
        teachingRequestRef.current.key
      );
      if (!response.ok) {
        setTeachingMessage(`授课记录未写入：${response.error.message_zh}；${response.error.next_action}`);
        if (response.error.code === 'VERSION_CONFLICT') await loadFeedbackHistory(selectedPlan.plan_id);
        return;
      }
      setFeedbackRevision(response.data.streamRevision);
      await loadFeedbackHistory(selectedPlan.plan_id);
      setTeachingMessage('已记录实际授课；采用状态与教学效果未自动改变。');
      setAdjustmentSummary('');
      teachingRequestRef.current = null;
    } finally {
      recordingTeachingRef.current = false;
      setRecordingTeaching(false);
    }
  }

  async function saveObservation(teachingEventId: string): Promise<void> {
    if (!selectedPlan || savingObservationRef.current) return;
    const taskId = selectedPlan.tasks[0]?.task_id;
    if (!taskId) {
      setObservationMessage('当前课时没有可绑定的稳定任务，未保存观察。');
      return;
    }
    const delayDays = Number(observationDelayDays);
    const sampleCount = Number(observationSampleCount);
    const populationCount = Number(observationPopulationCount);
    const observedAt = new Date(observationObservedAt);
    if (
      ![delayDays, sampleCount, populationCount].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      sampleCount > populationCount
    ) {
      setObservationMessage('延迟天数、样本数和总体数须为非负整数，且样本数不能超过总体数。');
      return;
    }
    if (Number.isNaN(observedAt.getTime())) {
      setObservationMessage('请填写有效的观察时间。');
      return;
    }
    if (!observationCaveat.trim()) {
      setObservationMessage('请说明样本选择和覆盖限制。');
      return;
    }
    const payload = {
      planId: selectedPlan.plan_id,
      planRevisionId: selectedPlan.revision_id,
      teachingEventId,
      taskId,
      sourceKind: observationSourceKind,
      observedAt: observedAt.toISOString(),
      outcome: observationOutcome,
      supportLevel: observationSupport,
      materialRelation: observationMaterial,
      delayDays,
      sampleCount,
      populationCount,
      selection: observationSelection,
      coverageCaveat: observationCaveat,
      summary: observationSummary
    };
    const signature = JSON.stringify(payload);
    if (observationRequestRef.current?.signature !== signature) {
      observationRequestRef.current = { signature, key: `observation-${crypto.randomUUID()}` };
    }
    savingObservationRef.current = true;
    setSavingObservation(true);
    setObservationMessage(null);
    try {
      const response = await window.yuwen.addObservation(payload, feedbackRevision, observationRequestRef.current.key);
      if (!response.ok) {
        setObservationMessage(`课堂观察未保存：${response.error.message_zh}；${response.error.next_action}`);
        if (response.error.code === 'VERSION_CONFLICT') await loadFeedbackHistory(selectedPlan.plan_id);
        return;
      }
      setFeedbackRevision(response.data.streamRevision);
      await loadObservations(selectedPlan.plan_id);
      setObservationMessage('已在本机保存观察；这不是教学有效性或全班表现证明。');
      observationRequestRef.current = null;
    } finally {
      savingObservationRef.current = false;
      setSavingObservation(false);
    }
  }

  async function deleteObservation(observationId: string): Promise<void> {
    if (!selectedPlan || savingObservationRef.current) return;
    savingObservationRef.current = true;
    setSavingObservation(true);
    setObservationMessage(null);
    try {
      const prepared = await window.yuwen.prepareObservationDelete(selectedPlan.plan_id, observationId);
      if (!prepared.ok) {
        setObservationMessage(`未删除：${prepared.error.message_zh}`);
        return;
      }
      let key = observationDeleteKeysRef.current.get(observationId);
      if (!key) {
        key = `observation-delete-${crypto.randomUUID()}`;
        observationDeleteKeysRef.current.set(observationId, key);
      }
      const response = await window.yuwen.deleteObservation(
        selectedPlan.plan_id,
        observationId,
        prepared.data.confirmationToken,
        feedbackRevision,
        key
      );
      if (!response.ok) {
        setObservationMessage(`未删除：${response.error.message_zh}；${response.error.next_action}`);
        if (response.error.code === 'VERSION_CONFLICT') await loadFeedbackHistory(selectedPlan.plan_id);
        return;
      }
      observationDeleteKeysRef.current.delete(observationId);
      setFeedbackRevision(response.data.streamRevision);
      await loadObservations(selectedPlan.plan_id);
      setObservationMessage('本机观察正文已删除；外部或离线备份不在本次删除范围内。');
    } finally {
      savingObservationRef.current = false;
      setSavingObservation(false);
    }
  }

  async function analyzeFeedback(): Promise<void> {
    if (!selectedPlan || analyzingRef.current) return;
    const teachingEvent = teachingEvents.at(-1);
    if (!teachingEvent) {
      setAnalysisMessage('请先明确记录实际授课。');
      return;
    }
    const observationIds = observations
      .filter((record) => record.teachingEventId === teachingEvent.event_id)
      .map((record) => record.observation.observation_id);
    const signature = JSON.stringify([
      selectedPlan.plan_id, teachingEvent.event_id, observationIds, dispatchConsent, feedbackRevision
    ]);
    if (analysisRequestRef.current?.signature !== signature) {
      analysisRequestRef.current = { signature, key: `feedback-analysis-${crypto.randomUUID()}` };
    }
    analyzingRef.current = true;
    setAnalyzing(true);
    setAnalysisMessage(null);
    try {
      const response = await window.yuwen.analyzeFeedback(
        selectedPlan.plan_id,
        teachingEvent.event_id,
        observationIds,
        dispatchConsent,
        feedbackRevision,
        analysisRequestRef.current.key
      );
      if (!response.ok) {
        setAnalysisMessage(`反馈分析未完成：${response.error.message_zh}；${response.error.next_action}`);
        if (response.error.code === 'VERSION_CONFLICT') await loadFeedbackHistory(selectedPlan.plan_id);
        return;
      }
      setAnalysisResult(response.data);
      setFeedbackRevision(response.data.streamRevision);
      setAnalysisMessage(
        response.data.status === 'attributed'
          ? '已生成待验证假设；尚未完成真实 API 质量验证和教学专业复核。'
          : response.data.status === 'needs_measurement_review'
            ? '测量条件不足，未调用模型。'
            : response.data.status === 'uncertain'
              ? '模型请求的执行或费用状态不确定，未自动重试。'
              : `模型辅助归因被阻断：${response.data.note}`
      );
      analysisRequestRef.current = null;
      await loadFeedbackHistory(selectedPlan.plan_id);
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }

  async function decideCorrection(record: CorrectionRecord, action: 'accept' | 'reject' | 'revert'): Promise<void> {
    if (!selectedPlan || correctionInFlight) return;
    const signature = JSON.stringify([selectedPlan.plan_id, record.proposal.change_id, action, record.stateRevision, feedbackRevision]);
    let key = correctionKeysRef.current.get(signature);
    if (!key) {
      key = `correction-${crypto.randomUUID()}`;
      correctionKeysRef.current.set(signature, key);
    }
    setCorrectionInFlight(`${record.proposal.change_id}:${action}`);
    setCorrectionMessage(null);
    const payload = {
      planId: selectedPlan.plan_id,
      proposalId: record.proposal.change_id,
      reason: action === 'accept' ? '教师确认有限试行' : action === 'reject' ? '教师决定不采用本次纠偏' : '教师撤回已接受纠偏',
      expectedProposalRevision: record.stateRevision
    };
    try {
      const response = action === 'revert'
        ? await window.yuwen.revertCorrection(payload, feedbackRevision, key)
        : await window.yuwen.decideCorrection({ ...payload, decision: action }, feedbackRevision, key);
      if (!response.ok) {
        setCorrectionMessage(`纠偏操作未完成：${response.error.message_zh}；${response.error.next_action}`);
        if (response.error.code === 'VERSION_CONFLICT') await loadFeedbackHistory(selectedPlan.plan_id);
        return;
      }
      setFeedbackRevision(response.data.streamRevision);
      if (response.data.lessonChangeSuggestion?.kind === 'increase_independent_time') {
        setChangeKind('increase_independent_time');
        setActivityId(response.data.lessonChangeSuggestion.activityId);
        invalidatePreview();
        setCorrectionMessage('已接受纠偏；仅生成 G07 修改建议，需在“一处修改”中预览确认后才会应用。');
      } else {
        setCorrectionMessage(action === 'reject' ? '已记录拒绝，原提案和决策历史均保留。' : '已追加记录本次纠偏决策。');
      }
      correctionKeysRef.current.delete(signature);
      await loadFeedbackHistory(selectedPlan.plan_id);
    } finally {
      setCorrectionInFlight(null);
    }
  }

  function controlledChange(): LessonChange | null {
    if (!selectedPlan) return null;
    if (changeKind === 'change_duration') {
      return { kind: changeKind, durationSec: Math.round(Number(durationMinutes) * 60) };
    }
    if (changeKind === 'increase_independent_time') {
      return activityId ? { kind: changeKind, activityId, addedSec: 300 } : null;
    }
    if (changeKind === 'remove_link') return linkId ? { kind: changeKind, linkId } : null;
    const answerList = variants
      .split(/[；;]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (changeKind === 'edit_task') {
      return taskId && prompt.trim()
        ? { kind: changeKind, taskId, prompt: prompt.trim(), acceptableVariants: answerList }
        : null;
    }
    if (changeKind === 'edit_rubric') {
      return rubricId ? { kind: changeKind, rubricId, acceptableVariants: answerList } : null;
    }
    return { kind: changeKind, fontScale: Number(fontScale), paperSize, theme };
  }

  async function previewChange(): Promise<void> {
    if (!selectedPlan) return;
    const change = controlledChange();
    if (!change) {
      setChangeMessage('请先补全这一处修改。');
      return;
    }
    const response = await window.yuwen.changePreview(selectedPlan.plan_id, selectedPlan.revision_id, change);
    if (!response.ok) {
      setChangeMessage(`未生成预览：${response.error.message_zh}；${response.error.next_action}`);
      return;
    }
    setPreviewed({ preview: response.data.preview, change });
    setApplyResult(null);
    setChangeMessage(null);
    applyKeyRef.current = crypto.randomUUID();
  }

  async function applyChange(): Promise<void> {
    if (!selectedPlan || !previewed || applyingRef.current || applyResult) return;
    applyingRef.current = true;
    setApplying(true);
    const idempotencyKey = applyKeyRef.current ?? crypto.randomUUID();
    applyKeyRef.current = idempotencyKey;
    try {
      const response = await window.yuwen.changeApply(
        selectedPlan.plan_id,
        selectedPlan.revision_id,
        previewed.change,
        idempotencyKey
      );
      if (!response.ok) {
        setChangeMessage(`旧版未受影响：${response.error.message_zh}；${response.error.next_action}`);
        return;
      }
      if (response.data.result.status === 'failed_final') {
        setChangeMessage(
          `旧版未受影响：同一修改已连续失败 ${response.data.result.failureCount} 次，已停止自动重试（${response.data.result.errorCode}）。`
        );
        return;
      }
      setApplyResult(response.data.result);
      setChangeMessage('修改已原子接纳；旧修订与旧成品仍可查。');
      await reload();
      await loadHistory(selectedPlan.plan_id);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  const viewDiff = previewed ? changeViewDiff(previewed.preview) : [];
  const printWarning = needsPrintedCopyWarning(viewDiff);
  const teachingStatus = buildTeachingStatus({ adopted: false, events: teachingEvents });
  const observationPrompt = buildObservationPrompt({
    teachingEvents,
    observedTeachingEventIds: observations.map((record) => record.teachingEventId),
    dismissedTeachingEventIds
  });
  const coveragePreview = observationCoverageSummary({
    sample_count: Number.isSafeInteger(Number(observationSampleCount)) ? Number(observationSampleCount) : null,
    population_count: Number.isSafeInteger(Number(observationPopulationCount)) ? Number(observationPopulationCount) : null,
    selection: observationSelection,
    coverage_caveat: observationCaveat.trim() || '尚未填写覆盖限制'
  });

  return (
    <div className="page">
      <h1>我的课程</h1>
      <p className="lead">完整课时计划（LessonPlan）与三类五文件成品：课堂 PPT、学生讲义(DOCX/PDF)、教师讲解版(DOCX/PDF)。软件审查只检查结构、引用与版本一致性。</p>
      <div className="card">
        <div className="card-title">课时计划</div>
        <p className="muted small">无真实模型授权时，可用“自拟完整计划”并行开发；模拟/自拟内容明确标注，不冒充真实备课质量。</p>
        <div className="confirm-actions">
          <button className="btn small" onClick={() => void buildDemo()}>
            组建自拟完整课时计划（测试）
          </button>
        </div>
        {msg && <p className="notice small">{msg}</p>}
        <ul className="src-list">
          {plans.map((p) => (
            <li key={p.planId} className="src-item">
              <div>
                <b>{p.title}</b> <span className="tag">完整 LessonPlan</span>
                <div className="muted small mono">{p.planId}</div>
              </div>
              <div className="src-actions">
                <button className="btn small" onClick={() => void openPlan(p.planId)}>
                  打开课程与反馈
                </button>
                <button className="btn small" onClick={() => void generate(p.planId)}>
                  生成三类五文件
                </button>
              </div>
            </li>
          ))}
          {plans.length === 0 && <p className="muted small">暂无课时计划。点击上方按钮组建自拟完整计划。</p>}
        </ul>
      </div>

      {selectedPlan && (
        <div className="card teaching-panel">
          <div className="card-title">记录实际授课 · {selectedPlan.title}</div>
          <div className="teaching-status">
            <span className="tag">采用状态：{teachingStatus.adoptionLabel}</span>
            <span className="tag">授课状态：{teachingStatus.teachingLabel}</span>
          </div>
          <p className="muted small">
            当前版本尚无独立采用记录；即使记录了授课，也不会据此认定计划已采用或教学有效。
          </p>
          <div className="change-grid">
            <label>
              <span>授课时间</span>
              <input className="search-input" type="datetime-local" value={taughtAt} onChange={(event) => setTaughtAt(event.target.value)} />
            </label>
            <label>
              <span>实际时长（分钟）</span>
              <input
                className="search-input"
                type="number"
                min={1}
                max={240}
                step={1}
                value={teachingDurationMinutes}
                onChange={(event) => setTeachingDurationMinutes(event.target.value)}
              />
            </label>
            <label>
              <span>实施情况</span>
              <select className="search-input" value={implementationState} onChange={(event) => setImplementationState(event.target.value as ImplementationState)}>
                <option value="completed">完整实施</option>
                <option value="partial">部分实施</option>
                <option value="stopped">中止</option>
              </select>
            </label>
            <label className="wide">
              <span>临场调整（可选，只写实施事实）</span>
              <textarea
                className="draft compact"
                maxLength={4000}
                value={adjustmentSummary}
                placeholder="例如：删减教师讲解，保留核心学生任务。"
                onChange={(event) => setAdjustmentSummary(event.target.value)}
              />
            </label>
          </div>
          <button className="btn" disabled={recordingTeaching || !teachingStatus.canRecordTeaching} onClick={() => void recordTeaching()}>
            {recordingTeaching ? '正在记录…' : '记录已授课'}
          </button>
          {teachingMessage && <p className={`notice small ${teachingMessage.startsWith('授课记录未写入') ? 'warn' : ''}`}>{teachingMessage}</p>}
          {teachingEvents.length > 0 && (
            <ul className="history-list teaching-history">
              {teachingEvents.map((event) => (
                <li key={event.event_id}>
                  <span>{new Date(event.taught_at).toLocaleString('zh-CN')} · {Math.round(event.actual_duration_sec / 60)} 分钟</span>
                  <span>
                    {event.implementation_state === 'completed' ? '完整实施' : event.implementation_state === 'partial' ? '部分实施' : '中止'}
                    {event.adjustment_summary ? ` · ${event.adjustment_summary}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selectedPlan && observationPrompt.visible && observationPrompt.teachingEventId && (
        <div className="card observation-panel">
          <div className="card-title">一次可选课后反馈</div>
          <p className="muted small">
            只记录本次表现事实。无需填写学生姓名、联系方式、原始作业正文或文件路径；跳过不会记为成功或失败。
          </p>
          <div className="outcome-options" role="group" aria-label="本次观察结果">
            {OBSERVATION_OUTCOME_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`btn small ${observationOutcome === option.value ? 'selected' : ''}`}
                onClick={() => {
                  setObservationOutcome(option.value);
                  observationRequestRef.current = null;
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="observation-summary">
            <span>表现事实摘要（可选）</span>
            <textarea
              className="draft compact"
              maxLength={4000}
              value={observationSummary}
              placeholder="例如：部分作答能指出关键词，但书面证据联系仍需提示。"
              onChange={(event) => {
                setObservationSummary(event.target.value);
                observationRequestRef.current = null;
              }}
            />
          </label>
          <p className="coverage-preview">样本范围：{coveragePreview}</p>
          <details className="observation-details">
            <summary>补充观察条件与样本范围</summary>
            <div className="change-grid">
              <label>
                <span>观察时间</span>
                <input className="search-input" type="datetime-local" value={observationObservedAt} onChange={(event) => { setObservationObservedAt(event.target.value); observationRequestRef.current = null; }} />
              </label>
              <label>
                <span>来源类型</span>
                <select className="search-input" value={observationSourceKind} onChange={(event) => { setObservationSourceKind(event.target.value as ObservationSourceKind); observationRequestRef.current = null; }}>
                  <option value="teacher_observation">教师观察</option>
                  <option value="student_work">已授权学生作品的观察（不保存正文）</option>
                  <option value="existing_exam">既有考试的观察（不保存正文）</option>
                </select>
              </label>
              <label>
                <span>提示程度</span>
                <select className="search-input" value={observationSupport} onChange={(event) => { setObservationSupport(event.target.value as ObservationSupportLevel); observationRequestRef.current = null; }}>
                  <option value="independent">独立完成</option>
                  <option value="partial_prompt">部分提示</option>
                  <option value="full_model">完整示范</option>
                  <option value="unknown">未知</option>
                </select>
              </label>
              <label>
                <span>材料关系</span>
                <select className="search-input" value={observationMaterial} onChange={(event) => { setObservationMaterial(event.target.value as ObservationMaterialRelation); observationRequestRef.current = null; }}>
                  <option value="same_item">同题</option>
                  <option value="similar_new">相似新题</option>
                  <option value="different_context">不同情境</option>
                  <option value="unknown">未知</option>
                </select>
              </label>
              <label>
                <span>延迟天数</span>
                <input className="search-input" type="number" min={0} step={1} value={observationDelayDays} onChange={(event) => { setObservationDelayDays(event.target.value); observationRequestRef.current = null; }} />
              </label>
              <label>
                <span>样本选择</span>
                <select className="search-input" value={observationSelection} onChange={(event) => { setObservationSelection(event.target.value as ObservationSelection); observationRequestRef.current = null; }}>
                  <option value="unknown">未知</option>
                  <option value="all_available">全部可用记录</option>
                  <option value="planned_sample">预先计划样本</option>
                  <option value="typical_cases">典型样本</option>
                  <option value="voluntary">自愿样本</option>
                </select>
              </label>
              <label>
                <span>样本数</span>
                <input className="search-input" type="number" min={0} step={1} value={observationSampleCount} onChange={(event) => { setObservationSampleCount(event.target.value); observationRequestRef.current = null; }} />
              </label>
              <label>
                <span>总体数</span>
                <input className="search-input" type="number" min={0} step={1} value={observationPopulationCount} onChange={(event) => { setObservationPopulationCount(event.target.value); observationRequestRef.current = null; }} />
              </label>
              <label className="wide">
                <span>覆盖限制（必填）</span>
                <textarea className="draft compact" maxLength={4000} value={observationCaveat} onChange={(event) => { setObservationCaveat(event.target.value); observationRequestRef.current = null; }} />
              </label>
            </div>
          </details>
          <div className="confirm-actions">
            <button className="btn" disabled={savingObservation} onClick={() => void saveObservation(observationPrompt.teachingEventId as string)}>
              {savingObservation ? '正在保存…' : '保存本机观察'}
            </button>
            <button
              className="btn"
              disabled={savingObservation}
              onClick={() => setDismissedTeachingEventIds((current) => [...current, observationPrompt.teachingEventId as string])}
            >
              暂不反馈
            </button>
          </div>
        </div>
      )}

      {selectedPlan && observations.length > 0 && (
        <div className="card observation-history">
          <div className="card-title">本机课堂观察</div>
          <p className="muted small">这些记录保持本地，不含原始学生作品；样本限制始终随记录显示。</p>
          <ul className="history-list">
            {observations.map((record) => (
              <li key={record.observation.observation_id}>
                <div>
                  <b>{OBSERVATION_OUTCOME_OPTIONS.find((option) => option.value === record.outcome.outcome)?.label}</b>
                  <div className="muted small">{record.observation.summary || '未填写表现摘要'}</div>
                  <div className="muted small">{observationCoverageSummary(record.observation)}</div>
                </div>
                <button className="btn small" disabled={savingObservation} onClick={() => void deleteObservation(record.observation.observation_id)}>
                  删除本机观察
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {selectedPlan && observationMessage && <p className={`notice small ${observationMessage.includes('未') ? 'warn' : ''}`}>{observationMessage}</p>}

      {selectedPlan && teachingEvents.length > 0 && (
        <div className="card attribution-panel">
          <div className="card-title">测量检查与模型辅助归因</div>
          <p className="muted small">
            先检查题目、评分、可比条件、样本覆盖和实际实施；任一关键条件不足都不会调用模型。模型只接收结构化白名单字段，不接收本机观察摘要、原始作品、身份信息或文件路径。
          </p>
          <label className="dispatch-consent">
            <input
              type="checkbox"
              checked={dispatchConsent}
              onChange={(event) => {
                setDispatchConsent(event.target.checked);
                analysisRequestRef.current = null;
              }}
            />
            若当前配置为真实服务商，仅同意本次去身份化结构字段派发（不会改变观察的本地状态）
          </label>
          <button className="btn" disabled={analyzing} onClick={() => void analyzeFeedback()}>
            {analyzing ? '正在检查并分析…' : '先检查测量条件，再辅助归因'}
          </button>
          {analysisMessage && <p className={`notice small ${analysisMessage.includes('阻断') || analysisMessage.includes('不足') || analysisMessage.includes('不确定') ? 'warn' : ''}`}>{analysisMessage}</p>}
          {analysisResult && (() => {
            const view = buildAnalysisView(analysisResult);
            return (
              <div className="analysis-result">
                <div className="analysis-head">
                  <b>{view.statusLabel}</b>
                  {view.originLabel && <span className="tag">内容来源：{view.originLabel}</span>}
                </div>
                <ol className="measurement-list" aria-label="测量检查（先于归因假设）">
                  {view.measurementChecks.map((check) => (
                    <li key={check.id}>
                      <span className={`check-state ${check.status}`}>{check.status}</span>
                      <code>{check.id}</code>
                      <span>{check.evidence}</span>
                      {check.status !== 'pass' && <span>退回 {check.returnModule}</span>}
                    </li>
                  ))}
                </ol>
                {view.hypotheses.length > 0 && (
                  <div className="hypothesis-list">
                    {view.hypotheses.map((hypothesis, index) => (
                      <article key={`${hypothesis.kind}-${index}`}>
                        <b>{hypothesis.summary}</b>
                        <p>限制：{hypothesis.limitations.join('；')}</p>
                        <p>反证/撤回条件：{hypothesis.disconfirmingEvidence.join('；')}</p>
                        <p>退回模块：{hypothesis.returnModules.join('、')}</p>
                      </article>
                    ))}
                  </div>
                )}
                {view.notExecutedLabels.length > 0 && <p className="blocked-checks">未执行：{view.notExecutedLabels.join('；')}</p>}
                <p className="proof-disclaimer">{view.proofDisclaimer}</p>
              </div>
            );
          })()}
        </div>
      )}

      {selectedPlan && corrections.length > 0 && (() => {
        const evidence = buildEvidenceTrackView({ preferenceState, effectState });
        return (
          <div className="card correction-panel">
            <div className="card-title">最小纠偏建议</div>
            <p className="muted small">提案来自测量门后的待验证归因；接受只产生 G07 预览建议，不会直接修改课时或成品。</p>
            <div className="evidence-tracks" aria-label="表达偏好与效果证据分轨">
              <span><b>交付偏好</b>：{evidence.preferenceLabel}</span>
              <span><b>效果证据</b>：{evidence.effectLabel}</span>
            </div>
            {corrections.map((record) => {
              const card = buildCorrectionCard(record);
              return (
                <article className="correction-card" key={card.proposalId}>
                  <div className="analysis-head">
                    <b>{card.hypothesis}</b>
                    <span className="tag">状态：{card.status}</span>
                  </div>
                  <dl className="correction-fields">
                    <div><dt>替换什么</dt><dd>{card.replacementAction}</dd></div>
                    <div><dt>减少什么</dt><dd>{card.removedOrReduced}</dd></div>
                    <div><dt>预计看到什么</dt><dd>{card.predictedEvidence}</dd></div>
                    <div><dt>什么情况说明没奏效</dt><dd>{card.disconfirmingEvidence}</dd></div>
                    <div><dt>在哪次正常任务复核</dt><dd>{card.nextNormalTask}</dd></div>
                    <div><dt>退回模块</dt><dd>{card.returnModules.join('、')}</dd></div>
                  </dl>
                  <div className="actions-row">
                    {card.canAccept && <button className="btn" disabled={correctionInFlight !== null} onClick={() => void decideCorrection(record, 'accept')}>采用建议</button>}
                    {card.canReject && <button className="btn secondary" disabled={correctionInFlight !== null} onClick={() => void decideCorrection(record, 'reject')}>不采用</button>}
                    {card.canRevert && <button className="btn secondary" disabled={correctionInFlight !== null} onClick={() => void decideCorrection(record, 'revert')}>撤回采用</button>}
                  </div>
                </article>
              );
            })}
            {correctionMessage && <p className={`notice small ${correctionMessage.includes('未完成') ? 'warn' : ''}`}>{correctionMessage}</p>}
          </div>
        );
      })()}

      {selectedPlan && (
        <div className="card change-panel">
          <div className="card-title">一处修改 · {selectedPlan.title}</div>
          <p className="muted small mono">当前语义修订 {selectedPlan.revision_id}</p>
          <div className="change-grid">
            <label>
              <span>本次只改</span>
              <select
                className="search-input"
                value={changeKind}
                onChange={(event) => {
                  setChangeKind(event.target.value as LessonChange['kind']);
                  invalidatePreview();
                }}
              >
                <option value="change_duration">改变实际课时</option>
                <option value="increase_independent_time">独立学习增加 5 分钟</option>
                {selectedPlan.links.some((link) => link.decision === 'include') && <option value="remove_link">减少一个联结</option>}
                <option value="edit_task">修改题目与合理答案范围</option>
                <option value="edit_rubric">只修改合理答案范围</option>
                <option value="presentation_only">只调整版式</option>
              </select>
            </label>

            {changeKind === 'change_duration' && (
              <label>
                <span>实际课时（分钟）</span>
                <input
                  className="search-input"
                  type="number"
                  min={5}
                  max={240}
                  value={durationMinutes}
                  onChange={(event) => {
                    setDurationMinutes(event.target.value);
                    invalidatePreview();
                  }}
                />
              </label>
            )}
            {changeKind === 'increase_independent_time' && (
              <label>
                <span>学生独立活动</span>
                <select
                  className="search-input"
                  value={activityId}
                  onChange={(event) => {
                    setActivityId(event.target.value);
                    invalidatePreview();
                  }}
                >
                  {selectedPlan.activities
                    .filter((activity) => activity.actor === 'student')
                    .map((activity) => (
                      <option key={activity.activity_id} value={activity.activity_id}>{activity.title}</option>
                    ))}
                </select>
              </label>
            )}
            {changeKind === 'remove_link' && (
              <label>
                <span>移除联结</span>
                <select
                  className="search-input"
                  value={linkId}
                  onChange={(event) => {
                    setLinkId(event.target.value);
                    invalidatePreview();
                  }}
                >
                  {selectedPlan.links.filter((link) => link.decision === 'include').map((link) => (
                    <option key={link.link_id} value={link.link_id}>{link.purpose}</option>
                  ))}
                </select>
              </label>
            )}
            {(changeKind === 'edit_task' || changeKind === 'edit_rubric') && (
              <>
                <label>
                  <span>{changeKind === 'edit_task' ? '任务' : '量规'}</span>
                  <select
                    className="search-input"
                    value={changeKind === 'edit_task' ? taskId : rubricId}
                    onChange={(event) => {
                      const nextTask = selectedPlan.tasks.find((task) =>
                        changeKind === 'edit_task'
                          ? task.task_id === event.target.value
                          : task.rubric_id === event.target.value
                      );
                      if (changeKind === 'edit_task') setTaskId(event.target.value);
                      else setRubricId(event.target.value);
                      if (nextTask) {
                        setTaskId(nextTask.task_id);
                        setRubricId(nextTask.rubric_id);
                        setPrompt(nextTask.prompt);
                        const nextRubric = selectedPlan.rubrics.find((item) => item.rubric_id === nextTask.rubric_id);
                        setVariants(nextRubric?.criteria[0]?.acceptable_variants.join('；') ?? '');
                      }
                      invalidatePreview();
                    }}
                  >
                    {selectedPlan.tasks.map((task) => (
                      <option key={task.task_id} value={changeKind === 'edit_task' ? task.task_id : task.rubric_id}>{task.prompt}</option>
                    ))}
                  </select>
                </label>
                {changeKind === 'edit_task' && (
                  <label className="wide">
                    <span>新题意</span>
                    <textarea
                      className="draft compact"
                      value={prompt}
                      maxLength={4000}
                      onChange={(event) => {
                        setPrompt(event.target.value);
                        invalidatePreview();
                      }}
                    />
                  </label>
                )}
                <label className="wide">
                  <span>合理答案范围（用分号分隔）</span>
                  <textarea
                    className="draft compact"
                    value={variants}
                    maxLength={4000}
                    onChange={(event) => {
                      setVariants(event.target.value);
                      invalidatePreview();
                    }}
                  />
                </label>
              </>
            )}
            {changeKind === 'presentation_only' && (
              <>
                <label>
                  <span>字号比例</span>
                  <input
                    className="search-input"
                    type="number"
                    min={0.8}
                    max={1.5}
                    step={0.05}
                    value={fontScale}
                    onChange={(event) => {
                      setFontScale(event.target.value);
                      invalidatePreview();
                    }}
                  />
                </label>
                <label>
                  <span>纸张</span>
                  <select className="search-input" value={paperSize} onChange={(event) => { setPaperSize(event.target.value as 'A4' | 'Letter'); invalidatePreview(); }}>
                    <option value="A4">A4</option>
                    <option value="Letter">Letter</option>
                  </select>
                </label>
                <label>
                  <span>主题</span>
                  <select className="search-input" value={theme} onChange={(event) => { setTheme(event.target.value as 'light' | 'high_contrast'); invalidatePreview(); }}>
                    <option value="light">明亮</option>
                    <option value="high_contrast">高对比</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <button className="btn" disabled={applying} onClick={() => void previewChange()}>预览改动</button>

          {previewed && (
            <div className="change-preview">
              <b>单一建议方案</b>
              <p>{buildChangeSummary({ changeKind: previewed.change.kind, invalidatedModules: previewed.preview.invalidatedModules, diff: viewDiff, affectedOutputs: AFFECTED_OUTPUTS })}</p>
              <div className="muted small">提案：{previewed.preview.proposal.hypothesis}</div>
              <ul className="diff-list">
                {viewDiff.map((entry, index) => (
                  <li key={`${entry.objectId}-${entry.field}-${index}`}>
                    <b>{entry.objectId} · {entry.field}</b>
                    <span>{displayValue(entry.before)} → {displayValue(entry.after)}</span>
                  </li>
                ))}
              </ul>
              {printWarning && <p className="notice warn small">{PRINTED_COPY_WARNING}</p>}
              <button className="btn" disabled={applying || !!applyResult} onClick={() => void applyChange()}>
                {applying ? '正在校验并同步生成…' : '确认并同步更新'}
              </button>
            </div>
          )}
          {changeMessage && <p className={`notice small ${changeMessage.startsWith('旧版未受影响') ? 'warn' : ''}`}>{changeMessage}</p>}
        </div>
      )}

      {applyResult && (
        <div className="card">
          <div className="card-title">同步更新结果</div>
          <p className="notice small">
            {applyResult.semanticRevisionChanged
              ? `新语义修订 ${applyResult.revisionId}；先前修订仍可用。`
              : `语义修订保持 ${applyResult.revisionId}；仅新增呈现包。`}
          </p>
          <p className="muted small">
            软件审查：{applyResult.reviewReport.disposition}；未执行：{applyResult.reviewReport.not_executed_checks.join('、') || '无'}
          </p>
          {printWarning && <p className="notice warn small">{PRINTED_COPY_WARNING}</p>}
          <ul className="src-list">
            {applyResult.files.map((file) => (
              <li key={`${applyResult.bundleId}-${file.filename}`} className="src-item">
                <div>
                  <b>{file.filename}</b> <span className="tag">{file.role}</span> <span className="tag">{file.format}</span>
                  <div className="muted small mono">{file.byteSize} 字节 · sha256 {file.sha256}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selectedPlan && history && (
        <div className="card">
          <div className="card-title">版本与成品历史</div>
          <p className="muted small">旧修订不会被覆盖；每个成品包按修订与呈现规格单独保留。</p>
          <ul className="history-list">
            {history.revisions.map((revision) => (
              <li key={revision.revisionId}>
                <span className="mono">{revision.revisionId}</span>
                <span>{revision.previousRevisionId ? `来自 ${revision.previousRevisionId}` : '初始修订'}</span>
              </li>
            ))}
            {history.bundles.map((bundle) => (
              <li key={bundle.bundleId}>
                <span className="mono">{bundle.bundleId}</span>
                <span>修订 {bundle.revisionId} · 规格 {bundle.presentationSpecHash.slice(0, 12)}…</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {manifest && (
        <div className="card">
          <div className="card-title">三类五文件（版本一致 · 角色隔离）</div>
          <p className="notice small">{manifest.versionStamp}</p>
          <p className="muted small">内容来源：{manifest.contentOrigin}（自拟/模拟内容明确标注；真实备课质量需真实模型与教师核验）</p>
          <ul className="src-list">
            {manifest.files.map((f) => (
              <li key={f.filename} className="src-item">
                <div>
                  <b>{f.filename}</b>{' '}
                  <span className="tag">{f.role === 'presentation' ? '课堂PPT' : f.role === 'student' ? '学生' : '教师'}</span>{' '}
                  <span className="tag">{f.format}</span>
                  <div className="muted small mono">{f.byteSize} 字节 · sha256 {f.sha256.slice(0, 16)}…</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// 文本格式（渲染层直接读文本）与二进制格式（读 ArrayBuffer→base64 交主进程解析）。
const TEXT_EXT: Record<string, string> = { txt: 'txt', md: 'md', markdown: 'md', csv: 'csv' };
const BINARY_EXT: Record<string, string> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };
const ACCEPT = '.txt,.md,.markdown,.csv,.pdf,.docx,.xlsx,.pptx';

function classifyLabel(c: string): string {
  return (
    { public_reference: '公开参考', licensed_reference: '授权参考', teacher_private: '教师私有', student_sensitive: '学生敏感' }[c] ?? c
  );
}

// 用 FileReader 读为 base64（避免大文件 apply 栈溢出）。
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read_failed'));
    fr.onload = () => {
      const s = String(fr.result);
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.readAsDataURL(file);
  });
}

type PendingItem = {
  title: string;
  format: string;
  existing: { documentId: string; title: string; currentVersion: number; currentHash: string };
} & ({ kind: 'text'; content: string } | { kind: 'file'; base64: string });

function ResourcesPage(): JSX.Element {
  const [sources, setSources] = useState<SourceListItemDTO[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SourceHitDTO[]>([]);
  const [searched, setSearched] = useState(false);
  const [reader, setReader] = useState<(SourceReadDTO & { hitContextQuery?: string }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [versionsFor, setVersionsFor] = useState<{ title: string; classification: string; versions: SourceVersionDTO[] } | null>(null);
  const [verify, setVerify] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<{ title: string; text: string; isTestDouble: boolean; fromCache: boolean } | null>(null);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef(false);
  const currentJobRef = useRef<string | null>(null);
  const [currentJob, setCurrentJob] = useState<string | null>(null);
  const [privacyBusy, setPrivacyBusy] = useState<string | null>(null);
  const [privacyMessage, setPrivacyMessage] = useState<string | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<SourceDeleteSummary | null>(null);
  const privacyKeysRef = useRef(new Map<string, string>());

  async function reloadList(): Promise<void> {
    const r = await window.yuwen.listSources();
    if (r.ok) setSources(r.data.sources);
  }
  useEffect(() => {
    void reloadList();
  }, []);

  // 分批导入：逐个文件处理，保留界面响应，可在文件之间取消。
  async function importFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    setBusy(true);
    cancelRef.current = false;
    const summary: string[] = [];
    for (let idx = 0; idx < list.length; idx++) {
      if (cancelRef.current) {
        summary.push(`已取消，剩余 ${list.length - idx} 个未处理`);
        break;
      }
      const file = list[idx];
      setProgress(`导入中 ${idx + 1}/${list.length}：${file.name}`);
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const textFormat = TEXT_EXT[ext];
      const binFormat = BINARY_EXT[ext];
      if (!textFormat && !binFormat) {
        summary.push(`跳过「${file.name}」：暂不支持的格式（支持 txt/md/csv/pdf/docx/xlsx/pptx）`);
        continue;
      }
      try {
        let r;
        if (textFormat) {
          r = await window.yuwen.importSource({ title: file.name, format: textFormat, content: await file.text() });
        } else {
          const jobId = `job-${Date.now()}-${idx}`;
          currentJobRef.current = jobId;
          setCurrentJob(jobId);
          r = await window.yuwen.importFile({ title: file.name, format: binFormat, base64: await readAsBase64(file), jobId });
          currentJobRef.current = null;
          setCurrentJob(null);
        }
        if (!r.ok) {
          summary.push(`「${file.name}」未导入：${r.error.message_zh}`);
          continue;
        }
        const d = r.data;
        if (d.status === 'imported') summary.push(`「${file.name}」已导入（v${d.version}，hash ${d.contentHash?.slice(0, 8)}…）`);
        else if (d.status === 'new_version') summary.push(`「${file.name}」已作为新版本 v${d.version}`);
        else if (d.status === 'duplicate') summary.push(`「${file.name}」重复（同原件哈希，未新增版本）`);
        else if (d.status === 'cancelled') summary.push(`「${file.name}」已取消（未入库）`);
        else if (d.status === 'needs_confirmation' && d.existing) {
          summary.push(`「${file.name}」检测到同名资料（当前 v${d.existing.currentVersion}），需确认关系`);
          const base: Omit<PendingItem, 'kind' | 'content' | 'base64'> = { title: file.name, format: textFormat ?? binFormat, existing: d.existing };
          const item: PendingItem = textFormat
            ? { ...base, kind: 'text', content: await file.text() }
            : { ...base, kind: 'file', base64: await readAsBase64(file) };
          setPending((prev) => [...prev, item]);
        }
      } catch {
        summary.push(`「${file.name}」读取失败`);
      }
    }
    setProgress(null);
    setMessage(summary.join('；'));
    await reloadList();
    if (query.trim()) await runSearch(query);
    setBusy(false);
  }

  async function resolvePending(item: PendingItem, relation: 'new_version' | 'separate'): Promise<void> {
    const targetDocumentId = relation === 'new_version' ? item.existing.documentId : undefined;
    if (item.kind === 'text') {
      await window.yuwen.importSource({ title: item.title, format: item.format, content: item.content, relation, targetDocumentId });
    } else {
      await window.yuwen.importFile({ title: item.title, format: item.format, base64: item.base64, relation, targetDocumentId });
    }
    setPending((prev) => prev.filter((p) => p !== item));
    await reloadList();
    if (query.trim()) await runSearch(query);
  }

  async function showVersions(documentId: string, title: string, classification: string): Promise<void> {
    const r = await window.yuwen.sourceVersions(documentId);
    if (r.ok) setVersionsFor({ title, classification, versions: r.data.versions });
  }

  function privacyKey(action: string, documentId: string, revision: number): string {
    const signature = `${action}:${documentId}:${revision}`;
    const existing = privacyKeysRef.current.get(signature);
    if (existing) return existing;
    const created = `${action}-${crypto.randomUUID()}`;
    privacyKeysRef.current.set(signature, created);
    return created;
  }

  async function protectSource(source: SourceListItemDTO): Promise<void> {
    if (privacyBusy) return;
    setPrivacyBusy(source.documentId);
    setPrivacyMessage(null);
    const response = await window.yuwen.reclassifySourceSensitive(
      source.documentId,
      source.revision,
      privacyKey('protect', source.documentId, source.revision)
    );
    setPrivacyMessage(response.ok
      ? `已升级为学生敏感资料；${response.data.protectedVersionIds.length} 个版本已转入认证加密，相关课时需重新核对来源。`
      : `敏感升级未完成：${response.error.message_zh}`);
    if (response.ok) await reloadList();
    setPrivacyBusy(null);
  }

  async function deleteSource(source: SourceListItemDTO): Promise<void> {
    if (privacyBusy) return;
    setPrivacyBusy(source.documentId);
    setPrivacyMessage(null);
    setDeleteSummary(null);
    const prepared = await window.yuwen.prepareSourceDelete(
      source.documentId,
      source.revision,
      privacyKey('prepare-delete', source.documentId, source.revision)
    );
    if (!prepared.ok || prepared.data.cancelled || !prepared.data.confirmationToken || !prepared.data.managedBackupIds || !prepared.data.policy) {
      setPrivacyMessage(prepared.ok ? '已取消永久删除。' : `未能确认删除范围：${prepared.error.message_zh}`);
      setPrivacyBusy(null);
      return;
    }
    const deleted = await window.yuwen.deleteSourcePermanently(
      source.documentId,
      source.revision,
      prepared.data.confirmationToken,
      prepared.data.managedBackupIds,
      prepared.data.policy,
      privacyKey('delete', source.documentId, source.revision)
    );
    if (deleted.ok) {
      setDeleteSummary(buildSourceDeleteSummary(deleted.data));
      setPrivacyMessage('本机删除事务已完成；请逐项查看当前数据库、受管备份与外部副本范围。');
      await reloadList();
      if (query.trim()) await runSearch(query);
    } else {
      setPrivacyMessage(`永久删除未完成：${deleted.error.message_zh}`);
    }
    setPrivacyBusy(null);
  }

  // 原件核对：取回原件字节，在本机重算 SHA-256 与存储原件哈希比对（提取成功≠原文已核验）。
  async function verifyOriginal(v: SourceVersionDTO): Promise<void> {
    const r = await window.yuwen.readOriginal(v.versionId);
    if (!r.ok) {
      setVerify((p) => ({ ...p, [v.versionId]: '无原件字节' }));
      return;
    }
    try {
      const bin = Uint8Array.from(atob(r.data.base64), (c) => c.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', bin);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      setVerify((p) => ({ ...p, [v.versionId]: hex === r.data.originalHash ? '核对一致 ✓' : '核对不一致 ✗' }));
    } catch {
      setVerify((p) => ({ ...p, [v.versionId]: `原件 ${r.data.byteSize} 字节（本机无法重算摘要）` }));
    }
  }

  async function runSearch(q: string): Promise<void> {
    const term = q.trim();
    if (!term) {
      setHits([]);
      setSearched(false);
      return;
    }
    const r = await window.yuwen.searchSources(term);
    setHits(r.ok ? r.data.hits : []);
    setSearched(true);
  }

  async function openOriginal(hit: SourceHitDTO): Promise<void> {
    const r = hit.anchor
      ? await window.yuwen.readSource(hit.versionId, hit.anchor.char_start, hit.anchor.char_end)
      : await window.yuwen.readSource(hit.versionId);
    if (r.ok) setReader({ ...r.data, hitContextQuery: query.trim() });
  }

  // 用正文命中片段作为“获准依据”做结构化分析或生成课时计划（上下文边界：仅该获准非敏感片段进入模型）。
  async function analyze(hit: SourceHitDTO, task: 'analyze_text' | 'lesson_outline'): Promise<void> {
    setAiMsg(null);
    if (hit.matchKind !== 'body' || !hit.anchor) {
      setAiMsg('请选择正文命中的片段作为依据（标题命中不作为原文依据）。');
      return;
    }
    const r = await window.yuwen.modelRun({
      task,
      fragments: [{ versionId: hit.versionId, charStart: hit.anchor.char_start, charEnd: hit.anchor.char_end, approved: true }]
    });
    if (!r.ok) {
      setAiMsg(`${task === 'lesson_outline' ? '课时计划' : '分析'}未成功：${r.error.message_zh}`);
      return;
    }
    const d = r.data;
    const res = (d.result ?? {}) as { text?: string; isTestDouble?: boolean };
    const label = task === 'lesson_outline' ? '课时计划' : '结构化分析';
    setAnalysis({ title: `${hit.title} · ${label}`, text: res.text ?? '', isTestDouble: !!res.isTestDouble, fromCache: d.status === 'cached' || !!d.fromCache });
  }

  async function retire(documentId: string): Promise<void> {
    await window.yuwen.retireSource(documentId);
    await reloadList();
    if (query.trim()) await runSearch(query);
  }

  return (
    <div className="page">
      <h1>资料</h1>
      <p className="lead">导入教材与自拟资料，做中文全文检索并精确定位到原文。所有资料先在本机处理。</p>

      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
        }}
      >
        <p className="muted">拖拽 txt / md / csv / pdf / docx / xlsx / pptx 文件到此处，或</p>
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          选择文件导入
        </button>
        {busy && (
          <>
            {currentJob && (
              <button
                className="btn small"
                onClick={() => {
                  if (currentJobRef.current) void window.yuwen.cancelImport(currentJobRef.current);
                }}
              >
                取消当前文件
              </button>
            )}
            <button className="btn small" onClick={() => (cancelRef.current = true)}>
              停止后续
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void importFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="muted small">Word / PDF 直接导入，无需先转换；教师私有为默认分类。学生材料可在导入后升级为认证加密资料。</p>
        {progress && <p className="notice small">{progress}</p>}
        {message && <p className="notice small">{message}</p>}
      </div>

      {pending.map((item, i) => (
        <div className="notice warn confirm-box" key={item.title + i}>
          <div>
            检测到同名资料「{item.title}」（现有当前版本 v{item.existing.currentVersion}）。同名仅表示疑似关联，请明确关系：
          </div>
          <div className="confirm-actions">
            <button className="btn small" onClick={() => void resolvePending(item, 'new_version')}>
              作为新版本（切换当前版本，保留旧版本）
            </button>
            <button className="btn small" onClick={() => void resolvePending(item, 'separate')}>
              作为独立文档
            </button>
            <button className="btn small" onClick={() => setPending((prev) => prev.filter((p) => p !== item))}>
              取消
            </button>
          </div>
        </div>
      ))}

      <div className="card">
        <div className="card-title">检索与原文定位</div>
        <div className="row">
          <input
            className="search-input"
            placeholder="输入关键词（支持单字短词回退）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(query);
            }}
          />
          <button className="btn" onClick={() => void runSearch(query)}>
            搜索
          </button>
        </div>
        {aiMsg && <p className="notice warn small">{aiMsg}</p>}
        {searched && hits.length === 0 && <p className="muted small">未找到匹配的资料。</p>}
        <ul className="hit-list">
          {hits.map((h) => (
            <li key={h.versionId + (h.anchor?.char_start ?? -1)} className="hit">
              <div className="hit-head">
                <b>{h.title}</b>
                <span className="tag">v{h.version}</span>
                <span className="tag">{h.matchKind === 'title' ? '标题命中' : h.locatorLabel}</span>
                {!h.reliable && <span className="pill pill-off">不可靠</span>}
              </div>
              <div className="hit-context">…{h.context}…</div>
              <button className="btn small" onClick={() => void openOriginal(h)}>
                {h.matchKind === 'title' ? '查看文档' : `查看原文（${h.locatorLabel}）`}
              </button>
              {h.matchKind === 'body' && h.anchor && (
                <>
                  <button className="btn small" onClick={() => void analyze(h, 'analyze_text')}>
                    用作依据·分析
                  </button>
                  <button className="btn small" onClick={() => void analyze(h, 'lesson_outline')}>
                    生成课时计划
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="card-title">已导入资料（{sources.length}）</div>
        <p className="muted small">{sensitiveSourceNotice()}</p>
        {privacyMessage && <p className="notice small">{privacyMessage}</p>}
        {deleteSummary && (
          <div className="notice warn small">
            <div>{deleteSummary.database}</div>
            <div>{deleteSummary.managedBackups}</div>
            <div>{deleteSummary.postDeleteBackup}</div>
            <div>{deleteSummary.externalBackups}</div>
            <div>{deleteSummary.physicalErasure}</div>
          </div>
        )}
        {sources.length === 0 && <p className="muted small">暂无资料。用上方导入自拟的 txt / md / csv 打通完整路径。</p>}
        <ul className="src-list">
          {sources.map((s) => (
            <li key={s.documentId} className="src-item">
              <div>
                <b>{s.title}</b>{' '}
                <span className="tag">v{s.version}</span>{' '}
                <span className="tag">{classifyLabel(s.classification)}</span>{' '}
                {s.status === 'retired' ? <span className="pill pill-off">已停用</span> : <span className="pill pill-on">启用中</span>}
                <div className="muted small mono">文本哈希 {s.contentHash?.slice(0, 16)}…</div>
              </div>
              <div className="src-actions">
                <button className="btn small" onClick={() => void showVersions(s.documentId, s.title, s.classification)}>
                  版本/来源
                </button>
                {s.classification !== 'student_sensitive' && (
                  <button className="btn small" disabled={privacyBusy === s.documentId} onClick={() => void protectSource(s)}>
                    升级为学生敏感资料
                  </button>
                )}
                <button className="btn small danger" disabled={privacyBusy === s.documentId} onClick={() => void deleteSource(s)}>
                  永久删除…
                </button>
                {s.status !== 'retired' && (
                  <button className="btn small" onClick={() => void retire(s.documentId)}>
                    停用
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {reader && (
        <div className="reader-mask" onClick={() => setReader(null)}>
          <div className="reader" onClick={(e) => e.stopPropagation()}>
            <div className="reader-head">
              <b>{reader.title}</b> <span className="tag">v{reader.version}</span>
              {reader.char_start !== null && <span className="muted small">定位跨度 {reader.char_start}–{reader.char_end}</span>}
              <button className="btn small" onClick={() => setReader(null)}>
                关闭
              </button>
            </div>
            <pre className="reader-body">{reader.text}</pre>
            {reader.truncated && <p className="muted small">（原文较长，已截断预览）</p>}
          </div>
        </div>
      )}

      {analysis && (
        <div className="reader-mask" onClick={() => setAnalysis(null)}>
          <div className="reader" onClick={(e) => e.stopPropagation()}>
            <div className="reader-head">
              <b>{analysis.title}</b>
              {analysis.isTestDouble && <span className="pill pill-off">测试替身（非真实模型）</span>}
              {analysis.fromCache && <span className="tag">缓存复用</span>}
              <button className="btn small" onClick={() => setAnalysis(null)}>
                关闭
              </button>
            </div>
            <pre className="reader-body">{analysis.text}</pre>
            <p className="muted small">依据仅限所选获准片段；精确事实/引文/版本需教师核实。</p>
          </div>
        </div>
      )}

      {versionsFor && (
        <div className="reader-mask" onClick={() => setVersionsFor(null)}>
          <div className="reader" onClick={(e) => e.stopPropagation()}>
            <div className="reader-head">
              <b>{versionsFor.title} · 版本与来源核对</b>
              <button className="btn small" onClick={() => setVersionsFor(null)}>
                关闭
              </button>
            </div>
            <div className="reader-body">
              <ul className="ver-list">
                {versionsFor.versions.map((v) => (
                  <li key={v.versionId} className="ver-item">
                    <div>
                      <b>v{v.version}</b> {v.isCurrent && <span className="pill pill-on">当前</span>}{' '}
                      <span className="tag">{v.format}</span>
                      {v.scanned && <span className="pill pill-off">扫描件（无可靠文字·未OCR）</span>}
                    </div>
                    <div className="muted small mono">原件哈希 {v.originalHash.slice(0, 24)}…</div>
                    <div className="muted small mono">文本哈希 {v.textHash.slice(0, 24)}…</div>
                    <div className="muted small">导入时间 {v.createdAt}</div>
                    <div className="row" style={{ marginTop: 6 }}>
                      {versionsFor.classification === 'student_sensitive' ? (
                        <span className="muted small">原件只保留在认证加密载荷中，不提供普通读取。</span>
                      ) : (
                        <button className="btn small" onClick={() => void verifyOriginal(v)}>
                          核对原件
                        </button>
                      )}
                      {verify[v.versionId] && <span className="muted small">{verify[v.versionId]}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelPanel(): JSX.Element {
  const [providers, setProviders] = useState<{ id: string; defaultModel: string; requiresKey: boolean }[]>([]);
  const [provider, setProvider] = useState('test-double');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState('0');
  const [allowNet, setAllowNet] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [probeNote, setProbeNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const p = await window.yuwen.modelProviders();
      if (p.ok) setProviders(p.data.providers);
      const c = await window.yuwen.modelGetConfig();
      if (c.ok && c.data.config) {
        const cfg = c.data.config as { provider: string; model: string; budgetCapCents: number; allowRealNetwork: boolean };
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBudget(String(cfg.budgetCapCents));
        setAllowNet(!!cfg.allowRealNetwork);
      }
    })();
  }, []);

  const current = providers.find((p) => p.id === provider);
  async function save(): Promise<void> {
    const r = await window.yuwen.modelConfigure({
      provider,
      model: model.trim() || undefined,
      budgetCapCents: Number(budget) || 0,
      allowRealNetwork: allowNet,
      apiKey: apiKey.trim() || undefined
    });
    setMsg(r.ok ? '已保存配置。' : `配置失败：${r.error.message_zh}`);
    if (r.ok) setApiKey('');
  }
  async function probe(): Promise<void> {
    const r = await window.yuwen.modelProbe();
    setProbeNote(r.ok ? `可用：${r.data.note}` : `未通过：${r.error.message_zh}`);
  }

  return (
    <div className="card">
      <div className="card-title">AI 连接（可配置服务商）</div>
      <p className="muted small">产品运行模型可配置，不绑定单一厂商。默认使用本机“测试替身”打通本地链路；真实云模型需授权账户与联网，未授权保持 BLOCKED。</p>
      <div className="row">
        <label className="muted small">服务商</label>
        <select
          className="search-input"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            const pv = providers.find((x) => x.id === e.target.value);
            setModel(pv?.defaultModel ?? '');
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label className="muted small">模型 ID</label>
        <input className="search-input" value={model} placeholder={current?.defaultModel} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="row">
        <label className="muted small">预算上限(分)</label>
        <input className="search-input" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>
      {current?.requiresKey && (
        <>
          <div className="row">
            <label className="muted small">API 密钥</label>
            <input className="search-input" type="password" value={apiKey} placeholder="仅经系统加密保存，无安全后端将拒绝" onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="row">
            <label className="muted small">
              <input type="checkbox" checked={allowNet} onChange={(e) => setAllowNet(e.target.checked)} /> 允许真实联网（需授权账户；未勾选保持 BLOCKED）
            </label>
          </div>
        </>
      )}
      <div className="confirm-actions">
        <button className="btn small" onClick={() => void save()}>
          保存配置
        </button>
        <button className="btn small" onClick={() => void probe()}>
          探测
        </button>
      </div>
      {msg && <p className="notice small">{msg}</p>}
      {probeNote && <p className="notice small">{probeNote}</p>}
    </div>
  );
}

function ProtectionPanel(): JSX.Element {
  const [backups, setBackups] = useState<BackupRecordDTO[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const response = await window.yuwen.backupsList();
    if (response.ok) setBackups(response.data.backups);
  };
  useEffect(() => { void refresh(); }, []);

  const operationKey = (kind: string): string => `${kind}-${crypto.randomUUID()}`;
  async function createLocal(): Promise<void> {
    setBusy(true);
    const response = await window.yuwen.backupCreateLocal(operationKey('backup-local'));
    setMessage(response.ok ? '本机备份已完成并通过校验。' : response.error.message_zh);
    if (response.ok) await refresh();
    setBusy(false);
  }
  async function exportPortable(): Promise<void> {
    setBusy(true);
    const response = await window.yuwen.backupExportPortable(passphrase, operationKey('backup-portable'));
    setMessage(response.ok ? (response.data.cancelled ? '已取消导出。' : '跨机加密备份已保存。') : response.error.message_zh);
    if (response.ok && response.data.saved) setPassphrase('');
    setBusy(false);
  }
  async function restorePortable(): Promise<void> {
    setBusy(true);
    const previewResponse = await window.yuwen.backupRestorePreview(passphrase, operationKey('restore-preview'));
    if (!previewResponse.ok || previewResponse.data.cancelled || !previewResponse.data.restoreJobId || !previewResponse.data.previewHash || !previewResponse.data.preview) {
      setMessage(previewResponse.ok ? '已取消恢复。' : previewResponse.error.message_zh);
      setBusy(false);
      return;
    }
    const preview: RestorePreviewDTO = previewResponse.data.preview;
    setMessage(restorePreviewNotice(preview));
    const grant = await window.yuwen.backupRestoreRequestConfirmation(
      previewResponse.data.restoreJobId, previewResponse.data.previewHash, operationKey('restore-confirmation')
    );
    if (!grant.ok || grant.data.cancelled || !grant.data.confirmationToken) {
      setMessage(grant.ok ? '已取消恢复。' : grant.error.message_zh);
      setBusy(false);
      return;
    }
    const confirmed = await window.yuwen.backupRestoreConfirm(
      previewResponse.data.restoreJobId, previewResponse.data.previewHash, grant.data.confirmationToken, operationKey('restore-apply')
    );
    setMessage(confirmed.ok ? '恢复包已验证，将重启并安全切换。' : confirmed.error.message_zh);
    setPassphrase('');
    setBusy(false);
  }
  async function deleteBackup(backupId: string): Promise<void> {
    const prepared = await window.yuwen.backupDeletePrepare(backupId, operationKey('backup-delete-prepare'));
    if (!prepared.ok || prepared.data.cancelled || !prepared.data.confirmationToken) {
      setMessage(prepared.ok ? '已取消删除。' : prepared.error.message_zh);
      return;
    }
    const deleted = await window.yuwen.backupDeleteConfirm(backupId, prepared.data.confirmationToken, operationKey('backup-delete-confirm'));
    setMessage(deleted.ok && deleted.data.deleted ? '备份已删除。' : deleted.ok ? '未找到可删除备份。' : deleted.error.message_zh);
    if (deleted.ok) await refresh();
  }

  return (
    <div className="card">
      <div className="card-title">备份与恢复</div>
      <p className="muted small">{portableBackupNotice()}</p>
      <div className="confirm-actions">
        <button className="btn small" disabled={busy} onClick={() => void createLocal()}>立即创建本机备份</button>
      </div>
      <div className="row">
        <label className="muted small">跨机备份口令</label>
        <input className="search-input" type="password" value={passphrase} minLength={14} autoComplete="new-password" onChange={(event) => setPassphrase(event.target.value)} />
      </div>
      <div className="confirm-actions">
        <button className="btn small" disabled={busy || [...passphrase].length < 14} onClick={() => void exportPortable()}>导出跨机加密备份</button>
        <button className="btn small" disabled={busy || [...passphrase].length < 14} onClick={() => void restorePortable()}>从加密备份恢复</button>
      </div>
      {message && <p className="notice small">{message}</p>}
      {buildBackupRows(backups).length === 0 ? <p className="muted small">尚无已验证本机备份。</p> : (
        <ul className="kv">
          {buildBackupRows(backups).map((backup) => (
            <li key={backup.backupId}>
              <span>{backup.createdAt}<br /><small>{backup.retentionLabel} · {backup.sizeLabel}</small></span>
              <b>{backup.statusLabel} <button className="btn small" onClick={() => void deleteBackup(backup.backupId)}>删除</button></b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiagnosticsPanel(): JSX.Element {
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null);
  const [previewHash, setPreviewHash] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function review(): Promise<void> {
    setBusy(true);
    const response = await window.yuwen.diagnosticsPreview();
    if (response.ok) {
      setPreview(response.data.preview);
      setPreviewHash(response.data.previewHash);
      setMessage('请完整核对下方预览；只有当前预览摘要仍匹配时才能保存。');
    } else {
      setPreview(null);
      setPreviewHash(null);
      setMessage(response.error.message_zh);
    }
    setBusy(false);
  }

  async function save(): Promise<void> {
    if (!previewHash) return;
    setBusy(true);
    const response = await window.yuwen.diagnosticsSave(previewHash, `diagnostics-save-${crypto.randomUUID()}`);
    if (response.ok) {
      setMessage(response.data.cancelled ? '已取消保存诊断包。' : '诊断包已按当前预览原子保存；应用没有上传该文件。');
    } else {
      setMessage(`${response.error.message_zh} ${response.error.next_action}`);
      if (response.error.code === 'VERSION_CONFLICT') {
        setPreview(null);
        setPreviewHash(null);
      }
    }
    setBusy(false);
  }

  return (
    <div className="card diagnostics-card">
      <div className="card-title">最小诊断</div>
      <p className="muted small">{diagnosticsScopeNotice()}</p>
      <div className="confirm-actions">
        <button className="btn small" disabled={busy} onClick={() => void review()}>生成并完整预览</button>
        <button
          className="btn small"
          disabled={!diagnosticsSaveEnabled(previewHash, previewHash, busy)}
          onClick={() => void save()}
        >保存当前预览</button>
      </div>
      {message && <p className="notice small">{message}</p>}
      {preview && <pre className="diagnostics-preview">{diagnosticsPreviewText(preview)}</pre>}
    </div>
  );
}

function UpdatePanel(): JSX.Element {
  const [trustConfigured, setTrustConfigured] = useState(false);
  const [summary, setSummary] = useState<UpdateSummary | null>(null);
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.yuwen.updateStatus().then((response) => {
      if (response.ok) {
        setTrustConfigured(response.data.trustConfigured);
        setMessage(response.data.noticeZh);
      } else {
        setMessage(response.error.message_zh);
      }
    });
  }, []);

  async function inspect(): Promise<void> {
    setBusy(true);
    const response = await window.yuwen.inspectOfflineUpdate();
    if (!response.ok) {
      setMessage(response.error.message_zh);
      setSummary(null);
      setConfirmationToken(null);
    } else if (response.data.cancelled) {
      setMessage('已取消选择离线更新包。');
    } else {
      setSummary(response.data.summary);
      setConfirmationToken(response.data.confirmationToken);
      setMessage(response.data.noticeZh);
    }
    setBusy(false);
  }

  async function stage(): Promise<void> {
    if (!summary || !confirmationToken) return;
    setBusy(true);
    const response = await window.yuwen.stageOfflineUpdate({
      confirmationToken,
      manifestSha256: summary.manifestSha256,
      currentVersion: summary.currentVersion,
      targetVersion: summary.targetVersion
    }, `update-stage-${crypto.randomUUID()}`);
    setMessage(response.ok ? updateReadyNotice() : `${response.error.message_zh} ${response.error.next_action}`);
    setConfirmationToken(null);
    setBusy(false);
  }

  return (
    <div className="card update-card">
      <div className="card-title">可信离线更新</div>
      <p className="muted small">{updateTrustNotice(trustConfigured)}</p>
      <div className="confirm-actions">
        <button className="btn small" disabled={busy || !trustConfigured} onClick={() => void inspect()}>
          选择并验证离线更新包
        </button>
        <button
          className="btn small"
          disabled={!canStageUpdate({ trustConfigured, confirmationToken, busy }) || !summary}
          onClick={() => void stage()}
        >仅暂存已验证更新</button>
      </div>
      {message && <p className="notice small" role="status" aria-live="polite">{message}</p>}
      {summary && (
        <ul className="kv update-summary">
          {buildUpdateSummaryRows(summary).map((row) => <li key={row.label}><span>{row.label}</span><b>{row.value}</b></li>)}
        </ul>
      )}
    </div>
  );
}

function SettingsPage({ boot }: { boot: BootstrapData | null }): JSX.Element {
  return (
    <div className="page">
      <h1>帮助与设置</h1>
      <p className="lead">图形化连接 AI、设置费用上限、备份恢复、检查更新与导出诊断。无需命令行或编辑配置文件。教师无需编写或调试提示词。</p>
      <div className="grid">
        <ModelPanel />
        <ProtectionPanel />
        <UpdatePanel />
        <DiagnosticsPanel />
        <div className="card">
          <div className="card-title">关于</div>
          <ul className="kv">
            <li><span>应用</span><b>语文备课工作台</b></li>
            <li><span>版本</span><b>{boot?.app_version ?? '—'}</b></li>
            <li><span>接口版本</span><b>{boot?.schema_version ?? '—'}</b></li>
            <li><span>阶段</span><b>G01 骨架 · G02 本地数据 · G03 资料 · G04 模型闭环(测试替身)</b></li>
          </ul>
          <p className="muted small">
            工程验证版：可自动构建与本地运行，暂缺真实账户、签名与完整教学资料。非正式教学发布。
          </p>
        </div>
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const [nav, setNav] = useState<NavKey>('prepare');
  const { boot, health } = useBootstrap();

  // 关闭前刷新握手在 App 级注册（跨页面生存），卸载时释放订阅（F01）。
  // 控制器为模块单例，页面切换不会丢失在途保存或 dirty 状态。
  useEffect(() => {
    const controller = getDraftController();
    const unsub = window.yuwen.onBeforeClose(async (requestId) => {
      const saved = await controller.flush();
      window.yuwen.notifyFlushDone(requestId, saved);
    });
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') void controller.save();
    };
    const onBlur = (): void => void controller.save();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">语</div>
          <div>
            <div className="brand-name">语文备课工作台</div>
            <div className="brand-sub">YuwenDesk</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${nav === n.key ? 'active' : ''}`}
              onClick={() => setNav(n.key)}
            >
              <span className="nav-label">{n.label}</span>
              <span className="nav-hint">{n.hint}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot muted small">
          面向初中语文教师 · 数据留在本机
        </div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="crumb">{NAV.find((n) => n.key === nav)?.label}</div>
          <StatusPill online={boot?.connection === 'connected'} />
        </header>
        <div className="scroll">
          {nav === 'prepare' && <PreparePage boot={boot} health={health} />}
          {nav === 'courses' && <CoursesPage />}
          {nav === 'resources' && <ResourcesPage />}
          {nav === 'settings' && <SettingsPage boot={boot} />}
        </div>
      </main>
    </div>
  );
}
