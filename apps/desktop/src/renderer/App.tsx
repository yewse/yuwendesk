import { useEffect, useRef, useState } from 'react';
import type { BootstrapData, HealthData, SourceHitDTO, SourceListItemDTO, SourceReadDTO, SourceVersionDTO } from '../shared/ipc';
import type { ChangePreview, LessonChange } from '../main/change/types';
import type { LessonPlan } from '../main/lesson/types';
import type { LessonChangeApplyResult } from '../main/store';
import { DraftController, DraftSnapshot, getDraftController } from './draftController';
import {
  buildChangeSummary,
  needsPrintedCopyWarning,
  PRINTED_COPY_WARNING,
  type LessonChangeViewDiff
} from './lessonChangeView';

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
  const applyKeyRef = useRef<string | null>(null);
  const applyingRef = useRef(false);

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

  async function openPlan(planId: string): Promise<void> {
    const response = await window.yuwen.lessonGet(planId);
    if (!response.ok) {
      setChangeMessage(`读取失败：${response.error.message_zh}`);
      return;
    }
    const plan = response.data.plan as LessonPlan;
    setSelectedPlan(plan);
    setDurationMinutes(String(Math.round(plan.declared_duration_sec / 60)));
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
    await loadHistory(planId);
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
                  打开一处修改
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
  const [versionsFor, setVersionsFor] = useState<{ title: string; versions: SourceVersionDTO[] } | null>(null);
  const [verify, setVerify] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<{ title: string; text: string; isTestDouble: boolean; fromCache: boolean } | null>(null);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef(false);
  const currentJobRef = useRef<string | null>(null);
  const [currentJob, setCurrentJob] = useState<string | null>(null);

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

  async function showVersions(documentId: string, title: string): Promise<void> {
    const r = await window.yuwen.sourceVersions(documentId);
    if (r.ok) setVersionsFor({ title, versions: r.data.versions });
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
        <p className="muted small">Word / PDF 直接导入，无需先转换；教师私有为默认分类，敏感学生材料在安全路径实现前一律阻止。</p>
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
                <button className="btn small" onClick={() => void showVersions(s.documentId, s.title)}>
                  版本/来源
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
                      <button className="btn small" onClick={() => void verifyOriginal(v)}>
                        核对原件
                      </button>
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

function SettingsPage({ boot }: { boot: BootstrapData | null }): JSX.Element {
  return (
    <div className="page">
      <h1>帮助与设置</h1>
      <p className="lead">图形化连接 AI、设置费用上限、备份恢复、检查更新与导出诊断。无需命令行或编辑配置文件。教师无需编写或调试提示词。</p>
      <div className="grid">
        <ModelPanel />
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
