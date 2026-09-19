import { useCallback, useEffect, useRef, useState } from 'react';
import type { BootstrapData, HealthData } from '../shared/ipc';

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

function newIdemKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function DraftNote(): JSX.Element {
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const contentRef = useRef('');
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const keyRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await window.yuwen.loadDraft();
      if (r.ok) {
        setContent(r.data.content);
        contentRef.current = r.data.content;
        setRevision(r.data.revision);
        revisionRef.current = r.data.revision;
        setSavedAt(r.data.updated_at);
      }
    })();
  }, []);

  // 串行化保存：任一时刻仅一个在途保存；保存期间内容再变则循环续存。
  // 每段"待保存内容"使用稳定的 idempotency_key，网络重试/关闭刷新与防抖重合时不会重复写入或误报冲突。
  const runSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      while (dirtyRef.current) {
        const snapshot = contentRef.current;
        const key = keyRef.current ?? newIdemKey();
        keyRef.current = key;
        const r = await window.yuwen.saveDraft(snapshot, revisionRef.current, key);
        if (r.ok) {
          revisionRef.current = r.data.revision;
          setRevision(r.data.revision);
          setSavedAt(r.data.updated_at);
          setConflict(false);
          if (contentRef.current === snapshot) {
            dirtyRef.current = false;
            keyRef.current = null;
          } else {
            keyRef.current = newIdemKey();
          }
        } else if (r.error.code === 'VERSION_CONFLICT') {
          const latest = await window.yuwen.loadDraft();
          if (latest.ok) revisionRef.current = latest.data.revision;
          keyRef.current = newIdemKey();
          setConflict(true);
          break;
        } else {
          break;
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  const flushNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (dirtyRef.current) await runSave();
  }, [runSave]);

  // 关闭前刷新 + 切到后台/失焦时落盘（规范 3.3：窗口关闭前自动保存）。
  useEffect(() => {
    window.yuwen.onBeforeClose(async () => {
      await flushNow();
      window.yuwen.notifyFlushDone();
    });
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') void flushNow();
    };
    const onBlur = (): void => void flushNow();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
    };
  }, [flushNow]);

  const onChange = (text: string): void => {
    setContent(text);
    contentRef.current = text;
    dirtyRef.current = true;
    keyRef.current = newIdemKey();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSave(), 500);
  };

  return (
    <div className="card">
      <div className="card-title">备课草稿（本地保存）</div>
      <p className="muted small">
        随手记录本课思路；内容仅保存在本机，自动保存并保留版本。演示离线可用与退出不丢失。
      </p>
      <textarea
        className="draft"
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如：本课《春》——朗读中体会比喻与排比，学生尝试仿写一句…"
        spellCheck={false}
      />
      <div className="row small muted">
        <span>版本 v{revision}</span>
        <span>{saving ? '保存中…' : savedAt ? `已保存 ${new Date(savedAt).toLocaleString('zh-CN')}` : '尚未保存'}</span>
      </div>
      {conflict && (
        <div className="notice warn small">本地草稿已在别处更新，已停止覆盖，请刷新后重试。</div>
      )}
    </div>
  );
}

function HealthPanel({ health }: { health: HealthData | null }): JSX.Element {
  const rows: { label: string; ok: boolean; text: string }[] = health
    ? [
        { label: '主进程', ok: health.main_process === 'ok', text: '正常' },
        { label: '本地存储', ok: health.storage_writable, text: health.storage_writable ? '可写' : '不可写' },
        {
          label: '本地网络监听',
          ok: health.http_listeners === 0,
          text: health.http_listeners === 0 ? '无（符合安全要求）' : `${health.http_listeners} 个`
        },
        { label: '离线可用', ok: health.offline_ready, text: '是' },
        {
          label: '运行模式',
          ok: health.build_mode === 'production',
          text: health.build_mode === 'production' ? '生产' : '开发验证（非正式发布）'
        },
        {
          label: 'OS 沙箱',
          ok: health.sandbox_enabled,
          text: health.sandbox_enabled ? '启用' : '已禁用（仅开发验证）'
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

function CoursesPage(): JSX.Element {
  return (
    <div className="page">
      <h1>我的课程</h1>
      <p className="lead">单元与课时、采用与实际授课分离、版本差异。生成、采用、已授课、有效果是不同状态。</p>
      <div className="card">
        <div className="card-title">暂无课程</div>
        <p className="muted">
          当前为可安装骨架（G01）。备课生成、材料导出与审查将在后续阶段（G05–G07）开放。
        </p>
      </div>
    </div>
  );
}

function ResourcesPage(): JSX.Element {
  return (
    <div className="page">
      <h1>资料</h1>
      <p className="lead">拖拽导入教材与资源，查看来源与教材覆盖。所有资料先在本机处理。</p>
      <div className="card">
        <div className="card-title">导入（后续开放）</div>
        <p className="muted">
          安全解析导入、中文全文检索与精确原文定位将在 G03 开放。学生原始材料默认仅本地保存并加密，不外发。
        </p>
      </div>
    </div>
  );
}

function SettingsPage({ boot }: { boot: BootstrapData | null }): JSX.Element {
  return (
    <div className="page">
      <h1>帮助与设置</h1>
      <p className="lead">图形化连接 AI、设置费用上限、备份恢复、检查更新与导出诊断。无需命令行或编辑配置文件。</p>
      <div className="grid">
        <div className="card">
          <div className="card-title">AI 连接</div>
          <p className="muted">
            未连接。真实 Grok 连接与能力探测需持有人在此配置密钥与费用上限（G04）。当前离线可查阅与编辑现有内容。
          </p>
          <span className="tag">状态：待配置（BLOCKED · 需外部账户）</span>
        </div>
        <div className="card">
          <div className="card-title">关于</div>
          <ul className="kv">
            <li><span>应用</span><b>语文备课工作台</b></li>
            <li><span>版本</span><b>{boot?.app_version ?? '—'}</b></li>
            <li><span>接口版本</span><b>{boot?.schema_version ?? '—'}</b></li>
            <li><span>阶段</span><b>G00/G01 工程验证骨架</b></li>
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
