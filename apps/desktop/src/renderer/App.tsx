import { useEffect, useRef, useState } from 'react';
import type { BootstrapData, HealthData } from '../shared/ipc';
import { DraftController, DraftSnapshot, getDraftController } from './draftController';

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
