import { describe, expect, it } from 'vitest';
import { DraftController, type DraftApi } from '../src/renderer/draftController';
import type { DraftData, IpcResponse } from '../src/shared/ipc';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 一个可控的内存后端，模拟主进程 saveDraft/loadDraft 语义（版本、幂等、冲突、慢写、失败）。
class FakeBackend {
  content = '';
  revision = 0;
  updatedAt: string | null = null;
  private seen = new Map<string, IpcResponse<DraftData>>();
  saveDelayMs = 0;
  failNext = 0;
  forceConflictOnce = false;
  saveCalls = 0;

  api(): DraftApi {
    return {
      loadDraft: async () => ({
        ok: true,
        data: { content: this.content, revision: this.revision, updated_at: this.updatedAt }
      }),
      saveDraft: async (content, expected, key) => {
        this.saveCalls++;
        if (this.saveDelayMs) await delay(this.saveDelayMs);
        const prior = this.seen.get(key);
        if (prior) return prior;
        if (this.failNext > 0) {
          this.failNext--;
          return { ok: false, error: { code: 'DISK_FULL', message_zh: '写盘失败', retryable: true, next_action: '重试' } };
        }
        if (this.forceConflictOnce) {
          this.forceConflictOnce = false;
          return { ok: false, error: { code: 'VERSION_CONFLICT', message_zh: '版本冲突', retryable: false, next_action: '刷新' } };
        }
        if (expected !== this.revision) {
          return { ok: false, error: { code: 'VERSION_CONFLICT', message_zh: '版本冲突', retryable: false, next_action: '刷新' } };
        }
        this.content = content;
        this.revision += 1;
        this.updatedAt = new Date().toISOString();
        const res: IpcResponse<DraftData> = {
          ok: true,
          data: { content: this.content, revision: this.revision, updated_at: this.updatedAt }
        };
        this.seen.set(key, res);
        return res;
      }
    };
  }
}

describe('DraftController 关闭刷新与保存可靠性（F01）', () => {
  it('输入后立即 flush：等待落盘并返回 saved=true，磁盘为最新内容', async () => {
    const be = new FakeBackend();
    const c = new DraftController(be.api());
    await c.load();
    c.setContent('最后一句');
    const saved = await c.flush();
    expect(saved).toBe(true);
    expect(be.content).toBe('最后一句');
    expect(be.revision).toBe(1);
  });

  it('保存进行中再 flush：不提前返回，等待在途并提交最新内容', async () => {
    const be = new FakeBackend();
    be.saveDelayMs = 30;
    const c = new DraftController(be.api());
    await c.load();
    c.setContent('A');
    const p1 = c.save(); // 在途
    c.setContent('AB'); // 保存进行中继续输入
    const saved = await c.flush(); // 必须等待在途 + 提交最新
    await p1;
    expect(saved).toBe(true);
    expect(be.content).toBe('AB');
    expect(c.hasUnsaved()).toBe(false);
  });

  it('写盘失败：flush 返回 false，本地内容保留为 dirty，可重试成功', async () => {
    const be = new FakeBackend();
    be.failNext = 1;
    const c = new DraftController(be.api());
    await c.load();
    c.setContent('要保存');
    const first = await c.flush();
    expect(first).toBe(false);
    expect(c.hasUnsaved()).toBe(true);
    expect(c.snapshot().lastError).toBeTruthy();
    const second = await c.flush(); // 重试
    expect(second).toBe(true);
    expect(be.content).toBe('要保存');
  });

  it('版本冲突：保留本地内容，不隐式覆盖远端，暂停自动保存并读到远端内容', async () => {
    const be = new FakeBackend();
    be.content = '远端内容';
    be.revision = 5;
    be.forceConflictOnce = true;
    const c = new DraftController(be.api());
    await c.load(); // revision=5
    c.setContent('本地内容');
    const saved = await c.flush();
    expect(saved).toBe(false);
    const s = c.snapshot();
    expect(s.conflict).toBe(true);
    expect(s.content).toBe('本地内容'); // 本地保留
    expect(s.remoteContent).toBe('远端内容'); // 读到远端供展示
    // 阻塞后：未经新的用户编辑不得自动再写
    const before = be.saveCalls;
    await c.flush();
    expect(be.saveCalls).toBe(before);
  });

  it('加载竞争：加载晚于用户输入时，不覆盖用户已输入内容', async () => {
    const be = new FakeBackend();
    be.content = '磁盘旧稿';
    be.revision = 2;
    be.saveDelayMs = 0;
    const c = new DraftController(be.api());
    // 用户在 load 之前先输入
    c.setContent('用户新输入');
    await c.load(); // 迟到的加载
    expect(c.snapshot().content).toBe('用户新输入');
    // 保存应基于磁盘版本作为基线，成功提交
    const saved = await c.flush();
    expect(saved).toBe(true);
    expect(be.content).toBe('用户新输入');
  });

  it('幂等：flush 与防抖重合导致同内容重复保存时不重复递增（同键复用）', async () => {
    const be = new FakeBackend();
    const c = new DraftController(be.api());
    await c.load();
    c.setContent('同一内容');
    const [a, b] = await Promise.all([c.save(), c.save()]);
    expect(a || b).toBe(true);
    expect(be.revision).toBe(1); // 只递增一次
  });
});
