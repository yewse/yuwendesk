import { promises as fs } from 'node:fs';
import * as nodefs from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// G01 本地持久化：只保存教师自己的备课草稿与窗口状态，不含任何 AI 生成正文或密钥。
// 使用「临时文件 → 原子改名」保证崩溃时不产生半成品（规范 7.2）。后续 G02 以 SQLite 单写入者替换。

export interface DraftState {
  content: string;
  revision: number;
  updated_at: string | null;
}

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

interface PersistShape {
  draft: DraftState;
  window: WindowState;
}

// 条件保存结果：区分成功与版本冲突（用于原子的乐观并发）。
export type SaveExpectResult =
  | { ok: true; draft: DraftState }
  | { ok: false; reason: 'conflict'; current: DraftState };

// 草稿保存的幂等业务提交（T04）：业务修改 + 幂等结果 + 事件在同一事务内提交。
export interface DraftCommitOp {
  idempotencyKey: string;
  fingerprint: string; // 绑定（基线版本 + 载荷）的确定性指纹
  content: string;
  expectedRevision: number;
}
export type DraftCommitResult =
  | { status: 'applied'; draft: DraftState }
  | { status: 'replayed'; draft: DraftState } // 同键同请求重放：返回原结果，不重复修改
  | { status: 'conflict'; current: DraftState }
  | { status: 'key_reuse' }; // 同键异请求：拒绝

// ===== G03 资料/来源类型与能力接口（由 SqliteStore 实现） =====
export type SourceClassification =
  | 'public_reference'
  | 'licensed_reference'
  | 'teacher_private'
  | 'student_sensitive';
export interface SourceAnchor {
  char_start: number;
  char_end: number;
  line: number;
}
export const SOURCE_CLASSIFICATIONS: readonly SourceClassification[] = [
  'public_reference',
  'licensed_reference',
  'teacher_private',
  'student_sensitive'
];
// 未显式分类时的安全默认：本地私有、不可外发（绝不默认公开）。
export const DEFAULT_CLASSIFICATION: SourceClassification = 'teacher_private';

export interface SourceImportInput {
  title: string;
  format: string;
  content: string;
  classification?: SourceClassification | string;
  // 版本关系（仅在明确确认后传入）：
  //  - relation='new_version' + targetDocumentId：确认为该文档的新版本（显式，允许切换当前版本）。
  //  - relation='separate'：确认为独立的新文档（即使同名）。
  relation?: 'new_version' | 'separate';
  targetDocumentId?: string;
}
export interface SourceExistingSummary {
  documentId: string;
  title: string;
  currentVersion: number;
  currentHash: string;
}
export type SourceImportResult =
  | { status: 'imported' | 'new_version'; documentId: string; versionId: string; version: number; contentHash: string; versionConflict: boolean }
  | { status: 'duplicate'; documentId: string; versionId: string; version: number; contentHash: string }
  // 同标题但内容不同：仅“疑似关联”，需教师明确关系后再落库，不自动新增版本/切换当前版本。
  | { status: 'needs_confirmation'; contentHash: string; existing: SourceExistingSummary }
  | { status: 'blocked_sensitive'; reason: 'not_implemented' | 'encryption_unavailable' }
  // 取消：解析或提交前被取消，已取消任务不得静默入库。
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: 'too_large' | 'empty' | 'bad_classification' | 'parse_failed' | 'limit_exceeded' };
export interface SourceLocator {
  kind: string; // text_line | csv_row | pdf_page | docx_paragraph | docx_table_cell | xlsx_cell | pptx_slide
  [k: string]: number | string;
}
export interface SourceSearchHit {
  documentId: string;
  title: string;
  version: number;
  versionId: string;
  classification: SourceClassification;
  anchor: SourceAnchor | null; // 正文精确锚点；正文未定位到时为 null（不制造假锚点）
  context: string;
  locator: SourceLocator | null; // 结构化定位（页/段落/表格单元格/行列/幻灯片）；标题命中为 null
  reliable: boolean; // 是否可靠文字命中（扫描件无文字不参与）
  locatorLabel: string; // 面向教师的可读定位标签
  matchKind: 'title' | 'body'; // 标题命中与正文命中分开
}
export interface SourceListItem {
  documentId: string;
  title: string;
  classification: SourceClassification;
  status: string;
  version: number;
  contentHash: string;
}
export interface SourceReadResult {
  title: string;
  version: number;
  text: string;
  char_start: number | null;
  char_end: number | null;
  truncated: boolean;
}
export interface SourceVersionItem {
  versionId: string;
  version: number;
  contentHash: string;
  originalHash: string;
  textHash: string;
  format: string;
  scanned: boolean;
  reliableText: boolean;
  createdAt: string;
  isCurrent: boolean;
}
// 真实原始文件导入（PDF/DOCX/…）：字节以 base64 传入（渲染层 ArrayBuffer→base64）。
export interface SourceFileImportInput {
  title: string;
  format: string;
  base64: string;
  classification?: SourceClassification | string;
  relation?: 'new_version' | 'separate';
  targetDocumentId?: string;
  // 取消作用域：注册此 jobId 后，cancelImport(jobId) 可取消当前文件的解析与提交（不影响其它文件）。
  jobId?: string;
}
export interface SourceStore {
  importSource(input: SourceImportInput): SourceImportResult;
  importFile(input: SourceFileImportInput): Promise<SourceImportResult>;
  // 取消当前文件（作用于其解析与提交边界）；返回是否命中在途任务。
  cancelImport(jobId: string): boolean;
  searchSources(query: string): SourceSearchHit[];
  readSource(versionId: string, charStart?: number, charEnd?: number): SourceReadResult | null;
  retireSource(documentId: string): boolean;
  listSources(): SourceListItem[];
  getSourceVersions(documentId: string): SourceVersionItem[];
  // 原件核对途径：返回原件字节（base64）与原件哈希，供外部重算/核对（提取成功≠原文已核验）。
  readOriginal(versionId: string): SourceOriginalResult | null;
  // 版本/权限边界检查所需：由 versionId 反查文档元信息。
  getVersionMeta(versionId: string): SourceVersionMeta | null;
  // 精确区间读取（不加任何前后文 padding）：用于模型上下文，避免复用带未授权前后文的展示预览。
  // 返回 { text, fullLength }；调用方据 fullLength 判断是否越界/需扩展授权，不静默截断。
  readExactRange(versionId: string, charStart: number, charEnd: number): { text: string; fullLength: number } | null;
}
export interface SourceVersionMeta {
  documentId: string;
  title: string;
  version: number;
  classification: SourceClassification;
  status: string;
  isCurrent: boolean;
  textHash: string;
}
export interface SourceOriginalResult {
  base64: string;
  originalHash: string;
  byteSize: number;
  mime: string;
}

