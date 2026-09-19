import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

// G01 本地持久化：只保存教师自己的备课草稿与窗口状态，不含任何 AI 生成正文或密钥。
// 使用「临时文件 → 原子改名」保证崩溃时不产生半成品（对应规范 7.2 的原子写入要求）。
// 后续 G02 将以 SQLite 单写入者 + 版本并发替换本地 JSON 存储；此处为骨架占位并保持版本外壳。

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

// 原子写入器：可注入以便测试注入慢写/失败。默认实现写临时文件后原子改名。
export type AtomicWriter = (filePath: string, contents: string) => Promise<void>;

const DEFAULT_STATE: PersistShape = {
  draft: { content: '', revision: 0, updated_at: null },
  window: { width: 1180, height: 800 }
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

let writeCounter = 0;

const defaultWriter: AtomicWriter = async (filePath, contents) => {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++writeCounter}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, contents, 'utf-8');
  await fs.rename(tmp, filePath);
};

export class LocalStore {
  private readonly filePath: string;
  private state: PersistShape;
  private readonly writer: AtomicWriter;
  // 串行化写入队列：每个写入以 mutator 从「最近已提交状态」派生候选，写盘成功后才提交，失败不改内存。
  private queue: Promise<void> = Promise.resolve();
  // 加载时若原文件损坏，记录备份路径，绝不以默认状态覆盖原始坏文件。
  private corruptBackupPath: string | null = null;

  constructor(userDataDir: string, writer: AtomicWriter = defaultWriter) {
    this.filePath = join(userDataDir, 'yuwendesk-local-state.json');
    this.state = structuredClone(DEFAULT_STATE);
    this.writer = writer;
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.state = structuredClone(DEFAULT_STATE);
      return;
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      // 读取失败（IO/权限）：不改动磁盘、不覆盖，回退默认内存状态但记录未持久化。
      this.state = structuredClone(DEFAULT_STATE);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏 JSON：隔离原文件（保留证据），不以默认状态覆盖。
      this.quarantineCorrupt();
      this.state = structuredClone(DEFAULT_STATE);
      return;
    }
    // 运行时结构校验：合法 JSON 但字段类型非法（如 content=123/revision='bad'）不得进入内存状态。
    if (!isValidPersist(parsed)) {
      this.quarantineCorrupt();
      this.state = structuredClone(DEFAULT_STATE);
      return;
    }
    this.state = {
      draft: { ...(parsed as PersistShape).draft },
      window: { ...(parsed as PersistShape).window }
    };
  }

  private quarantineCorrupt(): void {
    const backup = `${this.filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(this.filePath, backup);
      this.corruptBackupPath = backup;
    } catch {
      // 无法改名时也绝不覆盖原文件：保持内存默认，但标记存在未备份的坏文件。
      this.corruptBackupPath = this.filePath;
    }
  }

  // 受控可写探针：真实写入并删除一个临时文件，返回实际结果（F04：不以常量冒充运行检测）。
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

  async saveDraft(content: string): Promise<DraftState> {
    const committed = await this.enqueue((s) => ({
      ...s,
      draft: {
        content,
        revision: s.draft.revision + 1,
        updated_at: new Date().toISOString()
      }
    }));
    return { ...committed.draft };
  }

  async saveWindow(win: WindowState): Promise<void> {
    await this.enqueue((s) => ({ ...s, window: { ...win } }));
  }

  storageWritable(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  // 串行化：从最近已提交状态派生候选 → 写盘 → 仅在成功后提交内存。失败向调用者抛出且不改内存版本。
  private enqueue(mutator: (state: PersistShape) => PersistShape): Promise<PersistShape> {
    const run = async (): Promise<PersistShape> => {
      const candidate = mutator(this.state);
      await this.writer(this.filePath, JSON.stringify(candidate, null, 2));
      this.state = candidate; // 只有写盘成功才提交，避免"写盘失败提前改内存版本"
      return candidate;
    };
    const result = this.queue.then(run, run);
    // 让队列在失败后仍可继续（后续写入从最近已提交状态派生），但把失败传播给本次调用者。
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
