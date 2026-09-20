import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import type { SqliteStore } from '../db/sqliteStore';
import { buildBackupManifest, isSafeArchivePath, validateBackupManifest, verifyBackupDirectory } from './manifest';
import { sealPortableArchive } from './envelope';
import type { BackupFileEntry, BackupManifest, BackupRetention, ProtectionFaultHooks } from './types';

export interface BackupRecord {
  backupId: string;
  createdAt: string;
  kind: 'local';
  path: string;
  valid: boolean;
  retention: BackupRetention[];
  byteSize: number;
}

export interface BackupServiceOptions {
  userDataDir: string;
  appVersion: string;
  store: SqliteStore;
  ids?: { backupId(): string };
  now?: () => Date;
  faults?: Pick<ProtectionFaultHooks, 'afterOnlineSnapshot' | 'beforeManifestRename' | 'afterPortableKeyWrap'>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export class BackupService {
  private readonly ids: { backupId(): string };
  private readonly now: () => Date;
  private exclusiveTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: BackupServiceOptions) {
    this.ids = options.ids ?? { backupId: () => `backup_${randomUUID()}` };
    this.now = options.now ?? (() => new Date());
  }

  private get backupsRoot(): string {
    return join(this.options.userDataDir, 'backups');
  }

  private async retentionFor(now: Date): Promise<BackupRetention[]> {
    const records = await this.list();
    const week = isoWeekKey(now);
    const alreadyWeekly = records.some((record) => record.retention.includes('weekly') && isoWeekKey(new Date(record.createdAt)) === week);
    return alreadyWeekly ? ['daily'] : ['daily', 'weekly'];
  }

  private async copyRegisteredMaterials(root: string): Promise<BackupFileEntry[]> {
    const materialRoot = resolve(this.options.userDataDir, 'materials');
    const entries: BackupFileEntry[] = [];
    const seen = new Set<string>();
    for (const artifact of this.options.store.listAllMaterialArtifacts()) {
      const source = resolve(artifact.path);
      if (source !== materialRoot && !source.startsWith(`${materialRoot}${sep}`)) throw new Error('backup_material_path_outside_root');
      const rel = relative(materialRoot, source).split(sep).join('/');
      const archivePath = `materials/${rel}`;
      if (!isSafeArchivePath(archivePath) || seen.has(archivePath)) throw new Error('backup_material_path_invalid');
      seen.add(archivePath);
      const bytes = await fs.readFile(source);
      const digest = sha256(bytes);
      if (digest !== artifact.sha256 || bytes.length !== artifact.byteSize) throw new Error('backup_material_hash_mismatch');
      const destination = join(root, ...archivePath.split('/'));
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
      entries.push({ path: archivePath, sha256: digest, byteSize: bytes.length, role: 'material' });
    }
    return entries;
  }

