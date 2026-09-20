import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import { BackupCoordinator, BackupService } from '../src/main/protection/backup';
import {
  applyPendingRestoreBeforeOpen,
  hasRestoreCapacity,
  preparePortableRestore,
  writePendingRestore
} from '../src/main/protection/restore';

const stores = new Set<SqliteStore>();
const passphrase = 'restore-语文备份-strong-2026';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeSafe(prefix: string): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`${prefix}:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      const text = value.toString();
      if (!text.startsWith(`${prefix}:`)) throw new Error('wrong machine');
      return Buffer.from(text.slice(prefix.length + 1), 'base64').toString();
    }
  };
}

async function open(dir: string, safe = fakeSafe('source')): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { safeStorage: safe });
  stores.add(store);
  await store.load();
  return store;
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe('G09 backup and portable restore flow', () => {
  it('requires space for staged data plus rollback headroom', () => {
    expect(hasRestoreCapacity({ bavail: 1000, bsize: 1024 }, 100_000)).toBe(false);
    expect(hasRestoreCapacity({ bavail: 200_000, bsize: 1024 }, 100_000)).toBe(true);
  });

  it('coalesces the first successful business write of a local day into one automatic backup', async () => {
    let creates = 0;
    const coordinator = new BackupCoordinator({
      list: async () => [],
      createLocal: async () => { creates += 1; return { backupId: 'auto_1' }; }
    }, () => new Date('2026-09-20T11:00:00+07:00'));
    coordinator.noteSuccessfulWrite('ui.saveDraft');
    coordinator.noteSuccessfulWrite('sources.import');
    await coordinator.drain();
    expect(creates).toBe(1);
  });

  it('publishes only a verified ready local backup and excludes credentials', async () => {
    const userDataDir = temp('yuwendesk-local-backup-');
    const store = await open(userDataDir);
    await store.saveDraft('local backup state');
    store.setCredential('grok_api_key', 'sk-LOCAL-SECRET-1234');
    const service = new BackupService({
      userDataDir, appVersion: '0.1.0', store,
      ids: { backupId: () => 'backup_local_1' },
      now: () => new Date('2026-09-20T10:00:00.000Z')
    });

    const created = await service.createLocal();
    expect(created.backupId).toBe('backup_local_1');
    expect(created.valid).toBe(true);
    expect(created.path.endsWith('.ready')).toBe(true);
    expect(existsSync(created.path.replace(/\.ready$/u, '.partial'))).toBe(false);
    expect((await service.list()).map((item) => item.backupId)).toEqual(['backup_local_1']);
    expect(readFileSync(join(created.path, 'data', 'yuwendesk.db')).includes(Buffer.from('sk-LOCAL-SECRET-1234'))).toBe(false);
  });

  it('restores data on another safeStorage backend while leaving API credentials empty', async () => {
    const sourceDir = temp('yuwendesk-portable-source-');
    const source = await open(sourceDir, fakeSafe('machine-a'));
    await source.saveDraft('portable restored state');
    source.setCredential('grok_api_key', 'sk-PORTABLE-SECRET-9876');
    expect(source.putSensitive('fixture', 'sensitive round trip', 'workspace=w;object=fixture;version=1').ok).toBe(true);
    const backup = new BackupService({
      userDataDir: sourceDir, appVersion: '0.1.0', store: source,
      ids: { backupId: () => 'backup_portable_1' },
      now: () => new Date('2026-09-20T10:05:00.000Z')
    });
    const portable = await backup.exportPortable(passphrase);
    expect(portable.container.includes(Buffer.from('sk-PORTABLE-SECRET-9876'))).toBe(false);
    expect(portable.container.includes(Buffer.from('SQLite format 3'))).toBe(false);

    const targetDir = temp('yuwendesk-portable-target-');
    const prepared = await preparePortableRestore({
      container: portable.container,
      passphrase,
      userDataDir: targetDir,
      safeStorage: fakeSafe('machine-b'),
      jobId: 'restore_job_1',
      now: new Date('2026-09-20T10:10:00.000Z')
    });
    expect(prepared.preview.apiReconnectRequired).toBe(true);
    expect(prepared.preview.backupId).toBe('backup_portable_1');

    const restored = await open(prepared.stagedUserDataDir, fakeSafe('machine-b'));
    expect(restored.getDraft().content).toBe('portable restored state');
    expect(restored.getCredentialLast4('grok_api_key')).toBeNull();
    expect(restored.getSensitive('fixture', 'workspace=w;object=fixture;version=1')).toEqual({ ok: true, value: 'sensitive round trip' });
  });

  it('uses a pending marker and rolls back when startup validation rejects the restored database', async () => {
    const currentDir = temp('yuwendesk-restore-current-');
    const current = await open(currentDir);
    await current.saveDraft('current state must survive');
    current.close();
    stores.delete(current);

    const stagedDir = join(currentDir, 'restore-staging', 'restore_job_rollback', 'userData');
    mkdirSync(stagedDir, { recursive: true });
    const staged = await open(stagedDir);
    await staged.saveDraft('candidate restored state');
    staged.close();
    stores.delete(staged);

    const prepared = {
      jobId: 'restore_job_rollback', previewHash: 'a'.repeat(64),
      stagedUserDataDir: stagedDir,
      preview: { backupId: 'backup_rollback', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 10, apiReconnectRequired: true as const }
    };
    await writePendingRestore(currentDir, prepared, {
      token: 'restore-token', jobId: prepared.jobId, previewHash: prepared.previewHash,
      expiresAt: Date.now() + 60_000
    });
    const result = await applyPendingRestoreBeforeOpen(currentDir, async () => false);
    expect(result.status).toBe('rolled_back');

    const reopened = await open(currentDir);
    expect(reopened.getDraft().content).toBe('current state must survive');
  });

  it('does not stage anything for a wrong password', async () => {
    const sourceDir = temp('yuwendesk-wrong-pass-source-');
    const source = await open(sourceDir);
    const backup = new BackupService({ userDataDir: sourceDir, appVersion: '0.1.0', store: source });
    const portable = await backup.exportPortable(passphrase);
    const target = temp('yuwendesk-wrong-pass-target-');
    await expect(preparePortableRestore({
      container: portable.container, passphrase: 'wrong-password-long-enough', userDataDir: target,
      safeStorage: fakeSafe('target'), jobId: 'wrong_pass', now: new Date()
    })).rejects.toThrow('backup_authentication_failed');
    expect(existsSync(join(target, 'restore-staging', 'wrong_pass'))).toBe(false);
  });

  it('keeps a sanitized portable snapshot structurally valid', async () => {
    const dir = temp('yuwendesk-portable-structure-');
    const store = await open(dir);
    const service = new BackupService({ userDataDir: dir, appVersion: '0.1.0', store });
    const portable = await service.exportPortable(passphrase);
    const target = temp('yuwendesk-portable-structure-target-');
    const prepared = await preparePortableRestore({
      container: portable.container, passphrase, userDataDir: target,
      safeStorage: fakeSafe('target'), jobId: 'structure', now: new Date()
    });
    const db = new Database(join(prepared.stagedUserDataDir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT COUNT(*) FROM credential').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});