// ===== G04 模型配置与作业持久化 =====
export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  budgetCapCents: number;
  allowRealNetwork: boolean;
  updatedAt: string;
}
export interface ModelJobRecord {
  id: string;
  task: string;
  cacheKey: string;
  provider: string;
  model: string;
  paramsJson: string;
  promptVersion: string;
  materialVersionsJson: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  resultJson: string | null;
  costCents: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
// ===== G05 课时计划持久化 =====
export interface LessonRevisionRecord {
  revisionId: string;
  planId: string;
  previousRevisionId: string | null;
  title: string;
  contentJson: string;
  contentOrigin: string;
  valid: boolean;
  createdAt: string;
}
export interface LessonPlanListItem {
  planId: string;
  title: string;
  currentRevisionId: string | null;
  updatedAt: string;
}
export interface LessonStore {
  saveLessonRevision(rec: LessonRevisionRecord, makeCurrent: boolean): void;
  getLessonRevision(planId: string, revisionId?: string): LessonRevisionRecord | null;
  listLessonPlans(): LessonPlanListItem[];
}

export interface ModelStore {
  getModelConfig(): ModelConfig | null;
  setModelConfig(cfg: ModelConfig): void;
  budgetSpentCents(): number;
  findCachedJob(cacheKey: string): ModelJobRecord | null;
  insertModelJob(job: ModelJobRecord): void;
  updateModelJob(id: string, patch: Partial<ModelJobRecord>): void;
  listModelJobs(limit: number): ModelJobRecord[];
  getModelJob(id: string): ModelJobRecord | null;
}

// 草稿存储接口：LocalStore（JSON，G01）与 SqliteStore（G02）均实现，供主进程/IPC 无缝切换。
export interface DraftStore {
  load(): Promise<void>;
  getDraft(): DraftState;
  getWindow(): WindowState;
  saveDraft(content: string): Promise<DraftState>;
  saveDraftExpecting(content: string, expectedRevision: number): Promise<SaveExpectResult>;
  // 幂等业务提交：将版本检查、草稿修改、幂等结果与 outbox 事件置于同一事务；失败回滚。
  commitDraftSave(op: DraftCommitOp): Promise<DraftCommitResult>;
  saveWindow(win: WindowState): Promise<void>;
  probeWritable(): Promise<boolean>;
  isProtected(): boolean;
  recoveredFromCorruption(): boolean;
  corruptBackup(): string | null;
  credentialEncryptionAvailable(): boolean;
}

// 存储保护错误：读取/隔离失败进入保护态后，任何可能覆盖源文件的写入都以此拒绝。
export class StoreProtectedError extends Error {
  readonly code = 'STORE_PROTECTED';
  constructor(public readonly reason: string) {
    super(`store is protected: ${reason}`);
    this.name = 'StoreProtectedError';
  }
}

// 原子写入器：可注入以便测试注入慢写/失败。默认实现写临时文件后原子改名。
export type AtomicWriter = (filePath: string, contents: string) => Promise<void>;

// 可注入的加载期 IO（便于确定性地注入读取/隔离失败）。默认在调用时访问 node:fs（运行时可被 mock）。
export interface StoreIo {
  readFile?: (path: string) => Promise<string>;
  rename?: (from: string, to: string) => void;
}

const DEFAULT_STATE: PersistShape = {
  draft: { content: '', revision: 0, updated_at: null },
  window: { width: 1180, height: 800 }
};

let writeCounter = 0;

const defaultWriter: AtomicWriter = async (filePath, contents) => {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++writeCounter}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, contents, 'utf-8');
  await fs.rename(tmp, filePath);
};

