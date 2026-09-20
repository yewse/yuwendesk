import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService } from '../src/main/ipc';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-src-'));
}
async function svcOn(dir: string): Promise<{ svc: IpcService; store: SqliteStore }> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    appVersion: '0.1.0',
    appNameZh: 'src-ipc',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false,
    platformTargetSupported: true,
    platformIdentity: 'win11'
  });
  return { svc, store };
}
function req(operation: string, payload: unknown) {
  return { schema_version: IPC_SCHEMA_VERSION, request_id: operation, operation, workspace_id: null, payload };
}
afterEach(() => {
  for (const s of stores)
    try {
      s.close();
    } catch {
      /* ignore */
    }
  stores.clear();
});

const 春 = '《春》\n盼望着，盼望着，东风来了，春天的脚步近了。\n小草偷偷地从土里钻出来。';

describe('IPC 资料闭环：导入/搜索/定位/查看/停用', () => {
  it('导入→列表→搜索(带锚点)→按锚点查看原文', async () => {
    const { svc } = await svcOn(tmp());
    const imp = await svc.handle('sources.import', req('sources.import', { title: '春', format: 'txt', content: 春 }));
    expect(imp.ok).toBe(true);

    const list = await svc.handle('sources.list', req('sources.list', undefined));
    expect(list.ok && (list.data as { sources: unknown[] }).sources.length).toBe(1);

    const search = await svc.handle('sources.search', req('sources.search', { query: '春天的脚步' }));
    expect(search.ok).toBe(true);
    const hits = (search.data as { hits: Array<{ versionId: string; anchor: { char_start: number; char_end: number } | null; context: string }> }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].anchor).not.toBeNull();
    expect(hits[0].context).toContain('春天的脚步');

    const h = hits[0];
    const read = await svc.handle('sources.read', req('sources.read', { versionId: h.versionId, charStart: h.anchor!.char_start, charEnd: h.anchor!.char_end }));
    expect(read.ok).toBe(true);
    expect((read.data as { text: string }).text).toContain('春天的脚步');
  });

  it('短词回退：单字检索命中', async () => {
    const { svc } = await svcOn(tmp());
    await svc.handle('sources.import', req('sources.import', { title: '春', format: 'txt', content: 春 }));
    const search = await svc.handle('sources.search', req('sources.search', { query: '草' }));
    expect((search.data as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });

  it('停用后搜索不再命中', async () => {
    const { svc } = await svcOn(tmp());
    const imp = await svc.handle('sources.import', req('sources.import', { title: '春', format: 'txt', content: 春 }));
    const documentId = (imp.data as { documentId: string }).documentId;
    await svc.handle('sources.retire', req('sources.retire', { documentId }));
    const search = await svc.handle('sources.search', req('sources.search', { query: '春天的脚步' }));
    expect((search.data as { hits: unknown[] }).hits.length).toBe(0);
  });

  it('敏感分类 → PRIVACY_BLOCKED（无条件阻止），不落库', async () => {
    const { svc, store } = await svcOn(tmp());
    const r = await svc.handle('sources.import', req('sources.import', { title: '学生作答', format: 'txt', content: '自拟', classification: 'student_sensitive' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRIVACY_BLOCKED');
    expect(store.listSources().length).toBe(0);
  });

  it('schema 门：未知字段被拒', async () => {
    const { svc } = await svcOn(tmp());
    const r = await svc.handle('sources.import', req('sources.import', { title: 't', format: 'txt', content: 'x', evil: 1 }));
    expect(r.ok).toBe(false);
  });

  it('sources.versions 返回版本与双哈希（来源核对）', async () => {
    const { svc } = await svcOn(tmp());
    const imp = await svc.handle('sources.import', req('sources.import', { title: '春', format: 'txt', content: 春 }));
    const documentId = (imp.data as { documentId: string }).documentId;
    const r = await svc.handle('sources.versions', req('sources.versions', { documentId }));
    expect(r.ok).toBe(true);
    const versions = (r.data as { versions: Array<{ version: number; originalHash: string; textHash: string; isCurrent: boolean }> }).versions;
    expect(versions.length).toBe(1);
    expect(versions[0].isCurrent).toBe(true);
    expect(versions[0].originalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0].textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('读取不存在版本 → SOURCE_MISSING', async () => {
    const { svc } = await svcOn(tmp());
    const r = await svc.handle('sources.read', req('sources.read', { versionId: 'nope' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SOURCE_MISSING');
  });
});