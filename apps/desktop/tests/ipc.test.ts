import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService, isImplementedOperation, validateEnvelope } from '../src/main/ipc';
import { LocalStore } from '../src/main/store';
import { IMPLEMENTED_OPERATIONS, IPC_SCHEMA_VERSION } from '../src/shared/ipc';

function makeService(): IpcService {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-test-'));
  const store = new LocalStore(dir);
  return new IpcService({
    store,
    appVersion: '0.1.0',
    appNameZh: '语文备课工作台',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false
  });
}

function envelope(op: string, extra: Record<string, unknown> = {}) {
  return { schema_version: IPC_SCHEMA_VERSION, request_id: 'r1', operation: op, workspace_id: null, ...extra };
}

describe('IPC 白名单与外壳校验（SEC/规范 9.1）', () => {
  it('只承认已实现的白名单操作', () => {
    expect(isImplementedOperation('app.health')).toBe(true);
    expect(isImplementedOperation('sources.delete')).toBe(false);
    expect(isImplementedOperation('shell.exec')).toBe(false);
  });

  it('拒绝未实现操作', () => {
    const bad = validateEnvelope('shell.exec', envelope('shell.exec'));
    expect(bad?.ok).toBe(false);
  });

  it('拒绝接口版本不一致', () => {
    const bad = validateEnvelope('app.health', { ...envelope('app.health'), schema_version: '9.9.9' });
    expect(bad?.ok).toBe(false);
  });

  it('拒绝通道与内容不一致', () => {
    const bad = validateEnvelope('app.health', envelope('app.getStatus'));
    expect(bad?.ok).toBe(false);
  });
});

describe('app.health 语义（INS-008：无本地监听）', () => {
  it('生产骨架报告 0 个 HTTP 监听', async () => {
    const svc = makeService();
    const r = await svc.handle('app.health', envelope('app.health'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { http_listeners: number }).http_listeners).toBe(0);
      expect((r.data as { offline_ready: boolean }).offline_ready).toBe(true);
    }
  });
});

describe('app.getStatus 语义（未知不显示为成功）', () => {
  it('无工作区时如实返回 has_workspace=false', async () => {
    const svc = makeService();
    const r = await svc.handle('app.getStatus', envelope('app.getStatus'));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { has_workspace: boolean }).has_workspace).toBe(false);
  });
});

describe('ui.saveDraft 版本并发（规范 7.3）', () => {
  let svc: IpcService;
  beforeEach(() => {
    svc = makeService();
  });

  it('保存草稿并递增版本，重启后可恢复', async () => {
    const r1 = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'k1', payload: { content: '本课《春》' } }));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect((r1.data as { revision: number }).revision).toBe(1);

    const load = await svc.handle('ui.loadDraft', envelope('ui.loadDraft'));
    expect(load.ok).toBe(true);
    if (load.ok) expect((load.data as { content: string }).content).toBe('本课《春》');
  });

  it('expected_revision 过期返回 VERSION_CONFLICT，不覆盖', async () => {
    await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'k1', payload: { content: 'A' } }));
    const conflict = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'k2', payload: { content: 'B' } }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('VERSION_CONFLICT');
  });

  it('拒绝无效 payload', async () => {
    const bad = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { payload: { content: 123 } }));
    expect(bad.ok).toBe(false);
  });
});

describe('ui.saveDraft 幂等（idempotency_key，防重放/网络重试重复写入）', () => {
  it('相同 idempotency_key 重放只应用一次，返回同一结果而非再次递增或冲突', async () => {
    const svc = makeService();
    const first = await svc.handle(
      'ui.saveDraft',
      envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'same-key', payload: { content: '甲' } })
    );
    expect(first.ok).toBe(true);
    const firstRev = first.ok ? (first.data as { revision: number }).revision : -1;
    expect(firstRev).toBe(1);

    // 重放同一请求（同 key、同 expected_revision）——例如客户端在 REQUEST_UNCERTAIN 后重试。
    const replay = await svc.handle(
      'ui.saveDraft',
      envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'same-key', payload: { content: '甲' } })
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      // 幂等：版本仍为 1，不得递增到 2，也不得因 expected_revision 过期而返回冲突。
      expect((replay.data as { revision: number }).revision).toBe(1);
    }

    const load = await svc.handle('ui.loadDraft', envelope('ui.loadDraft'));
    if (load.ok) expect((load.data as { content: string }).content).toBe('甲');
  });

  it('不同 idempotency_key 是不同写入，正常递增', async () => {
    const svc = makeService();
    const r1 = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'k1', payload: { content: '一' } }));
    const r2 = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 1, idempotency_key: 'k2', payload: { content: '二' } }));
    expect(r1.ok && (r1.data as { revision: number }).revision).toBe(1);
    expect(r2.ok && (r2.data as { revision: number }).revision).toBe(2);
  });
});

describe('ui.saveDraft 并发：冲突时不得部分写入/覆盖', () => {
  it('过期 expected_revision 冲突后，磁盘内容保持为冲突前的值', async () => {
    const svc = makeService();
    await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'a', payload: { content: '原始' } }));
    const conflict = await svc.handle('ui.saveDraft', envelope('ui.saveDraft', { expected_revision: 0, idempotency_key: 'b', payload: { content: '覆盖尝试' } }));
    expect(conflict.ok).toBe(false);
    const load = await svc.handle('ui.loadDraft', envelope('ui.loadDraft'));
    if (load.ok) {
      expect((load.data as { content: string }).content).toBe('原始');
      expect((load.data as { revision: number }).revision).toBe(1);
    }
  });
});

describe('app.health 状态证据（真实运行标志，不写死）', () => {
  it('如实反映 build_mode / sandbox_enabled / platform_dev_override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-test-'));
    const store = new LocalStore(dir);
    const svc = new IpcService({
      store,
      appVersion: '0.1.0',
      appNameZh: '语文备课工作台',
      platformSupported: true,
      httpListeners: 0,
      online: false,
      buildMode: 'development',
      sandboxEnabled: false,
      platformDevOverride: true
    });
    const r = await svc.handle('app.health', envelope('app.health'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { build_mode: string; sandbox_enabled: boolean; platform_dev_override: boolean };
      expect(d.build_mode).toBe('development');
      expect(d.sandbox_enabled).toBe(false);
      expect(d.platform_dev_override).toBe(true);
    }
  });
});

describe('白名单与目录一致性', () => {
  it('预加载暴露的操作数与实现数一致', () => {
    expect(IMPLEMENTED_OPERATIONS.length).toBe(5);
  });
});
