import type { DraftData, IpcResponse } from '../shared/ipc';

// 渲染层草稿保存控制器（F01 渲染侧）。为跨页面生存，采用模块级单例（见文件末尾 draftController）。
// 关键性质：唯一在途 Promise 串行提交；flush 等待在途并继续提交后续 dirty；
// 加载竞争保护；版本冲突保留本地内容、阻塞自动覆盖；写盘失败保留 dirty 并返回失败。
// 依赖注入 api 以便单元测试（不依赖 Electron/DOM）。

export interface DraftApi {
  loadDraft(): Promise<IpcResponse<DraftData>>;
  saveDraft(content: string, expectedRevision: number, idempotencyKey: string): Promise<IpcResponse<DraftData>>;
}

export interface DraftSnapshot {
  content: string;
  revision: number;
  updatedAt: string | null;
  saving: boolean;
  conflict: boolean;
  loaded: boolean;
  lastError: string | null;
  remoteContent: string | null;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `d-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export class DraftController {
  private content = '';
  private revision = 0;
  private updatedAt: string | null = null;
  private saving = false;
  private conflict = false;
  private loaded = false;
  private lastError: string | null = null;
  private remoteContent: string | null = null;

  private dirty = false;
  private key: string | null = null;
  private blocked = false; // 版本冲突后阻塞自动保存，等待用户处理
  private drain: Promise<boolean> = Promise.resolve(true);
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: DraftApi) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  snapshot(): DraftSnapshot {
    return {
      content: this.content,
      revision: this.revision,
      updatedAt: this.updatedAt,
      saving: this.saving,
      conflict: this.conflict,
      loaded: this.loaded,
      lastError: this.lastError,
      remoteContent: this.remoteContent
    };
  }

  hasUnsaved(): boolean {
    return this.dirty;
  }

  async load(): Promise<void> {
    const r = await this.api.loadDraft();
    if (!r.ok) return;
    // 加载竞争保护：若用户在加载完成前已输入（dirty），不覆盖其内容；仅采用磁盘版本作为基线。
    this.revision = r.data.revision;
    if (!this.dirty && this.content === '') {
      this.content = r.data.content;
      this.updatedAt = r.data.updated_at;
    }
    this.loaded = true;
    this.emit();
  }

  // 普通编辑只更新本地待保存内容，绝不解除未解决冲突，也不默认覆盖较新版本（修 R3-04）。
  // 冲突需通过明确的解决动作（resolveKeepLocal/resolveUseRemote）处理。
  setContent(text: string): void {
    this.content = text;
    this.dirty = true;
    if (!this.conflict) {
      this.key = newKey(); // 无冲突时内容变化即换幂等键
    }
    this.emit();
  }

  // 明确解决：以本地内容覆盖（用户明确同意）。提交前由存储层原子重查版本；若期间又变则重新冲突。
  async resolveKeepLocal(): Promise<boolean> {
    if (!this.conflict) return false;
    this.conflict = false;
    this.blocked = false;
    this.dirty = true;
    this.key = newKey();
    this.emit();
    return this.save();
  }

  // 明确解决：采用远端版本，放弃本地改动。
  resolveUseRemote(): void {
    if (!this.conflict) return;
    if (this.remoteContent !== null) this.content = this.remoteContent;
    this.dirty = false;
    this.blocked = false;
    this.conflict = false;
    this.key = null;
    this.emit();
  }

  // 触发保存；返回"最新内容是否已提交"。串行 drain：等待在途保存并继续提交后续 dirty。
  save(): Promise<boolean> {
    const next = this.drain.then(async () => {
      let ok = true;
      while (this.dirty && !this.blocked) {
        const content = this.content;
        const key = this.key ?? (this.key = newKey());
        const expected = this.revision;
        this.saving = true;
        this.lastError = null;
        this.emit();
        let r: IpcResponse<DraftData>;
        try {
          r = await this.api.saveDraft(content, expected, key);
        } catch (e) {
          this.lastError = String(e);
          ok = false;
          break;
        }
        if (r.ok) {
          this.revision = r.data.revision;
          this.updatedAt = r.data.updated_at;
          this.conflict = false;
          if (this.content === content) {
            this.dirty = false;
            this.key = null;
          } else {
            this.key = newKey();
          }
        } else if (r.error.code === 'VERSION_CONFLICT') {
          // 保留本地内容，不隐式覆盖远端；读取远端供展示，阻塞自动保存，等待用户处理。
          const latest = await this.api.loadDraft();
          if (latest.ok) {
            this.revision = latest.data.revision;
            this.remoteContent = latest.data.content;
          }
          this.conflict = true;
          this.blocked = true;
          this.lastError = r.error.message_zh;
          ok = false;
          break;
        } else {
          this.lastError = r.error.message_zh;
          ok = false;
          break;
        }
      }
      this.saving = false;
      this.emit();
      return ok && !this.dirty;
    });
    this.drain = next.then(
      (v) => v,
      () => false
    );
    return next;
  }

  flush(): Promise<boolean> {
    return this.save();
  }
}

// 跨页面生存的单例（绑定真实 window.yuwen）。测试使用独立实例注入 mock api。
let singleton: DraftController | null = null;
export function getDraftController(): DraftController {
  if (!singleton) {
    singleton = new DraftController({
      loadDraft: () => window.yuwen.loadDraft(),
      saveDraft: (content, expectedRevision, key) => window.yuwen.saveDraft(content, expectedRevision, key)
    });
  }
  return singleton;
}
