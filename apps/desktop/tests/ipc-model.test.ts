import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService } from '../src/main/ipc';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { ModelService } from '../src/main/model/service';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-model-'));
}
async function svcOn(dir: string): Promise<{ svc: IpcService; store: SqliteStore }> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  const svc = new IpcService({
    store,
    sourceStore: store,
    modelService: new ModelService(store),
    appVersion: '0',
    appNameZh: 'm',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: true,
    platformTargetSupported: true,
    platformIdentity: 'm'
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

function seed(s: SqliteStore) {
  const r = s.importSource({ title: '春', format: 'txt', content: '盼望着，东风来了，春天的脚步近了。' });
  if (r.status !== 'imported') throw new Error('seed');
  return { versionId: s.getSourceVersions(r.documentId)[0].versionId };
}

describe('IPC 模型闭环：配置/探测/运行/边界/schema', () => {
  it('providers 列出可配置服务商(含 deepseek 与 test-double)', async () => {
    const { svc } = await svcOn(tmp());
    const r = await svc.handle('model.providers', req('model.providers', undefined));
    const ids = (r.data as { providers: { id: string }[] }).providers.map((p) => p.id);
    expect(ids).toContain('deepseek');
    expect(ids).toContain('test-double');
  });

  it('配置 test-double → 探测 ok；运行获准片段 → 成功且标注测试替身', async () => {
    const { svc, store } = await svcOn(tmp());
    await svc.handle('model.configure', req('model.configure', { provider: 'test-double' }));
    const probe = await svc.handle('model.probe', req('model.probe', undefined));
    expect(probe.ok).toBe(true);
    const { versionId } = seed(store);
    const run = await svc.handle('model.run', req('model.run', { task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] }));
    expect(run.ok).toBe(true);
    const d = run.data as { status: string; result: { isTestDouble: boolean } };
    expect(d.status).toBe('succeeded');
    expect(d.result.isTestDouble).toBe(true);
  });

  it('未获准片段 → INPUT_INVALID（不外发）', async () => {
    const { svc, store } = await svcOn(tmp());
    await svc.handle('model.configure', req('model.configure', { provider: 'test-double' }));
    const { versionId } = seed(store);
    const run = await svc.handle('model.run', req('model.run', { task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: false }] }));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('INPUT_INVALID');
  });

  it('deepseek 真实运行 → MODEL_NOT_AVAILABLE（不伪造）', async () => {
    const { svc, store } = await svcOn(tmp());
    // 无安全后端：配置不带密钥仍可保存配置；运行时真实调用 BLOCKED
    await svc.handle('model.configure', req('model.configure', { provider: 'deepseek' }));
    const { versionId } = seed(store);
    const run = await svc.handle('model.run', req('model.run', { task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] }));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('MODEL_NOT_AVAILABLE');
  });

  it('schema 门：model.run 未知字段被拒', async () => {
    const { svc } = await svcOn(tmp());
    const r = await svc.handle('model.run', req('model.run', { task: 'analyze_text', evil: 1 }));
    expect(r.ok).toBe(false);
  });
});
