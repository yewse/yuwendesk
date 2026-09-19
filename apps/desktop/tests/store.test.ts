import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/main/store';

function freshStore(): LocalStore {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-store-'));
  return new LocalStore(dir);
}

describe('LocalStore 并发写入安全（原子写入不因并发 rename 竞争而失败）', () => {
  it('并发的多次 saveDraft/saveWindow 不抛错，最终状态可读且为合法 JSON', async () => {
    const store = freshStore();
    await store.load();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      ops.push(store.saveDraft(`内容${i}`));
      ops.push(store.saveWindow({ width: 1000 + i, height: 700 + i }));
    }
    // 不得因为并发写入而 reject（历史缺陷：临时文件名仅含 pid，导致 rename ENOENT）。
    await expect(Promise.all(ops)).resolves.toBeDefined();
    // 再写入一次确定的终值，确保串行化后最终一致。
    const final = await store.saveDraft('最终内容');
    expect(final.content).toBe('最终内容');
    expect(final.revision).toBeGreaterThan(0);

    // 磁盘文件应为合法 JSON 且反映最终草稿。
    const raw = readFileSync((store as unknown as { filePath: string }).filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.draft.content).toBe('最终内容');
  });

  it('saveDraft 版本单调递增', async () => {
    const store = freshStore();
    await store.load();
    const a = await store.saveDraft('一');
    const b = await store.saveDraft('二');
    expect(b.revision).toBe(a.revision + 1);
  });
});
