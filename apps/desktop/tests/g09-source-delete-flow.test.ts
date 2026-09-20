import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, type SourcePrivacyFaultHooks } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import { BackupService } from '../src/main/protection/backup';
import { SourcePrivacyService } from '../src/main/protection/sourcePrivacy';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-source-delete-'));
}

function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}

async function openStore(dir: string, faults?: SourcePrivacyFaultHooks): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { safeStorage: fakeSafe(), sourcePrivacyFaults: faults });
  stores.add(store);
  await store.load();
  return store;
}

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* keep original failure */ }
  }
  stores.clear();
});

function seedTwoVersions(store: SqliteStore, title = '学生甲的课堂作答') {
  const first = store.importSource({ title, format: 'txt', content: '第一版：学生甲的课堂回答。' });
  if (first.status !== 'imported') throw new Error('seed v1 failed');
  const second = store.importSource({
    title,
    format: 'txt',
    content: '第二版：学生甲修订后的课堂回答。',
    relation: 'new_version',
    targetDocumentId: first.documentId
  });
  if (second.status !== 'new_version') throw new Error('seed v2 failed');
  return { documentId: first.documentId, versionIds: [first.versionId, second.versionId] };
}

describe('G09 permanent source deletion transaction', () => {
  it('removes every version/plaintext/ciphertext/cache and leaves one content-free tombstone', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedTwoVersions(store);
    store.reclassifySource({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      targetClassification: 'student_sensitive', idempotencyKey: 'reclassify_for_delete',
      fingerprint: 'reclassify_for_delete_fp', updatedAt: '2026-09-20T03:00:00.000Z'
    });
    store.insertModelJob({
      id: 'job_delete_me', task: 'analyze_text', cacheKey: 'cache_delete_me', provider: 'test-double', model: 'test-double-v0',
      paramsJson: '{}', promptVersion: 'v1', materialVersionsJson: JSON.stringify([seeded.versionIds[1]]),
      status: 'succeeded', resultJson: '{"derived":"student answer"}', costCents: 0, errorCode: null,
      createdAt: '2026-09-20T03:01:00.000Z', updatedAt: '2026-09-20T03:01:00.000Z'
    });

    const result = store.deleteSourcePermanently({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 4,
      managedBackupIds: ['managed_before_delete'], idempotencyKey: 'delete_source_1',
      policy: 'delete_managed_and_create_post_delete',
      fingerprint: 'delete_source_fp_1', deletedAt: '2026-09-20T04:00:00.000Z'
    });
    expect(result).toMatchObject({ status: 'succeeded', documentId: seeded.documentId, deletedVersionCount: 2, databaseDeleted: true, replayed: false });
    expect(store.deleteSourcePermanently({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 4,
      managedBackupIds: ['managed_before_delete'], idempotencyKey: 'delete_source_1',
      policy: 'delete_managed_and_create_post_delete',
      fingerprint: 'delete_source_fp_1', deletedAt: '2026-09-20T04:00:00.000Z'
    })).toEqual({ ...result, replayed: true });
    expect(store.listSources()).toEqual([]);
    expect(store.searchSources('学生甲')).toEqual([]);
    for (const versionId of seeded.versionIds) {
      expect(store.readSource(versionId)).toBeNull();
      expect(store.readOriginal(versionId)).toBeNull();
      expect(store.getVersionMeta(versionId)).toBeNull();
    }
    expect(store.listModelJobs(10)).toEqual([]);

    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      for (const table of ['source_document', 'source_version', 'source_file', 'source_text', 'source_segment', 'source_sensitive_payload']) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
      }
      expect(db.prepare('SELECT COUNT(*) FROM source_seg_fts').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM source_fts').pluck().get()).toBe(0);
      const tombstone = db.prepare('SELECT * FROM source_tombstone WHERE document_id=?').get(seeded.documentId) as Record<string, unknown>;
      expect(tombstone).toMatchObject({
        document_id: seeded.documentId,
        deleted_at: '2026-09-20T04:00:00.000Z',
        version_count: 2,
        reason_code: 'user_permanent_delete',
        backup_scope_json: JSON.stringify({ managedBackupIds: ['managed_before_delete'], externalOrOfflineBackups: 'not_recalled' })
      });
      const serialized = JSON.stringify(tombstone);
      expect(serialized).not.toContain('学生甲');
      expect(serialized).not.toContain('课堂作答');
      expect(serialized).not.toContain('ciphertext');
    } finally { db.close(); }
  });

  it.each(['beforeTombstone', 'beforeIdempotency'] as const)('rolls back all deletions when %s fails', async (faultName) => {
    const dir = tempDir();
    const faults = { [faultName]: () => { throw new Error(`fault_${faultName}`); } } as SourcePrivacyFaultHooks;
    const store = await openStore(dir, faults);
    const seeded = seedTwoVersions(store, '普通资料');

    expect(() => store.deleteSourcePermanently({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: [], idempotencyKey: 'delete_fault', fingerprint: 'delete_fault_fp',
      policy: 'keep_managed',
      deletedAt: '2026-09-20T05:00:00.000Z'
    })).toThrow(`fault_${faultName}`);
    expect(store.listSources()).toHaveLength(1);
    expect(store.getSourceVersions(seeded.documentId)).toHaveLength(2);
    expect(store.readSource(seeded.versionIds[0])?.text).toContain('第一版');
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM source_tombstone').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM maintenance_idempotency').pluck().get()).toBe(0);
    } finally { db.close(); }
  });
});

