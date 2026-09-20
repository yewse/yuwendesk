import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type MigrationErrorCode,
  type MigrationJournal,
  readMigrationJournal,
  writeMigrationJournal
} from './journal';

const MIGRATION_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

export interface MigrationFaultHooks {
  afterCandidateMigrated?: (candidatePath: string) => void | Promise<void>;
  afterOriginalMoved?: () => void | Promise<void>;
  afterCandidateMoved?: () => void | Promise<void>;
  interruptAfterOriginalMove?: boolean;
  beforeCompletionCleanup?: () => void | Promise<void>;
  afterLockAcquired?: () => void | Promise<void>;
}

export interface DatabaseMigrationOptions {
  userDataDir: string;
  sourceAppVersion: string;
  targetAppVersion: string;
  targetSchema: number;
  targetGeneration: number;
  migrateCandidate: (database: Database.Database) => void;
  ids?: { jobId(): string; recoveryPointId(): string };
  now?: () => Date;
  availableBytes?: (directory: string) => Promise<number>;
  faults?: MigrationFaultHooks;
}

export type DatabaseMigrationResult =
  | { state: 'not_required'; schema: number; generation: number }
  | { state: 'migrated'; jobId: string; recoveryPointId: string }
  | { state: 'recovered'; jobId: string }
  | { state: 'rolled_back'; jobId: string; code: 'MIGRATION_SWITCH_FAILED' }
  | { state: 'blocked'; code: MigrationErrorCode; jobId?: string };

interface DatabaseIdentity {
  schema: number;
  generation: number;
  credentialFingerprint: string;
  migrationJobId: string | null;
}

interface RecoveryManifest {
  format: 'yuwendesk-migration-recovery';
  version: 1;
  recoveryPointId: string;
  jobId: string;
  createdAt: string;
  sourceAppVersion: string;
  sourceSchema: number;
  sourceGeneration: number;
  databaseSha256: string;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function readGeneration(db: Database.Database): number {
  if (!tableExists(db, 'app_meta')) return 0;
  const row = db.prepare("SELECT value FROM app_meta WHERE key='data_generation'").get() as { value: string } | undefined;
  if (!row) return 0;
  const value = Number(row.value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('database_generation_invalid');
  return value;
}

function readMigrationJobId(db: Database.Database): string | null {
  if (!tableExists(db, 'app_meta')) return null;
  const row = db.prepare("SELECT value FROM app_meta WHERE key='last_migration_job_id'").get() as { value: string } | undefined;
  if (!row) return null;
  if (!isSafeId(row.value)) throw new Error('database_migration_marker_invalid');
  return row.value;
}

function writeMigrationJobId(db: Database.Database, jobId: string): void {
  if (!tableExists(db, 'app_meta') || !isSafeId(jobId)) throw new Error('database_migration_marker_unavailable');
  db.prepare(
    "INSERT INTO app_meta(key,value) VALUES('last_migration_job_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(jobId);
}

function advanceDataGeneration(db: Database.Database, targetGeneration: number): void {
  if (!tableExists(db, 'app_meta') || !Number.isSafeInteger(targetGeneration) || targetGeneration < 0) {
    throw new Error('database_generation_target_invalid');
  }
  const current = readGeneration(db);
  if (current > targetGeneration) throw new Error('database_generation_newer');
  db.prepare(
    "INSERT INTO app_meta(key,value) VALUES('data_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(targetGeneration));
}

function normalizedSqlValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { bytesSha256: createHash('sha256').update(value).digest('hex'), byteLength: value.length };
  if (value === null || ['string', 'number', 'bigint'].includes(typeof value)) return typeof value === 'bigint' ? String(value) : value;
  throw new Error('credential_value_invalid');
}

function normalizedTableRows(db: Database.Database, table: 'credential' | 'secure_key'): string[] {
  const rows = tableExists(db, table)
    ? db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    : [];
  const normalized = rows.map((row) => JSON.stringify(Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalizedSqlValue(value)])
  ))).sort();
  return normalized;
}