  private async buildDirectory(root: string, backupId: string, kind: 'local' | 'portable', createdAt: string, retention: BackupRetention[]): Promise<BackupManifest> {
    await fs.mkdir(join(root, 'data'), { recursive: true });
    const dbPath = join(root, 'data', 'yuwendesk.db');
    const snapshot = await this.options.store.createSanitizedSnapshot(dbPath, kind);
    this.options.faults?.afterOnlineSnapshot?.();
    const dbBytes = await fs.readFile(dbPath);
    const materialEntries = await this.copyRegisteredMaterials(root);
    const snapshotDb = new Database(dbPath, { readonly: true });
    let sourceDocumentIds: string[];
    try {
      sourceDocumentIds = (snapshotDb.prepare('SELECT id FROM source_document ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id);
    } finally {
      snapshotDb.close();
    }
    return buildBackupManifest({
      backupId, kind, createdAt, appVersion: this.options.appVersion,
      schemaVersion: snapshot.schemaVersion, retention,
      files: [{ path: 'data/yuwendesk.db', sha256: sha256(dbBytes), byteSize: dbBytes.length, role: 'database' }, ...materialEntries],
      sourceDocumentIds
    });
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }

  async withExclusive<T>(action: (backup: {
    findManagedBackupsContainingSource(documentId: string): Promise<string[]>;
    deleteManagedBackups(backupIds: string[], tokenScope: string[]): Promise<{ deletedIds: string[]; remainingIds: string[] }>;
    createLocal(): Promise<BackupRecord>;
    createLocalForOperation(backupId: string): Promise<BackupRecord>;
  }) => Promise<T>): Promise<T> {
    return this.exclusive(() => action({
      findManagedBackupsContainingSource: (documentId) => this.findManagedBackupsContainingSourceUnlocked(documentId),
      deleteManagedBackups: (backupIds, tokenScope) => this.deleteManagedBackupsUnlocked(backupIds, tokenScope),
      createLocal: () => this.createLocalUnlocked(),
      createLocalForOperation: (backupId) => this.createLocalUnlocked(backupId)
    }));
  }

  async createLocal(): Promise<BackupRecord> {
    return this.exclusive(() => this.createLocalUnlocked());
  }

  async createLocalForOperation(backupId: string): Promise<BackupRecord> {
    return this.exclusive(() => this.createLocalUnlocked(backupId));
  }

  private async createLocalUnlocked(requestedBackupId?: string): Promise<BackupRecord> {
    const now = this.now();
    const backupId = requestedBackupId ?? this.ids.backupId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(backupId)) throw new Error('backup_id_invalid');
    const partial = join(this.backupsRoot, `${backupId}.partial`);
    const ready = join(this.backupsRoot, `${backupId}.ready`);
    if (existsSync(ready)) {
      const existing = (await this.list()).find((record) => record.backupId === backupId);
      if (!existing) throw new Error('backup_id_exists_invalid');
      return existing;
    }
    if (existsSync(partial)) await fs.rm(partial, { recursive: true, force: true });
    await fs.mkdir(partial, { recursive: true });
    let published = false;
    try {
      const manifest = await this.buildDirectory(partial, backupId, 'local', now.toISOString(), await this.retentionFor(now));
      await fs.writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest), 'utf8');
      const verified = await verifyBackupDirectory(partial, manifest);
      if (!verified.ok) throw new Error(`backup_verification_failed:${verified.reason}`);
      this.options.faults?.beforeManifestRename?.();
      await fs.rename(partial, ready);
      published = true;
      await this.rotate();
      const files = await Promise.all(manifest.files.map((entry) => fs.stat(join(ready, ...entry.path.split('/')))));
      return { backupId, createdAt: manifest.createdAt, kind: 'local', path: ready, valid: true, retention: manifest.retention, byteSize: files.reduce((sum, item) => sum + item.size, 0) };
    } catch (error) {
      if (!published) await fs.rm(partial, { recursive: true, force: true });
      throw error;
    }
  }

  async exportPortable(passphrase: string): Promise<{ container: Buffer; manifest: BackupManifest }> {
    const now = this.now();
    const backupId = this.ids.backupId();
    const tempRoot = join(this.options.userDataDir, 'backup-temp', `${backupId}.partial`);
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
    try {
      const manifest = await this.buildDirectory(tempRoot, backupId, 'portable', now.toISOString(), []);
      const exportedKey = this.options.store.exportWorkspaceDataKey();
      if (!exportedKey.ok) throw new Error(`backup_workspace_key_${exportedKey.reason}`);
      if (exportedKey.key) {
        const wrappedKey = await sealPortableArchive(exportedKey.key, passphrase);
        this.options.faults?.afterPortableKeyWrap?.();
        const keyBytes = Buffer.from(JSON.stringify({ format: 'yuwendesk-portable-key', version: 1, wrapped: wrappedKey.toString('base64') }));
        const keyPath = join(tempRoot, 'keys', 'workspace-key.json');
        await fs.mkdir(dirname(keyPath), { recursive: true });
        await fs.writeFile(keyPath, keyBytes);
        manifest.files.push({ path: 'keys/workspace-key.json', sha256: sha256(keyBytes), byteSize: keyBytes.length, role: 'workspace-key' });
      }
      const errors = validateBackupManifest(manifest);
      if (errors.length) throw new Error(`backup_manifest_invalid:${errors[0]}`);
      await fs.writeFile(join(tempRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8');
      const verified = await verifyBackupDirectory(tempRoot, manifest);
      if (!verified.ok) throw new Error(`backup_verification_failed:${verified.reason}`);
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify(manifest));
      for (const entry of manifest.files) zip.file(entry.path, await fs.readFile(join(tempRoot, ...entry.path.split('/'))));
      const payload = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      return { container: await sealPortableArchive(payload, passphrase), manifest };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  async list(): Promise<BackupRecord[]> {
    if (!existsSync(this.backupsRoot)) return [];
    const names = await fs.readdir(this.backupsRoot);
    const records: BackupRecord[] = [];
    for (const name of names.filter((item) => item.endsWith('.ready')).sort()) {
      const path = join(this.backupsRoot, name);
      try {
        const manifest = JSON.parse(await fs.readFile(join(path, 'manifest.json'), 'utf8')) as BackupManifest;
        const verified = await verifyBackupDirectory(path, manifest);
        if (!verified.ok || manifest.kind !== 'local') continue;
        const sizes = await Promise.all(manifest.files.map((entry) => fs.stat(join(path, ...entry.path.split('/')))));
        records.push({ backupId: manifest.backupId, createdAt: manifest.createdAt, kind: 'local', path, valid: true, retention: manifest.retention, byteSize: sizes.reduce((sum, item) => sum + item.size, 0) });
      } catch {
        continue;
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async diagnosticsSummary(): Promise<{ validBackups: number; invalidBackups: number }> {
    const readyCount = existsSync(this.backupsRoot)
      ? (await fs.readdir(this.backupsRoot)).filter((name) => name.endsWith('.ready')).length
      : 0;
    const valid = await this.list();
    return { validBackups: valid.length, invalidBackups: Math.max(0, readyCount - valid.length) };
  }

  private async managedDirectoryIds(): Promise<string[]> {
    if (!existsSync(this.backupsRoot)) return [];
    const ids: string[] = [];
    for (const name of await fs.readdir(this.backupsRoot)) {
      if (!name.endsWith('.ready')) continue;
      const backupId = name.slice(0, -'.ready'.length);
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(backupId)) ids.push(backupId);
    }
    return [...new Set(ids)].sort();
  }

  async deleteManaged(backupId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(backupId)) return false;
    const path = join(this.backupsRoot, `${backupId}.ready`);
    if (!existsSync(path)) return false;
    await fs.rm(path, { recursive: true, force: true });
    return true;
  }

  async findManagedBackupsContainingSource(documentId: string): Promise<string[]> {
    return this.exclusive(() => this.findManagedBackupsContainingSourceUnlocked(documentId));
  }

  private async findManagedBackupsContainingSourceUnlocked(documentId: string): Promise<string[]> {
    const matching = new Set<string>();
    const inspected = new Set<string>();
    for (const record of await this.list()) {
      try {
        const manifest = JSON.parse(await fs.readFile(join(record.path, 'manifest.json'), 'utf8')) as BackupManifest;
        inspected.add(record.backupId);
        if (manifest.sourceDocumentIds.includes(documentId)) matching.add(record.backupId);
      } catch {
        // A backup that became unreadable after list() is conservatively included in the confirmation scope.
        matching.add(record.backupId);
      }
    }
    // Invalid/uninspectable .ready directories may still contain the source. Include them conservatively rather than
    // claiming the application-managed scope is clear.
    for (const backupId of await this.managedDirectoryIds()) if (!inspected.has(backupId)) matching.add(backupId);
    return [...matching].sort();
  }

  async deleteManagedBackups(
    backupIds: string[],
    tokenScope: string[]
  ): Promise<{ deletedIds: string[]; remainingIds: string[] }> {
    return this.exclusive(() => this.deleteManagedBackupsUnlocked(backupIds, tokenScope));
  }

  private async deleteManagedBackupsUnlocked(
    backupIds: string[],
    tokenScope: string[]
  ): Promise<{ deletedIds: string[]; remainingIds: string[] }> {
    const requested = [...new Set(backupIds)].sort();
    const scoped = [...new Set(tokenScope)].sort();
    if (JSON.stringify(requested) !== JSON.stringify(scoped)) throw new Error('managed_backup_scope_mismatch');
    const deletedIds: string[] = [];
    for (const backupId of requested) {
      try {
        const path = join(this.backupsRoot, `${backupId}.ready`);
        if (!existsSync(path) || await this.deleteManaged(backupId)) deletedIds.push(backupId);
      } catch {
        // Report the actual remainder; database deletion must not be misreported or rolled back.
      }
    }
    const deleted = new Set(deletedIds);
    return { deletedIds, remainingIds: requested.filter((backupId) => !deleted.has(backupId)) };
  }

  private async rotate(): Promise<void> {
    const records = await this.list();
    if (records.length <= 1) return;
    const keep = new Set<string>();
    records.filter((record) => record.retention.includes('daily')).slice(0, 7).forEach((record) => keep.add(record.backupId));
    records.filter((record) => record.retention.includes('weekly')).slice(0, 4).forEach((record) => keep.add(record.backupId));
    for (const record of records) if (!keep.has(record.backupId) && records.length - keep.size > 0) await fs.rm(record.path, { recursive: true, force: true });
  }
}

interface AutomaticBackupOperations {
  list(): Promise<Array<{ createdAt?: string }>>;
  createLocal(): Promise<unknown>;
}

interface AutomaticMaintenanceStore {
  diagnosticsSnapshot(): { maintenance: { repeatedFailureCount: number } };
  recordMaintenanceFailure(input: { scope: 'backup'; code: string; automatic: true; at: string }): void;
  recordMaintenanceSuccess(input: { scope: 'backup'; code: string; at: string }): void;
}

function localDay(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export class BackupCoordinator {
  private pending: Promise<void> | null = null;
  private completedDay: string | null = null;
  private lastError: string | null = null;
  private repeatedFailureCount = 0;

  constructor(
    private readonly backup: AutomaticBackupOperations,
    private readonly now: () => Date = () => new Date(),
    private readonly maintenance?: AutomaticMaintenanceStore
  ) {}

  noteSuccessfulWrite(_operation: string): void {
    void _operation;
    const day = localDay(this.now());
    let persistedFailures: number | undefined;
    try { persistedFailures = this.maintenance?.diagnosticsSnapshot().maintenance.repeatedFailureCount; } catch { /* maintenance state is advisory */ }
    if (typeof persistedFailures === 'number') this.repeatedFailureCount = persistedFailures;
    if (this.completedDay === day || this.pending || this.repeatedFailureCount >= 3) return;
    this.pending = this.run(day).finally(() => { this.pending = null; });
  }

  private async run(day: string): Promise<void> {
    try {
      const existing = await this.backup.list();
      if (existing.some((record) => record.createdAt && localDay(new Date(record.createdAt)) === day)) {
        this.completedDay = day;
        this.lastError = null;
        this.repeatedFailureCount = 0;
        try {
          this.maintenance?.recordMaintenanceSuccess({ scope: 'backup', code: 'BACKUP_OK', at: this.now().toISOString() });
        } catch { /* a completed backup remains valid even if status metadata cannot be updated */ }
        return;
      }
      await this.backup.createLocal();
      this.completedDay = day;
      this.lastError = null;
      this.repeatedFailureCount = 0;
      try {
        this.maintenance?.recordMaintenanceSuccess({ scope: 'backup', code: 'BACKUP_OK', at: this.now().toISOString() });
      } catch { /* a completed backup remains valid even if status metadata cannot be updated */ }
    } catch {
      this.lastError = 'AUTO_BACKUP_FAILED';
      this.repeatedFailureCount += 1;
      try {
        this.maintenance?.recordMaintenanceFailure({
          scope: 'backup', code: 'AUTO_BACKUP_FAILED', automatic: true, at: this.now().toISOString()
        });
      } catch { /* never turn maintenance telemetry failure into an application write failure */ }
    }
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  status(): { completedDay: string | null; lastError: string | null; repeatedFailureCount: number } {
    return { completedDay: this.completedDay, lastError: this.lastError, repeatedFailureCount: this.repeatedFailureCount };
  }
}
