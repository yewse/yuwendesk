import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService, type SourcePrivacyServiceLike } from '../src/main/ipc';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import { SourcePrivacyService } from '../src/main/protection/sourcePrivacy';

const stores = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-src-'));
}
function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}
async function svcOn(
  dir: string,
  encrypted = false,
  sourcePrivacyOverride?: SourcePrivacyServiceLike
): Promise<{ svc: IpcService; store: SqliteStore }> {
  const store = new SqliteStore(dir, encrypted ? { safeStorage: fakeSafe() } : undefined);
  stores.add(store);
  await store.load();
  const sourcePrivacyService = sourcePrivacyOverride ?? new SourcePrivacyService({
    store,
    backup: {
      findManagedBackupsContainingSource: async () => [],
      deleteManagedBackups: async () => ({ deletedIds: [], remainingIds: [] }),
      createLocal: async () => ({ backupId: 'post_delete' })
    },
    confirmDelete: async () => ({ policy: 'delete_managed_and_create_post_delete' }),
    token: () => 'source-delete-token',
    now: () => Date.parse('2026-09-20T00:00:00.000Z')
  });
  const svc = new IpcService({
    store,
    sourceStore: store,
    sourcePrivacyService,
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
function req(operation: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { schema_version: IPC_SCHEMA_VERSION, request_id: operation, operation, workspace_id: 'workspace_local', payload, ...extra };
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

  it('敏感分类在无安全密钥后端时 → PRIVACY_BLOCKED，不落库', async () => {
    const { svc, store } = await svcOn(tmp());
    const r = await svc.handle('sources.import', req('sources.import', { title: '学生作答', format: 'txt', content: '自拟', classification: 'student_sensitive' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PRIVACY_BLOCKED');
    expect(store.listSources().length).toBe(0);
  });

  it('安全密钥可用时可导入敏感资料，但不可读取普通正文', async () => {
    const { svc, store } = await svcOn(tmp(), true);
    const r = await svc.handle('sources.import', req('sources.import', {
      title: '学生姓名作答', format: 'txt', content: '学生姓名：样例回答', classification: 'student_sensitive'
    }));
    expect(r.ok).toBe(true);
    expect(store.listSources()[0].title).not.toContain('学生姓名');
    const versionId = (r.data as { versionId: string }).versionId;
    const read = await svc.handle('sources.read', req('sources.read', { versionId }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('SOURCE_MISSING');
  });

  it('重分类与永久删除要求版本/幂等，并经绑定确认 token', async () => {
    const { svc, store } = await svcOn(tmp(), true);
    const imported = store.importSource({ title: '待保护资料', format: 'txt', content: '学生作答样例' });
    if (imported.status !== 'imported') throw new Error('seed failed');

    const reclassified = await svc.handle('sources.reclassify', req('sources.reclassify', {
      documentId: imported.documentId, targetClassification: 'student_sensitive'
    }, { expected_revision: 2, idempotency_key: 'reclassify-ipc-1' }));
    expect(reclassified.ok).toBe(true);
    expect(store.listSources()[0].classification).toBe('student_sensitive');

    const prepared = await svc.handle('sources.prepareDelete', req('sources.prepareDelete', {
      documentId: imported.documentId
    }, { expected_revision: 3, idempotency_key: 'prepare-delete-ipc-1' }));
    expect(prepared.ok).toBe(true);
    const grant = prepared.data as { confirmationToken: string; managedBackupIds: string[]; policy: string };
    const deleted = await svc.handle('sources.delete', req('sources.delete', {
      documentId: imported.documentId,
      confirmationToken: grant.confirmationToken,
      managedBackupIds: grant.managedBackupIds,
      policy: grant.policy
    }, { expected_revision: 3, idempotency_key: 'delete-ipc-1' }));
    expect(deleted.ok).toBe(true);
    expect(store.listSources()).toEqual([]);
  });

  it('重分类/删除 schema 拒绝任意路径和多余字段', async () => {
    const { svc } = await svcOn(tmp(), true);
    const reclassify = await svc.handle('sources.reclassify', req('sources.reclassify', {
      documentId: 'd1', targetClassification: 'student_sensitive', path: 'C:\\outside'
    }, { expected_revision: 1, idempotency_key: 'k1' }));
    expect(reclassify.ok).toBe(false);
    const deletion = await svc.handle('sources.delete', req('sources.delete', {
      documentId: 'd1', confirmationToken: 't', managedBackupIds: [], policy: 'keep_managed', ciphertext: 'x'
    }, { expected_revision: 1, idempotency_key: 'k2' }));
    expect(deletion.ok).toBe(false);
  });

  it('受管备份范围变化 → VERSION_CONFLICT，要求重新确认范围', async () => {
    const sourcePrivacyService: SourcePrivacyServiceLike = {
      prepareDelete: async () => ({ confirmationToken: 'token', managedBackupIds: [], policy: 'keep_managed' }),
      delete: async () => { throw new Error('source_delete_scope_changed'); }
    };
    const { svc } = await svcOn(tmp(), true, sourcePrivacyService);
    const deletion = await svc.handle('sources.delete', req('sources.delete', {
      documentId: 'document-1', confirmationToken: 'token', managedBackupIds: [], policy: 'keep_managed'
    }, { expected_revision: 1, idempotency_key: 'delete-scope-changed' }));
    expect(deletion.ok).toBe(false);
    if (!deletion.ok) {
      expect(deletion.error.code).toBe('VERSION_CONFLICT');
      expect(deletion.error.next_action).toContain('最新备份范围');
    }
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