function protectedSecretsFingerprint(db: Database.Database): string {
  return createHash('sha256').update(JSON.stringify({
    credential: normalizedTableRows(db, 'credential'),
    secureKey: normalizedTableRows(db, 'secure_key')
  })).digest('hex');
}

function inspectOpenDatabase(db: Database.Database): DatabaseIdentity {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('database_integrity_invalid');
  return {
    schema: Number(db.pragma('user_version', { simple: true })),
    generation: readGeneration(db),
    credentialFingerprint: protectedSecretsFingerprint(db),
    migrationJobId: readMigrationJobId(db)
  };
}

function inspectDatabase(path: string): DatabaseIdentity {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return inspectOpenDatabase(db); } finally { db.close(); }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function defaultAvailableBytes(directory: string): Promise<number> {
  const stat = await fs.statfs(directory);
  const bytes = Number(stat.bavail) * Number(stat.bsize);
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
}

function recoveryManifest(value: RecoveryManifest): RecoveryManifest {
  const keys = Object.keys(value).sort();
  const expected = [
    'createdAt', 'databaseSha256', 'format', 'jobId', 'recoveryPointId', 'sourceAppVersion',
    'sourceGeneration', 'sourceSchema', 'version'
  ];
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) || value.format !== 'yuwendesk-migration-recovery' || value.version !== 1 ||
    !isSafeId(value.jobId) || !isSafeId(value.recoveryPointId) || Number.isNaN(Date.parse(value.createdAt)) ||
    !(value.sourceAppVersion === 'unknown' || /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.sourceAppVersion)) ||
    !Number.isSafeInteger(value.sourceSchema) || value.sourceSchema < 0 ||
    !Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration < 0 ||
    !/^[0-9a-f]{64}$/u.test(value.databaseSha256)
  ) throw new Error('migration_recovery_manifest_invalid');
  return value;
}

export class DatabaseMigrationCoordinator {
  private readonly now: () => Date;
  private readonly ids: { jobId(): string; recoveryPointId(): string };
  private readonly availableBytes: (directory: string) => Promise<number>;

  constructor(private readonly options: DatabaseMigrationOptions) {
    this.now = options.now ?? (() => new Date());
    this.ids = options.ids ?? {
      jobId: () => `migration_${randomUUID()}`,
      recoveryPointId: () => `pre_migration_${randomUUID()}`
    };
    this.availableBytes = options.availableBytes ?? defaultAvailableBytes;
  }

  private get currentPath(): string { return join(this.options.userDataDir, 'yuwendesk.db'); }
  private get lockPath(): string { return join(this.options.userDataDir, 'migration-maintenance.lock'); }
  private stagingRoot(jobId: string): string { return join(this.options.userDataDir, 'migration-staging', `${jobId}.partial`); }
  private rollbackRoot(jobId: string): string { return join(this.options.userDataDir, 'migration-rollback', jobId); }
  private failedRoot(jobId: string): string { return join(this.options.userDataDir, 'migration-failed', jobId); }
  private recoveryRoot(recoveryPointId: string, state: 'partial' | 'ready'): string {
    return join(this.options.userDataDir, 'migration-recovery', `${recoveryPointId}.${state}`);
  }

  private async clearCheckpointSidecars(): Promise<void> {
    const wal = `${this.currentPath}-wal`;
    if (existsSync(wal) && (await fs.stat(wal)).size !== 0) throw new Error('database_wal_not_checkpointed');
    await fs.rm(wal, { force: true });
    await fs.rm(`${this.currentPath}-shm`, { force: true });
  }

  private async prepareCurrentDatabase(): Promise<DatabaseIdentity> {
    const db = new Database(this.currentPath, { fileMustExist: true });
    try {
      db.pragma('busy_timeout = 1000');
      const identity = inspectOpenDatabase(db);
      const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>;
      if (rows.some((row) => Number(row.busy ?? 0) !== 0)) throw new Error('database_busy');
      return identity;
    } finally {
      db.close();
      await this.clearCheckpointSidecars();
    }
  }

