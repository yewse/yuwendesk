import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseMigrationCoordinator } from '../src/main/update/migration';
import {
  migrateSqliteDatabaseToTarget,
  SQLITE_DATA_GENERATION,
  SQLITE_SCHEMA_TARGET,
  SqliteStore
} from '../src/main/db/sqliteStore';
import { applyPendingRestoreBeforeOpen, writePendingRestore } from '../src/main/protection/restore';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yuwendesk-g10-migration-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function seed(root: string): string {
  const path = join(root, 'yuwendesk.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO app_meta(key,value) VALUES('data_generation','1');
    CREATE TABLE payload(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
    INSERT INTO payload(id,body) VALUES(1,'学生正文不得进入日志');
    CREATE TABLE credential(provider TEXT PRIMARY KEY,ciphertext BLOB NOT NULL);
    INSERT INTO credential(provider,ciphertext) VALUES('deepseek',X'01020304');
    CREATE TABLE secure_key(id INTEGER PRIMARY KEY,wrapped BLOB NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO secure_key(id,wrapped,created_at) VALUES(1,X'05060708','2026-09-20T00:00:00.000Z');
  `);
  db.pragma('user_version = 1');
  db.close();
  return path;
}

function coordinator(root: string, input?: {
  availableBytes?: number;
  targetGeneration?: number;
  jobId?: string;
  recoveryPointId?: string;
  mutateCredential?: boolean;
  mutateSecureKey?: boolean;
  failApply?: boolean;
  corruptCandidate?: boolean;
  throwAfterCandidate?: boolean;
  failAfterOriginalMove?: boolean;
  failAfterCandidateMove?: boolean;
  interruptAfterOriginalMove?: boolean;
  failCompletionCleanup?: boolean;
  removeSourceAfterLock?: boolean;
}) {
  return new DatabaseMigrationCoordinator({
    userDataDir: root,
    sourceAppVersion: '0.1.0',
    targetAppVersion: '0.2.0',
    targetSchema: 2,
    targetGeneration: input?.targetGeneration ?? 2,
    ids: {
      jobId: () => input?.jobId ?? 'migration_job_1',
      recoveryPointId: () => input?.recoveryPointId ?? 'pre_migration_1'
    },
    now: () => new Date('2026-09-20T12:00:00.000Z'),
    availableBytes: async () => input?.availableBytes ?? Number.MAX_SAFE_INTEGER,
    migrateCandidate: (db) => {
      db.exec('ALTER TABLE payload ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1');
      if (input?.mutateCredential) db.prepare('UPDATE credential SET ciphertext=? WHERE provider=?').run(Buffer.from('changed'), 'deepseek');
      if (input?.mutateSecureKey) db.prepare('UPDATE secure_key SET wrapped=? WHERE id=1').run(Buffer.from('changed'));
      if (input?.failApply) throw new Error('secret path C:\\Users\\teacher and student text');
      db.prepare("INSERT INTO app_meta(key,value) VALUES('data_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(input?.targetGeneration ?? 2));
      db.pragma('user_version = 2');
    },
    faults: {
      afterCandidateMigrated: input?.corruptCandidate
        ? (candidatePath) => rmSync(candidatePath, { force: true })
        : input?.throwAfterCandidate
          ? () => { throw new Error('candidate inspection fault C:\\teacher'); }
          : undefined,
      afterOriginalMoved: input?.failAfterOriginalMove
        ? () => { throw new Error('switch fault with C:\\private'); }
        : undefined,
      afterCandidateMoved: input?.failAfterCandidateMove
        ? () => { throw new Error('post-switch fault with student body'); }
        : undefined,
      interruptAfterOriginalMove: input?.interruptAfterOriginalMove,
      beforeCompletionCleanup: input?.failCompletionCleanup
        ? () => { throw new Error('cleanup unavailable'); }
        : undefined,
      afterLockAcquired: input?.removeSourceAfterLock
        ? () => rmSync(join(root, 'yuwendesk.db'), { force: true })
        : undefined
    }
  });
}

function readVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try { return Number(db.pragma('user_version', { simple: true })); } finally { db.close(); }
}

describe('G10-T02 side-copy migration and recovery', () => {
  it('creates a verified pre-migration recovery point, migrates the side copy, then switches', async () => {
    const root = tempRoot();
    const current = seed(root);
    const result = await coordinator(root).run();

    expect(result).toMatchObject({ state: 'migrated', jobId: 'migration_job_1', recoveryPointId: 'pre_migration_1' });
    expect(readVersion(current)).toBe(2);
    const migrated = new Database(current, { readonly: true });
    expect(migrated.prepare('SELECT body,migrated FROM payload WHERE id=1').get()).toEqual({
      body: '学生正文不得进入日志', migrated: 1
    });
    migrated.close();

    const recoveryRoot = join(root, 'migration-recovery', 'pre_migration_1.ready');
    expect(readVersion(join(recoveryRoot, 'yuwendesk.db'))).toBe(1);
    const manifest = JSON.parse(readFileSync(join(recoveryRoot, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ format: 'yuwendesk-migration-recovery', sourceSchema: 1, sourceGeneration: 1 });
    const journalText = readFileSync(join(root, 'migration-journal.json'), 'utf8');
    expect(journalText).not.toContain(root);
    expect(journalText).not.toContain('学生正文');
    expect(journalText).not.toContain('ciphertext');
    expect(JSON.parse(journalText)).toMatchObject({ phase: 'completed', errorCode: null });
  });

  it('keeps the original byte-identical when candidate migration throws and records only a closed code', async () => {
    const root = tempRoot();
    const current = seed(root);
    const before = sha256(current);
    const result = await coordinator(root, { failApply: true }).run();
    expect(result).toMatchObject({ state: 'blocked', code: 'MIGRATION_APPLY_FAILED' });
    expect(sha256(current)).toBe(before);
    expect(readVersion(current)).toBe(1);
    const journalText = readFileSync(join(root, 'migration-journal.json'), 'utf8');
    expect(journalText).not.toContain('secret path');
    expect(journalText).not.toContain(root);
    expect(JSON.parse(journalText)).toMatchObject({ phase: 'blocked', errorCode: 'MIGRATION_APPLY_FAILED' });
  });

  it('rejects a damaged candidate and credential drift before touching current data', async () => {
    for (const scenario of [
      { corruptCandidate: true }, { mutateCredential: true }, { mutateSecureKey: true }, { throwAfterCandidate: true }
    ]) {
      const root = tempRoot();
      const current = seed(root);
      const before = sha256(current);
      const result = await coordinator(root, scenario).run();
      expect(result).toMatchObject({ state: 'blocked', code: 'MIGRATION_CANDIDATE_INVALID' });
      expect(sha256(current)).toBe(before);
      expect(readVersion(current)).toBe(1);
    }
  });

  it('does not create a recovery point or modify data when rollback headroom is insufficient', async () => {
    const root = tempRoot();
    const current = seed(root);
    const before = sha256(current);
    await expect(coordinator(root, { availableBytes: 0 }).run()).resolves.toMatchObject({
      state: 'blocked', code: 'MIGRATION_SPACE_INSUFFICIENT'
    });
    expect(sha256(current)).toBe(before);
    expect(existsSync(join(root, 'migration-recovery'))).toBe(false);
  });

  it('restores the original after a switch fault and retains the failed side copy for support', async () => {
    for (const fault of [{ failAfterOriginalMove: true }, { failAfterCandidateMove: true }]) {
      const root = tempRoot();
      const current = seed(root);
      const result = await coordinator(root, fault).run();
      expect(result).toMatchObject({ state: 'rolled_back', code: 'MIGRATION_SWITCH_FAILED' });
      expect(readVersion(current)).toBe(1);
      expect(readVersion(join(root, 'migration-failed', 'migration_job_1', 'yuwendesk.db'))).toBe(2);
      expect(JSON.parse(readFileSync(join(root, 'migration-journal.json'), 'utf8'))).toMatchObject({
        phase: 'rolled_back', errorCode: 'MIGRATION_SWITCH_FAILED'
      });
    }
  });

  it('reconciles an interrupted original move on the next launch without erasing the rollback', async () => {
    const root = tempRoot();
    const current = seed(root);
    const interrupted = await coordinator(root, { interruptAfterOriginalMove: true }).run();
    expect(interrupted).toMatchObject({ state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED' });
    expect(existsSync(current)).toBe(false);
    expect(existsSync(join(root, 'migration-rollback', 'migration_job_1', 'yuwendesk.db'))).toBe(true);

    const recovered = await coordinator(root).run();
    expect(recovered).toMatchObject({ state: 'recovered', jobId: 'migration_job_1' });
    expect(readVersion(current)).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'migration-journal.json'), 'utf8'))).toMatchObject({ phase: 'rolled_back' });
  });

  it('is idempotent after a completed migration and does not create another recovery job', async () => {
    const root = tempRoot();
    const current = seed(root);
    await coordinator(root).run();
    const beforeRepeat = sha256(current);
    await expect(coordinator(root).run()).resolves.toEqual({ state: 'not_required', schema: 2, generation: 2 });
    expect(sha256(current)).toBe(beforeRepeat);
    expect(existsSync(`${current}-wal`)).toBe(false);
    expect(existsSync(`${current}-shm`)).toBe(false);
    expect(readdirSync(join(root, 'migration-recovery')).filter((name) => name.endsWith('.ready'))).toEqual([
      'pre_migration_1.ready'
    ]);
  });

  it('accepts normal business writes after completion without treating the next launch as migration damage', async () => {
    const root = tempRoot();
    const current = seed(root);
    await coordinator(root).run();
    const business = new Database(current);
    business.prepare('UPDATE payload SET body=? WHERE id=1').run('教师正常保存后的内容');
    business.close();

    await expect(coordinator(root).run()).resolves.toEqual({ state: 'not_required', schema: 2, generation: 2 });
    const reopened = new Database(current, { readonly: true });
    expect(reopened.prepare('SELECT body FROM payload WHERE id=1').pluck().get()).toBe('教师正常保存后的内容');
    reopened.close();
  });

  it('accepts a later supported data generation across repeated starts while keeping the completed lineage', async () => {
    const root = tempRoot();
    const current = seed(root);
    await coordinator(root).run();
    const future = new Database(current);
    future.prepare("UPDATE app_meta SET value='3' WHERE key='data_generation'").run();
    future.close();

    await expect(coordinator(root, { targetGeneration: 3 }).run()).resolves.toEqual({
      state: 'not_required', schema: 2, generation: 3
    });
    await expect(coordinator(root, { targetGeneration: 3 }).run()).resolves.toEqual({
      state: 'not_required', schema: 2, generation: 3
    });
  });

  it('treats post-validation staging cleanup as best-effort and never rolls back a completed install', async () => {
    const root = tempRoot();
    const current = seed(root);
    await expect(coordinator(root, { failCompletionCleanup: true }).run()).resolves.toMatchObject({ state: 'migrated' });
    expect(readVersion(current)).toBe(2);
    expect(JSON.parse(readFileSync(join(root, 'migration-journal.json'), 'utf8'))).toMatchObject({
      phase: 'completed', errorCode: null
    });
  });

  it('does not treat a missing current database as a fresh install when a completed journal exists', async () => {
    const root = tempRoot();
    const current = seed(root);
    await coordinator(root).run();
    rmSync(current, { force: true });
    await expect(coordinator(root).run()).resolves.toMatchObject({
      state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED'
    });
    expect(existsSync(current)).toBe(false);
  });

  it('retires stale migration control state with a proven restore, then migrates the restored old database', async () => {
    const root = tempRoot();
    seed(root);
    await coordinator(root).run();
    const staged = join(root, 'restore-staging', 'restore_old', 'userData');
    mkdirSync(staged, { recursive: true });
    seed(staged);
    const prepared = {
      jobId: 'restore_old',
      previewHash: 'b'.repeat(64),
      stagedUserDataDir: staged,
      preview: {
        backupId: 'backup_old', createdAt: '2026-09-20T10:00:00.000Z',
        schemaVersion: 1, apiReconnectRequired: true as const
      }
    };
    await writePendingRestore(root, prepared, {
      token: 'restore-token', jobId: prepared.jobId, previewHash: prepared.previewHash,
      expiresAt: Date.now() + 60_000
    });

    await expect(applyPendingRestoreBeforeOpen(root, async () => true)).resolves.toMatchObject({
      status: 'applied', jobId: 'restore_old'
    });
    expect(readVersion(join(root, 'yuwendesk.db'))).toBe(1);
    expect(existsSync(join(root, 'migration-journal.json'))).toBe(false);
    expect(existsSync(join(root, 'restore-rollback', 'restore_old', 'migration-journal.json'))).toBe(true);
    await expect(coordinator(root, {
      jobId: 'migration_job_2', recoveryPointId: 'pre_migration_2'
    }).run()).resolves.toMatchObject({ state: 'migrated', jobId: 'migration_job_2' });
    expect(readVersion(join(root, 'yuwendesk.db'))).toBe(2);
  });

  it('removes the maintenance lock when source hashing fails after lock acquisition', async () => {
    const root = tempRoot();
    seed(root);
    await expect(coordinator(root, { removeSourceAfterLock: true }).run()).resolves.toMatchObject({
      state: 'blocked', code: 'MIGRATION_SOURCE_INVALID'
    });
    expect(existsSync(join(root, 'migration-maintenance.lock'))).toBe(false);
  });

  it('resumes both failed-copy crash points around the candidate move', async () => {
    for (const point of ['directory_created', 'candidate_moved'] as const) {
      const root = tempRoot();
      const current = seed(root);
      await coordinator(root, { interruptAfterOriginalMove: true }).run();
      const failedPartial = join(root, 'migration-failed', 'migration_job_1.partial');
      mkdirSync(failedPartial, { recursive: true });
      if (point === 'candidate_moved') {
        const staged = join(root, 'migration-staging', 'migration_job_1.partial', 'yuwendesk.db');
        const moved = join(failedPartial, 'yuwendesk.db');
        renameSync(staged, moved);
      }
      await expect(coordinator(root).run()).resolves.toMatchObject({ state: 'recovered' });
      expect(readVersion(current)).toBe(1);
      expect(existsSync(failedPartial)).toBe(false);
      expect(readVersion(join(root, 'migration-failed', 'migration_job_1', 'yuwendesk.db'))).toBe(2);
    }
  });

  it('fails closed on an unknown journal field or an unexplained maintenance lock', async () => {
    for (const scenario of ['journal', 'lock'] as const) {
      const root = tempRoot();
      const current = seed(root);
      const before = sha256(current);
      if (scenario === 'journal') {
        writeFileSync(join(root, 'migration-journal.json'), JSON.stringify({ format: 'unknown', path: 'C:\\secret' }));
      } else {
        writeFileSync(join(root, 'migration-maintenance.lock'), '{}');
      }
      await expect(coordinator(root).run()).resolves.toMatchObject({
        state: 'blocked', code: scenario === 'journal' ? 'MIGRATION_RECOVERY_REQUIRED' : 'MIGRATION_LOCKED'
      });
      expect(sha256(current)).toBe(before);
    }
  });

  it('never erases a pre-existing rollback directory to start a new switch', async () => {
    const root = tempRoot();
    const current = seed(root);
    const rollback = join(root, 'migration-rollback', 'migration_job_1');
    mkdirSync(rollback, { recursive: true });
    writeFileSync(join(rollback, 'preserve-me'), 'existing recovery evidence', { flag: 'wx' });
    const before = sha256(current);
    await expect(coordinator(root).run()).resolves.toMatchObject({
      state: 'blocked', code: 'MIGRATION_RECOVERY_REQUIRED'
    });
    expect(sha256(current)).toBe(before);
    expect(readFileSync(join(rollback, 'preserve-me'), 'utf8')).toBe('existing recovery evidence');
  });

  it('runs the real schema migration callback against a side copy instead of the active database', async () => {
    const root = tempRoot();
    const initial = new SqliteStore(root);
    await initial.load();
    await initial.saveDraft('真实迁移链保留的数据');
    initial.withTransaction((db) => {
      db.exec(`
        DROP TABLE preparation_source;
        DROP TABLE preparation_session;
        DROP TABLE teaching_context;
        DROP TABLE maintenance_error_count;
        DROP TABLE maintenance_state;
      `);
      db.prepare("DELETE FROM app_meta WHERE key='data_generation'").run();
      db.pragma(`user_version = ${SQLITE_SCHEMA_TARGET - 1}`);
    });
    initial.close();

    const result = await new DatabaseMigrationCoordinator({
      userDataDir: root,
      sourceAppVersion: '0.1.0', targetAppVersion: '0.2.0',
      targetSchema: SQLITE_SCHEMA_TARGET, targetGeneration: SQLITE_DATA_GENERATION,
      ids: { jobId: () => 'real_schema_job', recoveryPointId: () => 'real_schema_recovery' },
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      migrateCandidate: (db) => migrateSqliteDatabaseToTarget(
        db,
        Number(db.pragma('user_version', { simple: true })),
        SQLITE_SCHEMA_TARGET
      )
    }).run();
    expect(result).toMatchObject({ state: 'migrated' });
    const reopened = new SqliteStore(root, { allowInPlaceMigrations: false });
    await reopened.load();
    expect(reopened.schemaVersion()).toBe(SQLITE_SCHEMA_TARGET);
    expect(reopened.dataGeneration()).toBe(SQLITE_DATA_GENERATION);
    expect(reopened.getDraft()).toMatchObject({ content: '真实迁移链保留的数据', revision: 1 });
    reopened.close();
  });
});
