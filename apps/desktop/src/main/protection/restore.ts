import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { SafeStorageLike } from '../crypto/secrets';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../db/sqliteStore';
import { inspectArchive } from './archive';
import { openPortableArchive } from './envelope';
import { validateBackupManifest, verifyBackupDirectory } from './manifest';
import type { BackupManifest } from './types';

export interface RestorePreview {
  backupId: string;
  createdAt: string;
  schemaVersion: number;
  apiReconnectRequired: true;
}

export interface PreparedRestore {
  jobId: string;
  previewHash: string;
  stagedUserDataDir: string;
  preview: RestorePreview;
}

export interface RestoreConfirmationGrant {
  token: string;
  jobId: string;
  previewHash: string;
  expiresAt: number;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const a = resolve(root);
  const b = resolve(candidate);
  return b === a || b.startsWith(`${a}${sep}`);
}

export function hasRestoreCapacity(space: { bavail: number | bigint; bsize: number | bigint }, expandedBytes: number): boolean {
  const available = BigInt(space.bavail) * BigInt(space.bsize);
  const required = BigInt(Math.max(0, expandedBytes)) * 2n + 64n * 1024n * 1024n;
  return available >= required;
}

export async function preparePortableRestore(input: {
  container: Buffer;
  passphrase: string;
  userDataDir: string;
  safeStorage: SafeStorageLike;
  jobId: string;
  now: Date;
}): Promise<PreparedRestore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.jobId)) throw new Error('restore_job_id_invalid');
  const payload = await openPortableArchive(input.container, input.passphrase);
  const inspected = await inspectArchive(payload);
  const space = await fs.statfs(input.userDataDir);
  const expandedBytes = inspected.entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (!hasRestoreCapacity(space, expandedBytes)) throw new Error('backup_disk_space_insufficient');
  const manifestEntry = inspected.entries.find((entry) => entry.path === 'manifest.json');
  if (!manifestEntry) throw new Error('backup_manifest_missing');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.bytes.toString('utf8')) as BackupManifest;
  } catch {
    throw new Error('backup_manifest_invalid');
  }
  const errors = validateBackupManifest(manifest);
  if (errors.length || manifest.kind !== 'portable') throw new Error(`backup_manifest_invalid:${errors[0] ?? 'kind'}`);
  if (manifest.schemaVersion > SQLITE_SCHEMA_TARGET) throw new Error('backup_schema_too_new');
  const stageRoot = join(input.userDataDir, 'restore-staging', input.jobId);
  const payloadRoot = join(stageRoot, 'payload');
  const stagedUserDataDir = join(stageRoot, 'userData');
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(payloadRoot, { recursive: true });
  try {
    for (const entry of inspected.entries) {
      const destination = join(payloadRoot, ...entry.path.split('/'));
      if (!inside(payloadRoot, destination)) throw new Error('backup_archive_path_invalid');
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.bytes);
    }
    const verified = await verifyBackupDirectory(payloadRoot, manifest);
    if (!verified.ok) throw new Error(`backup_verification_failed:${verified.reason}`);
    await fs.mkdir(stagedUserDataDir, { recursive: true });
    await fs.rename(join(payloadRoot, 'data', 'yuwendesk.db'), join(stagedUserDataDir, 'yuwendesk.db'));
    if (existsSync(join(payloadRoot, 'materials'))) await fs.rename(join(payloadRoot, 'materials'), join(stagedUserDataDir, 'materials'));

    const db = new Database(join(stagedUserDataDir, 'yuwendesk.db'), { readonly: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup_database_invalid');
      if (Number(db.pragma('user_version', { simple: true })) > SQLITE_SCHEMA_TARGET) throw new Error('backup_schema_too_new');
      if (Number(db.prepare('SELECT COUNT(*) FROM credential').pluck().get()) !== 0) throw new Error('backup_credential_present');
    } finally {
      db.close();
    }

    const keyEntry = inspected.entries.find((entry) => entry.path === 'keys/workspace-key.json');
    if (keyEntry) {
      let wrapped: Buffer;
      try {
        const parsed = JSON.parse(keyEntry.bytes.toString('utf8')) as { format: string; version: number; wrapped: string };
        if (parsed.format !== 'yuwendesk-portable-key' || parsed.version !== 1 || typeof parsed.wrapped !== 'string') throw new Error('invalid');
        wrapped = Buffer.from(parsed.wrapped, 'base64');
      } catch {
        throw new Error('backup_workspace_key_invalid');
      }
      const key = await openPortableArchive(wrapped, input.passphrase);
      const staged = new SqliteStore(stagedUserDataDir, { safeStorage: input.safeStorage });
      await staged.load();
      try {
        const installed = staged.installWorkspaceDataKey(key);
        if (!installed.ok) throw new Error(`backup_workspace_key_${installed.reason}`);
      } finally {
        staged.close();
      }
    }
    await fs.rm(payloadRoot, { recursive: true, force: true });
    const preview: RestorePreview = {
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      schemaVersion: manifest.schemaVersion,
      apiReconnectRequired: true
    };
    return { jobId: input.jobId, previewHash: hash(preview), stagedUserDataDir, preview };
  } catch (error) {
    await fs.rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function writePendingRestore(userDataDir: string, prepared: PreparedRestore, grant: RestoreConfirmationGrant): Promise<void> {
  if (grant.token.length < 8 || grant.jobId !== prepared.jobId || grant.previewHash !== prepared.previewHash || grant.expiresAt <= Date.now()) {
    throw new Error('restore_confirmation_invalid');
  }
  const expectedStage = join(userDataDir, 'restore-staging', prepared.jobId, 'userData');
  if (resolve(prepared.stagedUserDataDir) !== resolve(expectedStage)) throw new Error('restore_stage_invalid');
  const marker = {
    version: 1,
    jobId: prepared.jobId,
    previewHash: prepared.previewHash,
    stagedRelativePath: relative(userDataDir, prepared.stagedUserDataDir).split(sep).join('/')
  };
  const path = join(userDataDir, 'pending-restore.json');
  const temporary = `${path}.partial`;
  await fs.writeFile(temporary, JSON.stringify(marker), 'utf8');
  await fs.rename(temporary, path);
}

async function moveIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
}