describe('G09 delete confirmation and managed-backup scope', () => {
  it('invalidates confirmation when the document revision or managed-backup scope changes', async () => {
    const store = await openStore(tempDir());
    const seeded = seedTwoVersions(store, '范围变化资料');
    let scans = 0;
    const service = new SourcePrivacyService({
      store,
      backup: {
        findManagedBackupsContainingSource: async () => (++scans === 1 ? ['before'] : ['before', 'late']),
        deleteManagedBackups: async () => ({ deletedIds: [], remainingIds: [] }),
        createLocal: async () => ({ backupId: 'post' })
      },
      confirmDelete: async () => ({ policy: 'delete_managed_and_create_post_delete' }),
      token: (() => { const values = ['scope-token-1', 'scope-token-2']; return () => values.shift() ?? 'scope-token-extra'; })(),
      now: () => 9_000
    });
    const prepared = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_scope_change', fingerprint: 'prepare_scope_change_fp'
    });
    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: prepared!.managedBackupIds, policy: prepared!.policy,
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'delete_scope_change', fingerprint: 'delete_scope_change_fp'
    })).rejects.toThrow('source_delete_scope_changed');
    expect(store.listSources()).toHaveLength(1);
    const refreshed = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_scope_change', fingerprint: 'prepare_scope_change_fp'
    });
    expect(refreshed).toMatchObject({ confirmationToken: 'scope-token-2', managedBackupIds: ['before', 'late'] });

    const stableService = new SourcePrivacyService({
      store,
      backup: {
        findManagedBackupsContainingSource: async () => [],
        deleteManagedBackups: async () => ({ deletedIds: [], remainingIds: [] }),
        createLocal: async () => ({ backupId: 'post' })
      },
      confirmDelete: async () => ({ policy: 'keep_managed' }),
      token: () => 'revision-token',
      now: () => 10_000
    });
    const stale = await stableService.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_revision_change', fingerprint: 'prepare_revision_change_fp'
    });
    expect(store.reclassifySource({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      targetClassification: 'student_sensitive', idempotencyKey: 'revision_change', fingerprint: 'revision_change_fp',
      updatedAt: '2026-09-20T05:30:00.000Z'
    })).toMatchObject({ status: 'succeeded', revision: 4 });
    await expect(stableService.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: stale!.managedBackupIds, policy: stale!.policy,
      confirmationToken: stale!.confirmationToken, idempotencyKey: 'delete_stale_revision', fingerprint: 'delete_stale_revision_fp'
    })).resolves.toEqual({ status: 'conflict', currentRevision: 4 });
    expect(store.listSources()).toHaveLength(1);
  });

  it('binds a short-lived single-use token and reports managed versus external backup outcomes separately', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedTwoVersions(store);
    const backup = new BackupService({
      userDataDir: dir, appVersion: '0.1.0', store,
      ids: { backupId: (() => { const ids = ['before_delete', 'after_delete']; return () => ids.shift() ?? 'unexpected'; })() },
      now: (() => { const dates = [new Date('2026-09-20T06:00:00.000Z'), new Date('2026-09-20T07:00:00.000Z')]; return () => dates.shift() ?? new Date('2026-09-20T08:00:00.000Z'); })()
    });
    await backup.createLocal();
    expect(await backup.findManagedBackupsContainingSource(seeded.documentId)).toEqual(['before_delete']);

    let now = 10_000;
    let confirmCalls = 0;
    const service = new SourcePrivacyService({
      store,
      backup,
      confirmDelete: async () => { confirmCalls += 1; return { policy: 'delete_managed_and_create_post_delete' }; },
      token: () => 'source-delete-token-1',
      now: () => now
    });
    const prepared = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_1', fingerprint: 'prepare_fp_1'
    });
    expect(prepared).toMatchObject({
      confirmationToken: 'source-delete-token-1',
      managedBackupIds: ['before_delete'],
      policy: 'delete_managed_and_create_post_delete',
      externalOrOfflineBackups: 'cannot_be_recalled',
      ssdPhysicalErasure: 'not_guaranteed'
    });
    expect(await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_1', fingerprint: 'prepare_fp_1'
    })).toEqual(prepared);
    expect(confirmCalls).toBe(1);
    await expect(service.prepareDelete({
      workspaceId: 'workspace_local', documentId: 'different', expectedRevision: 3,
      idempotencyKey: 'prepare_1', fingerprint: 'different'
    })).rejects.toThrow('source_delete_prepare_key_reuse');

    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: 'wrong_document', expectedRevision: 3,
      managedBackupIds: ['before_delete'], policy: 'delete_managed_and_create_post_delete',
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'wrong', fingerprint: 'wrong'
    })).rejects.toThrow('source_delete_confirmation_invalid');
    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: [], policy: 'delete_managed_and_create_post_delete',
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'wrong_scope', fingerprint: 'wrong_scope'
    })).rejects.toThrow('source_delete_confirmation_invalid');

    const deleted = await service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: ['before_delete'], policy: 'delete_managed_and_create_post_delete',
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'delete_confirmed', fingerprint: 'delete_confirmed_fp'
    });
    expect(deleted).toMatchObject({
      databaseDeleted: true,
      managedBackupDeletedIds: ['before_delete'],
      managedBackupRemainingIds: [],
      postDeleteBackupId: expect.stringMatching(/^post_delete_[a-f0-9]{24}$/u),
      externalOrOfflineBackups: 'not_recalled',
      ssdPhysicalErasure: 'not_guaranteed'
    });
    expect(await backup.findManagedBackupsContainingSource(seeded.documentId)).toEqual([]);
    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: ['before_delete'], policy: 'delete_managed_and_create_post_delete',
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'reused', fingerprint: 'reused'
    })).rejects.toThrow('source_delete_confirmation_invalid');

    const other = seedTwoVersions(store, '另一个文档');
    const expiring = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: other.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_2', fingerprint: 'prepare_fp_2'
    });
    now += 120_001;
    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: other.documentId, expectedRevision: 3,
      managedBackupIds: expiring!.managedBackupIds, policy: expiring!.policy,
      confirmationToken: expiring!.confirmationToken, idempotencyKey: 'expired', fingerprint: 'expired'
    })).rejects.toThrow('source_delete_confirmation_invalid');
    const renewed = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: other.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_2', fingerprint: 'prepare_fp_2'
    });
    expect(renewed!.expiresAt).toBeGreaterThan(expiring!.expiresAt);
  });

  it('reports a managed-backup removal failure without undoing or hiding the database deletion', async () => {
    const store = await openStore(tempDir());
    const seeded = seedTwoVersions(store, '备份失败资料');
    const service = new SourcePrivacyService({
      store,
      backup: {
        findManagedBackupsContainingSource: async () => ['backup_still_present'],
        deleteManagedBackups: async () => { throw new Error('simulated_backup_remove_failure'); },
        createLocal: async () => ({ backupId: 'post_delete_after_failure' })
      },
      confirmDelete: async () => ({ policy: 'delete_managed_and_create_post_delete' }),
      token: () => 'failure-token',
      now: () => 20_000
    });
    const prepared = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_failure', fingerprint: 'prepare_failure_fp'
    });
    const result = await service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: prepared!.managedBackupIds, policy: prepared!.policy,
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'delete_failure', fingerprint: 'delete_failure_fp'
    });
    expect(result).toMatchObject({
      databaseDeleted: true,
      managedBackupDeletedIds: [],
      managedBackupRemainingIds: ['backup_still_present'],
      postDeleteBackupId: 'post_delete_after_failure'
    });
    expect(store.listSources()).toEqual([]);
  });

  it('persists an incomplete deletion workflow and resumes backup handling after restart', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedTwoVersions(store, '崩溃恢复资料');
    const firstService = new SourcePrivacyService({
      store,
      backup: {
        findManagedBackupsContainingSource: async () => ['before_restart'],
        deleteManagedBackups: async () => { throw new Error('simulated_crash_boundary'); },
        createLocal: async () => { throw new Error('simulated_crash_boundary'); }
      },
      confirmDelete: async () => ({ policy: 'delete_managed_and_create_post_delete' }),
      token: () => 'restart-token',
      now: () => 30_000
    });
    const prepared = await firstService.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_restart', fingerprint: 'prepare_restart_fp'
    });
    const first = await firstService.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: prepared!.managedBackupIds, policy: prepared!.policy,
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'delete_restart', fingerprint: 'delete_restart_fp'
    });
    expect(first).toMatchObject({ databaseDeleted: true, managedBackupRemainingIds: ['before_restart'], postDeleteBackupId: null });
    expect(store.getPendingSourceDeletionWorkflows()).toHaveLength(1);
    store.close();
    stores.delete(store);

    const reopened = await openStore(dir);
    const resumed = new SourcePrivacyService({
      store: reopened,
      backup: {
        findManagedBackupsContainingSource: async () => [],
        deleteManagedBackups: async () => ({ deletedIds: ['before_restart'], remainingIds: [] }),
        createLocal: async () => ({ backupId: 'unexpected' }),
        createLocalForOperation: async (backupId) => ({ backupId })
      },
      confirmDelete: async () => null,
      now: () => 40_000
    });
    await resumed.reconcilePending();
    expect(reopened.getPendingSourceDeletionWorkflows()).toEqual([]);
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT workflow_status FROM source_tombstone').pluck().get()).toBe('completed');
      expect(db.prepare('SELECT post_delete_backup_id FROM source_tombstone').pluck().get())
        .toMatch(/^post_delete_[a-f0-9]{24}$/u);
    } finally { db.close(); }
  });

  it('reconciles a crash after real managed-backup removal without falsely reporting the absent backup', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedTwoVersions(store, '真实备份崩溃边界');
    const backup = new BackupService({ userDataDir: dir, appVersion: '0.1.0', store, ids: { backupId: () => 'before_crash' } });
    await backup.createLocal();
    const originalUpdate = store.updateSourceDeletionWorkflow.bind(store);
    store.updateSourceDeletionWorkflow = () => { throw new Error('simulated_crash_after_backup_actions'); };
    const service = new SourcePrivacyService({
      store, backup,
      confirmDelete: async () => ({ policy: 'delete_managed_and_create_post_delete' }),
      token: () => 'real-crash-token', now: () => 50_000
    });
    const prepared = await service.prepareDelete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      idempotencyKey: 'prepare_real_crash', fingerprint: 'prepare_real_crash_fp'
    });
    await expect(service.delete({
      workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
      managedBackupIds: prepared!.managedBackupIds, policy: prepared!.policy,
      confirmationToken: prepared!.confirmationToken, idempotencyKey: 'delete_real_crash', fingerprint: 'delete_real_crash_fp'
    })).rejects.toThrow('simulated_crash_after_backup_actions');
    expect(await backup.findManagedBackupsContainingSource(seeded.documentId)).toEqual([]);
    store.updateSourceDeletionWorkflow = originalUpdate;
    store.close();
    stores.delete(store);

    const reopened = await openStore(dir);
    const resumedBackup = new BackupService({ userDataDir: dir, appVersion: '0.1.0', store: reopened });
    await new SourcePrivacyService({ store: reopened, backup: resumedBackup, confirmDelete: async () => null, now: () => 60_000 })
      .reconcilePending();
    expect(reopened.getPendingSourceDeletionWorkflows()).toEqual([]);
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(JSON.parse(db.prepare('SELECT managed_backup_deleted_json FROM source_tombstone').pluck().get() as string)).toEqual(['before_crash']);
      expect(JSON.parse(db.prepare('SELECT managed_backup_remaining_json FROM source_tombstone').pluck().get() as string)).toEqual([]);
    } finally { db.close(); }
  });
});

