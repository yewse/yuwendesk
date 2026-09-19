import Database from 'better-sqlite3';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalStore } from '../store';
import type { DraftState, SaveExpectResult, WindowState } from '../store';
import { StoreProtectedError } from '../store';

// G02-T02：真实文件型 SQLite 存储（单写入者 + 版本迁移 + WAL/外键 + 原子条件保存 + 失败回滚）。
// 与 LocalStore 提供同一组接口，便于主进程无缝切换；旧 JSON 首次运行安全迁入并备份，不丢数据。
//
// 原生依赖 better-sqlite3：Node 侧使用预编译二进制；在 Electron 中需按 Electron ABI 重建
// （electron-builder 打包自动执行 @electron/rebuild；开发运行前用 electron-rebuild）。

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

export class SqliteStore {
  private readonly dir: string;
  private readonly dbPath: string;
  private readonly legacyJsonPath: string;
  private db: Database.Database | null = null;
  private protectedState = false;
  private protectedReasonText: string | null = null;
  private migratedFromJson = false;

  constructor(userDataDir: string) {
    this.dir = userDataDir;
    this.dbPath = join(userDataDir, 'yuwendesk.db');
    this.legacyJsonPath = join(userDataDir, 'yuwendesk-local-state.json');
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
      this.runMigrations();
      await this.migrateLegacyJsonIfNeeded();
    } catch (e) {
      this.enterProtected(`open_failed:${(e as Error).message}`);
    }
  }

  private runMigrations(): void {
    const db = this.requireDb();
    const current = Number(db.pragma('user_version', { simple: true }));
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      const apply = db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      });
      apply.immediate();
    }
  }

  // 旧 JSON 安全迁入：仅当 SQLite 仍为初始空草稿且旧 JSON 有效时导入，导入后把旧文件改名备份（不删除、不覆盖）。
  private async migrateLegacyJsonIfNeeded(): Promise<void> {
    if (!existsSync(this.legacyJsonPath)) return;
    const draft = this.readDraft();
    if (draft.revision !== 0 || draft.content !== '') return; // 已有数据，不覆盖

    const legacy = new LocalStore(this.dir);
    await legacy.load(); // 复用已验证的解析/结构校验；坏 JSON 会被其安全隔离
    if (legacy.isProtected()) return; // 旧文件不可靠：不迁入、不删除，保持原样
    const ld = legacy.getDraft();
    const lw = legacy.getWindow();
    const hasContent = ld.content !== '' || ld.revision > 0;
    if (!hasContent) return;

    const db = this.requireDb();
    const tx = db.transaction(() => {
      db.prepare('UPDATE draft SET content=?, revision=?, updated_at=? WHERE id=1').run(
        ld.content,
        ld.revision,
        ld.updated_at
      );
      db.prepare('UPDATE window SET width=?, height=?, x=?, y=? WHERE id=1').run(
        lw.width,
        lw.height,
        lw.x ?? null,
        lw.y ?? null
      );
    });
    tx.immediate();

    // 迁入成功后备份旧文件（保留证据，不删除、不覆盖 SQLite）。
    if (existsSync(this.legacyJsonPath)) {
      const backup = `${this.legacyJsonPath}.migrated.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(this.legacyJsonPath, backup).catch(() => undefined);
    }
    this.migratedFromJson = true;
  }

  private readDraft(): DraftState {
    const db = this.requireDb();
    const row = db.prepare('SELECT content, revision, updated_at FROM draft WHERE id=1').get() as
      | { content: string; revision: number; updated_at: string | null }
      | undefined;
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
    if (!this.db) return { content: '', revision: 0, updated_at: null };
    return this.readDraft();
  }

  getWindow(): WindowState {
    if (!this.db) return { width: 1180, height: 800 };
    return this.readWindow();
  }

  isProtected(): boolean {
    return this.protectedState;
  }

  protectedReason(): string | null {
    return this.protectedReasonText;
  }

  recoveredFromCorruption(): boolean {
    return this.migratedFromJson;
  }

  corruptBackup(): string | null {
    return null;
  }

  async saveDraft(content: string): Promise<DraftState> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((c: string) => {
      const now = new Date().toISOString();
      db.prepare('UPDATE draft SET content=?, revision=revision+1, updated_at=? WHERE id=1').run(c, now);
      return this.readDraft();
    });
    return tx.immediate(content);
  }

  // 原子乐观并发：版本检查 + 写入 + 提交在同一 IMMEDIATE 事务内；冲突则不写入（回滚为无操作）。
  async saveDraftExpecting(content: string, expectedRevision: number): Promise<SaveExpectResult> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((c: string, expected: number): SaveExpectResult => {
      const cur = this.readDraft();
      if (cur.revision !== expected) {
        return { ok: false, reason: 'conflict', current: cur };
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE draft SET content=?, revision=revision+1, updated_at=? WHERE id=1').run(c, now);
      return { ok: true, draft: this.readDraft() };
    });
    return tx.immediate(content, expectedRevision);
  }

  async saveWindow(win: WindowState): Promise<void> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((w: WindowState) => {
      db.prepare('UPDATE window SET width=?, height=?, x=?, y=? WHERE id=1').run(
        w.width,
        w.height,
        w.x ?? null,
        w.y ?? null
      );
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
