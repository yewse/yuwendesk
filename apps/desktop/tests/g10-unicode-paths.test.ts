import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import type { MaterialFormat, MaterialRole, MaterialSet } from '../src/main/materials/generate';
import { promoteStagedBundle, stageMaterialSet } from '../src/main/materials/publish';
import { BackupService } from '../src/main/protection/backup';
import { applyPendingRestoreBeforeOpen, preparePortableRestore, writePendingRestore } from '../src/main/protection/restore';
import { buildUpdateContainer } from '../src/main/update/container';
import { canonicalUpdateManifest } from '../src/main/update/manifest';
import { UpdateService } from '../src/main/update/service';
import type { UpdateManifestV1 } from '../src/main/update/types';

const roots: string[] = [];
const openStores = new Set<SqliteStore>();
const keypair = generateKeyPairSync('ed25519');
const restorePassphrase = '语文 portable restore 2026 strong';

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

function unicodeRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'yuwendesk-g10-path-'));
  roots.push(base);
  const root = join(base, '语文 备课', `校本资料${'春'.repeat(52)}`, `组合字符-e\u0301-${'长路径'.repeat(22)}`);
  mkdirSync(root, { recursive: true });
  expect(root.length).toBeGreaterThan(150);
  return root;
}

function materialSet(): MaterialSet {
  const specs: Array<[MaterialRole, MaterialFormat, string]> = [
    ['presentation', 'pptx', '课堂课件 春与济南的冬天.pptx'],
    ['student', 'docx', '学生讲义 春与济南的冬天.docx'],
    ['student', 'pdf', '学生讲义 春与济南的冬天.pdf'],
    ['teacher', 'docx', '教师讲解版 春与济南的冬天.docx'],
    ['teacher', 'pdf', '教师讲解版 春与济南的冬天.pdf']
  ];
  return {
    revisionId: 'revision_unicode_1',
    files: specs.map(([role, format, filename]) => {
      const bytes = Buffer.from(`${role}:${format}:中文内容`);
      return { role, format, filename, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    })
  };
}

function signedContainer(): Buffer {
  const packageBytes = Buffer.from('synthetic unicode-path installer bytes');
  const manifest: UpdateManifestV1 = {
    format: 'yuwendesk-update-manifest', version: 1, releaseId: 'release-unicode-0.2.0',
    appId: 'org.yuwendesk.app', targetVersion: '0.2.0', minimumSourceVersion: '0.1.0',
    platform: 'win32', arch: 'x64', packageName: 'YuwenDesk-0.2.0.exe', packageBytes: packageBytes.length,
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    signingKeyId: 'fixture-key', createdAt: '2026-09-20T00:00:00.000Z'
  };
  const manifestBytes = canonicalUpdateManifest(manifest);
  return buildUpdateContainer({ manifestBytes, signature: sign(null, manifestBytes, keypair.privateKey), packageBytes });
}

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('G10-T03 Unicode, spaces, and bounded long paths', () => {
  it('persists SQLite data, backs it up, and restores it below exact Unicode userData roots', async () => {
    const userDataDir = unicodeRoot();
    const store = new SqliteStore(userDataDir, { safeStorage: fakeSafe('unicode-source') });
    openStores.add(store);
    await store.load();
    await store.saveDraft('《春》备课：组合字符 e\u0301 与全角标点，。；！');
    const backupService = new BackupService({
      userDataDir, appVersion: '0.1.0', store,
      ids: { backupId: () => 'backup_unicode_1' },
      now: () => new Date('2026-09-20T00:00:00.000Z')
    });
    const backup = await backupService.createLocal();
    expect(backup.valid).toBe(true);
    expect(backup.path.startsWith(join(userDataDir, 'backups'))).toBe(true);
    expect(existsSync(join(backup.path, 'data', 'yuwendesk.db'))).toBe(true);
    expect(store.getDraft().content).toContain('组合字符 e\u0301');

    const portable = await backupService.exportPortable(restorePassphrase);
    const restoreRoot = unicodeRoot();
    const targetSafe = fakeSafe('unicode-target');
    const prepared = await preparePortableRestore({
      container: portable.container,
      passphrase: restorePassphrase,
      userDataDir: restoreRoot,
      safeStorage: targetSafe,
      jobId: 'restore_unicode_1',
      now: new Date('2026-09-20T00:05:00.000Z')
    });
    expect(prepared.stagedUserDataDir.startsWith(join(restoreRoot, 'restore-staging'))).toBe(true);
    await writePendingRestore(restoreRoot, prepared, {
      token: 'restore-unicode-confirmation',
      jobId: prepared.jobId,
      previewHash: prepared.previewHash,
      expiresAt: Date.now() + 60_000
    });
    const applied = await applyPendingRestoreBeforeOpen(restoreRoot, async (candidateRoot) => {
      const candidate = new SqliteStore(candidateRoot, { safeStorage: targetSafe });
      await candidate.load();
      try {
        return candidate.getDraft().content.includes('组合字符 e\u0301');
      } finally {
        candidate.close();
      }
    });
    expect(applied).toMatchObject({ status: 'applied', jobId: 'restore_unicode_1' });
    const restored = new SqliteStore(restoreRoot, { safeStorage: targetSafe });
    openStores.add(restored);
    await restored.load();
    expect(restored.getDraft().content).toContain('组合字符 e\u0301');
    expect(existsSync(join(restoreRoot, 'pending-restore.json'))).toBe(false);
  });

  it('stages a signed offline update selected from a Chinese path without exposing or normalizing the source name', async () => {
    const userDataDir = unicodeRoot();
    const selectedPath = join(userDataDir, '教师选择 更新包.yuwenupdate');
    writeFileSync(selectedPath, signedContainer());
    const service = new UpdateService({
      userDataDir, currentVersion: '0.1.0', appId: 'org.yuwendesk.app', platform: 'win32', arch: 'x64',
      trustedKeys: new Map([['fixture-key', keypair.publicKey]]), chooseOfflinePath: async () => selectedPath
    });
    const preview = await service.inspectOffline();
    if (preview.cancelled) throw new Error('fixture unexpectedly cancelled');
    expect(preview).not.toHaveProperty('path');
    const staged = await service.stageOffline({
      confirmationToken: preview.confirmationToken,
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'unicode-stage'
    });
    const ready = join(userDataDir, 'updates', 'release-unicode-0.2.0.ready');
    expect(staged).toMatchObject({ state: 'verified_ready', releaseId: 'release-unicode-0.2.0' });
    expect(readFileSync(join(ready, 'installer.exe'))).toEqual(Buffer.from('synthetic unicode-path installer bytes'));
  });

  it('stages and atomically promotes all five Chinese-named material files inside a long fixed root', async () => {
    const materialsRoot = join(unicodeRoot(), 'materials');
    const staged = await stageMaterialSet(materialsRoot, 'bundle_unicode_1', materialSet());
    const published = await promoteStagedBundle(materialsRoot, staged);
    expect(published.directory.startsWith(materialsRoot)).toBe(true);
    expect(published.files).toHaveLength(5);
    for (const file of published.files) {
      expect(existsSync(join(published.directory, file.filename))).toBe(true);
      expect(file.filename).toMatch(/[\u4e00-\u9fff]/u);
    }
  });
});
