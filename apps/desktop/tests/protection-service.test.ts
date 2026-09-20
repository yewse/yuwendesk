import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionService } from '../src/main/protection/service';
import { SqliteStore } from '../src/main/db/sqliteStore';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-protection-service-'));
}

describe('G09 ProtectionService main-process authority', () => {
  it('reserves persistent backup idempotency before side effects and binds portable passphrases with a local-secret digest', async () => {
    const root = temp();
    const store = new SqliteStore(root, {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
        decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
      }
    });
    await store.load();
    let localCalls = 0;
    const output = join(root, 'portable.yuwenbackup');
    const options = {
      userDataDir: root,
      backup: {
        createLocal: async () => { localCalls += 1; throw new Error('published_then_uncertain'); },
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_bound' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      idempotencyStore: store,
      choosePortableSavePath: async () => output,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => false,
      relaunch: () => undefined
    };
    try {
      await expect(new ProtectionService(options).create({ mode: 'local' }, 'uncertain-local')).rejects.toThrow('published_then_uncertain');
      await expect(new ProtectionService(options).create({ mode: 'local' }, 'uncertain-local')).rejects.toThrow('protection_idempotency_incomplete');
      expect(localCalls).toBe(1);

      const first = await new ProtectionService(options).create({ mode: 'portable', passphrase: 'correct horse battery staple' }, 'portable-bound');
      expect(await new ProtectionService(options).create({ mode: 'portable', passphrase: 'correct horse battery staple' }, 'portable-bound')).toEqual(first);
      await expect(new ProtectionService(options).create({ mode: 'portable', passphrase: 'different passphrase value' }, 'portable-bound'))
        .rejects.toThrow('protection_idempotency_key_reuse');
      const row = store.getMaintenanceIdempotency('portable-bound');
      expect(JSON.stringify(row)).not.toContain('correct horse battery staple');
      expect(JSON.stringify(row)).not.toContain('different passphrase value');
    } finally { store.close(); }
  });

  it('does not repeat a reserved backup side effect across concurrent service instances', async () => {
    const root = temp();
    const store = new SqliteStore(root);
    await store.load();
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const options = {
      userDataDir: root,
      backup: {
        createLocal: async () => { calls += 1; started(); await blocked; return { backupId: 'concurrent_local' }; },
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable' } }),
        list: async () => [], deleteManaged: async () => true
      },
      idempotencyStore: store,
      choosePortableSavePath: async () => null, choosePortableOpenPath: async () => null,
      confirmRestore: async () => false, confirmDelete: async () => false, relaunch: () => undefined
    };
    try {
      const first = new ProtectionService(options).create({ mode: 'local' }, 'concurrent-reservation');
      await startedPromise;
      await expect(new ProtectionService(options).create({ mode: 'local' }, 'concurrent-reservation'))
        .rejects.toThrow('protection_idempotency_incomplete');
      release();
      await expect(first).resolves.toEqual({ backupId: 'concurrent_local' });
      expect(calls).toBe(1);
    } finally { store.close(); }
  });


  it('replays completed backup creation from persistent maintenance idempotency after service restart', async () => {
    const root = temp();
    const store = new SqliteStore(root);
    await store.load();
    let calls = 0;
    const options = {
      userDataDir: root,
      backup: {
        createLocal: async () => { calls += 1; return { backupId: 'persistent_local', valid: true }; },
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      idempotencyStore: store,
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => false,
      relaunch: () => undefined
    };
    try {
      const first = await new ProtectionService(options).create({ mode: 'local' }, 'persistent-create-key');
      const replayed = await new ProtectionService(options).create({ mode: 'local' }, 'persistent-create-key');
      expect(replayed).toEqual(first);
      expect(calls).toBe(1);
      await expect(new ProtectionService(options).create({ mode: 'portable', passphrase: 'a-long-enough-passphrase' }, 'persistent-create-key'))
        .rejects.toThrow('protection_idempotency_key_reuse');
    } finally {
      store.close();
    }
  });

  it('uses native-selected paths and never returns the selected path to the renderer', async () => {
    const root = temp();
    const output = join(root, 'portable.yuwenbackup');
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1', path: 'C:\\private\\local.ready', valid: true }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      choosePortableSavePath: async () => output,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => false,
      relaunch: () => undefined
    });
    const result = await service.create({ mode: 'portable', passphrase: 'restore-语文备份-strong-2026' }, 'create-1') as Record<string, unknown>;
    expect(readFileSync(output).toString()).toBe('encrypted');
    expect(result).toMatchObject({ backupId: 'portable_1', saved: true });
    expect(result.path).toBeUndefined();
    const local = await service.create({ mode: 'local' }, 'create-local-1') as Record<string, unknown>;
    expect(local).toMatchObject({ backupId: 'local_1', valid: true });
    expect(local.path).toBeUndefined();
  });

  it('issues a short-lived bound token, consumes it once, writes pending restore, and relaunches', async () => {
    const root = temp();
    const inputPath = join(root, 'input.yuwenbackup');
    writeFileSync(inputPath, 'encrypted');
    const pending: string[] = [];
    let relaunched = 0;
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1' }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => inputPath,
      prepareRestore: async () => ({
        jobId: 'restore_1', previewHash: 'a'.repeat(64), stagedUserDataDir: join(root, 'restore-staging', 'restore_1', 'userData'),
        preview: { backupId: 'portable_1', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 10, apiReconnectRequired: true }
      }),
      writePending: async (_root, prepared, grant) => { pending.push(`${prepared.jobId}:${grant.token}`); },
      confirmRestore: async () => true,
      confirmDelete: async () => false,
      relaunch: () => { relaunched += 1; },
      ids: { restoreJobId: () => 'restore_1', token: () => 'restore-token-1' },
      now: () => 1_000
    });

    const preview = await service.restore({ action: 'preview', passphrase: 'restore-语文备份-strong-2026' }, 'restore-preview') as Record<string, unknown>;
    expect(preview).toMatchObject({ restoreJobId: 'restore_1', previewHash: 'a'.repeat(64) });
    const grant = await service.restore({ action: 'request-confirmation', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64) }, 'restore-confirm-request') as { confirmationToken: string };
    expect(grant.confirmationToken).toBe('restore-token-1');
    const confirmed = await service.restore({
      action: 'confirm', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64), confirmationToken: grant.confirmationToken
    }, 'restore-confirm') as Record<string, unknown>;
    expect(confirmed).toEqual({ restoreJobId: 'restore_1', restartRequired: true });
    expect(pending).toEqual(['restore_1:restore-token-1']);
    expect(relaunched).toBe(1);
    await expect(service.restore({
      action: 'confirm', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64), confirmationToken: grant.confirmationToken
    }, 'restore-confirm-replay')).rejects.toThrow('restore_confirmation_invalid');
  });

  it('binds managed-backup deletion to one backup and consumes the token', async () => {
    const root = temp();
    const deleted: string[] = [];
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1' }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [{ backupId: 'local_1' }],
        deleteManaged: async (id) => { deleted.push(id); return true; }
      },
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => true,
      relaunch: () => undefined,
      ids: { restoreJobId: () => 'restore_1', token: () => 'delete-token-1' },
      now: () => 2_000
    });
    const prepared = await service.delete({ action: 'prepare', backupId: 'local_1' }, 'delete-prepare') as { confirmationToken: string };
    expect(prepared.confirmationToken).toBe('delete-token-1');
    expect(await service.delete({ action: 'confirm', backupId: 'local_1', confirmationToken: prepared.confirmationToken }, 'delete-confirm'))
      .toEqual({ backupId: 'local_1', deleted: true });
    expect(deleted).toEqual(['local_1']);
    await expect(service.delete({ action: 'confirm', backupId: 'other', confirmationToken: prepared.confirmationToken }, 'delete-other'))
      .rejects.toThrow('backup_delete_confirmation_invalid');
  });
});
