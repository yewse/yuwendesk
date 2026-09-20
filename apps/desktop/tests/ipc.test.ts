import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService, isImplementedOperation, validateEnvelope } from '../src/main/ipc';
import { LocalStore } from '../src/main/store';
import { IMPLEMENTED_OPERATIONS, IPC_SCHEMA_VERSION } from '../src/shared/ipc';

function makeService(): { svc: IpcService; store: LocalStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-test-'));
  const store = new LocalStore(dir);
  const svc = new IpcService({
    store,
    appVersion: '0.1.0',
    appNameZh: '语文备课工作台',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false,
    platformTargetSupported: true,
    platformIdentity: 'win11'
  });
  return { svc, store, file: join(dir, 'yuwendesk-local-state.json') };
}

function envelope(op: string, extra: Record<string, unknown> = {}) {
  return { schema_version: IPC_SCHEMA_VERSION, request_id: 'r1', operation: op, workspace_id: null, ...extra };
}
function saveReq(key: string | undefined, content: unknown, revision?: unknown) {
  const base: Record<string, unknown> = {
    schema_version: IPC_SCHEMA_VERSION,
    request_id: 'r',
    operation: 'ui.saveDraft',
    workspace_id: null,
    payload: { content }
  };
  if (key !== undefined) base.idempotency_key = key;
  if (revision !== undefined) base.expected_revision = revision;
  return base;
}

describe('IPC 白名单与外壳校验（SEC/规范 9.1）', () => {
  it('只承认已实现的白名单操作', () => {
    expect(isImplementedOperation('app.health')).toBe(true);
    expect(isImplementedOperation('sources.delete')).toBe(false);
    expect(isImplementedOperation('shell.exec')).toBe(false);
  });
  it('拒绝未实现操作 / 版本不一致 / 通道不符', () => {
    expect(validateEnvelope('shell.exec', envelope('shell.exec'))?.ok).toBe(false);
    expect(validateEnvelope('app.health', { ...envelope('app.health'), schema_version: '9.9.9' })?.ok).toBe(false);
    expect(validateEnvelope('app.health', envelope('app.getStatus'))?.ok).toBe(false);
  });
});

describe('app.health 状态证据（F04：设计保证/运行探针/未知分离，不写死）', () => {
  it('storage_probe 为实测结果；本地服务为设计保证；如实标运行模式与沙箱', async () => {
    const { svc } = makeService();
    const r = await svc.handle('app.health', envelope('app.health'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as Record<string, unknown>;
      expect(d.storage_probe).toBe('ok'); // 真实写入探针
      expect(d.local_http_service).toBe('not_started_by_design');
      expect(d.offline_capable_by_design).toBe(true);
      expect(d.build_mode).toBe('production');
      expect(d.sandbox_enabled).toBe(true);
      expect(d.platform_dev_override).toBe(false);
      expect(d.recovered_from_corruption).toBe(false);
    }
  });
});

describe('app.getStatus 语义（未知不显示为成功）', () => {
  it('无工作区时如实返回 has_workspace=false', async () => {
    const { svc } = makeService();
    const r = await svc.handle('app.getStatus', envelope('app.getStatus'));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { has_workspace: boolean }).has_workspace).toBe(false);
  });
});

