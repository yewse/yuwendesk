import { describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, type AtomicWriter } from '../src/main/store';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-store-'));
}
function fileOf(dir: string): string {
  return join(dir, 'yuwendesk-local-state.json');
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LocalStore 提交顺序与并发（F02 / T01,T03,T11）', () => {
  it('T01：新建 LocalStore 实例 load 后可读到已提交草稿', async () => {
    const dir = tmpDir();
    const a = new LocalStore(dir);
    await a.load();
    await a.saveDraft('已保存');
    const b = new LocalStore(dir);
    await b.load();
    expect(b.getDraft()).toMatchObject({ content: '已保存', revision: 1 });
  });

  it('T03：并发 saveDraft/saveWindow 交叠，磁盘最终一致且为合法 JSON', async () => {
    const dir = tmpDir();
    const store = new LocalStore(dir);
    await store.load();
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      tasks.push(store.saveDraft(`内容${i}`));
      tasks.push(store.saveWindow({ width: 1000 + i, height: 700 + i }));
    }
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    const disk = JSON.parse(readFileSync(fileOf(dir), 'utf8'));
    expect(disk.draft.content).toBe('内容24');
    expect(disk.draft.revision).toBe(25);
    expect(disk.window.width).toBe(1024);
  });

  it('T11：每次 saveDraft 返回自身提交的快照，而非后续状态', async () => {
    const dir = tmpDir();
    const store = new LocalStore(dir);
    await store.load();
    const [a, b] = await Promise.all([store.saveDraft('A'), store.saveDraft('B')]);
    expect(a).toMatchObject({ content: 'A', revision: 1 });
    expect(b).toMatchObject({ content: 'B', revision: 2 });
  });
});

describe('LocalStore 写盘失败不提前提交（F02 / T08 + 慢写）', () => {
  it('T08：注入写入失败，内存草稿与版本保持提交前值', async () => {
    const dir = tmpDir();
    let fail = false;
    const writer: AtomicWriter = async (fp, contents) => {
      if (fail) {
        const e = new Error('synthetic ENOSPC') as NodeJS.ErrnoException;
        e.code = 'ENOSPC';
        throw e;
      }
      await fsp.writeFile(fp, contents, 'utf-8');
    };
    const store = new LocalStore(dir, writer);
    await store.load();
    await store.saveDraft('committed-A');
    const before = store.getDraft();
    fail = true;
    let code: string | undefined;
    await store.saveDraft('uncommitted-B').catch((e: NodeJS.ErrnoException) => (code = e.code));
    expect(code).toBe('ENOSPC');
    expect(store.getDraft()).toEqual(before); // 未提交
  });

  it('慢写下并发保存仍串行、最终一致（不靠删断言/加等待）', async () => {
    const dir = tmpDir();
    const writer: AtomicWriter = async (fp, contents) => {
      await delay(15);
      await fsp.writeFile(fp, contents, 'utf-8');
    };
    const store = new LocalStore(dir, writer);
    await store.load();
    const [a, b, c] = await Promise.all([store.saveDraft('X'), store.saveDraft('Y'), store.saveDraft('Z')]);
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    expect(c.revision).toBe(3);
    expect(JSON.parse(readFileSync(fileOf(dir), 'utf8')).draft.content).toBe('Z');
  });
});

describe('LocalStore 加载校验与坏文件隔离（F02 / T09,T10）', () => {
  it('T09：坏 JSON 原文件被隔离保留，不被后续窗口保存覆盖', async () => {
    const dir = tmpDir();
    const damaged = '{"draft":{"content":"RECOVER-ME"';
    writeFileSync(fileOf(dir), damaged);
    const store = new LocalStore(dir);
    await store.load();
    expect(store.recoveredFromCorruption()).toBe(true);
    await store.saveWindow({ width: 900, height: 700 });
    const preserved = readdirSync(dir).some(
      (n) => statSync(join(dir, n)).isFile() && readFileSync(join(dir, n), 'utf8') === damaged
    );
    expect(preserved).toBe(true);
  });

  it('T10：合法 JSON 但字段类型非法不得进入运行状态（隔离并回退安全默认）', async () => {
    const dir = tmpDir();
    writeFileSync(
      fileOf(dir),
      JSON.stringify({ draft: { content: 123, revision: 'bad', updated_at: null }, window: { width: 'bad', height: 700 } })
    );
    const store = new LocalStore(dir);
    await store.load();
    expect(store.recoveredFromCorruption()).toBe(true);
    const d = store.getDraft();
    const w = store.getWindow();
    expect(typeof d.content).toBe('string');
    expect(Number.isSafeInteger(d.revision)).toBe(true);
    expect(typeof w.width).toBe('number');
  });

  it('合法文件正常加载，不误判为损坏', async () => {
    const dir = tmpDir();
    const a = new LocalStore(dir);
    await a.load();
    await a.saveDraft('正常');
    const b = new LocalStore(dir);
    await b.load();
    expect(b.recoveredFromCorruption()).toBe(false);
    expect(b.getDraft().content).toBe('正常');
  });
});

describe('LocalStore 可写探针（F04）', () => {
  it('可写目录 probeWritable 为 true 且不残留探针文件', async () => {
    const dir = tmpDir();
    const store = new LocalStore(dir);
    await store.load();
    expect(await store.probeWritable()).toBe(true);
    const leftover = readdirSync(dir).filter((n) => n.includes('.probe.'));
    expect(leftover.length).toBe(0);
  });
});
