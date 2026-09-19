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

  storageWritable(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
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
