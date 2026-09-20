import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLITE_DATA_GENERATION, SQLITE_SCHEMA_TARGET, SqliteStore } from '../src/main/db/sqliteStore';
import { IpcService } from '../src/main/ipc';
import { StoreProtectedError } from '../src/main/store';
import { downgradeProtectionNotice } from '../src/renderer/updateView';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const roots: string[] = [];
const open = new Set<SqliteStore>();

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'yuwendesk-g10-downgrade-'));
  roots.push(path);
  return path;
}

function store(path: string, supportedDataGeneration: number): SqliteStore {
  const value = new SqliteStore(path, { supportedDataGeneration });
  open.add(value);
  return value;
}

afterEach(() => {
  for (const value of open) value.close();
  open.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('G10-T02 incompatible downgrade guard', () => {
  it('advances the data generation before startup maintenance and keeps it on the first business write', async () => {
    const path = root();
    const current = store(path, SQLITE_DATA_GENERATION);
    await current.load();
    expect(current.dataGeneration()).toBe(SQLITE_DATA_GENERATION);
    await current.saveDraft('新版本写入');
    expect(current.dataGeneration()).toBe(SQLITE_DATA_GENERATION);
  });

  it('lets an older app read but refuses every write when the data generation is newer', async () => {
    const path = root();
    const current = store(path, 2);
    await current.load();
    await current.saveDraft('必须保留的新数据');
    current.close();
    open.delete(current);

    const older = store(path, 1);
    await older.load();
    expect(older.isProtected()).toBe(true);
    expect(older.protectedReason()).toBe('data_generation_newer:db=2>app=1');
    expect(older.getDraft()).toMatchObject({ content: '必须保留的新数据', revision: 1 });
    await expect(older.saveDraft('旧版覆盖')).rejects.toBeInstanceOf(StoreProtectedError);
    expect(older.getDraft()).toMatchObject({ content: '必须保留的新数据', revision: 1 });
  });

  it('explains that the old version did not overwrite data and does not promise binary rollback', () => {
    const text = downgradeProtectionNotice('data_generation_newer:db=2>app=1');
    expect(text).toContain('旧版未覆盖新数据');
    expect(text).toContain('保留');
    expect(text).toContain('导出');
    expect(text).not.toContain('已恢复旧程序');
    expect(text).not.toContain('自动覆盖');
  });

  it('does not change an old-schema database or create WAL sidecars when side-copy migration is required', async () => {
    const path = root();
    const databasePath = join(path, 'yuwendesk.db');
    const seed = new Database(databasePath);
    seed.exec(`
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE draft(id INTEGER PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT);
      INSERT INTO draft VALUES(1,'旧版数据',3,NULL);
      CREATE TABLE window(id INTEGER PRIMARY KEY,width INTEGER NOT NULL,height INTEGER NOT NULL,x INTEGER,y INTEGER);
      INSERT INTO window VALUES(1,1180,800,NULL,NULL);
    `);
    seed.pragma('user_version = 1');
    seed.close();
    const before = createHash('sha256').update(readFileSync(databasePath)).digest('hex');

    const guarded = new SqliteStore(path, { allowInPlaceMigrations: false });
    open.add(guarded);
    await guarded.load();
    expect(guarded.protectedReason()).toBe(`migration_required:db=1<app=${SQLITE_SCHEMA_TARGET}`);
    expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(before);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
  });

  it('forces a current-schema database read-only when startup migration recovery is unresolved', async () => {
    const path = root();
    const initial = store(path, SQLITE_DATA_GENERATION);
    await initial.load();
    await initial.saveDraft('故障时仍可读');
    initial.close();
    open.delete(initial);

    const guarded = new SqliteStore(path, { startupProtectionReason: 'migration_recovery_required' });
    open.add(guarded);
    await guarded.load();
    expect(guarded.isProtected()).toBe(true);
    expect(guarded.protectedReason()).toBe('migration_recovery_required');
    expect(guarded.getDraft()).toMatchObject({ content: '故障时仍可读', revision: 1 });
    await expect(guarded.saveDraft('不得写')).rejects.toBeInstanceOf(StoreProtectedError);

    const ipc = new IpcService({
      store: guarded,
      appVersion: '0.1.0',
      appNameZh: '语文备课工作台',
      platformSupported: true,
      httpListeners: 0,
      online: false,
      buildMode: 'production',
      sandboxEnabled: true,
      platformDevOverride: false,
      platformTargetSupported: true,
      platformIdentity: 'win11'
    });
    const health = await ipc.handle('app.health', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'health',
      operation: 'app.health',
      workspace_id: null,
      payload: {}
    });
    expect(health.ok).toBe(true);
    if (health.ok) expect(health.data).toMatchObject({ storage_protected: true, storage_protection_kind: 'migration_recovery' });
    const save = await ipc.handle('ui.saveDraft', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'save',
      operation: 'ui.saveDraft',
      workspace_id: null,
      idempotency_key: 'blocked-save',
      expected_revision: 1,
      payload: { content: '不得经 IPC 写入' }
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe('DATABASE_LOCKED');
  });

  it('does not create a blank database when migration evidence exists but current data is missing', async () => {
    const path = root();
    const guarded = new SqliteStore(path, { startupProtectionReason: 'migration_recovery_required' });
    open.add(guarded);
    await guarded.load();
    expect(guarded.isProtected()).toBe(true);
    expect(existsSync(join(path, 'yuwendesk.db'))).toBe(false);
    await expect(guarded.saveDraft('不得创建空库')).rejects.toBeInstanceOf(StoreProtectedError);
  });

  it('advances generation in the same startup recovery that changes a running model job', async () => {
    const path = root();
    const old = store(path, 1);
    await old.load();
    const now = '2026-09-20T00:00:00.000Z';
    old.insertModelJob({
      id: 'running_job', task: 'analyze_text', cacheKey: 'running', provider: 'test-double', model: 'test',
      paramsJson: '{}', promptVersion: 'p1', materialVersionsJson: '[]', status: 'running',
      resultJson: null, costCents: 0, errorCode: null, createdAt: now, updatedAt: now
    });
    expect(old.dataGeneration()).toBe(1);
    old.close();
    open.delete(old);

    const upgraded = store(path, 2);
    await upgraded.load();
    expect(upgraded.getModelJob('running_job')?.status).toBe('uncertain');
    expect(upgraded.dataGeneration()).toBe(2);
  });
});
