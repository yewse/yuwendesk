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
import {
  DEFAULT_CLASSIFICATION,
  LessonChangeConflictError,
  LessonChangeKeyReuseError,
  SOURCE_CLASSIFICATIONS,
  StoreProtectedError
} from '../store';
import { validateReviewReport } from '../review/review';
import type { ReviewReport } from '../review/types';
import { validateChangeProposal } from '../change/change';
import type { ChangeProposal, LessonChange } from '../change/types';
import {
  FeedbackKeyReuseError,
  FeedbackSourceMissingError,
  FeedbackVersionConflictError,
  type AddObservationInput,
  type DeleteObservationInput,
  type FeedbackHistory,
  type FeedbackKnowledgeState,
  type FeedbackWriteResult,
  type ObservationDeleteResult,
  type ObservationRecord,
  type RecordTeachingInput,
  type TeachingEvent
} from '../feedback/types';
import { validateTeachingEvent } from '../feedback/teaching';
import { validateObservation, validateObservationOutcome } from '../feedback/observation';
import { isBoundedString, isIsoDateTime, isRecord } from '../feedback/validation';
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

// 仅供 G07 原子提交测试使用；每个钩子位于一个明确的 SQLite 事务边界内。
export interface LessonChangeCommitFaultHooks {
  beforeRevisionInsert?: () => void;
  afterRevisionInsert?: () => void;
  afterBundleInsert?: () => void;
  afterArtifactInsert?: () => void;
  beforeCurrentPointerUpdate?: () => void;
  beforeIdempotencySuccess?: () => void;
}

