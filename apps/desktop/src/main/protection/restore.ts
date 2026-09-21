import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { SafeStorageLike } from '../crypto/secrets';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../db/sqliteStore';
import { inspectArchive, type ArchiveLimits } from './archive';
import { openPortableArchive } from './envelope';
import { validateBackupManifest, verifyBackupDirectory } from './manifest';
import type { BackupManifest, ProtectionFaultHooks } from './types';

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
  archiveLimits?: ArchiveLimits;
}): Promise<PreparedRestore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.jobId)) throw new Error('restore_job_id_invalid');
  const payload = await openPortableArchive(input.container, input.passphrase);
  const inspected = await inspectArchive(payload, input.archiveLimits);
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
  const archivePaths = inspected.entries.filter((entry) => entry.path !== 'manifest.json').map((entry) => entry.path).sort();
  const manifestPaths = manifest.files.map((entry) => entry.path).sort();
  if (archivePaths.length !== manifestPaths.length || archivePaths.some((path, index) => path !== manifestPaths[index])) {
    throw new Error('backup_manifest_entry_mismatch');
  }
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

export async function prepareLocalRestore(input: {
  backupDirectory: string;
  expectedBackupId: string;
  userDataDir: string;
  jobId: string;
  now: Date;
}): Promise<PreparedRestore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.jobId)) throw new Error('restore_job_id_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.expectedBackupId)) throw new Error('backup_id_invalid');
  const backupsRoot = resolve(input.userDataDir, 'backups');
  const backupDirectory = resolve(input.backupDirectory);
  const expectedDirectory = resolve(backupsRoot, `${input.expectedBackupId}.ready`);
  if (backupDirectory !== expectedDirectory || !inside(backupsRoot, backupDirectory)) throw new Error('backup_local_path_invalid');

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(backupDirectory, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    throw new Error('backup_manifest_invalid');
  }
  const errors = validateBackupManifest(manifest);
  if (errors.length || manifest.kind !== 'local' || manifest.backupId !== input.expectedBackupId) {
    throw new Error(`backup_manifest_invalid:${errors[0] ?? 'identity'}`);
  }
  if (manifest.schemaVersion > SQLITE_SCHEMA_TARGET) throw new Error('backup_schema_too_new');
  const verified = await verifyBackupDirectory(backupDirectory, manifest);
  if (!verified.ok) throw new Error(`backup_verification_failed:${verified.reason}`);
  const space = await fs.statfs(input.userDataDir);
  const expandedBytes = manifest.files.reduce((sum, entry) => sum + entry.byteSize, 0);
  if (!hasRestoreCapacity(space, expandedBytes)) throw new Error('backup_disk_space_insufficient');

  const stageRoot = join(input.userDataDir, 'restore-staging', input.jobId);
  const stagedUserDataDir = join(stageRoot, 'userData');
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stagedUserDataDir, { recursive: true });
  try {
    for (const entry of manifest.files) {
      if (entry.role === 'workspace-key') throw new Error('backup_local_workspace_key_invalid');
      const source = resolve(backupDirectory, ...entry.path.split('/'));
      if (!inside(backupDirectory, source)) throw new Error('backup_local_path_invalid');
      const relativeDestination = entry.role === 'database' ? 'yuwendesk.db' : entry.path;
      const destination = resolve(stagedUserDataDir, ...relativeDestination.split('/'));
      if (!inside(stagedUserDataDir, destination)) throw new Error('backup_local_path_invalid');
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('backup_local_file_invalid');
      const bytes = await fs.readFile(source);
      if (bytes.length !== entry.byteSize || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        throw new Error('backup_local_changed');
      }
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx' });
    }

    const db = new Database(join(stagedUserDataDir, 'yuwendesk.db'), { readonly: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup_database_invalid');
      if (Number(db.pragma('user_version', { simple: true })) > SQLITE_SCHEMA_TARGET) throw new Error('backup_schema_too_new');
      if (Number(db.prepare('SELECT COUNT(*) FROM credential').pluck().get()) !== 0) throw new Error('backup_credential_present');
    } finally {
      db.close();
    }
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

async function moveIfExists(from: string, to: string): Promise<boolean> {
  if (!existsSync(from)) return false;
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
  return true;
}

function databaseLooksUsable(databasePath: string): boolean {
  if (!existsSync(databasePath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true });
    return db.pragma('integrity_check', { simple: true }) === 'ok' &&
      Number(db.pragma('user_version', { simple: true })) <= SQLITE_SCHEMA_TARGET;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await fs.readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

interface RestoreComponent {
  name: 'database' | 'wal' | 'shm' | 'materials' | 'migration_journal' | 'migration_journal_partial' | 'migration_lock';
  current: string;
  rollback: string;
  wasPresent: boolean;
}

function partialOldMoveIsProven(components: RestoreComponent[], moved: Set<RestoreComponent['name']>): boolean {
  return components.every((component) => {
    if (!component.wasPresent) return !existsSync(component.current) && !existsSync(component.rollback);
    if (moved.has(component.name)) return !existsSync(component.current) && existsSync(component.rollback);
    return existsSync(component.current) && !existsSync(component.rollback);
  });
}

function completeOldRollbackIsProven(components: RestoreComponent[], currentMustBeEmpty: boolean): boolean {
  return components.every((component) => {
    const rollbackMatches = component.wasPresent ? existsSync(component.rollback) : !existsSync(component.rollback);
    return rollbackMatches && (!currentMustBeEmpty || !existsSync(component.current));
  });
}

function originalIsRestored(components: RestoreComponent[]): boolean {
  return components.every((component) => component.wasPresent
    ? existsSync(component.current) && !existsSync(component.rollback)
    : !existsSync(component.current) && !existsSync(component.rollback));
}

export async function applyPendingRestoreBeforeOpen(
  userDataDir: string,
  validateInstalled: (userDataDir: string) => Promise<boolean>,
  faults?: Pick<ProtectionFaultHooks, 'afterCurrentDatabaseRollbackMove' | 'afterCurrentDataRollbackMove'>
): Promise<{ status: 'none' | 'applied' | 'rolled_back'; jobId?: string }> {
  const markerPath = join(userDataDir, 'pending-restore.json');
  if (!existsSync(markerPath)) return { status: 'none' };
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { version: number; jobId: string; previewHash: string; stagedRelativePath: string };
  if (marker.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(marker.jobId)) throw new Error('restore_marker_invalid');
  const staged = resolve(userDataDir, ...marker.stagedRelativePath.split('/'));
  const expected = resolve(userDataDir, 'restore-staging', marker.jobId, 'userData');
  if (staged !== expected || !inside(userDataDir, staged)) throw new Error('restore_marker_invalid');
  const rollback = join(userDataDir, 'restore-rollback', marker.jobId);
  // A marker plus an existing rollback directory means a previous switch may have been interrupted. Never erase
  // that evidence/data to retry automatically; preserve every copy for the protected recovery path.
  if (existsSync(rollback)) throw new Error('restore_recovery_required');
  const currentDb = join(userDataDir, 'yuwendesk.db');
  const currentMaterials = join(userDataDir, 'materials');
  const currentMigrationJournal = join(userDataDir, 'migration-journal.json');
  const currentMigrationJournalPartial = `${currentMigrationJournal}.partial`;
  const currentMigrationLock = join(userDataDir, 'migration-maintenance.lock');
  const stagedDb = join(staged, 'yuwendesk.db');
  if (!databaseLooksUsable(stagedDb)) throw new Error('restore_stage_invalid');
  const originalDatabasePresent = existsSync(currentDb);
  const originalDatabaseHash = originalDatabasePresent ? await fileSha256(currentDb) : null;
  if (originalDatabasePresent && !originalDatabaseHash) throw new Error('restore_rollback_invalid');
  await fs.mkdir(rollback, { recursive: true });
  const components: RestoreComponent[] = [
    { name: 'database', current: currentDb, rollback: join(rollback, 'yuwendesk.db'), wasPresent: existsSync(currentDb) },
    { name: 'wal', current: `${currentDb}-wal`, rollback: join(rollback, 'yuwendesk.db-wal'), wasPresent: existsSync(`${currentDb}-wal`) },
    { name: 'shm', current: `${currentDb}-shm`, rollback: join(rollback, 'yuwendesk.db-shm'), wasPresent: existsSync(`${currentDb}-shm`) },
    { name: 'materials', current: currentMaterials, rollback: join(rollback, 'materials'), wasPresent: existsSync(currentMaterials) },
    {
      name: 'migration_journal', current: currentMigrationJournal,
      rollback: join(rollback, 'migration-journal.json'), wasPresent: existsSync(currentMigrationJournal)
    },
    {
      name: 'migration_journal_partial', current: currentMigrationJournalPartial,
      rollback: join(rollback, 'migration-journal.json.partial'), wasPresent: existsSync(currentMigrationJournalPartial)
    },
    {
      name: 'migration_lock', current: currentMigrationLock,
      rollback: join(rollback, 'migration-maintenance.lock'), wasPresent: existsSync(currentMigrationLock)
    }
  ];
  const movedOld = new Set<RestoreComponent['name']>();
  let oldMoveComplete = false;
  try {
    for (const component of components) {
      if (!component.wasPresent) continue;
      await fs.mkdir(dirname(component.rollback), { recursive: true });
      await fs.rename(component.current, component.rollback);
      movedOld.add(component.name);
      if (component.name === 'database') faults?.afterCurrentDatabaseRollbackMove?.();
    }
    oldMoveComplete = true;
    if (!completeOldRollbackIsProven(components, true) ||
        (components[0].wasPresent && await fileSha256(components[0].rollback) !== originalDatabaseHash)) {
      throw new Error('restore_rollback_invalid');
    }
    faults?.afterCurrentDataRollbackMove?.();
    await moveIfExists(stagedDb, currentDb);
    await moveIfExists(join(staged, 'materials'), currentMaterials);
    if (!(await validateInstalled(userDataDir))) throw new Error('restore_post_switch_validation_failed');
    await fs.rm(markerPath, { force: true });
    return { status: 'applied', jobId: marker.jobId };
  } catch {
    if (!oldMoveComplete) {
      // The candidate has not started. Prove the exact split, then undo only successful old-data moves.
      // Never sweep still-current original components into restore-failed.
      if (!partialOldMoveIsProven(components, movedOld)) throw new Error('restore_recovery_required');
      const oldDatabase = components[0];
      if (oldDatabase.wasPresent) {
        const databasePath = movedOld.has('database') ? oldDatabase.rollback : oldDatabase.current;
        if (await fileSha256(databasePath) !== originalDatabaseHash) throw new Error('restore_rollback_invalid');
      }
      for (const component of [...components].reverse()) {
        if (movedOld.has(component.name)) await fs.rename(component.rollback, component.current);
      }
      if (!originalIsRestored(components) ||
          (components[0].wasPresent && await fileSha256(components[0].current) !== originalDatabaseHash)) {
        throw new Error('restore_recovery_required');
      }
    } else {
      // All old components must still be complete in rollback before preserving a failed candidate.
      if (!completeOldRollbackIsProven(components, false) ||
          (components[0].wasPresent && await fileSha256(components[0].rollback) !== originalDatabaseHash)) {
        throw new Error('restore_rollback_invalid');
      }
      const failed = join(userDataDir, 'restore-failed', marker.jobId);
      const hasCandidate = components.some((component) => existsSync(component.current));
      if (hasCandidate) {
        if (existsSync(failed)) throw new Error('restore_failed_copy_exists');
        await fs.mkdir(failed, { recursive: true });
        await moveIfExists(currentDb, join(failed, 'yuwendesk.db'));
        await moveIfExists(`${currentDb}-wal`, join(failed, 'yuwendesk.db-wal'));
        await moveIfExists(`${currentDb}-shm`, join(failed, 'yuwendesk.db-shm'));
        await moveIfExists(currentMaterials, join(failed, 'materials'));
      }
      for (const component of components) {
        if (component.wasPresent) await fs.rename(component.rollback, component.current);
      }
      if (!originalIsRestored(components) ||
          (components[0].wasPresent && await fileSha256(components[0].current) !== originalDatabaseHash)) {
        throw new Error('restore_recovery_required');
      }
    }
    await fs.rm(markerPath, { force: true });
    return { status: 'rolled_back', jobId: marker.jobId };
  }
}
