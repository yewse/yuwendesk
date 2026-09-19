import { useEffect, useRef, useState } from 'react';
import type { BootstrapData, HealthData, SourceHitDTO, SourceListItemDTO, SourceReadDTO } from '../shared/ipc';
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

const SUPPORTED_EXT: Record<string, string> = { txt: 'txt', md: 'md', markdown: 'md', csv: 'csv' };

function classifyLabel(c: string): string {
  return (
    { public_reference: '公开参考', licensed_reference: '授权参考', teacher_private: '教师私有', student_sensitive: '学生敏感' }[c] ?? c
  );
}

function ResourcesPage(): JSX.Element {
  const [sources, setSources] = useState<SourceListItemDTO[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SourceHitDTO[]>([]);
  const [searched, setSearched] = useState(false);
  const [reader, setReader] = useState<(SourceReadDTO & { hitContextQuery?: string }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<
    { title: string; format: string; content: string; existing: { documentId: string; title: string; currentVersion: number; currentHash: string } }[]
  >([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function reloadList(): Promise<void> {
    const r = await window.yuwen.listSources();
    if (r.ok) setSources(r.data.sources);
  }
  useEffect(() => {
    void reloadList();
  }, []);

  async function importFiles(files: FileList | File[]): Promise<void> {
    setBusy(true);
    const summary: string[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const format = SUPPORTED_EXT[ext];
      if (!format) {
        summary.push(`跳过「${file.name}」：暂不支持的格式（当前支持 txt / md / csv）`);
        continue;
      }
      const content = await file.text();
      const r = await window.yuwen.importSource({ title: file.name, format, content });
      if (!r.ok) {
        summary.push(`「${file.name}」导入失败：${r.error.message_zh}`);
        continue;
      }
      const d = r.data;
      if (d.status === 'imported') summary.push(`「${file.name}」已导入（v${d.version}，hash ${d.contentHash?.slice(0, 8)}…）`);
      else if (d.status === 'new_version') summary.push(`「${file.name}」已作为新版本 v${d.version}`);
      else if (d.status === 'duplicate') summary.push(`「${file.name}」内容重复（同哈希，未新增版本）`);
      else if (d.status === 'needs_confirmation' && d.existing) {
        summary.push(`「${file.name}」检测到同名资料（当前 v${d.existing.currentVersion}），需确认关系`);
        setPending((prev) => [...prev, { title: file.name, format, content, existing: d.existing! }]);
      }
    }
    setMessage(summary.join('；'));
    await reloadList();
    if (query.trim()) await runSearch(query);
    setBusy(false);
  }

  async function resolvePending(
    item: { title: string; format: string; content: string; existing: { documentId: string } },
    relation: 'new_version' | 'separate'
  ): Promise<void> {
    await window.yuwen.importSource({
      title: item.title,
      format: item.format,
      content: item.content,
      relation,
      targetDocumentId: relation === 'new_version' ? item.existing.documentId : undefined
    });
    setPending((prev) => prev.filter((p) => p !== item));
    await reloadList();
    if (query.trim()) await runSearch(query);
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
        <p className="muted">拖拽 txt / md / csv 文件到此处，或</p>
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          选择文件导入
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void importFiles(e.target.files);
            e.target.value = '';
          }}
        />
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
        {searched && hits.length === 0 && <p className="muted small">未找到匹配的资料。</p>}
        <ul className="hit-list">
          {hits.map((h) => (
            <li key={h.versionId + (h.anchor?.char_start ?? -1)} className="hit">
              <div className="hit-head">
                <b>{h.title}</b>
                <span className="tag">v{h.version}</span>
                {h.anchor && <span className="muted small">第 {h.anchor.line} 行 · 字符 {h.anchor.char_start}–{h.anchor.char_end}</span>}
              </div>
              <div className="hit-context">…{h.context}…</div>
              <button className="btn small" onClick={() => void openOriginal(h)}>
                查看原文
              </button>
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
                <div className="muted small mono">hash {s.contentHash?.slice(0, 16)}…</div>
              </div>
              {s.status !== 'retired' && (
                <button className="btn small" onClick={() => void retire(s.documentId)}>
                  停用
                </button>
              )}
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
