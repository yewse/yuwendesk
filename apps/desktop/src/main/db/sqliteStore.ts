import Database from 'better-sqlite3';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalStore } from '../store';
import type { DraftCommitOp, DraftCommitResult, DraftState, SaveExpectResult, StoreIo, WindowState } from '../store';
import { StoreProtectedError } from '../store';
import {
  CredentialProtector,
  DataKeyManager,
  decryptSensitive,
  encryptSensitive,
  generateDataKey,
  isSecureSafeStorage,
  type SafeStorageLike
} from '../crypto/secrets';

// 仅供测试的事务中途故障注入点（验证 outbox/幂等写入失败时整体回滚）。
export interface CommitFaultHooks {
  afterDraftUpdate?: () => void;
  afterOutbox?: () => void;
  beforeIdempotency?: () => void;
}

export interface SqliteStoreOptions {
  // 旧 JSON 读取/隔离的可注入 IO（供确定性测试读取失败/隔离失败）。
  legacyIo?: StoreIo;
  // 原件归档改名的可注入实现（供确定性测试归档失败）。默认 fs.rename。
  archiveRename?: (from: string, to: string) => Promise<void>;
  // 凭据/敏感 payload 保护后端（生产注入 electron.safeStorage；测试注入伪实现）。
  safeStorage?: SafeStorageLike;
  // 测试用事务中途故障注入。
  commitFaults?: CommitFaultHooks;
}