// 仅供 G08 反馈事务回滚测试使用；生产不配置。
export interface FeedbackCommitFaultHooks {
  afterObservationInsert?: () => void;
  afterObservationDelete?: () => void;
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
  // G07 测试用课时修改事务故障注入；生产不配置。
  lessonChangeFaults?: LessonChangeCommitFaultHooks;
  // G08 测试用观察写入/删除事务故障注入；生产不配置。
  feedbackFaults?: FeedbackCommitFaultHooks;
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

function parseObservationRecord(value: unknown, context: string): ObservationRecord {
  if (!isRecord(value) || typeof value.teachingEventId !== 'string') {
    throw new StoreProtectedError(`${context}:record`);
  }
  const observationErrors = validateObservation(value.observation);
  const outcomeErrors = validateObservationOutcome(value.outcome);
  if (observationErrors.length || outcomeErrors.length) {
    throw new StoreProtectedError(`${context}:${[...observationErrors, ...outcomeErrors].join('|')}`);
  }
  const record = value as unknown as ObservationRecord;
  if (record.observation.observation_id !== record.outcome.observation_id) {
    throw new StoreProtectedError(`${context}:identity`);
  }
  return record;
}

function parseObservationDeleteResult(value: unknown, context: string): ObservationDeleteResult {
  if (
    !isRecord(value) ||
    typeof value.observationId !== 'string' ||
    typeof value.planId !== 'string' ||
    !isIsoDateTime(value.deletedAt) ||
    !Array.isArray(value.backupScopesNotCovered) ||
    value.backupScopesNotCovered.some((item) => typeof item !== 'string')
  ) {
    throw new StoreProtectedError(`${context}:result`);
  }
  return value as unknown as ObservationDeleteResult;
}

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
  },
  {
    version: 7,
    up: (db) => {
      // G05 完整课时计划持久化（含修订链与内容来源身份）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS lesson_plan (
          plan_id            TEXT PRIMARY KEY,
          current_revision_id TEXT,
          title              TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lesson_revision (
          revision_id          TEXT PRIMARY KEY,
          plan_id              TEXT NOT NULL,
          previous_revision_id TEXT,
          title                TEXT NOT NULL,
          content_json         TEXT NOT NULL,
          content_origin       TEXT NOT NULL,
          valid                INTEGER NOT NULL,
          created_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revision_plan ON lesson_revision(plan_id);
      `);
    }
  },
  {
    version: 8,
    up: (db) => {
      // G06 成品清单（版本一致记录：某修订产出哪些文件及其哈希与内容来源）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS material_artifact (
          id             TEXT PRIMARY KEY,
          plan_id        TEXT NOT NULL,
          revision_id    TEXT NOT NULL,
          role           TEXT NOT NULL,
          format         TEXT NOT NULL,
          filename       TEXT NOT NULL,
          path           TEXT NOT NULL,
          sha256         TEXT NOT NULL,
          byte_size      INTEGER NOT NULL,
          content_origin TEXT NOT NULL,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_plan ON material_artifact(plan_id, revision_id);
      `);
    }
  },
  {
    version: 9,
    up: (db) => {
      // G07 审查、一处修改与成品包：一次建齐表，后续工作包不再拆分数据库结构。
      db.exec(`
        CREATE TABLE review_report (
          report_id    TEXT PRIMARY KEY,
          plan_id      TEXT NOT NULL,
          revision_id  TEXT NOT NULL,
          report_json  TEXT NOT NULL,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_review_revision ON review_report(plan_id, revision_id, created_at);

        CREATE TABLE change_proposal (
          change_id             TEXT PRIMARY KEY,
          plan_id               TEXT NOT NULL,
          base_revision_id      TEXT NOT NULL,
          candidate_revision_id TEXT,
          change_kind           TEXT NOT NULL,
          proposal_json         TEXT NOT NULL,
          status                TEXT NOT NULL,
          created_at            TEXT NOT NULL,
          accepted_at           TEXT
        );

        CREATE TABLE material_bundle (
          bundle_id              TEXT PRIMARY KEY,
          plan_id                TEXT NOT NULL,
          revision_id            TEXT NOT NULL,
          presentation_spec_hash TEXT NOT NULL,
          directory              TEXT NOT NULL,
          status                 TEXT NOT NULL,
          created_at             TEXT NOT NULL
        );
        ALTER TABLE material_artifact ADD COLUMN bundle_id TEXT;

        CREATE TABLE lesson_change_idempotency (
          key           TEXT PRIMARY KEY,
          fingerprint   TEXT NOT NULL,
          status        TEXT NOT NULL,
          result_json   TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0,
          error_code    TEXT,
          updated_at    TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 10,
    up: (db) => {
      // G08 反馈、归因与纠正：先一次建齐结构；各工作包只开放已实现的行为。
      db.exec(`
        CREATE TABLE feedback_stream (
          plan_id      TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          revision     INTEGER NOT NULL DEFAULT 0,
          updated_at   TEXT NOT NULL
        );
        CREATE TABLE teaching_event (
          event_id         TEXT PRIMARY KEY,
          workspace_id     TEXT NOT NULL,
          plan_id          TEXT NOT NULL,
          plan_revision_id TEXT NOT NULL,
          event_json       TEXT NOT NULL,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX idx_teaching_plan ON teaching_event(workspace_id, plan_id, created_at);
        CREATE TABLE learning_observation (
          observation_id   TEXT PRIMARY KEY,
          workspace_id     TEXT NOT NULL,
          plan_id          TEXT NOT NULL,
          teaching_event_id TEXT NOT NULL,
          observation_json TEXT NOT NULL,
          created_at       TEXT NOT NULL
        );
        CREATE TABLE observation_outcome (
          observation_id TEXT PRIMARY KEY,
          outcome_json   TEXT NOT NULL
        );
        CREATE TABLE observation_tombstone (
          observation_id  TEXT PRIMARY KEY,
          workspace_id    TEXT NOT NULL,
          plan_id         TEXT NOT NULL,
          deleted_at      TEXT NOT NULL,
          backup_scope_json TEXT NOT NULL
        );
        CREATE TABLE measurement_review (
          review_id         TEXT PRIMARY KEY,
          workspace_id      TEXT NOT NULL,
          plan_id           TEXT NOT NULL,
          teaching_event_id TEXT NOT NULL,
          review_json       TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE TABLE attribution_run (
          run_id            TEXT PRIMARY KEY,
          workspace_id      TEXT NOT NULL,
          plan_id           TEXT NOT NULL,
          teaching_event_id TEXT NOT NULL,
          input_hash        TEXT NOT NULL,
          status            TEXT NOT NULL,
          result_json       TEXT,
          model_job_id      TEXT,
          content_origin    TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE TABLE correction_proposal (
          proposal_id   TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          plan_id       TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          state_revision INTEGER NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE TABLE preference_event (
          event_id      TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          plan_id       TEXT NOT NULL,
          proposal_id   TEXT NOT NULL,
          event_json    TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE TABLE effect_evidence_event (
          event_id      TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          plan_id       TEXT NOT NULL,
          proposal_id   TEXT NOT NULL,
          event_json    TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE TABLE feedback_idempotency (
          key         TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          operation   TEXT NOT NULL,
          status      TEXT NOT NULL,
          result_json TEXT,
          updated_at  TEXT NOT NULL
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
  private readonly lessonChangeFaults?: LessonChangeCommitFaultHooks;
  private readonly feedbackFaults?: FeedbackCommitFaultHooks;
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
    this.lessonChangeFaults = opts.lessonChangeFaults;
    this.feedbackFaults = opts.feedbackFaults;
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

  // ===== G05 课时计划持久化 =====
  saveLessonRevision(rec: import('../store').LessonRevisionRecord, makeCurrent: boolean): void {
    this.assertWritable();
    const db = this.requireDb();
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO lesson_revision(revision_id,plan_id,previous_revision_id,title,content_json,content_origin,valid,created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(rec.revisionId, rec.planId, rec.previousRevisionId, rec.title, rec.contentJson, rec.contentOrigin, rec.valid ? 1 : 0, rec.createdAt || now);
      const exists = db.prepare('SELECT 1 FROM lesson_plan WHERE plan_id=?').get(rec.planId);
      if (exists) {
        if (makeCurrent) db.prepare('UPDATE lesson_plan SET current_revision_id=?, title=?, updated_at=? WHERE plan_id=?').run(rec.revisionId, rec.title, now, rec.planId);
        else db.prepare('UPDATE lesson_plan SET updated_at=? WHERE plan_id=?').run(now, rec.planId);
      } else {
        db.prepare('INSERT INTO lesson_plan(plan_id,current_revision_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(rec.planId, makeCurrent ? rec.revisionId : null, rec.title, now, now);
      }
    });
    tx.immediate();
  }
  getLessonRevision(planId: string, revisionId?: string): import('../store').LessonRevisionRecord | null {
    if (!this.db) return null;
    const rid = revisionId ?? (this.db.prepare('SELECT current_revision_id r FROM lesson_plan WHERE plan_id=?').get(planId) as { r: string | null } | undefined)?.r;
    if (!rid) return null;
    const row = this.db
      .prepare('SELECT revision_id revisionId, plan_id planId, previous_revision_id previousRevisionId, title, content_json contentJson, content_origin contentOrigin, valid, created_at createdAt FROM lesson_revision WHERE revision_id=?')
      .get(rid) as (Omit<import('../store').LessonRevisionRecord, 'valid'> & { valid: number }) | undefined;
    return row ? { ...row, valid: row.valid === 1 } : null;
  }
  listLessonPlans(): import('../store').LessonPlanListItem[] {
    if (!this.db) return [];
    return this.db.prepare('SELECT plan_id planId, title, current_revision_id currentRevisionId, updated_at updatedAt FROM lesson_plan ORDER BY updated_at DESC').all() as import('../store').LessonPlanListItem[];
  }
  saveMaterialArtifacts(recs: import('../store').MaterialArtifactRecord[]): void {
    this.assertWritable();
    const db = this.requireDb();
    const ins = db.prepare('INSERT INTO material_artifact(id,plan_id,revision_id,role,format,filename,path,sha256,byte_size,content_origin,created_at,bundle_id) VALUES(@id,@planId,@revisionId,@role,@format,@filename,@path,@sha256,@byteSize,@contentOrigin,@createdAt,@bundleId)');
    const tx = db.transaction(() => {
      for (const r of recs) ins.run({ ...r, bundleId: r.bundleId ?? null });
    });
    tx.immediate();
  }
  listMaterialArtifacts(planId: string, revisionId?: string): import('../store').MaterialArtifactRecord[] {
    if (!this.db) return [];
    const rows = revisionId
      ? this.db.prepare('SELECT id,plan_id planId,revision_id revisionId,role,format,filename,path,sha256,byte_size byteSize,content_origin contentOrigin,created_at createdAt,bundle_id bundleId FROM material_artifact WHERE plan_id=? AND revision_id=? ORDER BY created_at').all(planId, revisionId)
      : this.db.prepare('SELECT id,plan_id planId,revision_id revisionId,role,format,filename,path,sha256,byte_size byteSize,content_origin contentOrigin,created_at createdAt,bundle_id bundleId FROM material_artifact WHERE plan_id=? ORDER BY created_at').all(planId);
    return (rows as import('../store').MaterialArtifactRecord[]).map((row) => {
      if (row.bundleId !== null) return row;
      const legacy = { ...row };
      delete legacy.bundleId;
      return legacy;
    });
  }

  // ===== G07 审查报告持久化 =====
  saveReviewReport(rec: import('../store').ReviewReportRecord): void {
    this.assertWritable();
    const errors = validateReviewReport(rec.report);
    if (errors.length) throw new Error(`invalid_review_report:${errors.join('|')}`);
    this.requireDb()
      .prepare(
        `INSERT INTO review_report(report_id,plan_id,revision_id,report_json,created_at)
         VALUES(@reportId,@planId,@revisionId,@reportJson,@createdAt)`
      )
      .run({
        reportId: rec.reportId,
        planId: rec.planId,
        revisionId: rec.revisionId,
        reportJson: JSON.stringify(rec.report),
        createdAt: rec.createdAt
      });
  }

  getLatestReviewReport(planId: string, revisionId: string): import('../store').ReviewReportRecord | null {
    if (!this.db) return null;
    const row = this.db
      .prepare(
        `SELECT report_id reportId, plan_id planId, revision_id revisionId, report_json reportJson, created_at createdAt
         FROM review_report WHERE plan_id=? AND revision_id=? ORDER BY created_at DESC, report_id DESC LIMIT 1`
      )
      .get(planId, revisionId) as
      | { reportId: string; planId: string; revisionId: string; reportJson: string; createdAt: string }
      | undefined;
    if (!row) return null;
    let report: unknown;
    try {
      report = JSON.parse(row.reportJson);
    } catch {
      throw new Error(`invalid_stored_review_report:${row.reportId}:json`);
    }
    const errors = validateReviewReport(report);
    if (errors.length) throw new Error(`invalid_stored_review_report:${row.reportId}:${errors.join('|')}`);
    return {
      reportId: row.reportId,
      planId: row.planId,
      revisionId: row.revisionId,
      report: report as ReviewReport,
      createdAt: row.createdAt
    };
  }

  findLessonChangeIdempotency(key: string): import('../store').LessonChangeIdempotencyRecord | null {
    if (!this.db) return null;
    return (
      (this.db
        .prepare(
          `SELECT key,fingerprint,status,result_json resultJson,failure_count failureCount,
                  error_code errorCode,updated_at updatedAt
           FROM lesson_change_idempotency WHERE key=?`
        )
        .get(key) as import('../store').LessonChangeIdempotencyRecord | undefined) ?? null
    );
  }

  recordLessonChangeFailure(
    key: string,
    fingerprint: string,
    errorCode: string,
    updatedAt = new Date().toISOString()
  ): number {
    this.assertWritable();
    const db = this.requireDb();
    const tx = db.transaction(() => {
      const existing = this.findLessonChangeIdempotency(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new LessonChangeKeyReuseError();
        if (existing.status === 'succeeded' || existing.status === 'failed_final') return existing.failureCount;
        const failureCount = Math.min(existing.failureCount + 1, 3);
        const status = failureCount >= 3 ? 'failed_final' : 'failed';
        db.prepare(
          `UPDATE lesson_change_idempotency
           SET status=?,result_json=NULL,failure_count=?,error_code=?,updated_at=? WHERE key=?`
        ).run(status, failureCount, errorCode, updatedAt, key);
      } else {
        db.prepare(
          `INSERT INTO lesson_change_idempotency(key,fingerprint,status,result_json,failure_count,error_code,updated_at)
           VALUES(?,?, 'failed', NULL,1,?,?)`
        ).run(key, fingerprint, errorCode, updatedAt);
      }
      return this.findLessonChangeIdempotency(key)!.failureCount;
    });
    return tx.immediate();
  }

  getLessonChangeAttempt(key: string, fingerprint: string): { failureCount: number; status: string } | null {
    const existing = this.findLessonChangeIdempotency(key);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw new LessonChangeKeyReuseError();
    return { failureCount: existing.failureCount, status: existing.status };
  }

  commitMaterialBundle(input: import('../store').MaterialBundleCommitInput): void {
    this.assertWritable();
    if (input.artifacts.length !== 5) throw new Error('material_bundle_requires_five_artifacts');
    const reviewErrors = validateReviewReport(input.review.report);
    if (reviewErrors.length) throw new Error(`invalid_review_report:${reviewErrors.join('|')}`);
    if (
      input.review.planId !== input.bundle.planId ||
      input.review.revisionId !== input.bundle.revisionId ||
      input.artifacts.some(
        (artifact) =>
          artifact.planId !== input.bundle.planId ||
          artifact.revisionId !== input.bundle.revisionId ||
          artifact.bundleId !== input.bundle.bundleId
      )
    ) {
      throw new Error('material_bundle_record_mismatch');
    }
    const db = this.requireDb();
    const tx = db.transaction(() => {
      const current = db
        .prepare('SELECT current_revision_id currentRevisionId FROM lesson_plan WHERE plan_id=?')
        .get(input.bundle.planId) as { currentRevisionId: string | null } | undefined;
      if (!current || current.currentRevisionId !== input.bundle.revisionId) throw new LessonChangeConflictError();
      db.prepare(
        `INSERT INTO material_bundle(bundle_id,plan_id,revision_id,presentation_spec_hash,directory,status,created_at)
         VALUES(@bundleId,@planId,@revisionId,@presentationSpecHash,@directory,@status,@createdAt)`
      ).run(input.bundle);
      const artifactInsert = db.prepare(
        `INSERT INTO material_artifact(id,plan_id,revision_id,role,format,filename,path,sha256,byte_size,content_origin,created_at,bundle_id)
         VALUES(@id,@planId,@revisionId,@role,@format,@filename,@path,@sha256,@byteSize,@contentOrigin,@createdAt,@bundleId)`
      );
      for (const artifact of input.artifacts) artifactInsert.run(artifact);
      db.prepare(
        `INSERT INTO review_report(report_id,plan_id,revision_id,report_json,created_at)
         VALUES(@reportId,@planId,@revisionId,@reportJson,@createdAt)`
      ).run({
        reportId: input.review.reportId,
        planId: input.review.planId,
        revisionId: input.review.revisionId,
        reportJson: JSON.stringify(input.review.report),
        createdAt: input.review.createdAt
      });
    });
    tx.immediate();
  }

  commitLessonChange(input: import('../store').LessonChangeCommitInput): import('../store').LessonChangeApplyResult {
    this.assertWritable();
    if (input.artifacts.length !== 5) throw new Error('lesson_change_requires_five_artifacts');
    if (input.proposal.status !== 'accepted' || input.proposal.proposal.status !== 'accepted') {
      throw new Error('lesson_change_proposal_not_accepted');
    }
    const proposalErrors = validateChangeProposal(input.proposal.proposal);
    if (proposalErrors.length) throw new Error(`invalid_change_proposal:${proposalErrors.join('|')}`);
    const reviewErrors = validateReviewReport(input.report.report);
    if (reviewErrors.length) throw new Error(`invalid_review_report:${reviewErrors.join('|')}`);
    if (
      input.bundle.planId !== input.result.planId ||
      input.bundle.revisionId !== input.result.revisionId ||
      input.bundle.bundleId !== input.result.bundleId ||
      input.artifacts.some(
        (artifact) =>
          artifact.planId !== input.result.planId ||
          artifact.revisionId !== input.result.revisionId ||
          artifact.bundleId !== input.result.bundleId
      )
    ) {
      throw new Error('lesson_change_record_mismatch');
    }

    const db = this.requireDb();
    const tx = db.transaction((): import('../store').LessonChangeApplyResult => {
      const existing = this.findLessonChangeIdempotency(input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new LessonChangeKeyReuseError();
        if (existing.status === 'succeeded' && existing.resultJson) {
          return JSON.parse(existing.resultJson) as import('../store').LessonChangeApplyResult;
        }
        if (existing.status !== 'failed') throw new LessonChangeConflictError();
      }

      const current = db
        .prepare('SELECT current_revision_id currentRevisionId FROM lesson_plan WHERE plan_id=?')
        .get(input.result.planId) as { currentRevisionId: string | null } | undefined;
      if (!current || current.currentRevisionId !== input.baseRevisionId) throw new LessonChangeConflictError();

      if (input.revision) {
        if (
          input.revision.planId !== input.result.planId ||
          input.revision.revisionId !== input.result.revisionId ||
          input.revision.previousRevisionId !== input.baseRevisionId
        ) {
          throw new Error('lesson_change_revision_mismatch');
        }
        this.lessonChangeFaults?.beforeRevisionInsert?.();
        db.prepare(
          `INSERT INTO lesson_revision(revision_id,plan_id,previous_revision_id,title,content_json,content_origin,valid,created_at)
           VALUES(@revisionId,@planId,@previousRevisionId,@title,@contentJson,@contentOrigin,@valid,@createdAt)`
        ).run({ ...input.revision, valid: input.revision.valid ? 1 : 0 });
        this.lessonChangeFaults?.afterRevisionInsert?.();
      } else if (input.result.revisionId !== input.baseRevisionId) {
        throw new Error('lesson_change_presentation_revision_mismatch');
      }

      db.prepare(
        `INSERT INTO material_bundle(bundle_id,plan_id,revision_id,presentation_spec_hash,directory,status,created_at)
         VALUES(@bundleId,@planId,@revisionId,@presentationSpecHash,@directory,@status,@createdAt)`
      ).run(input.bundle);
      this.lessonChangeFaults?.afterBundleInsert?.();
      const artifactInsert = db.prepare(
        `INSERT INTO material_artifact(id,plan_id,revision_id,role,format,filename,path,sha256,byte_size,content_origin,created_at,bundle_id)
         VALUES(@id,@planId,@revisionId,@role,@format,@filename,@path,@sha256,@byteSize,@contentOrigin,@createdAt,@bundleId)`
      );
      for (const artifact of input.artifacts) artifactInsert.run(artifact);
      this.lessonChangeFaults?.afterArtifactInsert?.();

      db.prepare(
        `INSERT INTO review_report(report_id,plan_id,revision_id,report_json,created_at)
         VALUES(@reportId,@planId,@revisionId,@reportJson,@createdAt)`
      ).run({
        reportId: input.report.reportId,
        planId: input.report.planId,
        revisionId: input.report.revisionId,
        reportJson: JSON.stringify(input.report.report),
        createdAt: input.report.createdAt
      });
      db.prepare(
        `INSERT INTO change_proposal(change_id,plan_id,base_revision_id,candidate_revision_id,change_kind,proposal_json,status,created_at,accepted_at)
         VALUES(@changeId,@planId,@baseRevisionId,@candidateRevisionId,@changeKind,@proposalJson,@status,@createdAt,@acceptedAt)`
      ).run({
        ...input.proposal,
        proposalJson: JSON.stringify(input.proposal.proposal)
      });

      if (input.revision) {
        this.lessonChangeFaults?.beforeCurrentPointerUpdate?.();
        const updated = db
          .prepare(
            `UPDATE lesson_plan SET current_revision_id=?,title=?,updated_at=?
             WHERE plan_id=? AND current_revision_id=?`
          )
          .run(
            input.revision.revisionId,
            input.revision.title,
            input.proposal.acceptedAt,
            input.revision.planId,
            input.baseRevisionId
          );
        if (updated.changes !== 1) throw new LessonChangeConflictError();
      }

      this.lessonChangeFaults?.beforeIdempotencySuccess?.();
      if (existing) {
        const updated = db.prepare(
          `UPDATE lesson_change_idempotency
           SET status='succeeded',result_json=?,error_code=NULL,updated_at=?
           WHERE key=? AND fingerprint=? AND status='failed'`
        ).run(JSON.stringify(input.result), input.proposal.acceptedAt, input.idempotencyKey, input.fingerprint);
        if (updated.changes !== 1) throw new LessonChangeConflictError();
      } else {
        db.prepare(
          `INSERT INTO lesson_change_idempotency(key,fingerprint,status,result_json,failure_count,error_code,updated_at)
           VALUES(?,?, 'succeeded', ?,0,NULL,?)`
        ).run(input.idempotencyKey, input.fingerprint, JSON.stringify(input.result), input.proposal.acceptedAt);
      }
      return input.result;
    });
    return tx.immediate();
  }

  listLessonChangeHistory(planId: string): {
    revisions: import('../store').LessonRevisionRecord[];
    proposals: import('../store').StoredChangeProposal[];
    bundles: import('../store').MaterialBundleRecord[];
  } {
    if (!this.db) return { revisions: [], proposals: [], bundles: [] };
    const revisions = (
      this.db
        .prepare(
          `SELECT revision_id revisionId,plan_id planId,previous_revision_id previousRevisionId,title,
                  content_json contentJson,content_origin contentOrigin,valid,created_at createdAt
           FROM lesson_revision WHERE plan_id=? ORDER BY created_at,revision_id`
        )
        .all(planId) as Array<Omit<import('../store').LessonRevisionRecord, 'valid'> & { valid: number }>
    ).map((revision) => ({ ...revision, valid: revision.valid === 1 }));
    const proposalRows = this.db
      .prepare(
        `SELECT change_id changeId,plan_id planId,base_revision_id baseRevisionId,
                candidate_revision_id candidateRevisionId,change_kind changeKind,proposal_json proposalJson,
                status,created_at createdAt,accepted_at acceptedAt
         FROM change_proposal WHERE plan_id=? ORDER BY created_at,change_id`
      )
      .all(planId) as Array<{
      changeId: string;
      planId: string;
      baseRevisionId: string;
      candidateRevisionId: string | null;
      changeKind: LessonChange['kind'];
      proposalJson: string;
      status: ChangeProposal['status'];
      createdAt: string;
      acceptedAt: string | null;
    }>;
    const proposals = proposalRows.map((row) => {
      const proposal = JSON.parse(row.proposalJson) as ChangeProposal;
      const errors = validateChangeProposal(proposal);
      if (errors.length) throw new Error(`invalid_stored_change_proposal:${row.changeId}:${errors.join('|')}`);
      return {
        changeId: row.changeId,
        planId: row.planId,
        baseRevisionId: row.baseRevisionId,
        candidateRevisionId: row.candidateRevisionId,
        changeKind: row.changeKind,
        status: row.status,
        createdAt: row.createdAt,
        acceptedAt: row.acceptedAt,
        proposal
      };
    });
    const bundles = this.db
      .prepare(
        `SELECT bundle_id bundleId,plan_id planId,revision_id revisionId,presentation_spec_hash presentationSpecHash,
                directory,status,created_at createdAt
         FROM material_bundle WHERE plan_id=? ORDER BY created_at,bundle_id`
      )
      .all(planId) as import('../store').MaterialBundleRecord[];
    return { revisions, proposals, bundles };
  }

  // ===== G08-T01 反馈流：实际授课独立于采用与效果 =====
  recordTeaching(input: RecordTeachingInput): FeedbackWriteResult<TeachingEvent> {
    this.assertWritable();
    const eventErrors = validateTeachingEvent(input.event);
    if (eventErrors.length) throw new Error(`invalid_teaching_event:${eventErrors.join('|')}`);
    if (
      input.event.workspace_id !== input.workspaceId ||
      input.event.plan_id !== input.planId ||
      input.event.plan_revision_id !== input.planRevisionId
    ) {
      throw new Error('teaching_event_identity_mismatch');
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('invalid_feedback_revision');
    }
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('invalid_feedback_idempotency');

    const db = this.requireDb();
    const tx = db.transaction((): FeedbackWriteResult<TeachingEvent> => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status,result_json resultJson FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as
        | { fingerprint: string; operation: string; status: string; resultJson: string | null }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== 'plans.recordTeaching') {
          throw new FeedbackKeyReuseError();
        }
        if (existing.status !== 'succeeded' || !existing.resultJson) throw new Error('feedback_idempotency_incomplete');
        const parsed = JSON.parse(existing.resultJson) as { streamRevision?: unknown; value?: unknown };
        const errors = validateTeachingEvent(parsed.value);
        if (!Number.isSafeInteger(parsed.streamRevision) || (parsed.streamRevision as number) < 1 || errors.length) {
          throw new Error('invalid_feedback_idempotency_result');
        }
        return {
          streamRevision: parsed.streamRevision as number,
          value: parsed.value as TeachingEvent,
          replayed: true
        };
      }

      const lesson = db
        .prepare('SELECT 1 FROM lesson_revision WHERE plan_id=? AND revision_id=?')
        .get(input.planId, input.planRevisionId);
      if (!lesson) throw new FeedbackSourceMissingError();

      const stream = db
        .prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      const currentRevision = stream?.revision ?? 0;
      if (stream && stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (currentRevision !== input.expectedRevision) throw new FeedbackVersionConflictError();

      db.prepare(
        `INSERT INTO teaching_event(event_id,workspace_id,plan_id,plan_revision_id,event_json,created_at)
         VALUES(?,?,?,?,?,?)`
      ).run(
        input.event.event_id,
        input.workspaceId,
        input.planId,
        input.planRevisionId,
        JSON.stringify(input.event),
        input.event.created_at
      );

      const nextRevision = currentRevision + 1;
      db.prepare(
        `INSERT INTO feedback_stream(plan_id,workspace_id,revision,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(plan_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`
      ).run(input.planId, input.workspaceId, nextRevision, input.event.created_at);

      const result = { streamRevision: nextRevision, value: input.event };
      db.prepare(
        `INSERT INTO feedback_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(
        input.idempotencyKey,
        input.fingerprint,
        'plans.recordTeaching',
        'succeeded',
        JSON.stringify(result),
        input.event.created_at
      );
      return { ...result, replayed: false };
    });
    return tx.immediate();
  }

  getFeedbackHistory(planId: string): FeedbackHistory {
    const db = this.requireDb();
    const stream = db.prepare('SELECT revision FROM feedback_stream WHERE plan_id=?').get(planId) as
      | { revision: number }
      | undefined;
    const rows = db
      .prepare('SELECT event_json eventJson FROM teaching_event WHERE plan_id=? ORDER BY created_at,event_id')
      .all(planId) as { eventJson: string }[];
    const teachingEvents = rows.map((row) => {
      let event: unknown;
      try {
        event = JSON.parse(row.eventJson) as unknown;
      } catch {
        throw new StoreProtectedError('invalid_stored_teaching_event:json');
      }
      const errors = validateTeachingEvent(event);
      if (errors.length) throw new StoreProtectedError(`invalid_stored_teaching_event:${errors.join('|')}`);
      return event as TeachingEvent;
    });
    return {
      streamRevision: stream?.revision ?? 0,
      teachingEvents,
      knowledgeState: this.feedbackKnowledgeState(planId)
    };
  }

  addObservation(input: AddObservationInput): FeedbackWriteResult<ObservationRecord> {
    this.assertWritable();
    const observationErrors = validateObservation(input.observation);
    const outcomeErrors = validateObservationOutcome(input.outcome);
    if (observationErrors.length) throw new Error(`invalid_observation:${observationErrors.join('|')}`);
    if (outcomeErrors.length) throw new Error(`invalid_observation_outcome:${outcomeErrors.join('|')}`);
    if (input.observation.observation_id !== input.outcome.observation_id) throw new Error('observation_identity_mismatch');
    if (input.observation.workspace_id !== input.workspaceId) throw new Error('observation_workspace_mismatch');
    if (!isIsoDateTime(input.createdAt)) throw new Error('invalid_observation_created_at');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_feedback_revision');
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('invalid_feedback_idempotency');

    const db = this.requireDb();
    const tx = db.transaction((): FeedbackWriteResult<ObservationRecord> => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status,result_json resultJson FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as
        | { fingerprint: string; operation: string; status: string; resultJson: string | null }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== 'observations.add') {
          throw new FeedbackKeyReuseError();
        }
        if (existing.status !== 'succeeded' || !existing.resultJson) throw new StoreProtectedError('observation_idempotency_incomplete');
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing.resultJson) as unknown;
        } catch {
          throw new StoreProtectedError('invalid_observation_idempotency_result:json');
        }
        if (!isRecord(parsed) || !Number.isSafeInteger(parsed.streamRevision) || (parsed.streamRevision as number) < 1) {
          throw new StoreProtectedError('invalid_observation_idempotency_result:revision');
        }
        return {
          streamRevision: parsed.streamRevision as number,
          value: parseObservationRecord(parsed.value, 'invalid_observation_idempotency_result'),
          replayed: true
        };
      }

      const lesson = db
        .prepare('SELECT content_json contentJson FROM lesson_revision WHERE plan_id=? AND revision_id=?')
        .get(input.planId, input.observation.plan_revision_id) as { contentJson: string } | undefined;
      if (!lesson) throw new FeedbackSourceMissingError();
      let lessonContent: unknown;
      try {
        lessonContent = JSON.parse(lesson.contentJson) as unknown;
      } catch {
        throw new StoreProtectedError('invalid_observation_lesson_revision:json');
      }
      if (
        input.observation.task_id !== null &&
        (!isRecord(lessonContent) ||
          !Array.isArray(lessonContent.tasks) ||
          !lessonContent.tasks.some((task) => isRecord(task) && task.task_id === input.observation.task_id))
      ) {
        throw new FeedbackSourceMissingError();
      }

      const teaching = db
        .prepare(
          `SELECT 1 FROM teaching_event
           WHERE event_id=? AND workspace_id=? AND plan_id=? AND plan_revision_id=?`
        )
        .get(input.teachingEventId, input.workspaceId, input.planId, input.observation.plan_revision_id);
      if (!teaching) throw new FeedbackSourceMissingError();

      const stream = db
        .prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      if (!stream || stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (stream.revision !== input.expectedRevision) throw new FeedbackVersionConflictError();

      db.prepare(
        `INSERT INTO learning_observation(observation_id,workspace_id,plan_id,teaching_event_id,observation_json,created_at)
         VALUES(?,?,?,?,?,?)`
      ).run(
        input.observation.observation_id,
        input.workspaceId,
        input.planId,
        input.teachingEventId,
        JSON.stringify(input.observation),
        input.createdAt
      );
      this.feedbackFaults?.afterObservationInsert?.();
      db.prepare('INSERT INTO observation_outcome(observation_id,outcome_json) VALUES(?,?)').run(
        input.observation.observation_id,
        JSON.stringify(input.outcome)
      );

      const nextRevision = stream.revision + 1;
      db.prepare('UPDATE feedback_stream SET revision=?,updated_at=? WHERE plan_id=?').run(
        nextRevision,
        input.createdAt,
        input.planId
      );
      const value: ObservationRecord = {
        teachingEventId: input.teachingEventId,
        observation: input.observation,
        outcome: input.outcome
      };
      const result = { streamRevision: nextRevision, value };
      db.prepare(
        `INSERT INTO feedback_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(
        input.idempotencyKey,
        input.fingerprint,
        'observations.add',
        'succeeded',
        JSON.stringify(result),
        input.createdAt
      );
      return { ...result, replayed: false };
    });
    return tx.immediate();
  }

  listObservations(planId: string): ObservationRecord[] {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT o.teaching_event_id teachingEventId,o.observation_json observationJson,
                oo.outcome_json outcomeJson
         FROM learning_observation o
         LEFT JOIN observation_outcome oo ON oo.observation_id=o.observation_id
         WHERE o.plan_id=? ORDER BY o.created_at,o.observation_id`
      )
      .all(planId) as Array<{ teachingEventId: string; observationJson: string; outcomeJson: string | null }>;
    return rows.map((row) => {
      try {
        if (row.outcomeJson === null) throw new StoreProtectedError('invalid_stored_observation:missing_outcome');
        return parseObservationRecord(
          {
            teachingEventId: row.teachingEventId,
            observation: JSON.parse(row.observationJson) as unknown,
            outcome: JSON.parse(row.outcomeJson) as unknown
          },
          'invalid_stored_observation'
        );
      } catch (error) {
        if (error instanceof StoreProtectedError) throw error;
        throw new StoreProtectedError('invalid_stored_observation:json');
      }
    });
  }

  feedbackKnowledgeState(planId: string): FeedbackKnowledgeState {
    const db = this.requireDb();
    const active = db.prepare('SELECT COUNT(*) count FROM learning_observation WHERE plan_id=?').get(planId) as { count: number };
    if (active.count > 0) return 'observed';
    const deleted = db.prepare('SELECT COUNT(*) count FROM observation_tombstone WHERE plan_id=?').get(planId) as { count: number };
    return deleted.count > 0 ? 'deleted' : 'unknown';
  }

  deleteObservation(input: DeleteObservationInput): FeedbackWriteResult<ObservationDeleteResult> {
    this.assertWritable();
    if (!input.confirmationToken.trim()) throw new Error('observation_delete_confirmation_missing');
    if (!isIsoDateTime(input.deletedAt)) throw new Error('invalid_observation_deleted_at');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_feedback_revision');
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('invalid_feedback_idempotency');
    if (
      !Array.isArray(input.backupScopesNotCovered) ||
      input.backupScopesNotCovered.length === 0 ||
      input.backupScopesNotCovered.some((scope) => !isBoundedString(scope, 1, 128))
    ) throw new Error('invalid_observation_backup_scope');

    const db = this.requireDb();
    const tx = db.transaction((): FeedbackWriteResult<ObservationDeleteResult> => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status,result_json resultJson FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as
        | { fingerprint: string; operation: string; status: string; resultJson: string | null }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== 'observations.delete') {
          throw new FeedbackKeyReuseError();
        }
        if (existing.status !== 'succeeded' || !existing.resultJson) throw new StoreProtectedError('observation_delete_idempotency_incomplete');
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing.resultJson) as unknown;
        } catch {
          throw new StoreProtectedError('invalid_observation_delete_idempotency_result:json');
        }
        if (!isRecord(parsed) || !Number.isSafeInteger(parsed.streamRevision) || (parsed.streamRevision as number) < 1) {
          throw new StoreProtectedError('invalid_observation_delete_idempotency_result:revision');
        }
        return {
          streamRevision: parsed.streamRevision as number,
          value: parseObservationDeleteResult(parsed.value, 'invalid_observation_delete_idempotency_result'),
          replayed: true
        };
      }

      const row = db
        .prepare('SELECT workspace_id workspaceId,plan_id planId FROM learning_observation WHERE observation_id=?')
        .get(input.observationId) as { workspaceId: string; planId: string } | undefined;
      if (!row || row.workspaceId !== input.workspaceId || row.planId !== input.planId) throw new FeedbackSourceMissingError();
      const stream = db
        .prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      if (!stream || stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (stream.revision !== input.expectedRevision) throw new FeedbackVersionConflictError();

      db.prepare('DELETE FROM observation_outcome WHERE observation_id=?').run(input.observationId);
      db.prepare('DELETE FROM learning_observation WHERE observation_id=?').run(input.observationId);
      this.feedbackFaults?.afterObservationDelete?.();

      const value: ObservationDeleteResult = {
        observationId: input.observationId,
        planId: input.planId,
        deletedAt: input.deletedAt,
        backupScopesNotCovered: [...input.backupScopesNotCovered]
      };
      db.prepare(
        `INSERT INTO observation_tombstone(observation_id,workspace_id,plan_id,deleted_at,backup_scope_json)
         VALUES(?,?,?,?,?)`
      ).run(input.observationId, input.workspaceId, input.planId, input.deletedAt, JSON.stringify(value));
      const nextRevision = stream.revision + 1;
      db.prepare('UPDATE feedback_stream SET revision=?,updated_at=? WHERE plan_id=?').run(
        nextRevision,
        input.deletedAt,
        input.planId
      );
      const result = { streamRevision: nextRevision, value };
      db.prepare(
        `INSERT INTO feedback_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(
        input.idempotencyKey,
        input.fingerprint,
        'observations.delete',
        'succeeded',
        JSON.stringify(result),
        input.deletedAt
      );
      return { ...result, replayed: false };
    });
    return tx.immediate();
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
