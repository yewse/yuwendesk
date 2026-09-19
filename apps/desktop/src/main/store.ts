import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
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

const DEFAULT_STATE: PersistShape = {
  draft: { content: '', revision: 0, updated_at: null },
  window: { width: 1180, height: 800 }
};

export class LocalStore {
  private readonly filePath: string;
  private state: PersistShape;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'yuwendesk-local-state.json');
    this.state = { ...DEFAULT_STATE };
  }

  async load(): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        this.state = { ...DEFAULT_STATE };
        return;
      }
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistShape>;
      this.state = {
        draft: { ...DEFAULT_STATE.draft, ...(parsed.draft ?? {}) },
        window: { ...DEFAULT_STATE.window, ...(parsed.window ?? {}) }
      };
    } catch {
      // 损坏时回退到默认，不阻止启动（离线可用是硬要求）。
      this.state = { ...DEFAULT_STATE };
    }
  }

  getDraft(): DraftState {
    return { ...this.state.draft };
  }

  getWindow(): WindowState {
    return { ...this.state.window };
  }

  async saveDraft(content: string): Promise<DraftState> {
    this.state.draft = {
      content,
      revision: this.state.draft.revision + 1,
      updated_at: new Date().toISOString()
    };
    await this.flush();
    return this.getDraft();
  }

  async saveWindow(win: WindowState): Promise<void> {
    this.state.window = { ...win };
    await this.flush();
  }

  storageWritable(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private async flush(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