describe('G09 backup source scope integrity', () => {
  it('derives source IDs from the completed snapshot rather than later live state', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const seeded = seedTwoVersions(store, '快照范围资料');
    const originalSnapshot = store.createSanitizedSnapshot.bind(store);
    store.createSanitizedSnapshot = async (destination, mode) => {
      const summary = await originalSnapshot(destination, mode);
      store.deleteSourcePermanently({
        workspaceId: 'workspace_local', documentId: seeded.documentId, expectedRevision: 3,
        managedBackupIds: [], policy: 'keep_managed', idempotencyKey: 'snapshot_race_delete',
        fingerprint: 'snapshot_race_delete_fp', deletedAt: '2026-09-20T09:00:00.000Z'
      });
      return summary;
    };
    const backup = new BackupService({ userDataDir: dir, appVersion: '0.1.0', store, ids: { backupId: () => 'snapshot_scope' } });
    const created = await backup.createLocal();
    const manifest = JSON.parse(readFileSync(join(created.path, 'manifest.json'), 'utf8')) as { sourceDocumentIds: string[] };
    expect(store.listSources()).toEqual([]);
    expect(manifest.sourceDocumentIds).toContain(seeded.documentId);
  });

  it('conservatively includes an unreadable managed backup in scope and can explicitly delete it', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    seedTwoVersions(store, '损坏备份范围资料');
    const backup = new BackupService({ userDataDir: dir, appVersion: '0.1.0', store, ids: { backupId: () => 'unreadable_scope' } });
    const created = await backup.createLocal();
    writeFileSync(join(created.path, 'manifest.json'), '{broken');
    expect(await backup.findManagedBackupsContainingSource(store.listSources()[0].documentId)).toEqual(['unreadable_scope']);
    expect(await backup.deleteManagedBackups(['unreadable_scope'], ['unreadable_scope']))
      .toEqual({ deletedIds: ['unreadable_scope'], remainingIds: [] });
  });
});
