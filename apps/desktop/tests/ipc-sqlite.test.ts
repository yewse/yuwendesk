import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService } from '../src/main/ipc';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../src/main/db/sqliteStore';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

// 通过真实 SqliteStore + IPC handle() 路径回归关键保护，不依赖旧 LocalStore 测试说明不退化。
const stores = new Set<SqliteStore>();
async function svcOn(dir: string): Promise<{ svc: IpcService; store: SqliteStore; file: string }> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  const svc = new IpcService({
    store,
    appVersion: '0.1.0',
    appNameZh: 'sqlite-ipc',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false,
    platformTargetSupported: true,
    platformIdentity: 'win11'
  });
  return { svc, store, file: join(dir, 'yuwendesk.db') };
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-sqlite-'));
}
function saveReq(key: string, content: string, revision: number) {
  return {
    schema_version: IPC_SCHEMA_VERSION,
    request_id: key,
    operation: 'ui.saveDraft',
    workspace_id: null,
    idempotency_key: key,
    expected_revision: revision,
    payload: { content }
  };
}
afterEach(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  stores.clear();
});

describe('IPC + 真实 SqliteStore 回归：幂等/并发/版本冲突/失败保护', () => {
  it('同键同请求顺序重放：只写一次，返回同一成功（幂等）', async () => {
    const { svc, store } = await svcOn(tmp());
    const a = await svc.handle('ui.saveDraft', saveReq('k', '甲', 0));
    const b = await svc.handle('ui.saveDraft', saveReq('k', '甲', 0));
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(store.getDraft().revision).toBe(1);
  });

  it('同键同请求并发：二者都得到原始成功，只递增一次', async () => {
    const { svc, store } = await svcOn(tmp());
    const q = saveReq('c', 'A', 0);
    const [a, b] = await Promise.all([svc.handle('ui.saveDraft', q), svc.handle('ui.saveDraft', q)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a).toEqual(b);
    expect(store.getDraft().revision).toBe(1);
  });

  it('不同键同基线版本并发：恰一个成功、一个 VERSION_CONFLICT，最终 revision=1（R3-01 于真实后端）', async () => {
    const { svc, store, file } = await svcOn(tmp());
    const [a, b] = await Promise.all([
      svc.handle('ui.saveDraft', saveReq('writer-A', 'A', 0)),
      svc.handle('ui.saveDraft', saveReq('writer-B', 'B', 0))
    ]);
    const res = [a, b];
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(res.filter((r) => !r.ok && r.error.code === 'VERSION_CONFLICT').length).toBe(1);
    expect(store.getDraft().revision).toBe(1);
    // getDraft 直读 SQLite；应为唯一提交者内容
    const committed = store.getDraft();
    expect(committed.content === 'A' || committed.content === 'B').toBe(true);
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });

  it('过期版本 → VERSION_CONFLICT，不覆盖', async () => {
    const { svc, store } = await svcOn(tmp());
    await svc.handle('ui.saveDraft', saveReq('k1', '原始', 0));
    const conflict = await svc.handle('ui.saveDraft', saveReq('k2', '覆盖尝试', 0));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('VERSION_CONFLICT');
    expect(store.getDraft()).toMatchObject({ content: '原始', revision: 1 });
  });

  it('保护态（高版本 DB）→ IPC 返回失败（DATABASE_LOCKED），不假成功', async () => {
    const dir = tmp();
    const seed = new SqliteStore(dir);
    stores.add(seed);
    await seed.load();
    seed.withTransaction((db) => db.pragma(`user_version = ${SQLITE_SCHEMA_TARGET + 3}`));
    seed.close();
    stores.delete(seed);

    const { svc, store } = await svcOn(dir);
    expect(store.isProtected()).toBe(true);
    const r = await svc.handle('ui.saveDraft', saveReq('k', 'x', 0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DATABASE_LOCKED');
  });

  it('必需记录缺失 → IPC 返回失败，不假成功', async () => {
    const { svc, store } = await svcOn(tmp());
    store.withTransaction((db) => db.prepare('DELETE FROM draft WHERE id=1').run());
    const r = await svc.handle('ui.saveDraft', saveReq('k', 'x', 0));
    expect(r.ok).toBe(false);
  });

  it('T04 跨进程/重启重试：新 SqliteStore+IpcService 同键重放不重复修改、无新增 outbox', async () => {
    const dir = tmp();
    const a = await svcOn(dir);
    const first = await a.svc.handle('ui.saveDraft', saveReq('same-key', '内容', 0));
    expect(first.ok).toBe(true);
    expect(a.store.getDraft().revision).toBe(1);
    expect(a.store.outboxCount()).toBe(1);
    a.store.close();
    stores.delete(a.store);
    // 模拟重启：新 store + 新 IpcService，相同 key/内容/基线重试
    const b = await svcOn(dir);
    const retry = await b.svc.handle('ui.saveDraft', saveReq('same-key', '内容', 0));
    expect(retry.ok).toBe(true);
    expect(b.store.getDraft().revision).toBe(1); // 未重复递增
    expect(b.store.outboxCount()).toBe(1); // 未新增事件
  });
});