  private async updateJournal(journal: MigrationJournal, changes: Partial<MigrationJournal>): Promise<MigrationJournal> {
    const updated: MigrationJournal = { ...journal, ...changes, updatedAt: this.now().toISOString() };
    await writeMigrationJournal(this.options.userDataDir, updated);
    return updated;
  }

  private failedPartialRoot(jobId: string): string {
    return `${this.failedRoot(jobId)}.partial`;
  }

  private async preserveFailedDatabase(sourcePath: string, jobId: string): Promise<void> {
    const failed = this.failedRoot(jobId);
    const partial = this.failedPartialRoot(jobId);
    const partialDb = join(partial, 'yuwendesk.db');
    if (existsSync(failed)) {
      if (existsSync(sourcePath)) throw new Error('migration_failed_copy_exists');
      return;
    }
    await fs.mkdir(dirname(failed), { recursive: true });
    await fs.mkdir(partial, { recursive: true });
    if (existsSync(partialDb)) {
      if (existsSync(sourcePath)) throw new Error('migration_failed_copy_ambiguous');
    } else {
      if (!existsSync(sourcePath)) throw new Error('migration_failed_source_missing');
      await fs.rename(sourcePath, partialDb);
    }
    await fs.rename(partial, failed);
  }

  private async moveCandidateToFailed(jobId: string): Promise<void> {
    const stagingDb = join(this.stagingRoot(jobId), 'yuwendesk.db');
    const partialDb = join(this.failedPartialRoot(jobId), 'yuwendesk.db');
    if (!existsSync(stagingDb) && !existsSync(partialDb)) return;
    await this.preserveFailedDatabase(stagingDb, jobId);
    await fs.rm(this.stagingRoot(jobId), { recursive: true, force: true });
  }

