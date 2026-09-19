import Database from 'better-sqlite3';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalStore } from '../store';
import type { DraftState, SaveExpectResult, StoreIo, WindowState } from '../store';
import { StoreProtectedError } from '../store';

export interface SqliteStoreOptions {
  // 旧 JSON 读取/隔离的可注入 IO（供确定性测试读取失败/隔离失败）。
  legacyIo?: StoreIo;
  // 原件归档改名的可注入实现（供确定性测试归档失败）。默认 fs.rename。
  archiveRename?: (from: string, to: string) => Promise<void>;
}

// G02-T02：真实文件型 SQLite 存储（单写入者 + 版本迁移 + WAL/外键 + 原子条件保存 + 失败回滚）。
// 本轮加固：高版本/未知结构拒写；旧 JSON 读取或隔离失败进入迁入保护；必需记录缺失/UPDATE 零行不返回成功；
// 迁入状态与数据提交一致（同一事务写入 legacy_migrated 标记）；原件归档失败如实记录不吞掉；
// 正常迁入(migratedFromJson) 与损坏恢复(recoveredFromCorruption) 分开表达。
//
// 原生依赖 better-sqlite3：Node 侧用预编译；Electron 中需按 Electron ABI 重建（打包自动 @electron/rebuild）。

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS draft (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          content    TEXT NOT NULL DEFAULT '',
          revision   INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS window (
          id     INTEGER PRIMARY KEY CHECK (id = 1),
          width  INTEGER NOT NULL,
          height INTEGER NOT NULL,
          x      INTEGER,
          y      INTEGER
        );
        INSERT OR IGNORE INTO draft (id, content, revision, updated_at) VALUES (1, '', 0, NULL);
        INSERT OR IGNORE INTO window (id, width, height, x, y) VALUES (1, 1180, 800, NULL, NULL);
      `);
    }
  }
];

const SCHEMA_TARGET = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface MigrationStatus {
  migratedFromJson: boolean; // 有效旧 JSON 已成功迁入
  recoveredFromCorruption: boolean; // 旧 JSON 损坏、已被安全隔离（恢复路径，非迁入）
  legacyArchive: 'none' | 'ok' | 'failed'; // 原件归档结果（失败如实记录，不冒充完成）
  legacyArchiveError: string | null;
  protectedReason: string | null;
}

export class SqliteStore {
  private readonly dir: string;
  private readonly dbPath: string;
  private readonly legacyJsonPath: string;
  private db: Database.Database | null = null;
  private protectedState = false;
  private protectedReasonText: string | null = null;
  private migratedFromJsonFlag = false;
  private recoveredFromCorruptionFlag = false;
  private legacyArchive: 'none' | 'ok' | 'failed' = 'none';
  private legacyArchiveError: string | null = null;
  private readonly legacyIo?: StoreIo;
  private readonly archiveRename: (from: string, to: string) => Promise<void>;

  constructor(userDataDir: string, opts: SqliteStoreOptions = {}) {
    this.dir = userDataDir;
    this.dbPath = join(userDataDir, 'yuwendesk.db');
    this.legacyJsonPath = join(userDataDir, 'yuwendesk-local-state.json');
    this.legacyIo = opts.legacyIo;
    this.archiveRename = opts.archiveRename ?? ((from, to) => fs.rename(from, to));
  }

  async load(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      const integrity = this.db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        this.enterProtected(`integrity_check:${String(integrity)}`);
        return;
      }
      const version = Number(this.db.pragma('user_version', { simple: true }));
      // 高版本/未知结构拒写：数据库由更高版本应用写入，本版本不得降级或误写。
      if (version > SCHEMA_TARGET) {
        this.enterProtected(`schema_newer:db=${version}>app=${SCHEMA_TARGET}`);
        return;
      }
      this.runMigrations(version);
      if (!this.verifyRequiredRows()) {
        this.enterProtected('required_row_missing');
        return;
      }
      await this.migrateLegacyJsonIfNeeded();
    } catch (e) {
      this.enterProtected(`open_failed:${(e as Error).message}`);
    }
  }

  private runMigrations(current: number): void {
    const db = this.requireDb();
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      const apply = db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      });
      apply.immediate();
    }
  }

  // 校验必需单例记录存在（未知/被篡改结构下拒写）。
  private verifyRequiredRows(): boolean {
    const db = this.requireDb();
    try {
      const d = db.prepare('SELECT 1 FROM draft WHERE id=1').get();
      const w = db.prepare('SELECT 1 FROM window WHERE id=1').get();
      return !!d && !!w;
    } catch {
      return false;
    }
  }

  private getMeta(key: string): string | null {
    const db = this.requireDb();
    const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  private setMetaInTx(db: Database.Database, key: string, value: string): void {
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      key,
      value
    );
  }

  // 旧 JSON 安全迁入：由 app_meta('legacy_migrated') 门控（与数据提交同一事务，可恢复且一致）。
  private async migrateLegacyJsonIfNeeded(): Promise<void> {
    const db = this.requireDb();
    if (this.getMeta('legacy_migrated') === '1') return; // 已迁入：幂等跳过
    if (!existsSync(this.legacyJsonPath)) return;

    // 若 SQLite 已有真实数据，绝不被后出现的旧 JSON 覆盖；标记为已处理以保持稳定与幂等。
    const cur = this.readDraft();
    if (cur.revision > 0 || cur.content !== '') {
      db.transaction(() => this.setMetaInTx(db, 'legacy_migrated', '1')).immediate();
      return;
    }

    const legacy = new LocalStore(this.dir, undefined, this.legacyIo);
    await legacy.load(); // 复用已验证的解析/结构校验；坏 JSON 会被其安全隔离(.corrupt)
    if (legacy.isProtected()) {
      // 旧文件读取失败或隔离失败：进入迁入保护，绝不以空库继续覆盖/掩盖旧数据。
      this.enterProtected(`legacy_${legacy.protectedReason() ?? 'unrecoverable'}`);
      return;
    }
    if (legacy.recoveredFromCorruption()) {
      // 坏 JSON 已被安全隔离：属"损坏恢复"，与"正常迁入"分开表达；无有效数据可迁入。
      this.recoveredFromCorruptionFlag = true;
    }
    const ld = legacy.getDraft();
    const lw = legacy.getWindow();
    const hasContent = ld.content !== '' || ld.revision > 0;

    // 数据导入 + 迁入标记在同一事务内提交，保证迁入状态与数据一致、可恢复。
    const tx = db.transaction(() => {
      if (hasContent) {
        const di = db
          .prepare('UPDATE draft SET content=?, revision=?, updated_at=? WHERE id=1')
          .run(ld.content, ld.revision, ld.updated_at);
        if (di.changes !== 1) throw new Error('migrate_draft_update_zero_rows');
        db.prepare('UPDATE window SET width=?, height=?, x=?, y=? WHERE id=1').run(
          lw.width,
          lw.height,
          lw.x ?? null,
          lw.y ?? null
        );
      }
      this.setMetaInTx(db, 'legacy_migrated', '1');
    });
    tx.immediate();
    this.migratedFromJsonFlag = hasContent;

    // 归档原件（保留证据）。失败如实记录，绝不吞掉后宣称备份完成。
    if (existsSync(this.legacyJsonPath)) {
      const backup = `${this.legacyJsonPath}.migrated.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        await this.archiveRename(this.legacyJsonPath, backup);
        this.legacyArchive = 'ok';
        const db2 = this.requireDb();
        db2.transaction(() => this.setMetaInTx(db2, 'legacy_archive', 'ok')).immediate();
      } catch (e) {
        this.legacyArchive = 'failed';
        this.legacyArchiveError = (e as Error).message;
        const db2 = this.requireDb();
        db2.transaction(() => this.setMetaInTx(db2, 'legacy_archive', `failed:${this.legacyArchiveError}`)).immediate();
      }
    }
  }

  private readDraftRow(): { content: string; revision: number; updated_at: string | null } | undefined {
    const db = this.requireDb();
    return db.prepare('SELECT content, revision, updated_at FROM draft WHERE id=1').get() as
      | { content: string; revision: number; updated_at: string | null }
      | undefined;
  }

  private readDraft(): DraftState {
    const row = this.readDraftRow();
    return row
      ? { content: row.content, revision: row.revision, updated_at: row.updated_at }
      : { content: '', revision: 0, updated_at: null };
  }

  private readWindow(): WindowState {
    const db = this.requireDb();
    const row = db.prepare('SELECT width, height, x, y FROM window WHERE id=1').get() as
      | { width: number; height: number; x: number | null; y: number | null }
      | undefined;
    if (!row) return { width: 1180, height: 800 };
    return { width: row.width, height: row.height, x: row.x ?? undefined, y: row.y ?? undefined };
  }

  getDraft(): DraftState {
    if (!this.db || this.protectedState) return { content: '', revision: 0, updated_at: null };
    return this.readDraft();
  }

  getWindow(): WindowState {
    if (!this.db || this.protectedState) return { width: 1180, height: 800 };
    return this.readWindow();
  }

  isProtected(): boolean {
    return this.protectedState;
  }
  protectedReason(): string | null {
    return this.protectedReasonText;
  }

  // recoveredFromCorruption 仅表示"损坏恢复"（坏 JSON 被隔离），不含正常迁入（见 migratedFromJson/migrationStatus）。
  recoveredFromCorruption(): boolean {
    return this.recoveredFromCorruptionFlag;
  }
  migratedFromJson(): boolean {
    return this.migratedFromJsonFlag;
  }
  migrationStatus(): MigrationStatus {
    return {
      migratedFromJson: this.migratedFromJsonFlag,
      recoveredFromCorruption: this.recoveredFromCorruptionFlag,
      legacyArchive: this.legacyArchive,
      legacyArchiveError: this.legacyArchiveError,
      protectedReason: this.protectedReasonText
    };
  }

  corruptBackup(): string | null {
    return null;
  }

  async saveDraft(content: string): Promise<DraftState> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((c: string) => {
      if (!this.readDraftRow()) throw new Error('draft_row_missing'); // 必需记录缺失不得返回成功
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE draft SET content=?, revision=revision+1, updated_at=? WHERE id=1').run(c, now);
      if (info.changes !== 1) throw new Error('draft_update_zero_rows'); // UPDATE 零行不得返回成功
      return this.readDraft();
    });
    return tx.immediate(content);
  }

  // 原子乐观并发：版本检查 + 写入 + 提交在同一 IMMEDIATE 事务内；冲突则不写入。
  async saveDraftExpecting(content: string, expectedRevision: number): Promise<SaveExpectResult> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((c: string, expected: number): SaveExpectResult => {
      const row = this.readDraftRow();
      if (!row) throw new Error('draft_row_missing'); // 必需记录缺失不得返回成功
      if (row.revision !== expected) {
        return { ok: false, reason: 'conflict', current: { content: row.content, revision: row.revision, updated_at: row.updated_at } };
      }
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE draft SET content=?, revision=revision+1, updated_at=? WHERE id=1').run(c, now);
      if (info.changes !== 1) throw new Error('draft_update_zero_rows');
      return { ok: true, draft: this.readDraft() };
    });
    return tx.immediate(content, expectedRevision);
  }

  async saveWindow(win: WindowState): Promise<void> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((w: WindowState) => {
      const info = db
        .prepare('UPDATE window SET width=?, height=?, x=?, y=? WHERE id=1')
        .run(w.width, w.height, w.x ?? null, w.y ?? null);
      if (info.changes !== 1) throw new Error('window_update_zero_rows');
    });
    tx.immediate(win);
  }

  // 通用事务原语（供 G02-T04 业务事件事务复用）：抛出即回滚，不改动已提交状态。
  withTransaction<T>(fn: (db: Database.Database) => T): T {
    this.assertWritable();
    const db = this.requireDb();
    return db.transaction(fn).immediate(db);
  }

  async probeWritable(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      const probe = `${this.dbPath}.probe.${process.pid}.${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(probe, 'ok', 'utf-8');
      await fs.rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  schemaVersion(): number {
    if (!this.db) return 0;
    return Number(this.db.pragma('user_version', { simple: true }));
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new StoreProtectedError(this.protectedReasonText ?? 'db_not_open');
    return this.db;
  }

  private assertWritable(): void {
    if (this.protectedState || !this.db) {
      throw new StoreProtectedError(this.protectedReasonText ?? 'protected');
    }
  }

  private enterProtected(reason: string): void {
    this.protectedState = true;
    this.protectedReasonText = reason;
  }
}

export const SQLITE_SCHEMA_TARGET = SCHEMA_TARGET;
