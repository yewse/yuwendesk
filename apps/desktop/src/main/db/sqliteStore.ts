import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { LocalStore } from '../store';
import type {
  DraftCommitOp,
  DraftCommitResult,
  DraftState,
  ModelConfig,
  ModelJobRecord,
  SaveExpectResult,
  SourceClassification,
  SourceImportInput,
  SourceImportResult,
  SourceListItem,
  SourceFileImportInput,
  SourceLocator,
  SourceReadResult,
  SourceSearchHit,
  SourceVersionItem,
  StoreIo,
  WindowState
} from '../store';
import { DEFAULT_CLASSIFICATION, SOURCE_CLASSIFICATIONS, StoreProtectedError } from '../store';
import { extractBuffer, ExtractError, extractText, type CancelSignal, type ExtractOpts, type ExtractResult } from '../sources/extract';
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
  // 可注入的解析实现：生产可注入 worker 线程后端使耗时解析不阻塞主进程；缺省内联 extractBuffer。
  parseFile?: (buf: Buffer, format: string, opts: ExtractOpts) => Promise<ExtractResult>;
}

export type CredentialSetResult = { ok: true; last4: string } | { ok: false; reason: 'encryption_unavailable' };
export type CredentialReadResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: 'not_found' | 'decrypt_failed' | 'unavailable' };
export type SensitiveResult<T> = { ok: true; value: T } | { ok: false; reason: 'unavailable' | 'decrypt_failed' | 'not_found' };

const SOURCE_MAX_BYTES = 5_000_000; // 文本类导入上限
const SOURCE_FILE_MAX_BYTES = 40_000_000; // 原始文件（PDF/DOCX）导入上限