export async function applyPendingRestoreBeforeOpen(
  userDataDir: string,
  validateInstalled: (userDataDir: string) => Promise<boolean>
): Promise<{ status: 'none' | 'applied' | 'rolled_back'; jobId?: string }> {
  const markerPath = join(userDataDir, 'pending-restore.json');
  if (!existsSync(markerPath)) return { status: 'none' };
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { version: number; jobId: string; previewHash: string; stagedRelativePath: string };
  if (marker.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(marker.jobId)) throw new Error('restore_marker_invalid');
  const staged = resolve(userDataDir, ...marker.stagedRelativePath.split('/'));
  const expected = resolve(userDataDir, 'restore-staging', marker.jobId, 'userData');
  if (staged !== expected || !inside(userDataDir, staged)) throw new Error('restore_marker_invalid');
  const rollback = join(userDataDir, 'restore-rollback', marker.jobId);
  await fs.rm(rollback, { recursive: true, force: true });
  await fs.mkdir(rollback, { recursive: true });
  const currentDb = join(userDataDir, 'yuwendesk.db');
  const currentMaterials = join(userDataDir, 'materials');
  try {
    await moveIfExists(currentDb, join(rollback, 'yuwendesk.db'));
    await moveIfExists(`${currentDb}-wal`, join(rollback, 'yuwendesk.db-wal'));
    await moveIfExists(`${currentDb}-shm`, join(rollback, 'yuwendesk.db-shm'));
    await moveIfExists(currentMaterials, join(rollback, 'materials'));
    await moveIfExists(join(staged, 'yuwendesk.db'), currentDb);
    await moveIfExists(join(staged, 'materials'), currentMaterials);
    if (!(await validateInstalled(userDataDir))) throw new Error('restore_post_switch_validation_failed');
    await fs.rm(markerPath, { force: true });
    return { status: 'applied', jobId: marker.jobId };
  } catch {
    await fs.rm(currentDb, { force: true });
    await fs.rm(`${currentDb}-wal`, { force: true });
    await fs.rm(`${currentDb}-shm`, { force: true });
    await fs.rm(currentMaterials, { recursive: true, force: true });
    await moveIfExists(join(rollback, 'yuwendesk.db'), currentDb);
    await moveIfExists(join(rollback, 'yuwendesk.db-wal'), `${currentDb}-wal`);
    await moveIfExists(join(rollback, 'yuwendesk.db-shm'), `${currentDb}-shm`);
    await moveIfExists(join(rollback, 'materials'), currentMaterials);
    await fs.rm(markerPath, { force: true });
    return { status: 'rolled_back', jobId: marker.jobId };
  }
}
