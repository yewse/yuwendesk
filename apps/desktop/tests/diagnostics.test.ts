import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  DiagnosticsService,
  buildDiagnosticsPreview,
  canonicalDiagnosticsJson,
  type DiagnosticsStoreLike
} from '../src/main/protection/diagnostics';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-diagnostics-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CANARIES = [
  'CANARY_API_KEY_9b1d',
  'CANARY_STUDENT_FILENAME_7cc2.docx',
  'CANARY_TEXTBOOK_BODY_6ef3',
  'CANARY_STUDENT_BODY_453a',
  'C:\\CANARY_PRIVATE_PATH_1ad4',
  'CANARY_PROMPT_8c51',
  'CANARY_MODEL_RESPONSE_5a77',
  'CANARY_THROWN_ERROR_300e'
];

function storageFixture(): DiagnosticsStoreLike & { sourceCount: number } {
  return {
    sourceCount: 2,
    diagnosticsSnapshot() {
      return {
        schemaVersion: 12,
        protected: false,
        credentialEncryption: true,
        objectCounts: {
          sources: this.sourceCount,
          lessonPlans: 1,
          materialBundles: 3,
          teachingEvents: 1,
          observations: 1,
          modelJobs: 4
        },
        maintenance: {
          lastBackupCode: 'BACKUP_OK',
          lastRestoreCode: null,
          repeatedFailureCount: 0
        },
        errors: [{ code: 'AUTO_BACKUP_FAILED', count: 2 }],
        // A malicious or accidentally over-broad collector must not reach the allowlisted preview.
        credential: CANARIES[0],
        sourceFilename: CANARIES[1],
        textbookBody: CANARIES[2],
        studentBody: CANARIES[3],
        path: CANARIES[4],
        prompt: CANARIES[5],
        modelResponse: CANARIES[6],
        errorMessage: CANARIES[7]
      } as ReturnType<DiagnosticsStoreLike['diagnosticsSnapshot']>;
    }
  };
}

function serviceFixture(
  dir: string,
  store = storageFixture(),
  hooks?: { beforeDiagnosticsRename?: () => void },
  onChoose?: () => Promise<string | null>
) {
  let chooseCalls = 0;
  const output = join(dir, 'teacher-selected-diagnostics.zip');
  const service = new DiagnosticsService({
    appVersion: '0.1.0',
    buildMode: 'production',
    platform: { targetSupported: true, identity: 'win11', sandboxEnabled: true },
    store,
    backups: { diagnosticsSummary: async () => ({ validBackups: 2, invalidBackups: 1 }) },
    chooseSavePath: async () => {
      chooseCalls += 1;
      return onChoose ? onChoose() : output;
    },
    now: () => new Date('2026-09-20T12:00:00.000Z'),
    faults: hooks
  });
  return { service, store, output, chooseCalls: () => chooseCalls };
}