// 面向教师的可读定位标签。
function locatorLabel(loc: SourceLocator): string {
  switch (loc.kind) {
    case 'pdf_page':
      return `第 ${loc.page} 页`;
    case 'docx_paragraph':
      return `第 ${loc.paragraph} 段`;
    case 'docx_table_cell':
      return `表格${loc.table} 第${loc.row}行第${loc.col}列`;
    case 'xlsx_cell':
      return `${loc.sheet} R${loc.row}C${loc.col}`;
    case 'pptx_slide':
      return `第 ${loc.slide} 张幻灯片`;
    case 'csv_row':
      return `第 ${loc.row} 行`;
    default:
      return `第 ${loc.line} 行`;
  }
}
const SOURCE_PREVIEW_MAX = 8000;
const SEARCH_LIMIT = 30;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_document (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          classification     TEXT NOT NULL,          -- public_reference | licensed_reference | teacher_private | student_sensitive
          status             TEXT NOT NULL,          -- active | retired
          current_version_id TEXT,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_version (
          id           TEXT PRIMARY KEY,
          document_id  TEXT NOT NULL REFERENCES source_document(id),
          version      INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          byte_size    INTEGER NOT NULL,
          format       TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          UNIQUE(document_id, version)
        );
        CREATE TABLE IF NOT EXISTS source_text (
          version_id TEXT PRIMARY KEY REFERENCES source_version(id),
          full_text  TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(text, version_id UNINDEXED, tokenize='trigram');
      `);
    }
  },
  {
    version: 5,
    up: (db) => {
      // 原件哈希与文本哈希分开；结构化段与段级 FTS 支持按页/段落/表格单元格等精确定位。
      db.exec(`
        ALTER TABLE source_version ADD COLUMN original_hash TEXT;
        ALTER TABLE source_version ADD COLUMN text_hash TEXT;
        ALTER TABLE source_version ADD COLUMN mime TEXT;
        ALTER TABLE source_version ADD COLUMN scanned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE source_version ADD COLUMN reliable_text INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE IF NOT EXISTS source_file (
          version_id    TEXT PRIMARY KEY REFERENCES source_version(id),
          original_blob BLOB,
          original_hash TEXT NOT NULL,
          byte_size     INTEGER NOT NULL,
          mime          TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_segment (
          id           TEXT PRIMARY KEY,
          version_id   TEXT NOT NULL REFERENCES source_version(id),
          ordinal      INTEGER NOT NULL,
          locator_kind TEXT NOT NULL,
          locator      TEXT NOT NULL,
          text         TEXT NOT NULL,
          char_start   INTEGER NOT NULL,
          char_end     INTEGER NOT NULL,
          reliable     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_segment_version ON source_segment(version_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS source_seg_fts USING fts5(text, segment_id UNINDEXED, version_id UNINDEXED, tokenize='trigram');
      `);
    }
  },
  {
    version: 6,
    up: (db) => {
      // G04 模型配置与作业持久化（可配置服务商+实际模型 ID；记录模型/提示/参数/材料版本）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_config (
          id                INTEGER PRIMARY KEY CHECK (id = 1),
          provider          TEXT NOT NULL,
          model             TEXT NOT NULL,
          temperature       REAL NOT NULL,
          max_tokens        INTEGER NOT NULL,
          budget_cap_cents  INTEGER NOT NULL,
          allow_real_network INTEGER NOT NULL DEFAULT 0,
          updated_at        TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_job (
          id                    TEXT PRIMARY KEY,
          task                  TEXT NOT NULL,
          cache_key             TEXT NOT NULL,
          provider              TEXT NOT NULL,
          model                 TEXT NOT NULL,
          params_json           TEXT NOT NULL,
          prompt_version        TEXT NOT NULL,
          material_versions_json TEXT NOT NULL,
          status                TEXT NOT NULL,
          result_json           TEXT,
          cost_cents            INTEGER NOT NULL DEFAULT 0,
          error_code            TEXT,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_job_cache ON model_job(cache_key);
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
  private readonly parseFile: (buf: Buffer, format: string, opts: ExtractOpts) => Promise<ExtractResult>;
  private readonly cancelRegistry = new Map<string, CancelSignal>();

  constructor(userDataDir: string, opts: SqliteStoreOptions = {}) {
    this.dir = userDataDir;
    this.dbPath = join(userDataDir, 'yuwendesk.db');
    this.legacyJsonPath = join(userDataDir, 'yuwendesk-local-state.json');
    this.legacyIo = opts.legacyIo;
    this.archiveRename = opts.archiveRename ?? ((from, to) => fs.rename(from, to));
    this.safeStorage = opts.safeStorage;
    this.commitFaults = opts.commitFaults;
    this.parseFile = opts.parseFile ?? ((buf, format, o) => extractBuffer(buf, format, o));
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
      // 重启不确定态：上次未完成（running）的模型作业无法确定远端是否已执行 → 标记 uncertain，如实呈现。
      this.db
        .prepare("UPDATE model_job SET status='uncertain', updated_at=? WHERE status='running'")
        .run(new Date().toISOString());
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

  // ===== G03 资料导入 / 搜索 / 原文定位 =====

  // 导入文本类资料（txt/md/csv）：抽取为行/行段，走统一提交路径。
  importSource(input: SourceImportInput): SourceImportResult {
    if (input.content.length === 0) return { status: 'rejected', reason: 'empty' };
    if (Buffer.byteLength(input.content, 'utf8') > SOURCE_MAX_BYTES) return { status: 'rejected', reason: 'too_large' };
    const extracted = extractText(input.content, input.format);
    const originalBytes = Buffer.from(input.content, 'utf8');
    return this.commitParsedImport({
      title: input.title,
      format: input.format,
      classification: input.classification,
      relation: input.relation,
      targetDocumentId: input.targetDocumentId,
      extracted,
      originalBytes,
      mime: 'text/plain'
    });
  }

  cancelImport(jobId: string): boolean {
    const sig = this.cancelRegistry.get(jobId);
    if (!sig) return false;
    sig.cancelled = true;
    return true;
  }

  // 导入真实原始文件（PDF/DOCX/…）：保存原件字节、原件哈希与文本哈希分开、结构化段落定位。
  // 处理边界：完整读取前先做初步大小检查；解析施加限额/超时/取消；提交前复检取消，已取消任务不入库。
  async importFile(input: SourceFileImportInput): Promise<SourceImportResult> {
    // 初步大小检查（在完整解码/解析前）：base64 长度约为字节数的 4/3。
    const approxBytes = Math.floor((input.base64.length * 3) / 4);
    if (approxBytes === 0) return { status: 'rejected', reason: 'empty' };
    if (approxBytes > SOURCE_FILE_MAX_BYTES) return { status: 'rejected', reason: 'too_large' };
    let buf: Buffer;
    try {
      buf = Buffer.from(input.base64, 'base64');
    } catch {
      return { status: 'rejected', reason: 'empty' };
    }
    if (buf.length === 0) return { status: 'rejected', reason: 'empty' };
    if (buf.length > SOURCE_FILE_MAX_BYTES) return { status: 'rejected', reason: 'too_large' };

    const signal: CancelSignal = { cancelled: false };
    if (input.jobId) this.cancelRegistry.set(input.jobId, signal);
    let extracted: ExtractResult;
    try {
      extracted = await this.parseFile(buf, input.format, { signal });
    } catch (e) {
      if (input.jobId) this.cancelRegistry.delete(input.jobId);
      if (e instanceof ExtractError) {
        if (e.code === 'cancelled') return { status: 'cancelled' };
        if (e.code === 'too_many_pages' || e.code === 'too_many_entries' || e.code === 'too_large_text' || e.code === 'timeout')
          return { status: 'rejected', reason: 'limit_exceeded' };
        if (e.code === 'unsupported') return { status: 'rejected', reason: 'parse_failed' };
      }
      return { status: 'rejected', reason: 'parse_failed' }; // 无法解析：不落库
    }
    // 提交前复检取消：取消传播到提交边界，已取消任务不得静默入库。
    if (signal.cancelled) {
      if (input.jobId) this.cancelRegistry.delete(input.jobId);
      return { status: 'cancelled' };
    }
    if (input.jobId) this.cancelRegistry.delete(input.jobId);
    const mimeByFormat: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    const mime = mimeByFormat[input.format.toLowerCase()] ?? 'application/octet-stream';
    return this.commitParsedImport({
      title: input.title,
      format: extracted.format,
      classification: input.classification,
      relation: input.relation,
      targetDocumentId: input.targetDocumentId,
      extracted,
      originalBytes: buf,
      mime
    });
  }

  // 统一提交路径：严格分类、无条件阻止敏感、去重（按原件哈希）、版本关系需明确确认（不自动切换当前版本）。
  private commitParsedImport(p: {
    title: string;
    format: string;
    classification?: SourceClassification | string;
    relation?: 'new_version' | 'separate';
    targetDocumentId?: string;
    extracted: ExtractResult;
    originalBytes: Buffer;
    mime: string;
  }): SourceImportResult {
    this.assertWritable();
    const classification: SourceClassification =
      p.classification === undefined ? DEFAULT_CLASSIFICATION : (p.classification as SourceClassification);
    if (p.classification !== undefined && !SOURCE_CLASSIFICATIONS.includes(classification)) {
      return { status: 'rejected', reason: 'bad_classification' };
    }
    if (classification === 'student_sensitive') {
      return { status: 'blocked_sensitive', reason: 'not_implemented' };
    }
    const db = this.requireDb();
    const now = new Date().toISOString();
    const originalHash = createHash('sha256').update(p.originalBytes).digest('hex');
    const textHash = createHash('sha256').update(p.extracted.fullText, 'utf8').digest('hex');
    const byteSize = p.originalBytes.length;
    const scanned = p.extracted.scanned ? 1 : 0;
    const reliableText = p.extracted.reliableText ? 1 : 0;

    const addVersion = (documentId: string, makeCurrent: boolean, versionConflict: boolean): SourceImportResult => {
      const maxV = (db.prepare('SELECT COALESCE(MAX(version),0) m FROM source_version WHERE document_id=?').get(documentId) as { m: number }).m;
      const version = maxV + 1;
      const versionId = randomUUID();
      db.prepare(
        'INSERT INTO source_version(id,document_id,version,content_hash,byte_size,format,created_at,original_hash,text_hash,mime,scanned,reliable_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(versionId, documentId, version, textHash, byteSize, p.format, now, originalHash, textHash, p.mime, scanned, reliableText);
      db.prepare('INSERT INTO source_text(version_id,full_text) VALUES(?,?)').run(versionId, p.extracted.fullText);
      db.prepare('INSERT INTO source_file(version_id,original_blob,original_hash,byte_size,mime,created_at) VALUES(?,?,?,?,?,?)').run(
        versionId,
        p.originalBytes,
        originalHash,
        byteSize,
        p.mime,
        now
      );
      const insSeg = db.prepare(
        'INSERT INTO source_segment(id,version_id,ordinal,locator_kind,locator,text,char_start,char_end,reliable) VALUES(?,?,?,?,?,?,?,?,?)'
      );
      const insFts = db.prepare('INSERT INTO source_seg_fts(text,segment_id,version_id) VALUES(?,?,?)');
      for (const seg of p.extracted.segments) {
        const segId = randomUUID();
        insSeg.run(segId, versionId, seg.ordinal, seg.locatorKind, JSON.stringify(seg.locator), seg.text, seg.char_start, seg.char_end, seg.reliable ? 1 : 0);
        // 仅把可靠且非空文字入检索索引；扫描件空文本不参与（不伪造可靠文字）。
        if (seg.reliable && seg.text.trim().length > 0) insFts.run(seg.text, segId, versionId);
      }
      if (makeCurrent) {
        db.prepare('UPDATE source_document SET current_version_id=?, status=?, updated_at=? WHERE id=?').run(versionId, 'active', now, documentId);
      } else {
        db.prepare('UPDATE source_document SET updated_at=? WHERE id=?').run(now, documentId);
      }
      return { status: maxV === 0 ? 'imported' : 'new_version', documentId, versionId, version, contentHash: textHash, versionConflict };
    };
    const createDoc = (): string => {
      const documentId = randomUUID();
      db.prepare(
        'INSERT INTO source_document(id,title,classification,status,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
      ).run(documentId, p.title, classification, 'active', null, now, now);
      return documentId;
    };
    // 去重按原件哈希：同一原始文件重复导入 → duplicate。
    const dupInDoc = (documentId: string): { versionId: string; version: number } | undefined =>
      db.prepare('SELECT id versionId, version FROM source_version WHERE document_id=? AND original_hash=? ORDER BY version LIMIT 1').get(documentId, originalHash) as
        | { versionId: string; version: number }
        | undefined;

    const tx = db.transaction((): SourceImportResult => {
      if (p.relation === 'new_version' && p.targetDocumentId) {
        const doc = db.prepare('SELECT id FROM source_document WHERE id=?').get(p.targetDocumentId) as { id: string } | undefined;
        if (!doc) return { status: 'rejected', reason: 'empty' };
        const dup = dupInDoc(doc.id);
        if (dup) return { status: 'duplicate', documentId: doc.id, versionId: dup.versionId, version: dup.version, contentHash: textHash };
        return addVersion(doc.id, true, true);
      }
      if (p.relation === 'separate') {
        return addVersion(createDoc(), true, false);
      }
      const doc = db.prepare('SELECT id, current_version_id FROM source_document WHERE title=? ORDER BY created_at LIMIT 1').get(p.title) as
        | { id: string; current_version_id: string | null }
        | undefined;
      if (!doc) return addVersion(createDoc(), true, false);
      const dup = dupInDoc(doc.id);
      if (dup) return { status: 'duplicate', documentId: doc.id, versionId: dup.versionId, version: dup.version, contentHash: textHash };
      const cur = doc.current_version_id
        ? (db.prepare('SELECT version, original_hash FROM source_version WHERE id=?').get(doc.current_version_id) as { version: number; original_hash: string } | undefined)
        : undefined;
      return {
        status: 'needs_confirmation',
        contentHash: textHash,
        existing: { documentId: doc.id, title: p.title, currentVersion: cur?.version ?? 0, currentHash: cur?.original_hash ?? '' }
      };
    });
    return tx.immediate();
  }

  // 中文检索：≥3 字用 FTS5 trigram；1–2 字短词回退 LIKE（含标题）；命中定位到具体段（页/段落/表格单元格等），
  // 返回结构化 locator + 段内精确锚点/上下文。仅可靠文字段参与（扫描件无文字不命中）。
  searchSources(query: string): SourceSearchHit[] {
    if (!this.db || this.protectedState) return [];
    const db = this.db;
    const cps = [...query];
    if (cps.length === 0) return [];
    const activeCurrent = new Set(
      (db.prepare("SELECT current_version_id v FROM source_document WHERE status='active' AND current_version_id IS NOT NULL").all() as {
        v: string;
      }[]).map((r) => r.v)
    );
    // 正文候选段：≥3 字用段级 FTS；1–2 字段级 LIKE。仅可靠文字段。
    const bodySegIds: string[] = [];
    if (cps.length >= 3) {
      const rows = db.prepare('SELECT segment_id FROM source_seg_fts WHERE source_seg_fts MATCH ?').all(`"${query.replace(/"/g, '""')}"`) as {
        segment_id: string;
      }[];
      for (const r of rows) bodySegIds.push(r.segment_id);
    } else {
      const like = `%${likeEscape(query)}%`;
      for (const r of db.prepare("SELECT id FROM source_segment WHERE reliable=1 AND text LIKE ? ESCAPE '\\'").all(like) as { id: string }[])
        bodySegIds.push(r.id);
    }
    const hits: SourceSearchHit[] = [];
    const seenSeg = new Set<string>();
    for (const segId of bodySegIds) {
      if (seenSeg.has(segId)) continue;
      seenSeg.add(segId);
      const seg = db
        .prepare('SELECT version_id versionId, locator_kind locatorKind, locator, text, char_start charStart, reliable FROM source_segment WHERE id=?')
        .get(segId) as
        | { versionId: string; locatorKind: string; locator: string; text: string; charStart: number; reliable: number }
        | undefined;
      if (!seg || !activeCurrent.has(seg.versionId)) continue;
      const meta = db
        .prepare(
          'SELECT sv.version version, sv.document_id documentId, sd.title title, sd.classification classification FROM source_version sv JOIN source_document sd ON sd.id=sv.document_id WHERE sv.id=?'
        )
        .get(seg.versionId) as { version: number; documentId: string; title: string; classification: SourceClassification } | undefined;
      if (!meta) continue;
      const parsedLocator = { kind: seg.locatorKind, ...(JSON.parse(seg.locator) as Record<string, number | string>) } as SourceLocator;
      const idxInSeg = seg.text.indexOf(query);
      // 正文未定位到具体位置 → 不制造精确锚点（anchor=null），仍如实给出段定位与段文预览。
      const anchor =
        idxInSeg >= 0
          ? { char_start: seg.charStart + idxInSeg, char_end: seg.charStart + idxInSeg + query.length, line: typeof parsedLocator.line === 'number' ? parsedLocator.line : 0 }
          : null;
      const ctxAround = idxInSeg >= 0 ? seg.text.slice(Math.max(0, idxInSeg - 30), Math.min(seg.text.length, idxInSeg + query.length + 30)) : seg.text.slice(0, 80);
      hits.push({
        documentId: meta.documentId,
        title: meta.title,
        version: meta.version,
        versionId: seg.versionId,
        classification: meta.classification,
        anchor,
        context: ctxAround,
        locator: parsedLocator,
        reliable: seg.reliable === 1,
        locatorLabel: locatorLabel(parsedLocator),
        matchKind: 'body'
      });
      if (hits.length >= SEARCH_LIMIT) break;
    }
    // 标题命中：与正文命中分开，不制造正文锚点/定位。
    const likeT = `%${likeEscape(query)}%`;
    const titleDocs = db
      .prepare(
        `SELECT sd.id documentId, sd.title title, sd.classification classification, sv.version version, sd.current_version_id versionId
         FROM source_document sd JOIN source_version sv ON sv.id=sd.current_version_id
         WHERE sd.status='active' AND sd.title LIKE ? ESCAPE '\\'`
      )
      .all(likeT) as { documentId: string; title: string; classification: SourceClassification; version: number; versionId: string }[];
    const seenDocTitle = new Set(hits.filter((h) => h.matchKind === 'title').map((h) => h.documentId));
    for (const d of titleDocs) {
      if (seenDocTitle.has(d.documentId)) continue;
      seenDocTitle.add(d.documentId);
      hits.push({
        documentId: d.documentId,
        title: d.title,
        version: d.version,
        versionId: d.versionId,
        classification: d.classification,
        anchor: null,
        context: d.title,
        locator: null,
        reliable: true,
        locatorLabel: '标题命中',
        matchKind: 'title'
      });
      if (hits.length >= SEARCH_LIMIT) break;
    }
    return hits;
  }

  // 原文查看：给定跨度返回定位文本；否则返回受限预览。
  readSource(versionId: string, charStart?: number, charEnd?: number): SourceReadResult | null {
    if (!this.db) return null;
    const db = this.db;
    const meta = db
      .prepare(
        'SELECT sv.version version, sd.title title FROM source_version sv JOIN source_document sd ON sd.id=sv.document_id WHERE sv.id=?'
      )
      .get(versionId) as { version: number; title: string } | undefined;
    if (!meta) return null;
    const textRow = db.prepare('SELECT full_text FROM source_text WHERE version_id=?').get(versionId) as { full_text: string } | undefined;
    if (!textRow) return null;
    const full = textRow.full_text;
    if (typeof charStart === 'number' && typeof charEnd === 'number' && charStart >= 0 && charEnd >= charStart) {
      const s = Math.max(0, charStart - 40);
      const e = Math.min(full.length, charEnd + 40);
      return { title: meta.title, version: meta.version, text: full.slice(s, e), char_start: charStart, char_end: charEnd, truncated: false };
    }
    return {
      title: meta.title,
      version: meta.version,
      text: full.slice(0, SOURCE_PREVIEW_MAX),
      char_start: null,
      char_end: null,
      truncated: full.length > SOURCE_PREVIEW_MAX
    };
  }

  retireSource(documentId: string): boolean {
    this.assertWritable();
    const db = this.requireDb();
    const info = db.prepare("UPDATE source_document SET status='retired', updated_at=? WHERE id=?").run(new Date().toISOString(), documentId);
    return info.changes === 1;
  }

  // 原件核对：返回原件字节 base64 + 原件哈希（供外部重算校验，提取成功≠原文已核验）。
  readOriginal(versionId: string): { base64: string; originalHash: string; byteSize: number; mime: string } | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT original_blob blob, original_hash originalHash, byte_size byteSize, mime FROM source_file WHERE version_id=?').get(versionId) as
      | { blob: Buffer | null; originalHash: string; byteSize: number; mime: string | null }
      | undefined;
    if (!row || !row.blob) return null;
    return { base64: Buffer.from(row.blob).toString('base64'), originalHash: row.originalHash, byteSize: row.byteSize, mime: row.mime ?? 'application/octet-stream' };
  }

  // 精确区间读取：仅返回 full_text[charStart, charEnd)（无 padding），供模型上下文严格按授权区间使用。
  readExactRange(versionId: string, charStart: number, charEnd: number): { text: string; fullLength: number } | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT full_text FROM source_text WHERE version_id=?').get(versionId) as { full_text: string } | undefined;
    if (!row) return null;
    const full = row.full_text;
    const s = Math.max(0, charStart);
    const e = Math.min(full.length, Math.max(s, charEnd));
    return { text: full.slice(s, e), fullLength: full.length };
  }

  getVersionMeta(versionId: string): import('../store').SourceVersionMeta | null {
    if (!this.db) return null;
    const r = this.db
      .prepare(
        `SELECT sv.document_id documentId, sd.title title, sv.version version, sd.classification classification, sd.status status,
                sd.current_version_id currentVersionId, COALESCE(sv.text_hash, sv.content_hash) textHash
         FROM source_version sv JOIN source_document sd ON sd.id=sv.document_id WHERE sv.id=?`
      )
      .get(versionId) as
      | { documentId: string; title: string; version: number; classification: SourceClassification; status: string; currentVersionId: string | null; textHash: string }
      | undefined;
    if (!r) return null;
    return {
      documentId: r.documentId,
      title: r.title,
      version: r.version,
      classification: r.classification,
      status: r.status,
      isCurrent: r.currentVersionId === versionId,
      textHash: r.textHash
    };
  }

  getSourceVersions(documentId: string): SourceVersionItem[] {
    if (!this.db) return [];
    const cur = (this.db.prepare('SELECT current_version_id v FROM source_document WHERE id=?').get(documentId) as { v: string | null } | undefined)?.v ?? null;
    return (
      this.db
        .prepare(
          `SELECT id versionId, version, content_hash contentHash, COALESCE(original_hash,content_hash) originalHash,
                  COALESCE(text_hash,content_hash) textHash, format,
                  COALESCE(scanned,0) scanned, COALESCE(reliable_text,1) reliableText, created_at createdAt
           FROM source_version WHERE document_id=? ORDER BY version`
        )
        .all(documentId) as (Omit<SourceVersionItem, 'isCurrent' | 'scanned' | 'reliableText'> & { scanned: number; reliableText: number })[]
    ).map((v) => ({ ...v, scanned: v.scanned === 1, reliableText: v.reliableText === 1, isCurrent: v.versionId === cur }));
  }

  // ===== G04 模型配置/作业持久化 =====
  getModelConfig(): ModelConfig | null {
    if (!this.db) return null;
    const r = this.db.prepare('SELECT provider, model, temperature, max_tokens maxTokens, budget_cap_cents budgetCapCents, allow_real_network allowRealNetwork, updated_at updatedAt FROM model_config WHERE id=1').get() as
      | (Omit<ModelConfig, 'allowRealNetwork'> & { allowRealNetwork: number })
      | undefined;
    return r ? { ...r, allowRealNetwork: r.allowRealNetwork === 1 } : null;
  }
  setModelConfig(cfg: ModelConfig): void {
    this.assertWritable();
    this.requireDb()
      .prepare(
        `INSERT INTO model_config(id,provider,model,temperature,max_tokens,budget_cap_cents,allow_real_network,updated_at)
         VALUES(1,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,temperature=excluded.temperature,
           max_tokens=excluded.max_tokens,budget_cap_cents=excluded.budget_cap_cents,allow_real_network=excluded.allow_real_network,updated_at=excluded.updated_at`
      )
      .run(cfg.provider, cfg.model, cfg.temperature, cfg.maxTokens, cfg.budgetCapCents, cfg.allowRealNetwork ? 1 : 0, cfg.updatedAt);
  }
  // 预算预留与结算：running 保留预留额、succeeded 结算实际额、uncertain/failed 保留已发生额；cancelled 不计。
  // 不以“调用失败”直接认定未计费——只有明确未发生（成本置 0）才不计。
  budgetSpentCents(): number {
    if (!this.db) return 0;
    return (this.db.prepare("SELECT COALESCE(SUM(cost_cents),0) c FROM model_job WHERE status != 'cancelled'").get() as { c: number }).c;
  }
  private mapJob(r: Record<string, unknown>): ModelJobRecord {
    return {
      id: String(r.id),
      task: String(r.task),
      cacheKey: String(r.cacheKey),
      provider: String(r.provider),
      model: String(r.model),
      paramsJson: String(r.paramsJson),
      promptVersion: String(r.promptVersion),
      materialVersionsJson: String(r.materialVersionsJson),
      status: r.status as ModelJobRecord['status'],
      resultJson: (r.resultJson as string | null) ?? null,
      costCents: Number(r.costCents),
      errorCode: (r.errorCode as string | null) ?? null,
      createdAt: String(r.createdAt),
      updatedAt: String(r.updatedAt)
    };
  }
  private readonly jobCols =
    'id, task, cache_key cacheKey, provider, model, params_json paramsJson, prompt_version promptVersion, material_versions_json materialVersionsJson, status, result_json resultJson, cost_cents costCents, error_code errorCode, created_at createdAt, updated_at updatedAt';
  findCachedJob(cacheKey: string): ModelJobRecord | null {
    if (!this.db) return null;
    const r = this.db.prepare(`SELECT ${this.jobCols} FROM model_job WHERE cache_key=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1`).get(cacheKey) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapJob(r) : null;
  }
  insertModelJob(job: ModelJobRecord): void {
    this.assertWritable();
    this.requireDb()
      .prepare(
        `INSERT INTO model_job(id,task,cache_key,provider,model,params_json,prompt_version,material_versions_json,status,result_json,cost_cents,error_code,created_at,updated_at)
         VALUES(@id,@task,@cacheKey,@provider,@model,@paramsJson,@promptVersion,@materialVersionsJson,@status,@resultJson,@costCents,@errorCode,@createdAt,@updatedAt)`
      )
      .run(job);
  }
  updateModelJob(id: string, patch: Partial<ModelJobRecord>): void {
    this.assertWritable();
    const cur = this.getModelJob(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.requireDb()
      .prepare('UPDATE model_job SET status=?, result_json=?, cost_cents=?, error_code=?, updated_at=? WHERE id=?')
      .run(next.status, next.resultJson, next.costCents, next.errorCode, next.updatedAt, id);
  }
  getModelJob(id: string): ModelJobRecord | null {
    if (!this.db) return null;
    const r = this.db.prepare(`SELECT ${this.jobCols} FROM model_job WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapJob(r) : null;
  }
  listModelJobs(limit: number): ModelJobRecord[] {
    if (!this.db) return [];
    return (this.db.prepare(`SELECT ${this.jobCols} FROM model_job ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => this.mapJob(r));
  }

  listSources(): SourceListItem[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT sd.id documentId, sd.title title, sd.classification classification, sd.status status,
                sv.version version, sv.content_hash contentHash
         FROM source_document sd LEFT JOIN source_version sv ON sv.id=sd.current_version_id
         ORDER BY sd.updated_at DESC`
      )
      .all() as SourceListItem[];
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
