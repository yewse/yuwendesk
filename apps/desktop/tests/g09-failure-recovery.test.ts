import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCoordinator, BackupService } from '../src/main/protection/backup';
import { ProtectionService } from '../src/main/protection/service';
import { applyPendingRestoreBeforeOpen, writePendingRestore } from '../src/main/protection/restore';
import { SqliteStore, type SourcePrivacyFaultHooks } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

const stores = new Set<SqliteStore>();
const dirs: string[] = [];
function tempDir(label = 'yuwendesk-g09-fault-'): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
}
function safeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}
async function open(dir: string, sourcePrivacyFaults?: SourcePrivacyFaultHooks): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { safeStorage: safeStorage(), sourcePrivacyFaults });
  stores.add(store);
  await store.load();
  return store;
}
function close(store: SqliteStore): void {
  store.close();
  stores.delete(store);
}
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('G09 cross-operation fault recovery', () => {
  it('keeps the old good backup when snapshot or publication faults interrupt a new backup', async () => {
    const dir = tempDir();
    const store = await open(dir);
    const baseline = new BackupService({
      userDataDir: dir, appVersion: '0.1.0', store,
      ids: { backupId: () => 'old_good' }, now: () => new Date('2026-09-19T10:00:00.000Z')
    });
    await baseline.createLocal();

    for (const [backupId, faults] of [
      ['snapshot_fault', { afterOnlineSnapshot: () => { throw new Error('fault'); } }],
      ['rename_fault', { beforeManifestRename: () => { throw new Error('fault'); } }]
    ] as const) {
      const failing = new BackupService({
        userDataDir: dir, appVersion: '0.1.0', store,
        ids: { backupId: () => backupId }, now: () => new Date('2026-09-20T10:00:00.000Z'), faults
      });
      await expect(failing.createLocal()).rejects.toThrow('fault');
      expect((await failing.list()).map((item) => item.backupId)).toEqual(['old_good']);
      expect(existsSync(join(dir, 'backups', `${backupId}.ready`))).toBe(false);
      expect(existsSync(join(dir, 'backups', `${backupId}.partial`))).toBe(false);
    }
  });

  it('cleans portable staging when key wrapping has completed but publication is interrupted', async () => {
    const dir = tempDir();
    const store = await open(dir);
    const imported = store.importSource({
      title: '敏感夹具', format: 'txt', content: '仅为虚构学生作答', classification: 'student_sensitive'
    });
    expect(imported.status).toBe('imported');
    const backup = new BackupService({
      userDataDir: dir, appVersion: '0.1.0', store,
      ids: { backupId: () => 'portable_fault' },
      faults: { afterPortableKeyWrap: () => { throw new Error('portable_fault'); } }
    });
    await expect(backup.exportPortable('portable-语文-strong-passphrase')).rejects.toThrow('portable_fault');
    expect(existsSync(join(dir, 'backup-temp', 'portable_fault.partial'))).toBe(false);
  });

  it('does not write a pending marker or relaunch when the confirmation boundary faults', async () => {
    const dir = tempDir();
    let relaunched = false;
    const service = new ProtectionService({
      userDataDir: dir,
      backup: {
        createLocal: async () => ({}), exportPortable: async () => { throw new Error('unused'); },
        list: async () => [], deleteManaged: async () => false
      },
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => join(dir, 'input.yuwenbackup'),
      confirmRestore: async () => true,
      confirmDelete: async () => false,
      relaunch: () => { relaunched = true; },
      prepareRestore: async () => ({
        jobId: 'restore_fault', previewHash: 'a'.repeat(64),
        stagedUserDataDir: join(dir, 'restore-staging', 'restore_fault', 'userData'),
        preview: { backupId: 'portable', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 12, apiReconnectRequired: true }
      }),
      writePending: async (root) => { await import('node:fs/promises').then((fs) => fs.writeFile(join(root, 'pending-restore.json'), 'bad')); },
      ids: { restoreJobId: () => 'restore_fault', token: () => 'restore-fault-token' },
      now: () => 1_000,
      faults: { beforePendingMarker: () => { throw new Error('pending_fault'); } }
    });
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'input.yuwenbackup'), 'fixture'));
    const preview = await service.restore({ action: 'preview', passphrase: 'strong-passphrase' }, 'preview') as { restoreJobId: string; previewHash: string };
    const grant = await service.restore({
      action: 'request-confirmation', restoreJobId: preview.restoreJobId, previewHash: preview.previewHash
    }, 'grant') as { confirmationToken: string };
    await expect(service.restore({
      action: 'confirm', restoreJobId: preview.restoreJobId, previewHash: preview.previewHash,
      confirmationToken: grant.confirmationToken
    }, 'confirm')).rejects.toThrow('pending_fault');
    expect(existsSync(join(dir, 'pending-restore.json'))).toBe(false);
    expect(relaunched).toBe(false);
  });

  it('restores the original current data when switching faults after the rollback move', async () => {
    const dir = tempDir();
    const current = await open(dir);
    await current.saveDraft('old current data');
    close(current);
    const stagedDir = join(dir, 'restore-staging', 'rollback_fault', 'userData');
    mkdirSync(stagedDir, { recursive: true });
    const staged = await open(stagedDir);
    await staged.saveDraft('new staged data');
    close(staged);
    const prepared = {
      jobId: 'rollback_fault', previewHash: 'b'.repeat(64), stagedUserDataDir: stagedDir,
      preview: { backupId: 'candidate', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 12, apiReconnectRequired: true as const }
    };
    await writePendingRestore(dir, prepared, {
      token: 'rollback-token', jobId: prepared.jobId, previewHash: prepared.previewHash, expiresAt: Date.now() + 60_000
    });
    const result = await applyPendingRestoreBeforeOpen(dir, async () => true, {
      afterCurrentDataRollbackMove: () => { throw new Error('switch_fault'); }
    });
    expect(result.status).toBe('rolled_back');
    const reopened = await open(dir);
    expect(reopened.getDraft().content).toBe('old current data');
  });

  it('restores only the moved database when switching faults before old materials move', async () => {
    const dir = tempDir();
    const current = await open(dir);
    await current.saveDraft('old current data');
    close(current);
    mkdirSync(join(dir, 'materials'), { recursive: true });
    writeFileSync(join(dir, 'materials', 'original.txt'), 'old material');

    const stagedDir = join(dir, 'restore-staging', 'partial_old_move', 'userData');
    mkdirSync(stagedDir, { recursive: true });
    const staged = await open(stagedDir);
    await staged.saveDraft('new staged data');
    close(staged);
    const prepared = {
      jobId: 'partial_old_move', previewHash: 'd'.repeat(64), stagedUserDataDir: stagedDir,
      preview: { backupId: 'candidate', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 12, apiReconnectRequired: true as const }
    };
    await writePendingRestore(dir, prepared, {
      token: 'partial-move-token', jobId: prepared.jobId, previewHash: prepared.previewHash, expiresAt: Date.now() + 60_000
    });

    const result = await applyPendingRestoreBeforeOpen(dir, async () => true, {
      afterCurrentDatabaseRollbackMove: () => { throw new Error('database_moved_fault'); }
    });
    expect(result).toEqual({ status: 'rolled_back', jobId: prepared.jobId });
    expect(readFileSync(join(dir, 'materials', 'original.txt'), 'utf8')).toBe('old material');
    expect(existsSync(join(stagedDir, 'yuwendesk.db'))).toBe(true);
    expect(existsSync(join(dir, 'restore-failed', prepared.jobId))).toBe(false);
    expect(existsSync(join(dir, 'pending-restore.json'))).toBe(false);
    const reopened = await open(dir);
    expect(reopened.getDraft().content).toBe('old current data');
  });

  it('never erases an existing rollback directory when an interrupted marker is seen again', async () => {
    const dir = tempDir();
    const jobId = 'interrupted_again';
    const staged = join(dir, 'restore-staging', jobId, 'userData');
    const rollback = join(dir, 'restore-rollback', jobId);
    mkdirSync(staged, { recursive: true });
    mkdirSync(rollback, { recursive: true });
    writeFileSync(join(rollback, 'preserve-me'), 'old copy');
    writeFileSync(join(dir, 'pending-restore.json'), JSON.stringify({
      version: 1, jobId, previewHash: 'c'.repeat(64),
      stagedRelativePath: `restore-staging/${jobId}/userData`
    }));
    await expect(applyPendingRestoreBeforeOpen(dir, async () => true)).rejects.toThrow('restore_recovery_required');
    expect(existsSync(join(rollback, 'preserve-me'))).toBe(true);
    expect(existsSync(join(dir, 'pending-restore.json'))).toBe(true);
  });

  it.each([
    ['after sensitive ciphertext insert', { afterSensitiveCiphertextInsert: () => { throw new Error('cipher_fault'); } }],
    ['after FTS cleanup', { afterFtsCleanup: () => { throw new Error('fts_fault'); } }]
  ] as const)('rolls back reclassification %s', async (_label, sourcePrivacyFaults) => {
    const dir = tempDir();
    const store = await open(dir, sourcePrivacyFaults);
    const imported = store.importSource({ title: '普通资料', format: 'txt', content: '可检索原文夹具' });
    if (imported.status !== 'imported') throw new Error('seed failed');
    const revision = store.listSources()[0].revision;
    expect(() => store.reclassifySource({
      workspaceId: 'workspace_local', documentId: imported.documentId, targetClassification: 'student_sensitive',
      expectedRevision: revision, idempotencyKey: `reclassify-${_label}`, fingerprint: `fp-${_label}`,
      updatedAt: '2026-09-20T10:00:00.000Z'
    })).toThrow(/fault/u);
    expect(store.listSources()[0]).toMatchObject({ classification: 'teacher_private', revision });
    expect(store.searchSources('可检索原文夹具')).toHaveLength(1);
    expect(store.getMaintenanceIdempotency(`reclassify-${_label}`)).toBeNull();
  });

  it('rolls back permanent deletion and reports no successful tombstone/idempotency on a mid-delete fault', async () => {
    const dir = tempDir();
    const store = await open(dir, { duringPermanentDeletion: () => { throw new Error('delete_fault'); } });
    const imported = store.importSource({ title: '待删除资料', format: 'txt', content: '仍应保留的正文' });
    if (imported.status !== 'imported') throw new Error('seed failed');
    const revision = store.listSources()[0].revision;
    expect(() => store.deleteSourcePermanently({
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: revision,
      managedBackupIds: [], policy: 'keep_managed', idempotencyKey: 'delete-fault', fingerprint: 'delete-fault-fp',
      deletedAt: '2026-09-20T10:00:00.000Z'
    })).toThrow('delete_fault');
    expect(store.listSources()).toHaveLength(1);
    expect(store.searchSources('仍应保留的正文')).toHaveLength(1);
    expect(store.getPendingSourceDeletionWorkflows()).toEqual([]);
    expect(store.getMaintenanceIdempotency('delete-fault')).toBeNull();
  });

  it('stops automatic retries after three failures and manual success clears only the consecutive counter', async () => {
    const dir = tempDir();
    const store = await open(dir);
    let automaticCalls = 0;
    const coordinator = new BackupCoordinator({
      list: async () => [],
      createLocal: async () => { automaticCalls += 1; throw new Error('CANARY_FREE_FORM_ERROR'); }
    }, () => new Date('2026-09-20T12:00:00.000Z'), store);
    for (let i = 0; i < 3; i += 1) {
      coordinator.noteSuccessfulWrite(`write-${i}`);
      await coordinator.drain();
    }
    coordinator.noteSuccessfulWrite('write-4');
    await coordinator.drain();
    expect(automaticCalls).toBe(3);
    expect(coordinator.status()).toMatchObject({ lastError: 'AUTO_BACKUP_FAILED', repeatedFailureCount: 3 });
    expect(JSON.stringify(store.diagnosticsSnapshot())).not.toContain('CANARY_FREE_FORM_ERROR');

    const manual = new ProtectionService({
      userDataDir: dir,
      backup: {
        createLocal: async () => ({ backupId: 'manual-recovery', valid: true }),
        exportPortable: async () => { throw new Error('unused'); }, list: async () => [], deleteManaged: async () => false
      },
      idempotencyStore: store,
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => false,
      relaunch: () => undefined
    });
    await manual.create({ mode: 'local' }, 'manual-recovery-key');
    const snapshot = store.diagnosticsSnapshot();
    expect(snapshot.maintenance.repeatedFailureCount).toBe(0);
    expect(snapshot.errors).toContainEqual({ code: 'AUTO_BACKUP_FAILED', count: 3 });
  });
});