  private async reconcile(journal: MigrationJournal): Promise<DatabaseMigrationResult | null> {
    if (journal.phase === 'completed') {
      try {
        if (!journal.candidateSha256 || !existsSync(this.currentPath)) throw new Error('migration_completed_missing');
        const installed = inspectDatabase(this.currentPath);
        if (
          installed.schema < journal.targetSchema || installed.generation < journal.targetGeneration ||
          installed.migrationJobId !== journal.jobId
        ) {
          throw new Error('migration_completed_invalid');
        }
        return null;
      } catch {
        return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId: journal.jobId };
      }
    }
    if (journal.phase === 'rolled_back' || journal.phase === 'blocked') {
      try {
        if (!existsSync(this.currentPath) || await fileSha256(this.currentPath) !== journal.sourceSha256) {
          throw new Error('migration_terminal_source_invalid');
        }
        return null;
      } catch {
        return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId: journal.jobId };
      }
    }
    const rollbackDb = join(this.rollbackRoot(journal.jobId), 'yuwendesk.db');
    const stagingDb = join(this.stagingRoot(journal.jobId), 'yuwendesk.db');
    try {
      if (journal.phase === 'candidate_moved') {
        const currentHash = existsSync(this.currentPath) ? await fileSha256(this.currentPath) : null;
        if (currentHash === journal.candidateSha256) {
          const candidate = inspectDatabase(this.currentPath);
          if (candidate.schema === journal.targetSchema && candidate.generation <= journal.targetGeneration) {
            await this.updateJournal(journal, { phase: 'completed', errorCode: null });
            await fs.rm(this.lockPath, { force: true });
            return { state: 'recovered', jobId: journal.jobId };
          }
        }
      }

      const rollbackHash = existsSync(rollbackDb) ? await fileSha256(rollbackDb) : null;
      if (rollbackHash) {
        if (rollbackHash !== journal.sourceSha256) throw new Error('migration_rollback_hash_invalid');
        if (existsSync(this.currentPath)) {
          await this.preserveFailedDatabase(this.currentPath, journal.jobId);
        } else {
          await this.moveCandidateToFailed(journal.jobId);
        }
        await fs.mkdir(dirname(this.currentPath), { recursive: true });
        await fs.rename(rollbackDb, this.currentPath);
        if (await fileSha256(this.currentPath) !== journal.sourceSha256) throw new Error('migration_restore_hash_invalid');
      } else {
        if (!existsSync(this.currentPath) || await fileSha256(this.currentPath) !== journal.sourceSha256) {
          throw new Error('migration_source_not_proven');
        }
        if (existsSync(stagingDb)) await this.moveCandidateToFailed(journal.jobId);
      }
      await this.updateJournal(journal, { phase: 'rolled_back', errorCode: 'MIGRATION_RECOVERY_REQUIRED' });
      await fs.rm(this.lockPath, { force: true });
      return { state: 'recovered', jobId: journal.jobId };
    } catch {
      return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId: journal.jobId };
    }
  }

  private async createRecoveryPoint(
    journal: MigrationJournal,
    source: DatabaseIdentity
  ): Promise<{ journal: MigrationJournal; databasePath: string }> {
    const partial = this.recoveryRoot(journal.recoveryPointId, 'partial');
    const ready = this.recoveryRoot(journal.recoveryPointId, 'ready');
    const readyDb = join(ready, 'yuwendesk.db');
    if (existsSync(ready)) {
      const parsed = recoveryManifest(JSON.parse(await fs.readFile(join(ready, 'manifest.json'), 'utf8')) as RecoveryManifest);
      const digest = await fileSha256(readyDb);
      const identity = inspectDatabase(readyDb);
      if (
        parsed.jobId !== journal.jobId || parsed.databaseSha256 !== digest ||
        identity.schema !== source.schema || identity.generation !== source.generation ||
        identity.credentialFingerprint !== source.credentialFingerprint
      ) throw new Error('migration_recovery_invalid');
      return { journal: await this.updateJournal(journal, { recoverySha256: digest, phase: 'recovery_ready' }), databasePath: readyDb };
    }
    await fs.rm(partial, { recursive: true, force: true });
    await fs.mkdir(partial, { recursive: true });
    const partialDb = join(partial, 'yuwendesk.db');
    const live = new Database(this.currentPath, { readonly: true, fileMustExist: true });
    try { await live.backup(partialDb); } finally { live.close(); }
    await this.clearCheckpointSidecars();
    const identity = inspectDatabase(partialDb);
    if (
      identity.schema !== source.schema || identity.generation !== source.generation ||
      identity.credentialFingerprint !== source.credentialFingerprint
    ) throw new Error('migration_recovery_invalid');
    const digest = await fileSha256(partialDb);
    const manifest: RecoveryManifest = recoveryManifest({
      format: 'yuwendesk-migration-recovery', version: 1,
      recoveryPointId: journal.recoveryPointId, jobId: journal.jobId,
      createdAt: journal.createdAt, sourceAppVersion: journal.sourceAppVersion,
      sourceSchema: source.schema, sourceGeneration: source.generation, databaseSha256: digest
    });
    await fs.writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' });
    await fs.mkdir(dirname(ready), { recursive: true });
    await fs.rename(partial, ready);
    return { journal: await this.updateJournal(journal, { recoverySha256: digest, phase: 'recovery_ready' }), databasePath: readyDb };
  }

  private async rollbackSwitch(journal: MigrationJournal): Promise<DatabaseMigrationResult> {
    const rollbackDb = join(this.rollbackRoot(journal.jobId), 'yuwendesk.db');
    try {
      if (!existsSync(rollbackDb) || await fileSha256(rollbackDb) !== journal.sourceSha256) {
        throw new Error('migration_rollback_invalid');
      }
      if (existsSync(this.currentPath)) {
        await this.preserveFailedDatabase(this.currentPath, journal.jobId);
      } else {
        await this.moveCandidateToFailed(journal.jobId);
      }
      await fs.rename(rollbackDb, this.currentPath);
      if (await fileSha256(this.currentPath) !== journal.sourceSha256) throw new Error('migration_restore_invalid');
      await this.updateJournal(journal, { phase: 'rolled_back', errorCode: 'MIGRATION_SWITCH_FAILED' });
      return { state: 'rolled_back', jobId: journal.jobId, code: 'MIGRATION_SWITCH_FAILED' };
    } catch {
      await this.updateJournal(journal, { phase: journal.phase, errorCode: 'MIGRATION_RECOVERY_REQUIRED' }).catch(() => undefined);
      return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId: journal.jobId };
    }
  }

  async run(): Promise<DatabaseMigrationResult> {
    await fs.mkdir(this.options.userDataDir, { recursive: true });
    let prior: MigrationJournal | null;
    try { prior = await readMigrationJournal(this.options.userDataDir); } catch {
      return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED' };
    }
    if (prior) {
      const reconciled = await this.reconcile(prior);
      if (reconciled) return reconciled;
      await fs.rm(this.lockPath, { force: true });
    } else if (existsSync(this.lockPath)) {
      return { state: 'blocked', code: 'MIGRATION_LOCKED' };
    }
    if (!existsSync(this.currentPath)) return { state: 'not_required', schema: 0, generation: 0 };

    let source: DatabaseIdentity;
    try { source = inspectDatabase(this.currentPath); } catch {
      return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID' };
    }
    if (source.schema > this.options.targetSchema || source.generation > this.options.targetGeneration) {
      return { state: 'blocked', code: 'MIGRATION_INCOMPATIBLE' };
    }
    if (source.schema === this.options.targetSchema) {
      return { state: 'not_required', schema: source.schema, generation: source.generation };
    }
    try {
      const prepared = await this.prepareCurrentDatabase();
      if (
        prepared.schema !== source.schema || prepared.generation !== source.generation ||
        prepared.credentialFingerprint !== source.credentialFingerprint
      ) return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID' };
      source = prepared;
    } catch {
      return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID' };
    }

    const size = (await fs.stat(this.currentPath)).size;
    const required = size * 3 + MIGRATION_SPACE_MARGIN_BYTES;
    if (await this.availableBytes(this.options.userDataDir) < required) {
      return { state: 'blocked', code: 'MIGRATION_SPACE_INSUFFICIENT' };
    }

    const jobId = this.ids.jobId();
    const recoveryPointId = this.ids.recoveryPointId();
    if (!isSafeId(jobId) || !isSafeId(recoveryPointId)) return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID' };
    let sourceSha256: string;
    try { sourceSha256 = await fileSha256(this.currentPath); } catch {
      return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID' };
    }
    try {
      await fs.writeFile(this.lockPath, JSON.stringify({ format: 'yuwendesk-migration-lock', version: 1, jobId }), { flag: 'wx' });
    } catch {
      return { state: 'blocked', code: 'MIGRATION_LOCKED' };
    }

    let leaveInterrupted = false;
    let journal: MigrationJournal = {
      format: 'yuwendesk-migration-journal', version: 1, jobId, recoveryPointId,
      createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
      sourceAppVersion: this.options.sourceAppVersion, targetAppVersion: this.options.targetAppVersion,
      sourceSchema: source.schema, targetSchema: this.options.targetSchema,
      sourceGeneration: source.generation, targetGeneration: this.options.targetGeneration,
      sourceSha256, recoverySha256: null, candidateSha256: null,
      phase: 'prepared', errorCode: null
    };
    try {
      try {
        await this.options.faults?.afterLockAcquired?.();
        if (!existsSync(this.currentPath) || await fileSha256(this.currentPath) !== sourceSha256) {
          return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID', jobId };
        }
      } catch {
        return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID', jobId };
      }
      await writeMigrationJournal(this.options.userDataDir, journal);
      let recovery: { journal: MigrationJournal; databasePath: string };
      try {
        recovery = await this.createRecoveryPoint(journal, source);
        journal = recovery.journal;
      } catch {
        journal = await this.updateJournal(journal, { phase: 'blocked', errorCode: 'MIGRATION_SOURCE_INVALID' });
        return { state: 'blocked', code: 'MIGRATION_SOURCE_INVALID', jobId };
      }

      const staging = this.stagingRoot(jobId);
      const candidatePath = join(staging, 'yuwendesk.db');
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { recursive: true });
      await fs.copyFile(recovery.databasePath, candidatePath);
      try {
        const candidate = new Database(candidatePath);
        try {
          this.options.migrateCandidate(candidate);
          advanceDataGeneration(candidate, this.options.targetGeneration);
          writeMigrationJobId(candidate, jobId);
          candidate.pragma('wal_checkpoint(TRUNCATE)');
        } finally { candidate.close(); }
      } catch {
        journal = await this.updateJournal(journal, { phase: 'blocked', errorCode: 'MIGRATION_APPLY_FAILED' });
        return { state: 'blocked', code: 'MIGRATION_APPLY_FAILED', jobId };
      }
      let candidateIdentity: DatabaseIdentity;
      try {
        await this.options.faults?.afterCandidateMigrated?.(candidatePath);
        candidateIdentity = inspectDatabase(candidatePath);
      } catch {
        journal = await this.updateJournal(journal, { phase: 'blocked', errorCode: 'MIGRATION_CANDIDATE_INVALID' });
        return { state: 'blocked', code: 'MIGRATION_CANDIDATE_INVALID', jobId };
      }
      if (
        candidateIdentity.schema !== this.options.targetSchema ||
        candidateIdentity.generation !== this.options.targetGeneration ||
        candidateIdentity.migrationJobId !== jobId ||
        candidateIdentity.credentialFingerprint !== source.credentialFingerprint
      ) {
        journal = await this.updateJournal(journal, { phase: 'blocked', errorCode: 'MIGRATION_CANDIDATE_INVALID' });
        return { state: 'blocked', code: 'MIGRATION_CANDIDATE_INVALID', jobId };
      }
      const candidateSha256 = await fileSha256(candidatePath);
      journal = await this.updateJournal(journal, { phase: 'candidate_ready', candidateSha256 });

      const rollback = this.rollbackRoot(jobId);
      const rollbackDb = join(rollback, 'yuwendesk.db');
      if (existsSync(rollback)) {
        await this.updateJournal(journal, { phase: 'blocked', errorCode: 'MIGRATION_RECOVERY_REQUIRED' });
        return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId };
      }
      await fs.mkdir(dirname(rollback), { recursive: true });
      await fs.mkdir(rollback, { recursive: false });
      try {
        if (
          await fileSha256(this.currentPath) !== journal.sourceSha256 ||
          existsSync(`${this.currentPath}-wal`) || existsSync(`${this.currentPath}-shm`)
        ) throw new Error('migration_source_changed');
        await fs.rename(this.currentPath, rollbackDb);
        journal = await this.updateJournal(journal, { phase: 'original_moved' });
        if (this.options.faults?.interruptAfterOriginalMove) {
          leaveInterrupted = true;
          return { state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED', jobId };
        }
        await this.options.faults?.afterOriginalMoved?.();
        await fs.rename(candidatePath, this.currentPath);
        journal = await this.updateJournal(journal, { phase: 'candidate_moved' });
        await this.options.faults?.afterCandidateMoved?.();
        const installed = inspectDatabase(this.currentPath);
        if (
          installed.schema !== this.options.targetSchema || installed.generation !== this.options.targetGeneration ||
          installed.migrationJobId !== jobId ||
          installed.credentialFingerprint !== source.credentialFingerprint ||
          await fileSha256(this.currentPath) !== candidateSha256
        ) throw new Error('migration_post_switch_invalid');
        try {
          await this.options.faults?.beforeCompletionCleanup?.();
          await fs.rm(staging, { recursive: true, force: true });
        } catch { /* verified installed data is authoritative; cleanup retries are not rollback triggers */ }
        await this.updateJournal(journal, { phase: 'completed', errorCode: null });
        return { state: 'migrated', jobId, recoveryPointId };
      } catch {
        return await this.rollbackSwitch(journal);
      }
    } finally {
      if (!leaveInterrupted) await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }
}