export type CredentialSetResult = { ok: true; last4: string } | { ok: false; reason: 'encryption_unavailable' };
export type CredentialReadResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: 'not_found' | 'decrypt_failed' | 'unavailable' };
export type SensitiveResult<T> = { ok: true; value: T } | { ok: false; reason: 'unavailable' | 'decrypt_failed' | 'not_found' };

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
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency (
          key              TEXT PRIMARY KEY,
          fingerprint      TEXT NOT NULL,
          status           TEXT NOT NULL,            -- applied | conflict
          draft_content    TEXT,
          draft_revision   INTEGER,
          draft_updated_at TEXT,
          current_revision INTEGER,
          created_at       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS credential (
          name       TEXT PRIMARY KEY,
          ciphertext BLOB NOT NULL,
          last4      TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secure_key (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          wrapped    BLOB NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sensitive (
          name       TEXT PRIMARY KEY,
          blob       BLOB NOT NULL,
          aad        TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  }
];

const SCHEMA_TARGET = Math.max(...MIGRATIONS.map((m) => m.version));

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
  private readonly safeStorage?: SafeStorageLike;
  private readonly commitFaults?: CommitFaultHooks;

  constructor(userDataDir: string, opts: SqliteStoreOptions = {}) {
    this.dir = userDataDir;
    this.dbPath = join(userDataDir, 'yuwendesk.db');
    this.legacyJsonPath = join(userDataDir, 'yuwendesk-local-state.json');
    this.legacyIo = opts.legacyIo;
    this.archiveRename = opts.archiveRename ?? ((from, to) => fs.rename(from, to));
    this.safeStorage = opts.safeStorage;
    this.commitFaults = opts.commitFaults;
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
    const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
    for (const m of ordered) {
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

  // T04 幂等业务提交：幂等检查 + 版本检查 + 草稿修改 + 幂等结果 + outbox 事件在同一 IMMEDIATE 事务；
  // 任一必要步骤失败则整体回滚。持久幂等表使跨进程/重启重试不重复修改；同键异请求拒绝。
  async commitDraftSave(op: DraftCommitOp): Promise<DraftCommitResult> {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction((o: DraftCommitOp): DraftCommitResult => {
      const existing = db.prepare('SELECT * FROM idempotency WHERE key=?').get(o.idempotencyKey) as
        | {
            fingerprint: string;
            status: string;
            draft_content: string | null;
            draft_revision: number | null;
            draft_updated_at: string | null;
          }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== o.fingerprint) return { status: 'key_reuse' };
        if (existing.status === 'applied') {
          return {
            status: 'replayed',
            draft: {
              content: existing.draft_content ?? '',
              revision: existing.draft_revision ?? 0,
              updated_at: existing.draft_updated_at
            }
          };
        }
        // 已记录的确定性冲突：返回当前值（不重复修改）。
        return { status: 'conflict', current: this.readDraft() };
      }

      const row = this.readDraftRow();
      if (!row) throw new Error('draft_row_missing'); // 必需记录缺失不得返回成功
      const now = new Date().toISOString();
      if (row.revision !== o.expectedRevision) {
        db.prepare(
          'INSERT INTO idempotency(key,fingerprint,status,current_revision,created_at) VALUES(?,?,?,?,?)'
        ).run(o.idempotencyKey, o.fingerprint, 'conflict', row.revision, now);
        return { status: 'conflict', current: { content: row.content, revision: row.revision, updated_at: row.updated_at } };
      }
      const info = db.prepare('UPDATE draft SET content=?, revision=revision+1, updated_at=? WHERE id=1').run(o.content, now);
      if (info.changes !== 1) throw new Error('draft_update_zero_rows'); // 零行不得返回成功 → 抛出触发回滚
      this.commitFaults?.afterDraftUpdate?.(); // 测试：草稿已更新后中途失败 → 应整体回滚
      const d = this.readDraft();
      db.prepare('INSERT INTO outbox(event_type,payload,created_at) VALUES(?,?,?)').run(
        'draft.saved',
        JSON.stringify({ revision: d.revision }),
        now
      );
      this.commitFaults?.afterOutbox?.(); // 测试：outbox 写入后中途失败 → 应整体回滚
      this.commitFaults?.beforeIdempotency?.(); // 测试：幂等结果写入前失败 → 应整体回滚
      db.prepare(
        'INSERT INTO idempotency(key,fingerprint,status,draft_content,draft_revision,draft_updated_at,created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(o.idempotencyKey, o.fingerprint, 'applied', d.content, d.revision, d.updated_at, now);
      return { status: 'applied', draft: d };
    });
    return tx.immediate(op);
  }

  // outbox 只读访问（测试/后续投递用）。
  outboxCount(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) c FROM outbox').get() as { c: number };
    return row.c;
  }
  readOutbox(): { event_type: string; payload: string }[] {
    if (!this.db) return [];
    return this.db.prepare('SELECT event_type, payload FROM outbox ORDER BY id').all() as {
      event_type: string;
      payload: string;
    }[];
  }

  // ===== T03 凭据与敏感 payload 保护 =====

  credentialEncryptionAvailable(): boolean {
    return !!this.safeStorage && isSecureSafeStorage(this.safeStorage);
  }

  // 存凭据：加密不可用则拒绝，绝不落明文；界面只用 last4 显示。
  setCredential(name: string, plaintext: string): CredentialSetResult {
    this.assertWritable();
    if (!this.safeStorage) return { ok: false, reason: 'encryption_unavailable' };
    const protector = new CredentialProtector(this.safeStorage);
    const r = protector.protect(plaintext);
    if (!r.ok) return { ok: false, reason: 'encryption_unavailable' };
    const db = this.requireDb();
    db.prepare(
      'INSERT INTO credential(name,ciphertext,last4,created_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,last4=excluded.last4'
    ).run(name, r.ciphertext, r.last4, new Date().toISOString());
    return { ok: true, last4: r.last4 };
  }

  getCredentialLast4(name: string): string | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT last4 FROM credential WHERE name=?').get(name) as { last4: string | null } | undefined;
    return row ? row.last4 : null;
  }

  // 读凭据：不穿过存储保护态；解密失败返回错误，且不改动已存密文（未写库）。
  readCredential(name: string): CredentialReadResult {
    if (this.protectedState) return { ok: false, reason: 'unavailable' };
    if (!this.safeStorage || !isSecureSafeStorage(this.safeStorage)) return { ok: false, reason: 'unavailable' };
    const db = this.requireDb();
    const row = db.prepare('SELECT ciphertext FROM credential WHERE name=?').get(name) as { ciphertext: Buffer } | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    const u = new CredentialProtector(this.safeStorage).unprotect(row.ciphertext);
    if (!u.ok) return { ok: false, reason: 'decrypt_failed' };
    return { ok: true, plaintext: u.plaintext };
  }

  // 读取现有数据密钥（只读，绝不创建/替换）；无密钥返回 not_found。
  private readDataKey(): { ok: true; key: Buffer } | { ok: false; reason: 'unavailable' | 'decrypt_failed' | 'not_found' } {
    if (!this.safeStorage || !isSecureSafeStorage(this.safeStorage)) return { ok: false, reason: 'unavailable' };
    const db = this.requireDb();
    const row = db.prepare('SELECT wrapped FROM secure_key WHERE id=1').get() as { wrapped: Buffer } | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    const u = new DataKeyManager(this.safeStorage).unwrap(row.wrapped);
    return u.ok ? { ok: true, key: u.dataKey } : { ok: false, reason: 'decrypt_failed' };
  }

  // 确保数据密钥存在（仅写路径使用；不存在才创建，绝不替换已有密钥）。
  private ensureDataKey(): { ok: true; key: Buffer } | { ok: false; reason: 'unavailable' | 'decrypt_failed' } {
    if (!this.safeStorage || !isSecureSafeStorage(this.safeStorage)) return { ok: false, reason: 'unavailable' };
    const existing = this.readDataKey();
    if (existing.ok) return existing;
    if (existing.reason === 'decrypt_failed') return { ok: false, reason: 'decrypt_failed' }; // 有密钥但解不开：不替换
    const db = this.requireDb();
    const key = generateDataKey();
    const w = new DataKeyManager(this.safeStorage).wrap(key);
    if (!w.ok) return { ok: false, reason: 'unavailable' };
    db.prepare('INSERT INTO secure_key(id,wrapped,created_at) VALUES(1,?,?)').run(w.wrapped, new Date().toISOString());
    return { ok: true, key };
  }

  putSensitive(name: string, plaintext: string, aad: string): SensitiveResult<null> {
    this.assertWritable();
    const dk = this.ensureDataKey();
    if (!dk.ok) return { ok: false, reason: dk.reason };
    const blob = encryptSensitive(dk.key, plaintext, aad);
    const db = this.requireDb();
    db.prepare(
      'INSERT INTO sensitive(name,blob,aad,created_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET blob=excluded.blob,aad=excluded.aad'
    ).run(name, blob, aad, new Date().toISOString());
    return { ok: true, value: null };
  }

  // 读敏感数据：不穿过保护态；只读数据密钥（不自动创建/替换）；解密失败不覆盖原密文。
  getSensitive(name: string, aad: string): SensitiveResult<string> {
    if (this.protectedState) return { ok: false, reason: 'unavailable' };
    const dk = this.readDataKey();
    if (!dk.ok) return { ok: false, reason: dk.reason === 'decrypt_failed' ? 'decrypt_failed' : dk.reason === 'not_found' ? 'not_found' : 'unavailable' };
    const db = this.requireDb();
    const row = db.prepare('SELECT blob FROM sensitive WHERE name=?').get(name) as { blob: Buffer } | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    try {
      return { ok: true, value: decryptSensitive(dk.key, row.blob, aad) };
    } catch {
      return { ok: false, reason: 'decrypt_failed' }; // 认证失败：不覆盖原密文
    }
  }

  // 通用事务原语（供业务事件事务复用）：抛出即回滚，不改动已提交状态。
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
