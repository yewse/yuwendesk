import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService } from '../src/main/ipc';
import { LocalStore } from '../src/main/store';
import { DraftController } from '../src/renderer/draftController';
import { evaluatePlatform } from '../src/main/platform';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-r3-'));
  const store = new LocalStore(dir);
  const svc = new IpcService({
    store,
    appVersion: '0.1.0',
    appNameZh: 'r3',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'development',
    sandboxEnabled: false,
    platformDevOverride: true,
    platformTargetSupported: false,
    platformIdentity: 'dev-override'
  });
  return { dir, file: join(dir, 'yuwendesk-local-state.json'), store, svc };
}
function req(key: string, content: string, revision: number) {
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

describe('R3-01 (F03)：不同 key 同基线版本不得同时提交', () => {
  it('并发不同 key/内容、expected=0：仅一个成功，另一个 VERSION_CONFLICT，最终 revision=1', async () => {
    const x = fresh();
    await x.store.load();
    const a = req('writer-A', 'A', 0);
    const b = req('writer-B', 'B', 0);
    const res = await Promise.all([x.svc.handle(a.operation, a), x.svc.handle(b.operation, b)]);
    const okCount = res.filter((r) => r.ok).length;
    const conflictCount = res.filter((r) => !r.ok && r.error.code === 'VERSION_CONFLICT').length;
    expect(okCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(JSON.parse(readFileSync(x.file, 'utf8')).draft.revision).toBe(1);
  });
});

describe('R3-02 (F02)：读取失败后不得被后续窗口保存抹掉源文件', () => {
  it('注入一次 readFile EIO，随后 saveWindow 不得覆盖原有有效草稿', async () => {
    const x = fresh();
    await x.store.load();
    await x.store.saveDraft('EXISTING IMPORTANT DRAFT');
    const original = readFileSync(x.file, 'utf8');
    // 注入一次性 readFile EIO（确定性），随后正常 saveWindow 不得覆盖原有效草稿。
    let failRead = true;
    const next = new LocalStore(x.dir, undefined, {
      readFile: async (p) => {
        if (failRead) {
          failRead = false;
          throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
        }
        return readFileSync(p, 'utf8');
      }
    });
    await next.load();
    await next.saveWindow({ width: 1200, height: 800 }).catch(() => undefined);
    const preserved = readdirSync(x.dir).some(
      (n) => statSync(join(x.dir, n)).isFile() && readFileSync(join(x.dir, n), 'utf8') === original
    );
    expect(preserved).toBe(true);
    expect(next.isProtected()).toBe(true);
  });
});

describe('R3-03 (F02)：隔离失败后不得覆盖损坏原文件', () => {
  it('注入 quarantine rename EPERM，随后 saveWindow 不得覆盖损坏原文件', async () => {
    const x = fresh();
    const damaged = '{"draft":{"content":"RECOVERABLE FRAGMENT"';
    writeFileSync(x.file, damaged);
    // 注入隔离 rename EPERM（确定性）：隔离失败必须进入保护态，后续 saveWindow 不得覆盖损坏原文件。
    const next = new LocalStore(x.dir, undefined, {
      rename: () => {
        throw Object.assign(new Error('injected quarantine failure'), { code: 'EPERM' });
      }
    });
    await next.load();
    await next.saveWindow({ width: 1200, height: 800 }).catch(() => undefined);
    const preserved = readdirSync(x.dir).some(
      (n) => statSync(join(x.dir, n)).isFile() && readFileSync(join(x.dir, n), 'utf8') === damaged
    );
    expect(preserved).toBe(true);
    expect(next.isProtected()).toBe(true);
  });
});

describe('R3-04 (F01)：未解决冲突时普通打字不得解除阻塞并覆盖较新版本', () => {
  it('冲突后继续 setContent 不派发保存，不覆盖磁盘较新版本，冲突仍在', async () => {
    const x = fresh();
    await x.store.load();
    let calls = 0;
    const dc = new DraftController({
      loadDraft: () =>
        x.svc.handle('ui.loadDraft', {
          schema_version: IPC_SCHEMA_VERSION,
          request_id: 'read',
          operation: 'ui.loadDraft',
          workspace_id: null
        }) as never,
      saveDraft: (content, rev, key) => {
        calls++;
        const q = req(key, content, rev);
        return x.svc.handle(q.operation, q) as never;
      }
    });
    await dc.load();
    const external = req('external', 'NEWER REMOTE VERSION', 0);
    await x.svc.handle(external.operation, external);
    dc.setContent('LOCAL VERSION');
    const first = await dc.save();
    expect(first).toBe(false);
    expect(dc.snapshot().conflict).toBe(true);
    const callsBefore = calls;
    dc.setContent('LOCAL VERSION plus typing, no resolution');
    const second = await dc.flush();
    expect(second).toBe(false);
    expect(calls).toBe(callsBefore); // 普通打字未派发覆盖
    expect(JSON.parse(readFileSync(x.file, 'utf8')).draft.content).toBe('NEWER REMOTE VERSION');
    expect(dc.snapshot().conflict).toBe(true);
  });

  it('明确解决（保留本地）后可提交，并在提交前重查版本', async () => {
    const x = fresh();
    await x.store.load();
    const dc = new DraftController({
      loadDraft: () =>
        x.svc.handle('ui.loadDraft', {
          schema_version: IPC_SCHEMA_VERSION,
          request_id: 'read',
          operation: 'ui.loadDraft',
          workspace_id: null
        }) as never,
      saveDraft: (content, rev, key) => {
        const q = req(key, content, rev);
        return x.svc.handle(q.operation, q) as never;
      }
    });
    await dc.load();
    await x.svc.handle('ui.saveDraft', req('external', 'REMOTE', 0));
    dc.setContent('LOCAL');
    await dc.save();
    expect(dc.snapshot().conflict).toBe(true);
    const resolved = await dc.resolveKeepLocal();
    expect(resolved).toBe(true);
    expect(JSON.parse(readFileSync(x.file, 'utf8')).draft.content).toBe('LOCAL');
    expect(dc.snapshot().conflict).toBe(false);
  });
});

describe('R3-05 (F07)：仅 build 26100 不能判定为 Windows 11 工作站', () => {
  it('无 productType 的 10.0.26100 → targetSupported=false', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { allowDevOverride: false, osRelease: '10.0.26100' });
    expect(r.targetSupported).toBe(false);
  });
  it('workstation(ProductType=1)+build≥22000 → 正式目标 Win11', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { osRelease: '10.0.26100', productType: 1 });
    expect(r.targetSupported).toBe(true);
    expect(r.identity).toBe('win11');
  });
  it('server(ProductType=3) → 可运行但非正式目标', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { osRelease: '10.0.26100', productType: 3 });
    expect(r.supported).toBe(true);
    expect(r.targetSupported).toBe(false);
    expect(r.identity).toBe('windows-server');
  });
  it('信息不足 → identity=unknown，非正式 Win11', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { osRelease: '10.0.22000' });
    expect(r.targetSupported).toBe(false);
    expect(r.identity).toBe('windows-unknown');
  });
});