// 运行时结构校验：只有字段类型全部合法的持久化对象才可进入内存状态。
function isValidPersist(v: unknown): v is PersistShape {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const d = o.draft as Record<string, unknown> | undefined;
  const w = o.window as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object' || !w || typeof w !== 'object') return false;
  if (typeof d.content !== 'string') return false;
  if (typeof d.revision !== 'number' || !Number.isSafeInteger(d.revision) || d.revision < 0) return false;
  if (!(d.updated_at === null || typeof d.updated_at === 'string')) return false;
  if (typeof w.width !== 'number' || !Number.isFinite(w.width)) return false;
  if (typeof w.height !== 'number' || !Number.isFinite(w.height)) return false;
  if (w.x !== undefined && (typeof w.x !== 'number' || !Number.isFinite(w.x))) return false;
  if (w.y !== undefined && (typeof w.y !== 'number' || !Number.isFinite(w.y))) return false;
  return true;
}

export class LocalStore {
  private readonly filePath: string;
  private state: PersistShape;
  private readonly writer: AtomicWriter;
  // 串行提交队列：版本检查+候选构造+写盘+内存提交在同一有序边界内完成。
  private queue: Promise<void> = Promise.resolve();
  // 加载时若原文件损坏且成功隔离，记录备份路径。
  private corruptBackupPath: string | null = null;
  // 保护态：源文件存在但未成功读取，或损坏且隔离失败——在可靠读取/成功隔离/用户明确恢复前禁止一切写入。
  private protectedState = false;
  private protectedReasonText: string | null = null;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly renameImpl: (from: string, to: string) => void;

  constructor(userDataDir: string, writer: AtomicWriter = defaultWriter, io: StoreIo = {}) {
    this.filePath = join(userDataDir, 'yuwendesk-local-state.json');
    this.state = structuredClone(DEFAULT_STATE);
    this.writer = writer;
    // 默认在调用时访问 node:fs（属性访问，便于运行时 mock）；测试可注入以确定性地模拟失败。
    this.readFileImpl = io.readFile ?? ((p) => fs.readFile(p, 'utf-8'));
    this.renameImpl = io.rename ?? ((from, to) => nodefs.renameSync(from, to));
  }

  async load(): Promise<void> {
    // 「确认文件不存在」才视为空库；不能把「存在但读取失败」当空库。
    if (!existsSync(this.filePath)) {
      this.state = structuredClone(DEFAULT_STATE);
      return;
    }
    let raw: string;
    try {
      raw = await this.readFileImpl(this.filePath);
    } catch {
      // 存在但未成功读取：进入保护态，绝不以默认状态覆盖未知内容。
      this.enterProtected('read_failed');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantineOrProtect();
      return;
    }
    if (!isValidPersist(parsed)) {
      this.quarantineOrProtect();
      return;
    }
    this.state = { draft: { ...(parsed as PersistShape).draft }, window: { ...(parsed as PersistShape).window } };
  }

  private enterProtected(reason: string): void {
    this.protectedState = true;
    this.protectedReasonText = reason;
    // 内存回退默认，但不写盘；写屏障阻止任何覆盖源文件的操作。
    this.state = structuredClone(DEFAULT_STATE);
  }

