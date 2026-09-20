import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import {
  buildBackupManifest,
  validateBackupManifest,
  verifyBackupDirectory
} from '../src/main/protection/manifest';

const stores = new Set<SqliteStore>();

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe('G09 backup manifest', () => {
  it('builds a closed canonical manifest and rejects unsafe or duplicate entries', () => {
    const manifest = buildBackupManifest({
      backupId: 'backup_1',
      kind: 'local',
      createdAt: '2026-09-20T10:00:00.000Z',
      appVersion: '0.1.0',
      schemaVersion: 10,
      retention: ['daily', 'weekly'],
      files: [
        { path: 'data/yuwendesk.db', sha256: 'a'.repeat(64), byteSize: 12, role: 'database' },
        { path: 'materials/bundle_1/lesson.pdf', sha256: 'b'.repeat(64), byteSize: 4, role: 'material' }
      ],
      sourceDocumentIds: ['source_1']
    });
    expect(manifest.credentialExcluded).toBe(true);
    expect(validateBackupManifest(manifest)).toEqual([]);
    expect(validateBackupManifest({
      ...manifest,
      files: [...manifest.files, { ...manifest.files[0] }]
    })).toContain('duplicate_path:data/yuwendesk.db');
    expect(validateBackupManifest({
      ...manifest,
      files: [{ ...manifest.files[0], path: '../outside.db' }]
    })).toContain('unsafe_path:../outside.db');
  });

  it('verifies every declared file hash and rejects a missing registered file', async () => {
    const root = temp('yuwendesk-backup-manifest-');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'yuwendesk.db'), Buffer.from('db-bytes'));
    const digest = createHash('sha256').update('db-bytes').digest('hex');
    const manifest = buildBackupManifest({
      backupId: 'backup_verify', kind: 'local', createdAt: '2026-09-20T10:00:00.000Z',
      appVersion: '0.1.0', schemaVersion: 10, retention: ['daily'],
      files: [{ path: 'data/yuwendesk.db', sha256: digest, byteSize: 8, role: 'database' }],
      sourceDocumentIds: []
    });
    expect(await verifyBackupDirectory(root, manifest)).toEqual({ ok: true });
    expect(await verifyBackupDirectory(root, {
      ...manifest,
      files: [...manifest.files, { path: 'materials/missing/file.pdf', sha256: 'c'.repeat(64), byteSize: 1, role: 'material' }]
    })).toEqual({ ok: false, reason: 'missing:materials/missing/file.pdf' });
  });

  it('uses SQLite online backup and removes API credentials from the independent snapshot', async () => {
    const sourceDir = temp('yuwendesk-backup-source-');
    const destinationDir = temp('yuwendesk-backup-destination-');
    const store = new SqliteStore(sourceDir, { safeStorage: fakeSafe() });
    stores.add(store);
    await store.load();
    await store.saveDraft('committed before backup');
    expect(store.setCredential('grok_api_key', 'sk-NEVER-IN-BACKUP-9999').ok).toBe(true);

    const destination = join(destinationDir, 'snapshot.db');
    const summary = await store.createSanitizedSnapshot(destination, 'local');
    expect(summary.schemaVersion).toBeGreaterThan(0);
    expect(summary.credentialRowsRemoved).toBe(1);

    const snapshot = new Database(destination, { readonly: true });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT content FROM draft WHERE id=1').pluck().get()).toBe('committed before backup');
      expect(snapshot.prepare('SELECT COUNT(*) FROM credential').pluck().get()).toBe(0);
    } finally {
      snapshot.close();
    }
    expect(readFileSync(destination).includes(Buffer.from('sk-NEVER-IN-BACKUP-9999'))).toBe(false);
  });
});