describe('G09 minimal diagnostics allowlist and two-phase export', () => {
  it('builds only the fixed allowlist and excludes every free-form canary', async () => {
    const { service } = serviceFixture(tempDir());
    const result = await service.preview();
    expect(Object.keys(result.preview)).toEqual([
      'format', 'version', 'generatedAt', 'appVersion', 'buildMode',
      'platform', 'storage', 'maintenance', 'errors', 'network'
    ]);
    expect(Object.keys(result.preview.platform)).toEqual(['targetSupported', 'identity', 'sandboxEnabled']);
    expect(Object.keys(result.preview.storage)).toEqual(['schemaVersion', 'protected', 'credentialEncryption', 'objectCounts']);
    expect(Object.keys(result.preview.maintenance)).toEqual([
      'validBackups', 'invalidBackups', 'lastBackupCode', 'lastRestoreCode', 'repeatedFailureCount'
    ]);
    expect(result.preview.network).toEqual({ automaticUpload: false, localHttpService: 'not_started_by_design' });
    const canonical = canonicalDiagnosticsJson(result.preview);
    expect(result.previewHash).toBe('2986bc3279e5da4ca218ea06acaf32c772902f744b589f78a2b73ca58bdc1792');
    for (const canary of CANARIES) expect(canonical).not.toContain(canary);
  });

  it('saves only the reviewed preview and README through a main-process path callback', async () => {
    const { service, output, chooseCalls } = serviceFixture(tempDir());
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { networkCalls += 1; throw new Error('network must not be called'); }) as typeof fetch;
    const reviewed = await service.preview();
    let result;
    try {
      result = await service.save({
        previewHash: reviewed.previewHash,
        idempotencyKey: 'diagnostics-save-1'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(result).toMatchObject({ saved: true, previewHash: reviewed.previewHash });
    expect(networkCalls).toBe(0);
    expect(chooseCalls()).toBe(1);
    expect(existsSync(output)).toBe(true);
    expect(existsSync(`${output}.partial`)).toBe(false);

    const bytes = readFileSync(output);
    for (const canary of CANARIES) expect(bytes.includes(Buffer.from(canary))).toBe(false);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(['README.txt', 'diagnostics.json']);
    expect(await zip.file('diagnostics.json')!.async('string')).toBe(canonicalDiagnosticsJson(reviewed.preview));
    expect(await zip.file('README.txt')!.async('string')).toContain('不会自动上传');
  });

  it('rejects no preview, stale state, arbitrary path, and same-key different preview', async () => {
    const dir = tempDir();
    const { service, store, chooseCalls } = serviceFixture(dir);
    await expect(service.save({ previewHash: '0'.repeat(64), idempotencyKey: 'missing' }))
      .rejects.toThrow('diagnostics_preview_required');

    const first = await service.preview();
    store.sourceCount += 1;
    await expect(service.save({ previewHash: first.previewHash, idempotencyKey: 'stale' }))
      .rejects.toThrow('diagnostics_preview_stale');
    expect(chooseCalls()).toBe(0);

    const second = await service.preview();
    await expect(service.save({
      previewHash: second.previewHash,
      idempotencyKey: 'arbitrary-path',
      path: join(dir, 'renderer-controlled.zip')
    } as never)).rejects.toThrow('diagnostics_save_input_invalid');

    await service.save({ previewHash: second.previewHash, idempotencyKey: 'same-key' });
    store.sourceCount += 1;
    const third = await service.preview();
    await expect(service.save({ previewHash: third.previewHash, idempotencyKey: 'same-key' }))
      .rejects.toThrow('diagnostics_idempotency_key_reuse');
  });

  it('rechecks the reviewed state after the native save dialog returns', async () => {
    const dir = tempDir();
    let reservations = 0;
    const store = Object.assign(storageFixture(), {
      reserveMaintenanceIdempotency: () => {
        reservations += 1;
        return 'reserved' as const;
      }
    });
    const output = join(dir, 'teacher-selected-diagnostics.zip');
    const { service, chooseCalls } = serviceFixture(dir, store, undefined, async () => {
      store.sourceCount += 1;
      return output;
    });
    const reviewed = await service.preview();
    await expect(service.save({ previewHash: reviewed.previewHash, idempotencyKey: 'dialog-race' }))
      .rejects.toThrow('diagnostics_preview_stale');
    expect(chooseCalls()).toBe(1);
    expect(reservations).toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('removes the private partial file when atomic publication is interrupted', async () => {
    const dir = tempDir();
    const { service, output } = serviceFixture(dir, storageFixture(), {
      beforeDiagnosticsRename: () => { throw new Error(CANARIES[7]); }
    });
    const reviewed = await service.preview();
    await expect(service.save({ previewHash: reviewed.previewHash, idempotencyKey: 'fault' }))
      .rejects.toThrow(CANARIES[7]);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
  });

  it('replays a persisted successful save across service instances and rejects key reuse', async () => {
    const rows = new Map<string, { fingerprint: string; operation: string; status: string; resultJson: string | null }>();
    const store = Object.assign(storageFixture(), {
      getMaintenanceIdempotency: (key: string) => rows.get(key) ?? null,
      reserveMaintenanceIdempotency: (input: { key: string; fingerprint: string; operation: string }) => {
        if (rows.has(input.key)) return 'existing' as const;
        rows.set(input.key, { fingerprint: input.fingerprint, operation: input.operation, status: 'running', resultJson: null });
        return 'reserved' as const;
      },
      saveMaintenanceIdempotency: (input: { key: string; fingerprint: string; operation: string; resultJson: string }) => {
        rows.set(input.key, { fingerprint: input.fingerprint, operation: input.operation, status: 'succeeded', resultJson: input.resultJson });
      }
    });
    const dir = tempDir();
    const first = serviceFixture(dir, store);
    const reviewed = await first.service.preview();
    const saved = await first.service.save({ previewHash: reviewed.previewHash, idempotencyKey: 'persisted-save' });
    const reopened = serviceFixture(dir, store);
    expect(await reopened.service.save({ previewHash: reviewed.previewHash, idempotencyKey: 'persisted-save' })).toEqual(saved);
    expect(reopened.chooseCalls()).toBe(0);
    await expect(reopened.service.save({ previewHash: 'b'.repeat(64), idempotencyKey: 'persisted-save' }))
      .rejects.toThrow('diagnostics_idempotency_key_reuse');
  });

  it('buildDiagnosticsPreview ignores unknown input keys instead of spreading them', () => {
    const preview = buildDiagnosticsPreview({
      generatedAt: '2026-09-20T12:00:00.000Z',
      appVersion: '0.1.0',
      buildMode: 'production',
      platform: { targetSupported: true, identity: 'win11', sandboxEnabled: true, path: CANARIES[4] },
      storage: storageFixture().diagnosticsSnapshot(),
      backupSummary: { validBackups: 1, invalidBackups: 0 },
      prompt: CANARIES[5]
    } as never);
    expect(canonicalDiagnosticsJson(preview)).not.toContain('CANARY_');
  });

  it('collapses unknown uppercase SQLite model errors into one closed-list UNKNOWN code', async () => {
    const dir = tempDir();
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
      decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
    };
    const store = new SqliteStore(dir, { safeStorage });
    await store.load();
    try {
      const now = '2026-09-20T12:00:00.000Z';
      for (const [id, errorCode] of [
        ['leak-a', 'STUDENT_NAME_ALICE'],
        ['leak-b', 'SCHOOL_NAME_BETA']
      ]) {
        store.insertModelJob({
          id, task: 'analyze_text', cacheKey: id, provider: 'test-double', model: 'test-double-v0',
          paramsJson: '{}', promptVersion: 'p', materialVersionsJson: '[]', status: 'failed',
          resultJson: null, costCents: 0, errorCode, createdAt: now, updatedAt: now
        });
      }
      const preview = buildDiagnosticsPreview({
        generatedAt: now,
        appVersion: '0.1.0',
        buildMode: 'production',
        platform: { targetSupported: true, identity: 'win11', sandboxEnabled: true },
        storage: store.diagnosticsSnapshot(),
        backupSummary: { validBackups: 0, invalidBackups: 0 }
      });
      const canonical = canonicalDiagnosticsJson(preview);
      expect(canonical).not.toContain('STUDENT_NAME_ALICE');
      expect(canonical).not.toContain('SCHOOL_NAME_BETA');
      expect(preview.errors).toEqual([{ code: 'UNKNOWN', count: 2 }]);
    } finally {
      store.close();
    }
  });
});
