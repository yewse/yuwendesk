import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IpcService } from '../src/main/ipc';
import { LocalStore } from '../src/main/store';
import { UpdateValidationError } from '../src/main/update/types';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

function envelope(operation: string, extra: Record<string, unknown> = {}) {
  return { schema_version: IPC_SCHEMA_VERSION, request_id: 'update-request', operation, workspace_id: null, ...extra };
}

function service(updateService: {
  status(): Promise<unknown>;
  inspectOffline(): Promise<unknown>;
  stageOffline(input: Record<string, unknown>): Promise<unknown>;
}): IpcService {
  return new IpcService({
    store: new LocalStore(mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-update-'))),
    updateService,
    appVersion: '0.1.0', appNameZh: '语文备课工作台', platformSupported: true,
    httpListeners: 0, online: false, buildMode: 'production', sandboxEnabled: true,
    platformDevOverride: false, platformTargetSupported: true, platformIdentity: 'win11'
  });
}

describe('narrow update IPC', () => {
  it('returns status and inspection summaries without accepting a renderer path', async () => {
    const status = vi.fn(async () => ({ state: 'trust_not_configured', trustConfigured: false, ready: [] }));
    const inspectOffline = vi.fn(async () => ({ cancelled: true }));
    const svc = service({ status, inspectOffline, stageOffline: vi.fn() });
    expect((await svc.handle('updates.status', envelope('updates.status'))).ok).toBe(true);
    expect((await svc.handle('updates.inspectOffline', envelope('updates.inspectOffline'))).ok).toBe(true);
    const injected = await svc.handle('updates.inspectOffline', envelope('updates.inspectOffline', { payload: { path: 'C:\\evil.exe' } }));
    expect(injected.ok).toBe(false);
    expect(inspectOffline).toHaveBeenCalledTimes(1);
  });

  it('requires a closed confirmation payload and passes idempotency outside renderer-controlled paths', async () => {
    const stageOffline = vi.fn(async () => ({ state: 'verified_ready' }));
    const svc = service({ status: vi.fn(), inspectOffline: vi.fn(), stageOffline });
    const payload = {
      confirmationToken: 'update_token',
      manifestSha256: 'a'.repeat(64),
      currentVersion: '0.1.0',
      targetVersion: '0.2.0'
    };
    const missingKey = await svc.handle('updates.stageOffline', envelope('updates.stageOffline', { payload }));
    expect(missingKey.ok).toBe(false);
    const response = await svc.handle('updates.stageOffline', envelope('updates.stageOffline', {
      idempotency_key: 'stage-idempotency', payload
    }));
    expect(response.ok).toBe(true);
    expect(stageOffline).toHaveBeenCalledWith({ ...payload, idempotencyKey: 'stage-idempotency' });
    expect(JSON.stringify(stageOffline.mock.calls)).not.toContain('path');
  });

  it('maps internal verification errors to fixed UPDATE_UNTRUSTED text without leaking arbitrary errors', async () => {
    const svc = service({
      status: vi.fn(), inspectOffline: vi.fn(),
      stageOffline: vi.fn(async () => { throw new UpdateValidationError('UPDATE_SIGNATURE_INVALID'); })
    });
    const response = await svc.handle('updates.stageOffline', envelope('updates.stageOffline', {
      idempotency_key: 'bad-signature',
      payload: {
        confirmationToken: 'token', manifestSha256: 'b'.repeat(64),
        currentVersion: '0.1.0', targetVersion: '0.2.0'
      }
    }));
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('UPDATE_UNTRUSTED');
      expect(response.error.message_zh).toContain('签名');
      expect(JSON.stringify(response.error)).not.toContain('update signature is invalid');
    }
  });
});