// —— F03 / 定向检查 T04,T05：版本号完整校验 ——
describe('ui.saveDraft 版本校验（T04/T05 + 负数/小数）', () => {
  let svc: IpcService;
  beforeEach(() => {
    svc = makeService().svc;
  });
  it('缺失 expected_revision → INPUT_INVALID（T04）', async () => {
    const r = await svc.handle('ui.saveDraft', saveReq('k', 'x', undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INPUT_INVALID');
  });
  it('字符串 expected_revision → INPUT_INVALID（T05）', async () => {
    const r = await svc.handle('ui.saveDraft', saveReq('k', 'x', '0'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INPUT_INVALID');
  });
  it('负数 / 小数 expected_revision → INPUT_INVALID', async () => {
    expect((await svc.handle('ui.saveDraft', saveReq('k1', 'x', -1))).ok).toBe(false);
    expect((await svc.handle('ui.saveDraft', saveReq('k2', 'x', 0.5))).ok).toBe(false);
  });
  it('缺失 / 空 idempotency_key → INPUT_INVALID', async () => {
    expect((await svc.handle('ui.saveDraft', saveReq(undefined, 'x', 0))).ok).toBe(false);
    expect((await svc.handle('ui.saveDraft', saveReq('', 'x', 0))).ok).toBe(false);
  });
  it('非字符串 content → INPUT_INVALID', async () => {
    const r = await svc.handle('ui.saveDraft', saveReq('k', 123, 0));
    expect(r.ok).toBe(false);
  });
  it('载荷含多余字段 → INPUT_INVALID（Schema 门 additionalProperties:false）', async () => {
    const bad = {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'r',
      operation: 'ui.saveDraft',
      workspace_id: null,
      idempotency_key: 'k',
      expected_revision: 0,
      payload: { content: 'x', teacher_only: '不该出现' }
    };
    const r = await svc.handle('ui.saveDraft', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INPUT_INVALID');
  });
});

// —— F03 / 定向检查 T02,T06,T07：幂等语义 ——
describe('ui.saveDraft 幂等（T02 顺序重放 / T06 同键异载荷 / T07 并发同请求）', () => {
  it('同键同请求顺序重放：只写一次，返回同一成功（T02）', async () => {
    const { svc, store } = makeService();
    const a = await svc.handle('ui.saveDraft', saveReq('k', '甲', 0));
    const b = await svc.handle('ui.saveDraft', saveReq('k', '甲', 0));
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(store.getDraft().revision).toBe(1);
  });
  it('同键不同载荷：拒绝键复用，不返回旧成功（T06）', async () => {
    const { svc, store, file } = makeService();
    await svc.handle('ui.saveDraft', saveReq('same', 'A', 0));
    const b = await svc.handle('ui.saveDraft', saveReq('same', 'B', 0));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe('INPUT_INVALID');
    expect(JSON.parse(readFileSync(file, 'utf8')).draft.content).toBe('A');
    expect(store.getDraft().content).toBe('A');
  });
  it('并发同请求：二者都得到原始成功，不误报冲突、只递增一次（T07）', async () => {
    const { svc, store } = makeService();
    const q = saveReq('concurrent', 'A', 0);
    const [a, b] = await Promise.all([svc.handle('ui.saveDraft', q), svc.handle('ui.saveDraft', q)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a).toEqual(b);
    expect(store.getDraft().revision).toBe(1);
  });
  it('不同键是不同写入，正常递增', async () => {
    const { svc } = makeService();
    const r1 = await svc.handle('ui.saveDraft', saveReq('k1', '一', 0));
    const r2 = await svc.handle('ui.saveDraft', saveReq('k2', '二', 1));
    expect(r1.ok && (r1.data as { revision: number }).revision).toBe(1);
    expect(r2.ok && (r2.data as { revision: number }).revision).toBe(2);
  });
});

describe('ui.saveDraft 版本冲突：不覆盖、确定性', () => {
  it('过期 expected_revision → VERSION_CONFLICT，磁盘保持冲突前值', async () => {
    const { svc, store, file } = makeService();
    await svc.handle('ui.saveDraft', saveReq('a', '原始', 0));
    const conflict = await svc.handle('ui.saveDraft', saveReq('b', '覆盖尝试', 0));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('VERSION_CONFLICT');
    expect(JSON.parse(readFileSync(file, 'utf8')).draft.content).toBe('原始');
    expect(store.getDraft().revision).toBe(1);
  });
});

describe('白名单与目录一致性', () => {
  it('实现操作白名单与已发布命名操作一致，且无重复', () => {
    const expected = [
      'app.bootstrap',
      'app.health',
      'app.getStatus',
      'ui.loadDraft',
      'ui.saveDraft',
      'sources.import',
      'sources.importFile',
      'sources.cancelImport',
      'sources.list',
      'sources.search',
      'sources.read',
      'sources.retire',
      'sources.versions',
      'sources.readOriginal',
      'model.providers',
      'model.getConfig',
      'model.configure',
      'model.probe',
      'model.run',
      'model.cancel',
      'model.listJobs',
      'lesson.buildDemo',
      'lesson.list',
      'lesson.get',
      'plans.recordTeaching',
      'feedback.history',
      'observations.add',
      'observations.list',
      'observations.prepareDelete',
      'observations.delete',
      'review.run',
      'change.preview',
      'change.apply',
      'change.history',
      'materials.generate',
      'materials.list'
    ];
    expect([...IMPLEMENTED_OPERATIONS].sort()).toEqual([...expected].sort());
    expect(new Set(IMPLEMENTED_OPERATIONS).size).toBe(IMPLEMENTED_OPERATIONS.length);
  });
});