  private quarantineOrProtect(): void {
    const backup = `${this.filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      this.renameImpl(this.filePath, backup);
      this.corruptBackupPath = backup;
      this.state = structuredClone(DEFAULT_STATE); // 隔离成功→可从空库开始
    } catch {
      // 隔离失败：进入保护态，绝不覆盖损坏原文件。
      this.corruptBackupPath = this.filePath;
      this.enterProtected('quarantine_failed');
    }
  }

  getDraft(): DraftState {
    return { ...this.state.draft };
  }

  getWindow(): WindowState {
    return { ...this.state.window };
  }

  recoveredFromCorruption(): boolean {
    return this.corruptBackupPath !== null;
  }

  corruptBackup(): string | null {
    return this.corruptBackupPath;
  }

  isProtected(): boolean {
    return this.protectedState;
  }

  protectedReason(): string | null {
    return this.protectedReasonText;
  }

  // 无条件保存（自增版本）。用于窗口无关的直接草稿写入与测试。
  async saveDraft(content: string): Promise<DraftState> {
    const committed = await this.runExclusive(async () => {
      this.assertWritable();
      const candidate: PersistShape = {
        ...this.state,
        draft: { content, revision: this.state.draft.revision + 1, updated_at: new Date().toISOString() }
      };
      await this.writer(this.filePath, JSON.stringify(candidate, null, 2));
      this.state = candidate;
      return candidate;
    });
    return { ...committed.draft };
  }

  // 条件保存：版本检查、候选构造、写盘、内存提交、返回自身快照在同一原子边界内完成（修 R3-01）。
  async saveDraftExpecting(content: string, expectedRevision: number): Promise<SaveExpectResult> {
    return this.runExclusive(async () => {
      this.assertWritable();
      if (this.state.draft.revision !== expectedRevision) {
        return { ok: false as const, reason: 'conflict' as const, current: { ...this.state.draft } };
      }
      const candidate: PersistShape = {
        ...this.state,
        draft: { content, revision: this.state.draft.revision + 1, updated_at: new Date().toISOString() }
      };
      await this.writer(this.filePath, JSON.stringify(candidate, null, 2));
      this.state = candidate;
      return { ok: true as const, draft: { ...candidate.draft } };
    });
  }

  async saveWindow(win: WindowState): Promise<void> {
    await this.runExclusive(async () => {
      this.assertWritable(); // 保护态下窗口保存也不得越过写屏障覆盖源文件
      const candidate: PersistShape = { ...this.state, window: { ...win } };
      await this.writer(this.filePath, JSON.stringify(candidate, null, 2));
      this.state = candidate;
    });
  }

  // 幂等业务提交（LocalStore：会话内内存幂等 + 在途去重；跨重启持久由 SqliteStore 实现）。
  private readonly idemCache = new Map<string, { fingerprint: string; result: DraftCommitResult }>();
  private readonly idemInflight = new Map<string, { fingerprint: string; promise: Promise<DraftCommitResult> }>();

  async commitDraftSave(op: DraftCommitOp): Promise<DraftCommitResult> {
    const cached = this.idemCache.get(op.idempotencyKey);
    if (cached) return cached.fingerprint === op.fingerprint ? this.asReplay(cached.result) : { status: 'key_reuse' };
    const pending = this.idemInflight.get(op.idempotencyKey);
    if (pending) return pending.fingerprint === op.fingerprint ? pending.promise : { status: 'key_reuse' };

    const promise = (async (): Promise<DraftCommitResult> => {
      const r = await this.saveDraftExpecting(op.content, op.expectedRevision);
      return r.ok ? { status: 'applied', draft: r.draft } : { status: 'conflict', current: r.current };
    })();
    this.idemInflight.set(op.idempotencyKey, { fingerprint: op.fingerprint, promise });
    let result: DraftCommitResult;
    try {
      result = await promise;
    } finally {
      this.idemInflight.delete(op.idempotencyKey);
    }
    // 仅缓存确定性结果（applied/conflict）；写盘失败已在 saveDraftExpecting 抛出并向上传播，不缓存。
    this.idemCache.set(op.idempotencyKey, { fingerprint: op.fingerprint, result });
    return result;
  }

  private asReplay(result: DraftCommitResult): DraftCommitResult {
    return result.status === 'applied' ? { status: 'replayed', draft: result.draft } : result;
  }

  storageWritable(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  // LocalStore（G01 JSON 骨架）不承载凭据加密；凭据保护由 G02 SqliteStore + safeStorage 提供。
  credentialEncryptionAvailable(): boolean {
    return false;
  }

  // 受控可写探针：真实写入并删除一个临时文件（F04：不以常量冒充运行检测）。
  async probeWritable(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const probe = `${this.filePath}.probe.${process.pid}.${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(probe, 'ok', 'utf-8');
      await fs.rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private assertWritable(): void {
    if (this.protectedState) {
      throw new StoreProtectedError(this.protectedReasonText ?? 'protected');
    }
  }

  // 串行执行：所有写入按序进行；失败向调用者抛出且不改内存，后续写入从最近已提交状态派生。
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
