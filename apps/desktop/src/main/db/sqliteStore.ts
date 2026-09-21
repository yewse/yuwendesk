import Database from 'better-sqlite3';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
  SourceReclassificationInput,
  SourceReclassificationResult,
  SourceDeletionInput,
  SourceDeletionResult,
  SourceDeletionWorkflow,
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
import { validateChangeProposal, validateLessonChange } from '../change/change';
import type { ChangeProposal, LessonChange } from '../change/types';
import {
  FeedbackKeyReuseError,
  FeedbackSourceMissingError,
  FeedbackVersionConflictError,
  CorrectionVersionConflictError,
  type AddObservationInput,
  type AttributionContentOrigin,
  type AttributionResult,
  type AttributionRunStatus,
  type BeginFeedbackAnalysisInput,
  type BeginFeedbackAnalysisResult,
  type CommitCorrectionDecisionInput,
  type CorrectionDecisionResult,
  type CorrectionRecord,
  type DeleteObservationInput,
  type FeedbackAnalysisHistory,
  type FeedbackCorrectionHistory,
  type FeedbackHistory,
  type FeedbackKnowledgeState,
  type FeedbackWriteResult,
  type FinishFeedbackAnalysisInput,
  type MeasurementReview,
  type ObservationDeleteResult,
  type ObservationRecord,
  type RecordTeachingInput,
  type TeachingEvent
} from '../feedback/types';
import { validateTeachingEvent } from '../feedback/teaching';
import { validateObservation, validateObservationOutcome } from '../feedback/observation';
import { validateMeasurementReview } from '../feedback/measurement';
import { validateAttributionResult, validateFeedbackAnalysisResult } from '../feedback/attribution';
import {
  applyEffectEvidence,
  applyPreferenceEvent,
  deriveCorrectionStatus,
  validateCorrectionDecisionEvent,
  validateCorrectionProposal,
  validateCorrectionRecord,
  validateEffectEvidenceEvent,
  validatePreferenceEvent
} from '../feedback/correction';
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
import type { BackupKind, ProtectionFaultHooks, SnapshotSummary } from '../protection/types';
import type { DiagnosticsStorageSnapshot } from '../protection/diagnostics';
import {
  encryptSensitiveSourcePayload,
  type EncryptedSensitiveSourcePayload,
  type SensitiveSourcePayloadV1
} from '../protection/sourcePrivacy';
import { canTransition, reconcileInterruptedStatus } from '../preparation/stateMachine';
import {
  PREPARATION_CONTENT_ORIGINS,
  PREPARATION_ERROR_CODES,
  PREPARATION_MODES,
  PREPARATION_SOURCE_PURPOSES,
  PREPARATION_STATUSES,
  TEACHING_GRADES,
  PreparationKeyReuseError,
  PreparationTransitionError,
  PreparationVersionConflictError,
  type PreparationMode,
  type PreparationSession,
  type PreparationSessionPatch,
  type PreparationSourceInput,
  type PreparationSourceSelection,
  type PreparationStatus,
  type TeachingContext,
  type TeachingContextInput
} from '../preparation/types';

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
  afterCorrectionProposalUpdate?: () => void;
  afterPreferenceInsert?: () => void;
  afterEffectInsert?: () => void;
  afterFeedbackStreamIncrement?: () => void;
  beforeFeedbackIdempotency?: () => void;
}

// 仅供 G09 敏感资料事务回滚测试使用；生产不配置。
export interface SourcePrivacyFaultHooks extends Pick<
  ProtectionFaultHooks,
  'afterSensitiveCiphertextInsert' | 'afterFtsCleanup' | 'duringPermanentDeletion'
> {
  afterCiphertextInsert?: () => void;
  afterFtsCleanup?: () => void;
  afterSegmentCleanup?: () => void;
  afterTextCleanup?: () => void;
  afterOriginalCleanup?: () => void;
  afterPlaintextCleanup?: () => void;
  afterDependencyInvalidation?: () => void;
  beforeIdempotency?: () => void;
  beforeTombstone?: () => void;
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
  // G09 测试用敏感升级/永久删除事务故障注入；生产不配置。
  sourcePrivacyFaults?: SourcePrivacyFaultHooks;
  // 可注入的解析实现：生产可注入 worker 线程后端使耗时解析不阻塞主进程；缺省内联 extractBuffer。
  parseFile?: (buf: Buffer, format: string, opts: ExtractOpts) => Promise<ExtractResult>;
  // G10：旧版只支持较低数据世代时保持可读但拒绝写入；生产使用当前常量，测试可模拟旧版。
  supportedDataGeneration?: number;
  // 生产启动先走旁路迁移，因此禁止在活动数据库上原地迁移；旧单元测试缺省保留原有行为。
  allowInPlaceMigrations?: boolean;
  // 启动迁移 journal/lock 无法安全调和时，由主进程注入闭集保护原因；不得来自 renderer。
  startupProtectionReason?: 'migration_recovery_required';
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

function jsonContainsAnyExactString(json: string, candidates: Set<string>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return false;
  }
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return candidates.has(value);
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(visit);
    return false;
  };
  return visit(parsed);
}

function inClosedSet<T extends string>(value: string, values: readonly T[]): value is T {
  return (values as readonly string[]).includes(value);
}

function assertPreparationId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)) throw new Error(`invalid_${field}`);
}

function assertTeachingContextInput(input: TeachingContextInput): void {
  const bounded = (value: unknown, min: number, max: number, field: string): void => {
    if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`invalid_${field}`);
  };
  if (input.contextId !== undefined) assertPreparationId(input.contextId, 'context_id');
  bounded(input.classDisplayName, 1, 80, 'class_display_name');
  if (!inClosedSet(input.grade, TEACHING_GRADES)) throw new Error('invalid_grade');
  bounded(input.textbookTitle, 1, 120, 'textbook_title');
  bounded(input.textbookEdition, 0, 80, 'textbook_edition');
  bounded(input.unitTitle, 0, 120, 'unit_title');
  bounded(input.lessonTitle, 1, 160, 'lesson_title');
  if (!Number.isSafeInteger(input.durationSec) || input.durationSec < 300 || input.durationSec > 14_400) {
    throw new Error('invalid_duration_sec');
  }
  bounded(input.notes, 0, 2_000, 'notes');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
  },
  {
    version: 11,
    up: (db) => {
      // G09 敏感资料密文、无内容墓碑与保护类写操作的持久幂等。
      db.exec(`
        CREATE TABLE source_sensitive_payload (
          version_id        TEXT PRIMARY KEY REFERENCES source_version(id),
          document_id       TEXT NOT NULL REFERENCES source_document(id),
          ciphertext        BLOB NOT NULL,
          nonce             BLOB NOT NULL,
          aad               TEXT NOT NULL,
          algorithm_version INTEGER NOT NULL CHECK (algorithm_version = 1),
          plaintext_hash    TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX idx_sensitive_document ON source_sensitive_payload(document_id);
        CREATE TABLE source_tombstone (
          document_id     TEXT PRIMARY KEY,
          deleted_at      TEXT NOT NULL,
          version_count   INTEGER NOT NULL,
          reason_code     TEXT NOT NULL,
          backup_scope_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          deletion_policy TEXT NOT NULL,
          workflow_status TEXT NOT NULL,
          managed_backup_deleted_json TEXT NOT NULL,
          managed_backup_remaining_json TEXT NOT NULL,
          post_delete_backup_id TEXT,
          workflow_updated_at TEXT NOT NULL
        );
        CREATE TABLE maintenance_idempotency (
          key         TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          operation   TEXT NOT NULL,
          status      TEXT NOT NULL,
          result_json TEXT,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE privacy_file_quarantine (
          operation_key  TEXT NOT NULL,
          original_path  TEXT NOT NULL,
          quarantine_path TEXT NOT NULL,
          PRIMARY KEY(operation_key, original_path)
        );
        ALTER TABLE lesson_revision ADD COLUMN source_review_required INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE source_document ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        INSERT INTO source_fts(source_fts, rank) VALUES('secure-delete', 1);
        INSERT INTO source_seg_fts(source_seg_fts, rank) VALUES('secure-delete', 1);
      `);
    }
  },
  {
    version: 12,
    up: (db) => {
      // G09 最小诊断只保存内容无关的维护代码、时间与计数；不保存 Error/message/stack/path。
      db.exec(`
        CREATE TABLE maintenance_state (
          id                     INTEGER PRIMARY KEY CHECK (id = 1),
          last_backup_code       TEXT,
          last_restore_code      TEXT,
          repeated_failure_count INTEGER NOT NULL DEFAULT 0,
          updated_at             TEXT NOT NULL
        );
        INSERT INTO maintenance_state(id,last_backup_code,last_restore_code,repeated_failure_count,updated_at)
        VALUES(1,NULL,NULL,0,'1970-01-01T00:00:00.000Z');
        CREATE TABLE maintenance_error_count (
          code       TEXT PRIMARY KEY,
          count      INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 13,
    up: (db) => {
      db.exec(`
        CREATE TABLE teaching_context (
          context_id            TEXT PRIMARY KEY,
          class_display_name    TEXT NOT NULL CHECK(length(class_display_name) BETWEEN 1 AND 80),
          grade                 TEXT NOT NULL CHECK(grade IN ('grade7','grade8','grade9','other')),
          textbook_title        TEXT NOT NULL CHECK(length(textbook_title) BETWEEN 1 AND 120),
          textbook_edition      TEXT NOT NULL CHECK(length(textbook_edition) <= 80),
          unit_title            TEXT NOT NULL CHECK(length(unit_title) <= 120),
          lesson_title          TEXT NOT NULL CHECK(length(lesson_title) BETWEEN 1 AND 160),
          duration_sec          INTEGER NOT NULL CHECK(duration_sec BETWEEN 300 AND 14400),
          notes                 TEXT NOT NULL CHECK(length(notes) <= 2000),
          revision              INTEGER NOT NULL CHECK(revision >= 1),
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL
        );
        CREATE TABLE preparation_session (
          session_id       TEXT PRIMARY KEY,
          context_id       TEXT NOT NULL REFERENCES teaching_context(context_id),
          status           TEXT NOT NULL CHECK(status IN ('CONTEXT_DRAFT','SOURCES_SELECTED','BUILDING','PLAN_REVIEW','READY_TO_EXPORT','EXPORTING','EXPORTED')),
          mode             TEXT NOT NULL CHECK(mode IN ('local_authored','model_assisted')),
          focus            TEXT NOT NULL DEFAULT '' CHECK(length(focus) <= 2000),
          core_task        TEXT NOT NULL DEFAULT '' CHECK(length(core_task) <= 4000),
          answer_scope     TEXT NOT NULL DEFAULT '' CHECK(length(answer_scope) <= 4000),
          plan_id          TEXT,
          revision_id      TEXT,
          review_report_id TEXT,
          bundle_id        TEXT,
          model_job_id     TEXT,
          content_origin   TEXT NOT NULL CHECK(content_origin IN ('teacher_authored','model_assisted_real','model_assisted_simulated')),
          last_error_code  TEXT CHECK(last_error_code IS NULL OR last_error_code IN ('PREPARATION_INTERRUPTED','PREPARATION_STALE','PREPARATION_SOURCE_REQUIRED','PREPARATION_SOURCE_CHANGED','PREPARATION_MODEL_UNAVAILABLE','PREPARATION_MODEL_INVALID','PREPARATION_REVIEW_REQUIRED','PREPARATION_EXPORT_FAILED')),
          revision         INTEGER NOT NULL CHECK(revision >= 1),
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
        CREATE INDEX idx_preparation_context ON preparation_session(context_id, updated_at);
        CREATE TABLE preparation_source (
          session_id         TEXT NOT NULL REFERENCES preparation_session(session_id) ON DELETE CASCADE,
          ordinal            INTEGER NOT NULL CHECK(ordinal >= 0),
          source_version_id  TEXT NOT NULL REFERENCES source_version(id),
          char_start         INTEGER NOT NULL CHECK(char_start >= 0),
          char_end           INTEGER NOT NULL CHECK(char_end > char_start),
          purpose            TEXT NOT NULL CHECK(purpose IN ('textbook','curriculum','teacher_reference')),
          approved_for_model INTEGER NOT NULL CHECK(approved_for_model IN (0,1)),
          text_sha256        TEXT NOT NULL CHECK(length(text_sha256) = 64),
          PRIMARY KEY(session_id, ordinal)
        );
      `);
    }
  }
];

const SCHEMA_TARGET = Math.max(...MIGRATIONS.map((m) => m.version));
const DATA_GENERATION_TARGET = 1;

export function migrateSqliteDatabaseToTarget(
  db: Database.Database,
  current: number,
  target = SCHEMA_TARGET
): void {
  if (target !== SCHEMA_TARGET || current > target) throw new Error('migration_target_unsupported');
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
  }
}

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
  private protectedReadAllowed = false;
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
  private readonly sourcePrivacyFaults?: SourcePrivacyFaultHooks;
  private readonly parseFile: (buf: Buffer, format: string, opts: ExtractOpts) => Promise<ExtractResult>;
  private readonly supportedDataGeneration: number;
  private readonly allowInPlaceMigrations: boolean;
  private readonly startupProtectionReason?: 'migration_recovery_required';
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
    this.sourcePrivacyFaults = opts.sourcePrivacyFaults;
    this.parseFile = opts.parseFile ?? ((buf, format, o) => extractBuffer(buf, format, o));
    this.supportedDataGeneration = opts.supportedDataGeneration ?? DATA_GENERATION_TARGET;
    this.allowInPlaceMigrations = opts.allowInPlaceMigrations ?? true;
    this.startupProtectionReason = opts.startupProtectionReason;
    if (!Number.isSafeInteger(this.supportedDataGeneration) || this.supportedDataGeneration < 0) {
      throw new Error('data_generation_target_invalid');
    }
  }

  async load(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    if (this.startupProtectionReason && !existsSync(this.dbPath)) {
      this.enterProtected(this.startupProtectionReason);
      return;
    }
    try {
      this.db = new Database(this.dbPath);
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
      if (version < SCHEMA_TARGET && !this.allowInPlaceMigrations) {
        this.enterProtected(`migration_required:db=${version}<app=${SCHEMA_TARGET}`);
        return;
      }
      this.runMigrations(version);
      let generation: number;
      try { generation = this.dataGeneration(); } catch {
        this.enterProtected('data_generation_invalid');
        return;
      }
      if (generation > this.supportedDataGeneration) {
        this.protectedReadAllowed = true;
        this.enterProtected(`data_generation_newer:db=${generation}>app=${this.supportedDataGeneration}`);
        return;
      }
      if (this.startupProtectionReason) {
        this.protectedReadAllowed = true;
        this.enterProtected(this.startupProtectionReason);
        return;
      }
      // 在任何当前版本启动维护或业务写之前推进世代；旧版随后只能只读，不会覆盖新版触碰过的数据。
      this.ensureDataGenerationInDb(this.requireDb());
      // 持久化 pragma 只能在 schema/世代兼容门通过后设置，避免受保护的旧库被新程序改写文件头或生成 sidecar。
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('secure_delete = ON');
      this.enableFtsSecureDelete();
      this.reconcilePrivacyFileQuarantine();
      if (!this.verifyRequiredRows()) {
        this.enterProtected('required_row_missing');
        return;
      }
      await this.migrateLegacyJsonIfNeeded();
      // 重启不确定态：上次未完成（running）的模型作业无法确定远端是否已执行 → 标记 uncertain，如实呈现。
      this.db
        .prepare("UPDATE model_job SET status='uncertain', updated_at=? WHERE status='running'")
        .run(new Date().toISOString());
      this.reconcileInterruptedPreparationSessions();
    } catch (e) {
      this.enterProtected(`open_failed:${(e as Error).message}`);
    }
  }

  private runMigrations(current: number): void {
    migrateSqliteDatabaseToTarget(this.requireDb(), current);
  }

  private reconcileInterruptedPreparationSessions(): void {
    const db = this.requireDb();
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const status of ['BUILDING', 'EXPORTING'] as const) {
        const reconciled = reconcileInterruptedStatus(status);
        db.prepare(
          `UPDATE preparation_session
           SET status=?,last_error_code=?,revision=revision+1,updated_at=?
           WHERE status=?`
        ).run(reconciled.status, reconciled.errorCode, now, status);
      }
    }).immediate();
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
    if (!this.db || (this.protectedState && !this.protectedReadAllowed)) return { content: '', revision: 0, updated_at: null };
    return this.readDraft();
  }

  getWindow(): WindowState {
    if (!this.db || (this.protectedState && !this.protectedReadAllowed)) return { width: 1180, height: 800 };
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

  private enableFtsSecureDelete(): void {
    const db = this.requireDb();
    db.prepare("INSERT INTO source_fts(source_fts, rank) VALUES('secure-delete', 1)").run();
    db.prepare("INSERT INTO source_seg_fts(source_seg_fts, rank) VALUES('secure-delete', 1)").run();
  }

  private reconcilePrivacyFileQuarantine(): void {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT q.operation_key operationKey,q.original_path originalPath,q.quarantine_path quarantinePath,
              m.status maintenanceStatus
       FROM privacy_file_quarantine q
       LEFT JOIN maintenance_idempotency m ON m.key=q.operation_key
       ORDER BY q.operation_key,q.original_path`
    ).all() as Array<{ operationKey: string; originalPath: string; quarantinePath: string; maintenanceStatus: string | null }>;
    for (const row of rows) {
      if (row.maintenanceStatus === 'succeeded') {
        if (existsSync(row.quarantinePath)) rmSync(row.quarantinePath, { recursive: true, force: true });
      } else if (existsSync(row.quarantinePath)) {
        mkdirSync(dirname(row.originalPath), { recursive: true });
        if (!existsSync(row.originalPath)) renameSync(row.quarantinePath, row.originalPath);
      }
      db.prepare('DELETE FROM privacy_file_quarantine WHERE operation_key=? AND original_path=?')
        .run(row.operationKey, row.originalPath);
    }
    const root = join(this.dir, 'privacy-quarantine');
    if (existsSync(root)) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* next startup retries registered entries */ }
    }
  }

  private quarantineDerivedFiles(operationKey: string, paths: string[]): Array<{ originalPath: string; quarantinePath: string }> {
    const materialRoot = resolve(this.dir, 'materials');
    const normalized = [...new Set(paths.map((value) => resolve(value)))].sort((a, b) => a.length - b.length);
    for (const candidate of normalized) {
      if (candidate !== materialRoot && !candidate.startsWith(`${materialRoot}${sep}`)) {
        throw new StoreProtectedError('privacy_artifact_path_outside_root');
      }
    }
    const roots = normalized.filter((candidate, index) => !normalized.slice(0, index).some((parent) => candidate.startsWith(`${parent}${sep}`)));
    const token = createHash('sha256').update(operationKey).digest('hex').slice(0, 24);
    const prepared = roots.filter((source) => existsSync(source)).map((source) => ({
      originalPath: source,
      quarantinePath: join(this.dir, 'privacy-quarantine', token, relative(materialRoot, source))
    }));
    if (prepared.length === 0) return [];
    const db = this.requireDb();
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO privacy_file_quarantine(operation_key,original_path,quarantine_path) VALUES(?,?,?)');
      for (const entry of prepared) insert.run(operationKey, entry.originalPath, entry.quarantinePath);
    }).immediate();
    try {
      for (const entry of prepared) {
        mkdirSync(dirname(entry.quarantinePath), { recursive: true });
        renameSync(entry.originalPath, entry.quarantinePath);
      }
      return prepared;
    } catch (error) {
      this.restoreDerivedFiles(operationKey, prepared);
      throw error;
    }
  }

  private restoreDerivedFiles(operationKey: string, entries: Array<{ originalPath: string; quarantinePath: string }>): void {
    for (const entry of [...entries].reverse()) {
      if (!existsSync(entry.quarantinePath)) continue;
      mkdirSync(dirname(entry.originalPath), { recursive: true });
      if (!existsSync(entry.originalPath)) renameSync(entry.quarantinePath, entry.originalPath);
    }
    this.requireDb().prepare('DELETE FROM privacy_file_quarantine WHERE operation_key=?').run(operationKey);
  }

  private finalizeDerivedFiles(operationKey: string, entries: Array<{ originalPath: string; quarantinePath: string }>): void {
    for (const entry of entries) if (existsSync(entry.quarantinePath)) rmSync(entry.quarantinePath, { recursive: true, force: true });
    this.requireDb().prepare('DELETE FROM privacy_file_quarantine WHERE operation_key=?').run(operationKey);
  }

  private dependentPrivacyData(versionIds: Set<string>): {
    revisionIds: string[];
    planIds: string[];
    filePaths: string[];
  } {
    const db = this.requireDb();
    const revisions = (db.prepare('SELECT revision_id revisionId,plan_id planId,content_json contentJson FROM lesson_revision').all() as Array<{
      revisionId: string; planId: string; contentJson: string;
    }>).filter((row) => jsonContainsAnyExactString(row.contentJson, versionIds));
    const revisionIds = revisions.map((row) => row.revisionId);
    const planIds = [...new Set(revisions.map((row) => row.planId))];
    if (planIds.length === 0) return { revisionIds, planIds, filePaths: [] };
    const placeholders = planIds.map(() => '?').join(',');
    const artifacts = db.prepare(`SELECT path FROM material_artifact WHERE plan_id IN (${placeholders})`).all(...planIds) as Array<{ path: string }>;
    const bundles = db.prepare(`SELECT directory FROM material_bundle WHERE plan_id IN (${placeholders})`).all(...planIds) as Array<{ directory: string }>;
    return { revisionIds, planIds, filePaths: [...artifacts.map((row) => row.path), ...bundles.map((row) => row.directory)] };
  }

  private purgeDependentPrivacyData(revisionIds: string[], planIds: string[]): void {
    if (planIds.length === 0) return;
    const db = this.requireDb();
    const planPlaceholders = planIds.map(() => '?').join(',');
    const revisionPlaceholders = revisionIds.map(() => '?').join(',');
    const observationIds = (db.prepare(`SELECT observation_id observationId FROM learning_observation WHERE plan_id IN (${planPlaceholders})`).all(...planIds) as Array<{ observationId: string }>).map((row) => row.observationId);
    if (observationIds.length) {
      db.prepare(`DELETE FROM observation_outcome WHERE observation_id IN (${observationIds.map(() => '?').join(',')})`).run(...observationIds);
    }
    for (const table of [
      'preference_event', 'effect_evidence_event', 'correction_proposal', 'attribution_run', 'measurement_review',
      'observation_tombstone', 'learning_observation', 'teaching_event', 'feedback_stream',
      'material_artifact', 'material_bundle', 'change_proposal', 'review_report'
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE plan_id IN (${planPlaceholders})`).run(...planIds);
    }
    const identities = new Set([...planIds, ...revisionIds]);
    for (const table of ['feedback_idempotency', 'lesson_change_idempotency']) {
      const rows = db.prepare(`SELECT key,result_json resultJson FROM ${table} WHERE result_json IS NOT NULL`).all() as Array<{ key: string; resultJson: string }>;
      const keys = rows.filter((row) => jsonContainsAnyExactString(row.resultJson, identities)).map((row) => row.key);
      if (keys.length) db.prepare(`DELETE FROM ${table} WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
    }
    if (revisionIds.length) {
      db.prepare(
        `UPDATE lesson_revision
         SET title='需重新生成的课时（敏感资料）',content_json='{"redacted_due_to_sensitive_source":true}',valid=0,source_review_required=1
         WHERE revision_id IN (${revisionPlaceholders})`
      ).run(...revisionIds);
      db.prepare(
        `UPDATE lesson_plan SET title='需重新生成的课时（敏感资料）'
         WHERE plan_id IN (${planPlaceholders}) AND current_revision_id IN (${revisionPlaceholders})`
      ).run(...planIds, ...revisionIds);
    }
  }

  exportWorkspaceDataKey():
    | { ok: true; key: Buffer | null }
    | { ok: false; reason: 'unavailable' | 'decrypt_failed' } {
    if (this.protectedState) return { ok: false, reason: 'unavailable' };
    const current = this.readDataKey();
    if (current.ok) return { ok: true, key: Buffer.from(current.key) };
    if (current.reason === 'not_found') return { ok: true, key: null };
    return { ok: false, reason: current.reason };
  }

  installWorkspaceDataKey(key: Buffer): { ok: true } | { ok: false; reason: 'unavailable' | 'already_exists' | 'invalid_key' } {
    this.assertWritable();
    if (key.length !== 32) return { ok: false, reason: 'invalid_key' };
    if (!this.safeStorage || !isSecureSafeStorage(this.safeStorage)) return { ok: false, reason: 'unavailable' };
    const db = this.requireDb();
    if (db.prepare('SELECT 1 FROM secure_key WHERE id=1').get()) return { ok: false, reason: 'already_exists' };
    const wrapped = new DataKeyManager(this.safeStorage).wrap(key);
    if (!wrapped.ok) return { ok: false, reason: 'unavailable' };
    db.prepare('INSERT INTO secure_key(id,wrapped,created_at) VALUES(1,?,?)').run(wrapped.wrapped, new Date().toISOString());
    return { ok: true };
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

  // 统一提交路径：严格分类；学生资料只写认证密文，不进入普通正文/段落/FTS；
  // 去重按原件哈希，版本关系需明确确认（不自动切换当前版本）。
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
    const sensitiveKey = classification === 'student_sensitive' ? this.ensureDataKey() : null;
    if (sensitiveKey && !sensitiveKey.ok) return { status: 'blocked_sensitive', reason: 'encryption_unavailable' };
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
      db.prepare('INSERT INTO source_file(version_id,original_blob,original_hash,byte_size,mime,created_at) VALUES(?,?,?,?,?,?)').run(
        versionId,
        classification === 'student_sensitive' ? null : p.originalBytes,
        originalHash,
        byteSize,
        p.mime,
        now
      );
      if (classification === 'student_sensitive') {
        const payload: SensitiveSourcePayloadV1 = {
          version: 1,
          originalBase64: p.originalBytes.toString('base64'),
          mime: p.mime,
          fullText: p.extracted.fullText,
          segments: p.extracted.segments.map((seg) => ({
            ordinal: seg.ordinal,
            locatorKind: seg.locatorKind,
            locator: JSON.stringify(seg.locator),
            text: seg.text,
            charStart: seg.char_start,
            charEnd: seg.char_end,
            reliable: seg.reliable
          }))
        };
        const encrypted = encryptSensitiveSourcePayload(
          (sensitiveKey as { ok: true; key: Buffer }).key,
          payload,
          { workspaceId: 'workspace_local', documentId, versionId }
        );
        db.prepare(
          `INSERT INTO source_sensitive_payload(
             version_id,document_id,ciphertext,nonce,aad,algorithm_version,plaintext_hash,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(versionId, documentId, encrypted.ciphertext, encrypted.nonce, encrypted.aad, encrypted.algorithmVersion, encrypted.plaintextHash, now, now);
      } else {
        db.prepare('INSERT INTO source_text(version_id,full_text) VALUES(?,?)').run(versionId, p.extracted.fullText);
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
      }
      if (makeCurrent) {
        if (classification === 'student_sensitive') {
          db.prepare('UPDATE source_document SET current_version_id=?,title=?,classification=?,status=?,updated_at=?,revision=revision+1 WHERE id=?')
            .run(versionId, `学生作品（${documentId.replace(/-/g, '').slice(-8)}）`, classification, 'active', now, documentId);
        } else {
          db.prepare('UPDATE source_document SET current_version_id=?, status=?, updated_at=?, revision=revision+1 WHERE id=?').run(versionId, 'active', now, documentId);
        }
      } else {
        db.prepare('UPDATE source_document SET updated_at=? WHERE id=?').run(now, documentId);
      }
      return { status: maxV === 0 ? 'imported' : 'new_version', documentId, versionId, version, contentHash: textHash, versionConflict };
    };
    const createDoc = (): string => {
      const documentId = randomUUID();
      db.prepare(
        'INSERT INTO source_document(id,title,classification,status,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
      ).run(
        documentId,
        classification === 'student_sensitive' ? `学生作品（${documentId.replace(/-/g, '').slice(-8)}）` : p.title,
        classification,
        'active',
        null,
        now,
        now
      );
      return documentId;
    };
    // 去重按原件哈希：同一原始文件重复导入 → duplicate。
    const dupInDoc = (documentId: string): { versionId: string; version: number } | undefined =>
      db.prepare('SELECT id versionId, version FROM source_version WHERE document_id=? AND original_hash=? ORDER BY version LIMIT 1').get(documentId, originalHash) as
        | { versionId: string; version: number }
        | undefined;

    const tx = db.transaction((): SourceImportResult => {
      if (p.relation === 'new_version' && p.targetDocumentId) {
        const doc = db.prepare('SELECT id,classification FROM source_document WHERE id=?').get(p.targetDocumentId) as
          | { id: string; classification: SourceClassification }
          | undefined;
        if (!doc) return { status: 'rejected', reason: 'empty' };
        if (doc.classification !== classification) {
          return { status: 'blocked_sensitive', reason: 'classification_transition_blocked' };
        }
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

  reclassifySource(input: SourceReclassificationInput): SourceReclassificationResult {
    this.assertWritable();
    if (input.targetClassification !== 'student_sensitive') return { status: 'blocked', reason: 'PRIVACY_BLOCKED' };
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('maintenance_idempotency_required');
    const db = this.requireDb();
    const existing = db.prepare(
      'SELECT fingerprint,operation,status,result_json resultJson FROM maintenance_idempotency WHERE key=?'
    ).get(input.idempotencyKey) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined;
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.operation !== 'sources.reclassify') {
        throw new Error('maintenance_idempotency_key_reuse');
      }
      if (existing.status !== 'succeeded' || !existing.resultJson) throw new Error('maintenance_idempotency_incomplete');
      const result = JSON.parse(existing.resultJson) as SourceReclassificationResult;
      return result.status === 'succeeded' ? { ...result, replayed: true } : result;
    }

    const doc = db.prepare(
      `SELECT sd.classification classification,sd.current_version_id currentVersionId,sd.revision currentRevision
       FROM source_document sd WHERE sd.id=?`
    ).get(input.documentId) as { classification: SourceClassification; currentVersionId: string | null; currentRevision: number } | undefined;
    if (!doc || !doc.currentVersionId) return { status: 'missing' };
    if (doc.currentRevision !== input.expectedRevision) return { status: 'conflict', currentRevision: doc.currentRevision };

    const existingVersionIds = (db.prepare('SELECT id FROM source_version WHERE document_id=? ORDER BY version').all(input.documentId) as Array<{ id: string }>).map((row) => row.id);
    const protectedCount = Number((db.prepare('SELECT COUNT(*) count FROM source_sensitive_payload WHERE document_id=?').get(input.documentId) as { count: number }).count);
    if (doc.classification === 'student_sensitive' && protectedCount === existingVersionIds.length) {
      const alreadyProtected: SourceReclassificationResult = {
        status: 'succeeded',
        documentId: input.documentId,
        classification: 'student_sensitive',
        revision: doc.currentRevision,
        protectedVersionIds: existingVersionIds,
        invalidatedLessonRevisionIds: [],
        deletedModelJobIds: [],
        replayed: false
      };
      db.prepare(
        `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(input.idempotencyKey, input.fingerprint, 'sources.reclassify', 'succeeded', JSON.stringify(alreadyProtected), input.updatedAt);
      return alreadyProtected;
    }

    const dataKey = this.ensureDataKey();
    if (!dataKey.ok) return { status: 'blocked', reason: 'KEY_UNAVAILABLE' };
    const versions = db.prepare(
      `SELECT sv.id versionId,sv.mime mime,sf.original_blob originalBlob
       FROM source_version sv LEFT JOIN source_file sf ON sf.version_id=sv.id
       WHERE sv.document_id=? ORDER BY sv.version`
    ).all(input.documentId) as Array<{ versionId: string; mime: string | null; originalBlob: Buffer | null }>;
    if (versions.length === 0) return { status: 'missing' };

    const encrypted = versions.map((version): { versionId: string; value: EncryptedSensitiveSourcePayload } => {
      const text = (db.prepare('SELECT full_text fullText FROM source_text WHERE version_id=?').get(version.versionId) as { fullText: string } | undefined)?.fullText ?? '';
      const segments = db.prepare(
        `SELECT ordinal,locator_kind locatorKind,locator,text,char_start charStart,char_end charEnd,reliable
         FROM source_segment WHERE version_id=? ORDER BY ordinal,id`
      ).all(version.versionId) as Array<{
        ordinal: number; locatorKind: string; locator: string; text: string; charStart: number; charEnd: number; reliable: number;
      }>;
      const payload: SensitiveSourcePayloadV1 = {
        version: 1,
        originalBase64: version.originalBlob ? Buffer.from(version.originalBlob).toString('base64') : '',
        mime: version.mime ?? 'application/octet-stream',
        fullText: text,
        segments: segments.map((segment) => ({ ...segment, reliable: segment.reliable === 1 }))
      };
      return {
        versionId: version.versionId,
        value: encryptSensitiveSourcePayload(dataKey.key, payload, {
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          versionId: version.versionId
        })
      };
    });
    const versionIds = new Set(versions.map((version) => version.versionId));
    const dependent = this.dependentPrivacyData(versionIds);
    const invalidatedLessonRevisionIds = dependent.revisionIds;
    const deletedModelJobIds = (db.prepare('SELECT id,material_versions_json materialVersionsJson FROM model_job').all() as Array<{
      id: string; materialVersionsJson: string;
    }>).filter((row) => jsonContainsAnyExactString(row.materialVersionsJson, versionIds)).map((row) => row.id);
    const result: SourceReclassificationResult = {
      status: 'succeeded',
      documentId: input.documentId,
      classification: 'student_sensitive',
      revision: doc.currentRevision + 1,
      protectedVersionIds: [...versionIds],
      invalidatedLessonRevisionIds,
      deletedModelJobIds,
      replayed: false
    };

    const quarantined = this.quarantineDerivedFiles(input.idempotencyKey, dependent.filePaths);
    const tx = db.transaction(() => {
      const current = db.prepare(
        'SELECT revision currentRevision FROM source_document WHERE id=?'
      ).get(input.documentId) as { currentRevision: number } | undefined;
      if (!current || current.currentRevision !== input.expectedRevision) throw new Error('source_reclassification_conflict');
      for (const item of encrypted) {
        db.prepare(
          `INSERT INTO source_sensitive_payload(
             version_id,document_id,ciphertext,nonce,aad,algorithm_version,plaintext_hash,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(version_id) DO UPDATE SET
             ciphertext=excluded.ciphertext,nonce=excluded.nonce,aad=excluded.aad,
             algorithm_version=excluded.algorithm_version,plaintext_hash=excluded.plaintext_hash,updated_at=excluded.updated_at`
        ).run(
          item.versionId,
          input.documentId,
          item.value.ciphertext,
          item.value.nonce,
          item.value.aad,
          item.value.algorithmVersion,
          item.value.plaintextHash,
          input.updatedAt,
          input.updatedAt
        );
      }
      this.sourcePrivacyFaults?.afterCiphertextInsert?.();
      this.sourcePrivacyFaults?.afterSensitiveCiphertextInsert?.();
      for (const versionId of versionIds) {
        db.prepare('DELETE FROM source_seg_fts WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_fts WHERE version_id=?').run(versionId);
      }
      this.sourcePrivacyFaults?.afterFtsCleanup?.();
      for (const versionId of versionIds) {
        db.prepare('DELETE FROM source_segment WHERE version_id=?').run(versionId);
      }
      this.sourcePrivacyFaults?.afterSegmentCleanup?.();
      for (const versionId of versionIds) {
        db.prepare('DELETE FROM source_text WHERE version_id=?').run(versionId);
      }
      this.sourcePrivacyFaults?.afterTextCleanup?.();
      for (const versionId of versionIds) {
        db.prepare('UPDATE source_file SET original_blob=NULL WHERE version_id=?').run(versionId);
      }
      this.sourcePrivacyFaults?.afterOriginalCleanup?.();
      this.sourcePrivacyFaults?.afterPlaintextCleanup?.();
      db.prepare('UPDATE source_document SET title=?,classification=?,updated_at=?,revision=revision+1 WHERE id=?').run(
        `学生作品（${input.documentId.replace(/-/g, '').slice(-8)}）`,
        'student_sensitive',
        input.updatedAt,
        input.documentId
      );
      this.purgeDependentPrivacyData(dependent.revisionIds, dependent.planIds);
      for (const jobId of deletedModelJobIds) db.prepare('DELETE FROM model_job WHERE id=?').run(jobId);
      this.sourcePrivacyFaults?.afterDependencyInvalidation?.();
      this.sourcePrivacyFaults?.beforeIdempotency?.();
      db.prepare(
        `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(input.idempotencyKey, input.fingerprint, 'sources.reclassify', 'succeeded', JSON.stringify(result), input.updatedAt);
    });
    try {
      tx.immediate();
    } catch (error) {
      this.restoreDerivedFiles(input.idempotencyKey, quarantined);
      throw error;
    }
    this.finalizeDerivedFiles(input.idempotencyKey, quarantined);
    db.pragma('wal_checkpoint(TRUNCATE)');
    return result;
  }

  deleteSourcePermanently(input: SourceDeletionInput): SourceDeletionResult {
    this.assertWritable();
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('maintenance_idempotency_required');
    const db = this.requireDb();
    const existing = db.prepare(
      'SELECT fingerprint,operation,status,result_json resultJson FROM maintenance_idempotency WHERE key=?'
    ).get(input.idempotencyKey) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined;
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.operation !== 'sources.delete') {
        throw new Error('maintenance_idempotency_key_reuse');
      }
      if (existing.status !== 'succeeded' || !existing.resultJson) throw new Error('maintenance_idempotency_incomplete');
      const result = JSON.parse(existing.resultJson) as SourceDeletionResult;
      return result.status === 'succeeded' ? { ...result, replayed: true } : result;
    }

    const doc = db.prepare(
      'SELECT revision currentRevision FROM source_document WHERE id=?'
    ).get(input.documentId) as { currentRevision: number } | undefined;
    if (!doc) return { status: 'missing' };
    if (doc.currentRevision !== input.expectedRevision) return { status: 'conflict', currentRevision: doc.currentRevision };
    const versionIds = new Set(
      (db.prepare('SELECT id FROM source_version WHERE document_id=? ORDER BY version').all(input.documentId) as Array<{ id: string }>).map((row) => row.id)
    );
    const dependent = this.dependentPrivacyData(versionIds);
    const invalidatedLessonRevisionIds = dependent.revisionIds;
    const deletedModelJobIds = (db.prepare('SELECT id,material_versions_json materialVersionsJson FROM model_job').all() as Array<{
      id: string; materialVersionsJson: string;
    }>).filter((row) => jsonContainsAnyExactString(row.materialVersionsJson, versionIds)).map((row) => row.id);
    const result: SourceDeletionResult = {
      status: 'succeeded',
      documentId: input.documentId,
      deletedVersionCount: versionIds.size,
      databaseDeleted: true,
      invalidatedLessonRevisionIds,
      deletedModelJobIds,
      externalOrOfflineBackups: 'not_recalled',
      replayed: false
    };
    const backupScopeJson = JSON.stringify({
      managedBackupIds: [...input.managedBackupIds].sort(),
      externalOrOfflineBackups: 'not_recalled'
    });

    const quarantined = this.quarantineDerivedFiles(input.idempotencyKey, dependent.filePaths);
    const tx = db.transaction(() => {
      const current = db.prepare(
        'SELECT revision currentRevision FROM source_document WHERE id=?'
      ).get(input.documentId) as { currentRevision: number } | undefined;
      if (!current || current.currentRevision !== input.expectedRevision) throw new Error('source_delete_conflict');
      for (const versionId of versionIds) {
        db.prepare('DELETE FROM source_seg_fts WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_fts WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_segment WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_text WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_file WHERE version_id=?').run(versionId);
        db.prepare('DELETE FROM source_sensitive_payload WHERE version_id=?').run(versionId);
      }
      this.purgeDependentPrivacyData(dependent.revisionIds, dependent.planIds);
      for (const jobId of deletedModelJobIds) db.prepare('DELETE FROM model_job WHERE id=?').run(jobId);
      db.prepare('DELETE FROM source_version WHERE document_id=?').run(input.documentId);
      db.prepare('DELETE FROM source_document WHERE id=?').run(input.documentId);
      this.sourcePrivacyFaults?.duringPermanentDeletion?.();
      this.sourcePrivacyFaults?.beforeTombstone?.();
      db.prepare(
        `INSERT INTO source_tombstone(
           document_id,deleted_at,version_count,reason_code,backup_scope_json,idempotency_key,deletion_policy,
           workflow_status,managed_backup_deleted_json,managed_backup_remaining_json,post_delete_backup_id,workflow_updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        input.documentId, input.deletedAt, versionIds.size, 'user_permanent_delete', backupScopeJson,
        input.idempotencyKey, input.policy, 'database_deleted', '[]', JSON.stringify([...input.managedBackupIds].sort()), null, input.deletedAt
      );
      this.sourcePrivacyFaults?.beforeIdempotency?.();
      db.prepare(
        `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(input.idempotencyKey, input.fingerprint, 'sources.delete', 'succeeded', JSON.stringify(result), input.deletedAt);
    });
    try {
      tx.immediate();
    } catch (error) {
      this.restoreDerivedFiles(input.idempotencyKey, quarantined);
      throw error;
    }
    this.finalizeDerivedFiles(input.idempotencyKey, quarantined);
    db.pragma('wal_checkpoint(TRUNCATE)');
    return result;
  }

  getMaintenanceIdempotency(key: string): {
    fingerprint: string;
    operation: string;
    status: string;
    resultJson: string | null;
  } | null {
    if (!this.db) return null;
    return (this.db.prepare(
      'SELECT fingerprint,operation,status,result_json resultJson FROM maintenance_idempotency WHERE key=?'
    ).get(key) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined) ?? null;
  }

  reserveMaintenanceIdempotency(input: {
    key: string;
    fingerprint: string;
    operation: string;
    updatedAt: string;
  }): 'reserved' | 'existing' {
    this.assertWritable();
    const db = this.requireDb();
    return db.transaction(() => {
      const existing = db.prepare('SELECT fingerprint,operation FROM maintenance_idempotency WHERE key=?').get(input.key) as
        | { fingerprint: string; operation: string }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== input.operation) {
          throw new Error('maintenance_idempotency_key_reuse');
        }
        return 'existing' as const;
      }
      db.prepare(
        `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,'running',NULL,?)`
      ).run(input.key, input.fingerprint, input.operation, input.updatedAt);
      return 'reserved' as const;
    }).immediate();
  }

  maintenanceRequestDigest(value: string): string {
    const key = this.ensureDataKey();
    if (!key.ok) throw new Error('maintenance_digest_key_unavailable');
    return createHmac('sha256', key.key).update(value, 'utf8').digest('hex');
  }

  getPendingSourceDeletionWorkflows(): SourceDeletionWorkflow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT document_id documentId,idempotency_key idempotencyKey,deletion_policy policy,workflow_status status,
              backup_scope_json backupScopeJson,managed_backup_deleted_json deletedJson,
              managed_backup_remaining_json remainingJson,post_delete_backup_id postDeleteBackupId,
              workflow_updated_at updatedAt
       FROM source_tombstone WHERE workflow_status<>'completed' ORDER BY deleted_at,document_id`
    ).all() as Array<{
      documentId: string; idempotencyKey: string; policy: SourceDeletionWorkflow['policy']; status: SourceDeletionWorkflow['status'];
      backupScopeJson: string; deletedJson: string; remainingJson: string; postDeleteBackupId: string | null; updatedAt: string;
    }>;
    return rows.map((row) => {
      const scope = JSON.parse(row.backupScopeJson) as { managedBackupIds?: unknown };
      return {
        documentId: row.documentId,
        idempotencyKey: row.idempotencyKey,
        policy: row.policy,
        status: row.status,
        managedBackupIds: Array.isArray(scope.managedBackupIds) ? scope.managedBackupIds.filter((value): value is string => typeof value === 'string') : [],
        managedBackupDeletedIds: JSON.parse(row.deletedJson) as string[],
        managedBackupRemainingIds: JSON.parse(row.remainingJson) as string[],
        postDeleteBackupId: row.postDeleteBackupId,
        updatedAt: row.updatedAt
      };
    });
  }

  updateSourceDeletionWorkflow(input: {
    idempotencyKey: string;
    status: SourceDeletionWorkflow['status'];
    managedBackupDeletedIds: string[];
    managedBackupRemainingIds: string[];
    postDeleteBackupId: string | null;
    updatedAt: string;
  }): void {
    this.assertWritable();
    const updated = this.requireDb().prepare(
      `UPDATE source_tombstone
       SET workflow_status=?,managed_backup_deleted_json=?,managed_backup_remaining_json=?,post_delete_backup_id=?,workflow_updated_at=?
       WHERE idempotency_key=?`
    ).run(
      input.status,
      JSON.stringify([...new Set(input.managedBackupDeletedIds)].sort()),
      JSON.stringify([...new Set(input.managedBackupRemainingIds)].sort()),
      input.postDeleteBackupId,
      input.updatedAt,
      input.idempotencyKey
    );
    if (updated.changes !== 1) throw new Error('source_deletion_workflow_missing');
  }

  saveMaintenanceIdempotency(input: {
    key: string;
    fingerprint: string;
    operation: string;
    resultJson: string;
    updatedAt: string;
  }): void {
    this.assertWritable();
    const db = this.requireDb();
    const existing = db.prepare('SELECT fingerprint,operation,status FROM maintenance_idempotency WHERE key=?').get(input.key) as
      | { fingerprint: string; operation: string; status: string }
      | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,?,?,?,?)`
      ).run(input.key, input.fingerprint, input.operation, 'succeeded', input.resultJson, input.updatedAt);
      return;
    }
    if (existing.fingerprint !== input.fingerprint || existing.operation !== input.operation) {
      throw new Error('maintenance_idempotency_key_reuse');
    }
    if (existing.status !== 'running') throw new Error('maintenance_idempotency_not_running');
    db.prepare("UPDATE maintenance_idempotency SET status='succeeded',result_json=?,updated_at=? WHERE key=?")
      .run(input.resultJson, input.updatedAt, input.key);
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
    const exists = !!db.prepare('SELECT 1 FROM source_document WHERE id=?').get(documentId);
    if (!exists) return false;
    db.prepare("UPDATE source_document SET status='retired', updated_at=?, revision=revision+1 WHERE id=? AND status<>'retired'")
      .run(new Date().toISOString(), documentId);
    return true;
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

  beginFeedbackAnalysis(input: BeginFeedbackAnalysisInput): BeginFeedbackAnalysisResult {
    this.assertWritable();
    const measurementErrors = validateMeasurementReview(input.measurement);
    if (measurementErrors.length) throw new Error(`invalid_measurement_review:${measurementErrors.join('|')}`);
    if (
      input.measurement.workspace_id !== input.workspaceId ||
      input.measurement.plan_id !== input.planId ||
      input.measurement.teaching_event_id !== input.teachingEventId
    ) throw new Error('measurement_identity_mismatch');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('invalid_feedback_revision');
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim() || !input.inputHash.trim() || !input.runId.trim()) throw new Error('invalid_feedback_analysis_identity');
    if (!isIsoDateTime(input.createdAt)) throw new Error('invalid_feedback_analysis_created_at');

    const db = this.requireDb();
    const tx = db.transaction((): BeginFeedbackAnalysisResult => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status,result_json resultJson FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== 'feedback.analyze') throw new FeedbackKeyReuseError();
        if (!existing.resultJson) throw new StoreProtectedError('feedback_analysis_idempotency_missing_result');
        let parsed: unknown;
        try { parsed = JSON.parse(existing.resultJson) as unknown; } catch { throw new StoreProtectedError('feedback_analysis_idempotency_invalid_json'); }
        if (existing.status === 'succeeded') return { kind: 'replayed', result: parsed };
        if (existing.status === 'running' && isRecord(parsed) && Number.isSafeInteger(parsed.streamRevision)) {
          return { kind: 'in_progress', streamRevision: parsed.streamRevision as number };
        }
        throw new StoreProtectedError('feedback_analysis_idempotency_invalid_state');
      }

      const lesson = db
        .prepare('SELECT 1 FROM lesson_revision WHERE plan_id=? AND revision_id=?')
        .get(input.planId, input.measurement.plan_revision_id);
      if (!lesson) throw new FeedbackSourceMissingError();
      const teaching = db
        .prepare('SELECT 1 FROM teaching_event WHERE event_id=? AND workspace_id=? AND plan_id=? AND plan_revision_id=?')
        .get(input.teachingEventId, input.workspaceId, input.planId, input.measurement.plan_revision_id);
      if (!teaching) throw new FeedbackSourceMissingError();
      const stream = db
        .prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      if (!stream || stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (stream.revision !== input.expectedRevision) throw new FeedbackVersionConflictError();

      db.prepare(
        `INSERT INTO measurement_review(review_id,workspace_id,plan_id,teaching_event_id,review_json,created_at)
         VALUES(?,?,?,?,?,?)`
      ).run(input.measurement.review_id, input.workspaceId, input.planId, input.teachingEventId, JSON.stringify(input.measurement), input.createdAt);
      if (input.measurement.disposition === 'ready_for_attribution') {
        db.prepare(
          `INSERT INTO attribution_run(run_id,workspace_id,plan_id,teaching_event_id,input_hash,status,result_json,model_job_id,content_origin,created_at,updated_at)
           VALUES(?,?,?,?,?,'running',NULL,NULL,NULL,?,?)`
        ).run(input.runId, input.workspaceId, input.planId, input.teachingEventId, input.inputHash, input.createdAt, input.createdAt);
      }
      const nextRevision = stream.revision + 1;
      db.prepare('UPDATE feedback_stream SET revision=?,updated_at=? WHERE plan_id=?').run(nextRevision, input.createdAt, input.planId);
      db.prepare(
        `INSERT INTO feedback_idempotency(key,fingerprint,operation,status,result_json,updated_at)
         VALUES(?,?,'feedback.analyze','running',?,?)`
      ).run(input.idempotencyKey, input.fingerprint, JSON.stringify({ streamRevision: nextRevision }), input.createdAt);
      return { kind: 'started', streamRevision: nextRevision };
    });
    return tx.immediate();
  }

  finishFeedbackAnalysis(input: FinishFeedbackAnalysisInput): { committed: boolean; streamRevision: number } {
    this.assertWritable();
    const resultErrors = validateFeedbackAnalysisResult(input.result);
    if (resultErrors.length) throw new Error(`invalid_feedback_analysis_result:${resultErrors.join('|')}`);
    if (input.attribution) {
      const attributionErrors = validateAttributionResult(input.attribution);
      if (attributionErrors.length) throw new Error(`invalid_attribution_result:${attributionErrors.join('|')}`);
    }
    if (input.correctionProposal) {
      const proposalErrors = validateCorrectionProposal(input.correctionProposal);
      if (proposalErrors.length) throw new Error(`invalid_correction_proposal:${proposalErrors.join('|')}`);
      if (!input.attribution || input.correctionProposal.plan_revision_id !== input.attribution.plan_revision_id) {
        throw new Error('correction_attribution_mismatch');
      }
    }
    if (!isIsoDateTime(input.updatedAt)) throw new Error('invalid_feedback_analysis_updated_at');
    if (!input.inputHash.trim()) throw new Error('invalid_feedback_analysis_input_hash');
    const db = this.requireDb();
    const tx = db.transaction((): { committed: boolean; streamRevision: number } => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as { fingerprint: string; operation: string; status: string } | undefined;
      if (!existing || existing.fingerprint !== input.fingerprint || existing.operation !== 'feedback.analyze') throw new FeedbackKeyReuseError();
      const stream = db
        .prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      if (!stream || stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (stream.revision !== input.expectedRevision) {
        if (input.runId) {
          const updated = db.prepare(
            `UPDATE attribution_run SET status='stale',result_json=?,model_job_id=?,content_origin=?,updated_at=?
             WHERE run_id=? AND plan_id=? AND input_hash=?`
          ).run(input.attribution ? JSON.stringify(input.attribution) : null, input.modelJobId, input.contentOrigin, input.updatedAt, input.runId, input.planId, input.inputHash);
          if (updated.changes !== 1) throw new StoreProtectedError('attribution_run_input_hash_mismatch');
        }
        db.prepare("UPDATE feedback_idempotency SET status='failed',result_json=NULL,updated_at=? WHERE key=?").run(input.updatedAt, input.idempotencyKey);
        return { committed: false, streamRevision: stream.revision };
      }

      const finalRevision = input.advanceRevision ? stream.revision + 1 : stream.revision;
      if (input.result.streamRevision !== finalRevision) throw new Error('feedback_analysis_result_revision_mismatch');
      if (input.runId) {
        const updated = db.prepare(
          `UPDATE attribution_run SET status=?,result_json=?,model_job_id=?,content_origin=?,updated_at=?
           WHERE run_id=? AND plan_id=? AND input_hash=?`
        ).run(input.runStatus, input.attribution ? JSON.stringify(input.attribution) : null, input.modelJobId, input.contentOrigin, input.updatedAt, input.runId, input.planId, input.inputHash);
        if (updated.changes !== 1) throw new StoreProtectedError('attribution_run_input_hash_mismatch');
      }
      if (input.correctionProposal) {
        const allowedObservationIds = new Set(input.attribution?.hypotheses.flatMap((item) => item.observation_ids) ?? []);
        if (input.correctionProposal.observation_ids.some((id) => !allowedObservationIds.has(id))) {
          throw new FeedbackSourceMissingError();
        }
        const correctionRecord: CorrectionRecord = {
          proposal: input.correctionProposal,
          decisionEvents: [],
          currentStatus: 'proposed',
          stateRevision: 0,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt
        };
        const recordErrors = validateCorrectionRecord(correctionRecord);
        if (recordErrors.length) throw new Error(`invalid_correction_record:${recordErrors.join('|')}`);
        db.prepare(
          `INSERT INTO correction_proposal(proposal_id,workspace_id,plan_id,proposal_json,state_revision,created_at,updated_at)
           VALUES(?,?,?,?,0,?,?)`
        ).run(
          input.correctionProposal.change_id,
          input.workspaceId,
          input.planId,
          JSON.stringify(correctionRecord),
          input.updatedAt,
          input.updatedAt
        );
      }
      if (input.advanceRevision) db.prepare('UPDATE feedback_stream SET revision=?,updated_at=? WHERE plan_id=?').run(finalRevision, input.updatedAt, input.planId);
      db.prepare("UPDATE feedback_idempotency SET status='succeeded',result_json=?,updated_at=? WHERE key=?").run(JSON.stringify(input.result), input.updatedAt, input.idempotencyKey);
      return { committed: true, streamRevision: finalRevision };
    });
    return tx.immediate();
  }

  getFeedbackAnalysisHistory(planId: string): FeedbackAnalysisHistory {
    const db = this.requireDb();
    const measurementRows = db
      .prepare('SELECT review_json reviewJson FROM measurement_review WHERE plan_id=? ORDER BY created_at,review_id')
      .all(planId) as Array<{ reviewJson: string }>;
    const measurementReviews = measurementRows.map((row) => {
      let value: unknown;
      try { value = JSON.parse(row.reviewJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_measurement_review:json'); }
      const errors = validateMeasurementReview(value);
      if (errors.length) throw new StoreProtectedError(`invalid_stored_measurement_review:${errors.join('|')}`);
      return value as MeasurementReview;
    });
    const runRows = db
      .prepare(
        `SELECT run_id runId,workspace_id workspaceId,plan_id planId,teaching_event_id teachingEventId,
                input_hash inputHash,status,result_json resultJson,model_job_id modelJobId,
                content_origin contentOrigin,created_at createdAt,updated_at updatedAt
         FROM attribution_run WHERE plan_id=? ORDER BY created_at,run_id`
      )
      .all(planId) as Array<{
        runId: string; workspaceId: string; planId: string; teachingEventId: string; inputHash: string;
        status: string; resultJson: string | null; modelJobId: string | null; contentOrigin: string | null;
        createdAt: string; updatedAt: string;
      }>;
    const statuses: AttributionRunStatus[] = ['running', 'succeeded', 'blocked', 'failed', 'uncertain', 'stale'];
    const origins: AttributionContentOrigin[] = ['real', 'offline-injected', 'simulated'];
    const attributionRuns = runRows.map((row) => {
      if (!statuses.includes(row.status as AttributionRunStatus)) throw new StoreProtectedError('invalid_stored_attribution_run:status');
      if (row.contentOrigin !== null && !origins.includes(row.contentOrigin as AttributionContentOrigin)) throw new StoreProtectedError('invalid_stored_attribution_run:origin');
      let result: AttributionResult | null = null;
      if (row.resultJson !== null) {
        let parsed: unknown;
        try { parsed = JSON.parse(row.resultJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_attribution_result:json'); }
        const errors = validateAttributionResult(parsed);
        if (errors.length) throw new StoreProtectedError(`invalid_stored_attribution_result:${errors.join('|')}`);
        result = parsed as AttributionResult;
      }
      return {
        runId: row.runId, workspaceId: row.workspaceId, planId: row.planId,
        teachingEventId: row.teachingEventId, inputHash: row.inputHash,
        status: row.status as AttributionRunStatus, result, modelJobId: row.modelJobId,
        contentOrigin: row.contentOrigin as AttributionContentOrigin | null,
        createdAt: row.createdAt, updatedAt: row.updatedAt
      };
    });
    return { measurementReviews, attributionRuns };
  }

  getFeedbackCorrectionHistory(planId: string): FeedbackCorrectionHistory {
    const db = this.requireDb();
    const correctionRows = db
      .prepare('SELECT proposal_json proposalJson FROM correction_proposal WHERE plan_id=? ORDER BY created_at,proposal_id')
      .all(planId) as Array<{ proposalJson: string }>;
    const corrections = correctionRows.map((row) => {
      let value: unknown;
      try { value = JSON.parse(row.proposalJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_correction:json'); }
      const errors = validateCorrectionRecord(value);
      if (errors.length) throw new StoreProtectedError(`invalid_stored_correction:${errors.join('|')}`);
      return value as CorrectionRecord;
    });
    const preferenceRows = db
      .prepare('SELECT event_json eventJson FROM preference_event WHERE plan_id=? ORDER BY created_at,event_id')
      .all(planId) as Array<{ eventJson: string }>;
    const preferenceEvents = preferenceRows.map((row) => {
      let value: unknown;
      try { value = JSON.parse(row.eventJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_preference_event:json'); }
      const errors = validatePreferenceEvent(value);
      if (errors.length) throw new StoreProtectedError(`invalid_stored_preference_event:${errors.join('|')}`);
      return value as FeedbackCorrectionHistory['preferenceEvents'][number];
    });
    const effectRows = db
      .prepare('SELECT event_json eventJson FROM effect_evidence_event WHERE plan_id=? ORDER BY created_at,event_id')
      .all(planId) as Array<{ eventJson: string }>;
    const effectEvents = effectRows.map((row) => {
      let value: unknown;
      try { value = JSON.parse(row.eventJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_effect_event:json'); }
      const errors = validateEffectEvidenceEvent(value);
      if (errors.length) throw new StoreProtectedError(`invalid_stored_effect_event:${errors.join('|')}`);
      return value as FeedbackCorrectionHistory['effectEvents'][number];
    });
    const tombstoneRows = db
      .prepare('SELECT backup_scope_json valueJson FROM observation_tombstone WHERE plan_id=? ORDER BY deleted_at,observation_id')
      .all(planId) as Array<{ valueJson: string }>;
    const observationTombstones = tombstoneRows.map((row) => {
      let value: unknown;
      try { value = JSON.parse(row.valueJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_observation_tombstone:json'); }
      return parseObservationDeleteResult(value, 'invalid_stored_observation_tombstone');
    });
    let state: Pick<FeedbackCorrectionHistory, 'preferenceState' | 'effectState' | 'preferenceEvents' | 'effectEvents'> = {
      preferenceState: {}, effectState: 'unknown', preferenceEvents: [], effectEvents: []
    };
    for (const event of preferenceEvents) state = applyPreferenceEvent(state, event);
    for (const event of effectEvents) state = applyEffectEvidence(state, event);
    return { corrections, observationTombstones, ...state };
  }

  commitCorrectionDecision(input: CommitCorrectionDecisionInput): CorrectionDecisionResult {
    this.assertWritable();
    const decisionErrors = validateCorrectionDecisionEvent(input.decisionEvent);
    if (decisionErrors.length) throw new Error(`invalid_correction_decision:${decisionErrors.join('|')}`);
    if (input.preferenceEvent) {
      const errors = validatePreferenceEvent(input.preferenceEvent);
      if (errors.length) throw new Error(`invalid_preference_event:${errors.join('|')}`);
    }
    if (input.effectEvent) {
      const errors = validateEffectEvidenceEvent(input.effectEvent);
      if (errors.length) throw new Error(`invalid_effect_event:${errors.join('|')}`);
    }
    if (input.lessonChangeSuggestion) {
      const errors = validateLessonChange(input.lessonChangeSuggestion);
      if (errors.length) throw new Error(`invalid_lesson_change_suggestion:${errors.join('|')}`);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.expectedProposalRevision) || input.expectedProposalRevision < 0) {
      throw new Error('invalid_correction_revision');
    }
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim() || !isIsoDateTime(input.updatedAt)) {
      throw new Error('invalid_correction_identity');
    }
    if (input.decisionEvent.proposal_id !== input.proposalId ||
        input.preferenceEvent && input.preferenceEvent.proposal_id !== input.proposalId ||
        input.effectEvent && input.effectEvent.proposal_id !== input.proposalId) {
      throw new Error('correction_event_identity_mismatch');
    }
    const operation = input.decisionEvent.action === 'revert' ? 'corrections.revert' : 'corrections.decide';
    const db = this.requireDb();
    const tx = db.transaction((): CorrectionDecisionResult => {
      const existing = db
        .prepare('SELECT fingerprint,operation,status,result_json resultJson FROM feedback_idempotency WHERE key=?')
        .get(input.idempotencyKey) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.operation !== operation) throw new FeedbackKeyReuseError();
        if (existing.status !== 'succeeded' || !existing.resultJson) throw new StoreProtectedError('correction_idempotency_incomplete');
        let parsed: unknown;
        try { parsed = JSON.parse(existing.resultJson) as unknown; } catch { throw new StoreProtectedError('invalid_correction_idempotency:json'); }
        if (!isRecord(parsed) || parsed.proposalId !== input.proposalId ||
            !Number.isSafeInteger(parsed.stateRevision) || !Number.isSafeInteger(parsed.streamRevision) ||
            !['accepted', 'rejected', 'reverted'].includes(String(parsed.currentStatus)) ||
            typeof parsed.preferenceState !== 'object' || parsed.preferenceState === null ||
            !['unknown', 'initial_support', 'repeated_support', 'disconfirmed'].includes(String(parsed.effectState))) {
          throw new StoreProtectedError('invalid_correction_idempotency_result');
        }
        return { ...(parsed as unknown as CorrectionDecisionResult), replayed: true };
      }

      const stream = db.prepare('SELECT workspace_id workspaceId,revision FROM feedback_stream WHERE plan_id=?')
        .get(input.planId) as { workspaceId: string; revision: number } | undefined;
      if (!stream || stream.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (stream.revision !== input.expectedRevision) throw new FeedbackVersionConflictError();
      const row = db.prepare(
        'SELECT workspace_id workspaceId,proposal_json proposalJson,state_revision stateRevision,created_at createdAt FROM correction_proposal WHERE proposal_id=? AND plan_id=?'
      ).get(input.proposalId, input.planId) as { workspaceId: string; proposalJson: string; stateRevision: number; createdAt: string } | undefined;
      if (!row || row.workspaceId !== input.workspaceId) throw new FeedbackSourceMissingError();
      if (row.stateRevision !== input.expectedProposalRevision) throw new CorrectionVersionConflictError();
      let stored: unknown;
      try { stored = JSON.parse(row.proposalJson) as unknown; } catch { throw new StoreProtectedError('invalid_stored_correction:json'); }
      const storedErrors = validateCorrectionRecord(stored);
      if (storedErrors.length) throw new StoreProtectedError(`invalid_stored_correction:${storedErrors.join('|')}`);
      const current = stored as CorrectionRecord;
      for (const observationId of current.proposal.observation_ids) {
        const observation = db.prepare(
          'SELECT 1 FROM learning_observation WHERE observation_id=? AND workspace_id=? AND plan_id=?'
        ).get(observationId, input.workspaceId, input.planId);
        if (!observation) throw new FeedbackSourceMissingError();
      }
      if (input.decisionEvent.state_revision !== current.stateRevision + 1) throw new CorrectionVersionConflictError();
      const decisionEvents = [...current.decisionEvents, input.decisionEvent];
      let currentStatus;
      try { currentStatus = deriveCorrectionStatus(decisionEvents); } catch { throw new CorrectionVersionConflictError(); }
      const updatedRecord: CorrectionRecord = {
        ...current, decisionEvents, currentStatus,
        stateRevision: current.stateRevision + 1,
        updatedAt: input.updatedAt
      };
      const updated = db.prepare(
        'UPDATE correction_proposal SET proposal_json=?,state_revision=?,updated_at=? WHERE proposal_id=? AND plan_id=? AND state_revision=?'
      ).run(JSON.stringify(updatedRecord), updatedRecord.stateRevision, input.updatedAt, input.proposalId, input.planId, input.expectedProposalRevision);
      if (updated.changes !== 1) throw new CorrectionVersionConflictError();
      this.feedbackFaults?.afterCorrectionProposalUpdate?.();

      const before = this.getFeedbackCorrectionHistory(input.planId);
      let evidence = {
        preferenceState: before.preferenceState,
        effectState: before.effectState,
        preferenceEvents: before.preferenceEvents,
        effectEvents: before.effectEvents
      };
      if (input.preferenceEvent) {
        db.prepare(
          'INSERT INTO preference_event(event_id,workspace_id,plan_id,proposal_id,event_json,created_at) VALUES(?,?,?,?,?,?)'
        ).run(input.preferenceEvent.event_id, input.workspaceId, input.planId, input.proposalId, JSON.stringify(input.preferenceEvent), input.preferenceEvent.created_at);
        this.feedbackFaults?.afterPreferenceInsert?.();
        evidence = applyPreferenceEvent(evidence, input.preferenceEvent);
      }
      if (input.effectEvent) {
        for (const observationId of input.effectEvent.observation_ids) {
          const observation = db.prepare(
            'SELECT 1 FROM learning_observation WHERE observation_id=? AND workspace_id=? AND plan_id=?'
          ).get(observationId, input.workspaceId, input.planId);
          if (!observation) throw new FeedbackSourceMissingError();
        }
        evidence = applyEffectEvidence(evidence, input.effectEvent);
        db.prepare(
          'INSERT INTO effect_evidence_event(event_id,workspace_id,plan_id,proposal_id,event_json,created_at) VALUES(?,?,?,?,?,?)'
        ).run(input.effectEvent.event_id, input.workspaceId, input.planId, input.proposalId, JSON.stringify(input.effectEvent), input.effectEvent.created_at);
        this.feedbackFaults?.afterEffectInsert?.();
      }
      const nextRevision = stream.revision + 1;
      db.prepare('UPDATE feedback_stream SET revision=?,updated_at=? WHERE plan_id=?').run(nextRevision, input.updatedAt, input.planId);
      this.feedbackFaults?.afterFeedbackStreamIncrement?.();
      const result: CorrectionDecisionResult = {
        proposalId: input.proposalId,
        currentStatus,
        stateRevision: updatedRecord.stateRevision,
        streamRevision: nextRevision,
        lessonChangeSuggestion: input.lessonChangeSuggestion,
        preferenceState: evidence.preferenceState,
        effectState: evidence.effectState,
        replayed: false
      };
      this.feedbackFaults?.beforeFeedbackIdempotency?.();
      db.prepare(
        'INSERT INTO feedback_idempotency(key,fingerprint,operation,status,result_json,updated_at) VALUES(?,?,?,?,?,?)'
      ).run(input.idempotencyKey, input.fingerprint, operation, 'succeeded', JSON.stringify(result), input.updatedAt);
      return result;
    });
    return tx.immediate();
  }

  // ===== G12 备课会话持久化 =====
  private preparationFingerprint(operation: string, payload: unknown): string {
    return createHash('sha256').update(canonicalJson({ operation, payload })).digest('hex');
  }

  private readPreparationReplay<T>(
    db: Database.Database,
    operation: string,
    key: string,
    fingerprint: string
  ): T | null {
    if (!key.trim() || key.length > 160) throw new Error('invalid_preparation_idempotency');
    const existing = db.prepare(
      'SELECT fingerprint,operation,status,result_json resultJson FROM maintenance_idempotency WHERE key=?'
    ).get(key) as { fingerprint: string; operation: string; status: string; resultJson: string | null } | undefined;
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint || existing.operation !== operation) throw new PreparationKeyReuseError();
    if (existing.status !== 'succeeded' || !existing.resultJson) {
      throw new StoreProtectedError('preparation_idempotency_incomplete');
    }
    try {
      return JSON.parse(existing.resultJson) as T;
    } catch {
      throw new StoreProtectedError('preparation_idempotency_invalid');
    }
  }

  private savePreparationReplay(
    db: Database.Database,
    operation: string,
    key: string,
    fingerprint: string,
    result: unknown,
    updatedAt: string
  ): void {
    db.prepare(
      `INSERT INTO maintenance_idempotency(key,fingerprint,operation,status,result_json,updated_at)
       VALUES(?,?,?,'succeeded',?,?)`
    ).run(key, fingerprint, operation, JSON.stringify(result), updatedAt);
  }

  private mapTeachingContext(row: Record<string, unknown>): TeachingContext {
    return {
      contextId: String(row.contextId),
      classDisplayName: String(row.classDisplayName),
      grade: String(row.grade) as TeachingContext['grade'],
      textbookTitle: String(row.textbookTitle),
      textbookEdition: String(row.textbookEdition),
      unitTitle: String(row.unitTitle),
      lessonTitle: String(row.lessonTitle),
      durationSec: Number(row.durationSec),
      notes: String(row.notes),
      revision: Number(row.revision),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    };
  }

  getTeachingContext(contextId: string): TeachingContext | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT context_id contextId,class_display_name classDisplayName,grade,
              textbook_title textbookTitle,textbook_edition textbookEdition,unit_title unitTitle,
              lesson_title lessonTitle,duration_sec durationSec,notes,revision,
              created_at createdAt,updated_at updatedAt
       FROM teaching_context WHERE context_id=?`
    ).get(contextId) as Record<string, unknown> | undefined;
    return row ? this.mapTeachingContext(row) : null;
  }

  saveTeachingContext(
    input: TeachingContextInput,
    expectedRevision: number,
    idempotencyKey: string
  ): TeachingContext {
    this.assertWritable();
    assertTeachingContextInput(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_expected_revision');
    const operation = 'preparation.context.save';
    const fingerprint = this.preparationFingerprint(operation, { input, expectedRevision });
    const db = this.requireDb();
    return db.transaction((): TeachingContext => {
      const replay = this.readPreparationReplay<TeachingContext>(db, operation, idempotencyKey, fingerprint);
      if (replay) return replay;
      const now = new Date().toISOString();
      const contextId = input.contextId ?? `context_${randomUUID()}`;
      const current = this.getTeachingContext(contextId);
      if (!current) {
        if (expectedRevision !== 0) throw new PreparationVersionConflictError();
        db.prepare(
          `INSERT INTO teaching_context(
             context_id,class_display_name,grade,textbook_title,textbook_edition,unit_title,
             lesson_title,duration_sec,notes,revision,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`
        ).run(
          contextId, input.classDisplayName, input.grade, input.textbookTitle, input.textbookEdition,
          input.unitTitle, input.lessonTitle, input.durationSec, input.notes, now, now
        );
      } else {
        if (current.revision !== expectedRevision) throw new PreparationVersionConflictError();
        const updated = db.prepare(
          `UPDATE teaching_context SET class_display_name=?,grade=?,textbook_title=?,textbook_edition=?,
             unit_title=?,lesson_title=?,duration_sec=?,notes=?,revision=revision+1,updated_at=?
           WHERE context_id=? AND revision=?`
        ).run(
          input.classDisplayName, input.grade, input.textbookTitle, input.textbookEdition,
          input.unitTitle, input.lessonTitle, input.durationSec, input.notes, now, contextId, expectedRevision
        );
        if (updated.changes !== 1) throw new PreparationVersionConflictError();
        db.prepare(
          `UPDATE preparation_session
           SET status='PLAN_REVIEW',review_report_id=NULL,bundle_id=NULL,
               last_error_code='PREPARATION_STALE',revision=revision+1,updated_at=?
           WHERE context_id=? AND plan_id IS NOT NULL`
        ).run(now, contextId);
      }
      const result = this.getTeachingContext(contextId);
      if (!result) throw new StoreProtectedError('preparation_context_write_missing');
      this.savePreparationReplay(db, operation, idempotencyKey, fingerprint, result, now);
      return result;
    }).immediate();
  }

  private getPreparationSources(sessionId: string): PreparationSourceSelection[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT session_id sessionId,ordinal,source_version_id sourceVersionId,char_start charStart,
              char_end charEnd,purpose,approved_for_model approvedForModel,text_sha256 textSha256
       FROM preparation_source WHERE session_id=? ORDER BY ordinal`
    ).all(sessionId) as Array<Omit<PreparationSourceSelection, 'approvedForModel'> & { approvedForModel: number }>;
    return rows.map((row) => ({ ...row, approvedForModel: row.approvedForModel === 1 }));
  }

  private mapPreparationSession(row: Record<string, unknown>): PreparationSession {
    const sessionId = String(row.sessionId);
    return {
      sessionId,
      contextId: String(row.contextId),
      status: String(row.status) as PreparationStatus,
      mode: String(row.mode) as PreparationMode,
      focus: String(row.focus),
      coreTask: String(row.coreTask),
      answerScope: String(row.answerScope),
      planId: (row.planId as string | null) ?? null,
      revisionId: (row.revisionId as string | null) ?? null,
      reviewReportId: (row.reviewReportId as string | null) ?? null,
      bundleId: (row.bundleId as string | null) ?? null,
      modelJobId: (row.modelJobId as string | null) ?? null,
      contentOrigin: String(row.contentOrigin) as PreparationSession['contentOrigin'],
      lastErrorCode: (row.lastErrorCode as PreparationSession['lastErrorCode']) ?? null,
      revision: Number(row.revision),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      sources: this.getPreparationSources(sessionId)
    };
  }

  getPreparationSession(sessionId: string): PreparationSession | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT session_id sessionId,context_id contextId,status,mode,focus,core_task coreTask,
              answer_scope answerScope,plan_id planId,revision_id revisionId,
              review_report_id reviewReportId,bundle_id bundleId,model_job_id modelJobId,
              content_origin contentOrigin,last_error_code lastErrorCode,revision,
              created_at createdAt,updated_at updatedAt
       FROM preparation_session WHERE session_id=?`
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapPreparationSession(row) : null;
  }

  listPreparationSessions(): PreparationSession[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT session_id sessionId,context_id contextId,status,mode,focus,core_task coreTask,
              answer_scope answerScope,plan_id planId,revision_id revisionId,
              review_report_id reviewReportId,bundle_id bundleId,model_job_id modelJobId,
              content_origin contentOrigin,last_error_code lastErrorCode,revision,
              created_at createdAt,updated_at updatedAt
       FROM preparation_session ORDER BY updated_at DESC,session_id`
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapPreparationSession(row));
  }

  createPreparationSession(
    contextId: string,
    mode: PreparationMode,
    idempotencyKey: string
  ): PreparationSession {
    this.assertWritable();
    assertPreparationId(contextId, 'context_id');
    if (!inClosedSet(mode, PREPARATION_MODES)) throw new Error('invalid_preparation_mode');
    const operation = 'preparation.session.create';
    const fingerprint = this.preparationFingerprint(operation, { contextId, mode });
    const db = this.requireDb();
    return db.transaction((): PreparationSession => {
      const replay = this.readPreparationReplay<PreparationSession>(db, operation, idempotencyKey, fingerprint);
      if (replay) return replay;
      if (!this.getTeachingContext(contextId)) throw new Error('preparation_context_missing');
      const now = new Date().toISOString();
      const sessionId = `session_${randomUUID()}`;
      db.prepare(
        `INSERT INTO preparation_session(
           session_id,context_id,status,mode,focus,core_task,answer_scope,content_origin,revision,created_at,updated_at
         ) VALUES(?,?,'CONTEXT_DRAFT',?,'','','','teacher_authored',1,?,?)`
      ).run(sessionId, contextId, mode, now, now);
      const result = this.getPreparationSession(sessionId);
      if (!result) throw new StoreProtectedError('preparation_session_write_missing');
      this.savePreparationReplay(db, operation, idempotencyKey, fingerprint, result, now);
      return result;
    }).immediate();
  }

  replacePreparationSources(
    sessionId: string,
    sources: PreparationSourceInput[],
    expectedRevision: number,
    idempotencyKey: string
  ): PreparationSession {
    this.assertWritable();
    assertPreparationId(sessionId, 'session_id');
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 50) throw new Error('invalid_preparation_sources');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid_expected_revision');
    const normalized = sources.map((source) => ({ ...source }));
    const unique = new Set<string>();
    for (const source of normalized) {
      assertPreparationId(source.sourceVersionId, 'source_version_id');
      if (!Number.isSafeInteger(source.charStart) || !Number.isSafeInteger(source.charEnd) || source.charStart < 0 || source.charEnd <= source.charStart) {
        throw new Error('invalid_preparation_source_range');
      }
      if (!inClosedSet(source.purpose, PREPARATION_SOURCE_PURPOSES) || typeof source.approvedForModel !== 'boolean' || !/^[a-f0-9]{64}$/u.test(source.textSha256)) {
        throw new Error('invalid_preparation_source');
      }
      const key = `${source.sourceVersionId}:${source.charStart}:${source.charEnd}`;
      if (unique.has(key)) throw new Error('duplicate_preparation_source');
      unique.add(key);
      const meta = this.getVersionMeta(source.sourceVersionId);
      const exact = this.readExactRange(source.sourceVersionId, source.charStart, source.charEnd);
      if (!meta || !meta.isCurrent || !exact || source.charEnd > exact.fullLength) throw new Error('preparation_source_changed');
      const actualHash = createHash('sha256').update(exact.text).digest('hex');
      if (actualHash !== source.textSha256) throw new Error('preparation_source_changed');
    }
    const operation = 'preparation.sources.set';
    const fingerprint = this.preparationFingerprint(operation, { sessionId, sources: normalized, expectedRevision });
    const db = this.requireDb();
    return db.transaction((): PreparationSession => {
      const replay = this.readPreparationReplay<PreparationSession>(db, operation, idempotencyKey, fingerprint);
      if (replay) return replay;
      const current = this.getPreparationSession(sessionId);
      if (!current || current.revision !== expectedRevision) throw new PreparationVersionConflictError();
      db.prepare('DELETE FROM preparation_source WHERE session_id=?').run(sessionId);
      const insert = db.prepare(
        `INSERT INTO preparation_source(
           session_id,ordinal,source_version_id,char_start,char_end,purpose,approved_for_model,text_sha256
         ) VALUES(?,?,?,?,?,?,?,?)`
      );
      normalized.forEach((source, ordinal) => insert.run(
        sessionId, ordinal, source.sourceVersionId, source.charStart, source.charEnd,
        source.purpose, source.approvedForModel ? 1 : 0, source.textSha256
      ));
      const now = new Date().toISOString();
      const updated = db.prepare(
        `UPDATE preparation_session SET status='SOURCES_SELECTED',plan_id=NULL,revision_id=NULL,
           review_report_id=NULL,bundle_id=NULL,model_job_id=NULL,last_error_code=NULL,
           revision=revision+1,updated_at=? WHERE session_id=? AND revision=?`
      ).run(now, sessionId, expectedRevision);
      if (updated.changes !== 1) throw new PreparationVersionConflictError();
      const result = this.getPreparationSession(sessionId);
      if (!result) throw new StoreProtectedError('preparation_session_write_missing');
      this.savePreparationReplay(db, operation, idempotencyKey, fingerprint, result, now);
      return result;
    }).immediate();
  }

  transitionPreparationSession(
    sessionId: string,
    fromRevision: number,
    nextStatus: PreparationStatus,
    patch: PreparationSessionPatch,
    idempotencyKey: string
  ): PreparationSession {
    this.assertWritable();
    assertPreparationId(sessionId, 'session_id');
    if (!Number.isSafeInteger(fromRevision) || fromRevision < 1 || !inClosedSet(nextStatus, PREPARATION_STATUSES)) {
      throw new Error('invalid_preparation_transition');
    }
    if (patch.focus !== undefined && (typeof patch.focus !== 'string' || patch.focus.length > 2_000)) throw new Error('invalid_focus');
    if (patch.coreTask !== undefined && (typeof patch.coreTask !== 'string' || patch.coreTask.length > 4_000)) throw new Error('invalid_core_task');
    if (patch.answerScope !== undefined && (typeof patch.answerScope !== 'string' || patch.answerScope.length > 4_000)) throw new Error('invalid_answer_scope');
    if (patch.contentOrigin !== undefined && !inClosedSet(patch.contentOrigin, PREPARATION_CONTENT_ORIGINS)) throw new Error('invalid_content_origin');
    if (patch.lastErrorCode !== undefined && patch.lastErrorCode !== null && !inClosedSet(patch.lastErrorCode, PREPARATION_ERROR_CODES)) {
      throw new Error('invalid_preparation_error');
    }
    const operation = 'preparation.session.transition';
    const fingerprint = this.preparationFingerprint(operation, { sessionId, fromRevision, nextStatus, patch });
    const db = this.requireDb();
    return db.transaction((): PreparationSession => {
      const replay = this.readPreparationReplay<PreparationSession>(db, operation, idempotencyKey, fingerprint);
      if (replay) return replay;
      const current = this.getPreparationSession(sessionId);
      if (!current || current.revision !== fromRevision) throw new PreparationVersionConflictError();
      if (!canTransition(current.status, nextStatus)) throw new PreparationTransitionError();
      const next = { ...current, ...patch };
      const now = new Date().toISOString();
      const updated = db.prepare(
        `UPDATE preparation_session SET status=?,focus=?,core_task=?,answer_scope=?,plan_id=?,revision_id=?,
           review_report_id=?,bundle_id=?,model_job_id=?,content_origin=?,last_error_code=?,
           revision=revision+1,updated_at=? WHERE session_id=? AND revision=?`
      ).run(
        nextStatus, next.focus, next.coreTask, next.answerScope, next.planId, next.revisionId,
        next.reviewReportId, next.bundleId, next.modelJobId, next.contentOrigin, next.lastErrorCode,
        now, sessionId, fromRevision
      );
      if (updated.changes !== 1) throw new PreparationVersionConflictError();
      const result = this.getPreparationSession(sessionId);
      if (!result) throw new StoreProtectedError('preparation_session_write_missing');
      this.savePreparationReplay(db, operation, idempotencyKey, fingerprint, result, now);
      return result;
    }).immediate();
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
                sv.version version, sd.revision revision, sv.content_hash contentHash
         FROM source_document sd LEFT JOIN source_version sv ON sv.id=sd.current_version_id
         ORDER BY sd.updated_at DESC`
      )
      .all() as SourceListItem[];
  }

  listAllMaterialArtifacts(): import('../store').MaterialArtifactRecord[] {
    if (!this.db) return [];
    return this.db.prepare(
      'SELECT id,plan_id planId,revision_id revisionId,role,format,filename,path,sha256,byte_size byteSize,content_origin contentOrigin,created_at createdAt,bundle_id bundleId FROM material_artifact ORDER BY created_at,id'
    ).all() as import('../store').MaterialArtifactRecord[];
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

  dataGeneration(): number {
    if (!this.db) return 0;
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
    if (!table) return 0;
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key='data_generation'").get() as { value: string } | undefined;
    if (!row) return 0;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new StoreProtectedError('data_generation_invalid');
    return value;
  }

  diagnosticsSnapshot(): DiagnosticsStorageSnapshot {
    const db = this.requireDb();
    const count = (table: string): number => Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
    const state = db.prepare(
      `SELECT last_backup_code lastBackupCode,last_restore_code lastRestoreCode,
              repeated_failure_count repeatedFailureCount
       FROM maintenance_state WHERE id=1`
    ).get() as { lastBackupCode: string | null; lastRestoreCode: string | null; repeatedFailureCount: number };
    const errors = db.prepare(
      `SELECT code,SUM(count) count FROM (
         SELECT code,count FROM maintenance_error_count WHERE count>0
         UNION ALL
         SELECT error_code code,COUNT(*) count FROM model_job WHERE error_code IS NOT NULL GROUP BY error_code
         UNION ALL
         SELECT error_code code,COUNT(*) count FROM lesson_change_idempotency WHERE error_code IS NOT NULL GROUP BY error_code
       ) GROUP BY code ORDER BY code LIMIT 100`
    ).all() as Array<{ code: string; count: number }>;
    return {
      schemaVersion: this.schemaVersion(),
      protected: this.isProtected(),
      credentialEncryption: this.credentialEncryptionAvailable(),
      objectCounts: {
        sources: count('source_document'),
        lessonPlans: count('lesson_plan'),
        materialBundles: count('material_bundle'),
        teachingEvents: count('teaching_event'),
        observations: count('learning_observation'),
        modelJobs: count('model_job')
      },
      maintenance: {
        lastBackupCode: state.lastBackupCode,
        lastRestoreCode: state.lastRestoreCode,
        repeatedFailureCount: state.repeatedFailureCount
      },
      errors
    };
  }

  recordMaintenanceFailure(input: {
    scope: 'backup' | 'restore' | 'diagnostics';
    code: string;
    automatic?: boolean;
    at: string;
  }): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.code) || Number.isNaN(Date.parse(input.at))) {
      throw new Error('maintenance_status_invalid');
    }
    this.withTransaction((db) => {
      db.prepare(
        `INSERT INTO maintenance_error_count(code,count,updated_at) VALUES(?,1,?)
         ON CONFLICT(code) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`
      ).run(input.code, input.at);
      if (input.scope === 'backup') {
        db.prepare(
          `UPDATE maintenance_state
           SET last_backup_code=?,repeated_failure_count=repeated_failure_count+?,updated_at=? WHERE id=1`
        ).run(input.code, input.automatic ? 1 : 0, input.at);
      } else if (input.scope === 'restore') {
        db.prepare('UPDATE maintenance_state SET last_restore_code=?,updated_at=? WHERE id=1')
          .run(input.code, input.at);
      } else {
        db.prepare('UPDATE maintenance_state SET updated_at=? WHERE id=1').run(input.at);
      }
    });
  }

  recordMaintenanceSuccess(input: {
    scope: 'backup' | 'restore';
    code: string;
    at: string;
  }): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.code) || Number.isNaN(Date.parse(input.at))) {
      throw new Error('maintenance_status_invalid');
    }
    this.withTransaction((db) => {
      if (input.scope === 'backup') {
        db.prepare(
          'UPDATE maintenance_state SET last_backup_code=?,repeated_failure_count=0,updated_at=? WHERE id=1'
        ).run(input.code, input.at);
      } else {
        db.prepare('UPDATE maintenance_state SET last_restore_code=?,updated_at=? WHERE id=1')
          .run(input.code, input.at);
      }
    });
  }

  async createSanitizedSnapshot(destination: string, mode: BackupKind): Promise<SnapshotSummary> {
    this.assertWritable();
    const db = this.requireDb();
    mkdirSync(dirname(destination), { recursive: true });
    await fs.rm(destination, { force: true });
    await db.backup(destination);
    let snapshot: Database.Database | null = null;
    try {
      snapshot = new Database(destination);
      snapshot.pragma('foreign_keys = ON');
      const integrity = snapshot.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new StoreProtectedError(`backup_integrity:${String(integrity)}`);
      const credentialRowsRemoved = snapshot.prepare('DELETE FROM credential').run().changes;
      const secureKeyRowsRemoved = mode === 'portable' ? snapshot.prepare('DELETE FROM secure_key').run().changes : 0;
      const schemaVersion = Number(snapshot.pragma('user_version', { simple: true }));
      snapshot.pragma('wal_checkpoint(TRUNCATE)');
      snapshot.close();
      snapshot = null;
      return { schemaVersion, credentialRowsRemoved, secureKeyRowsRemoved };
    } catch (error) {
      snapshot?.close();
      await fs.rm(destination, { force: true });
      throw error;
    }
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

  private ensureDataGenerationInDb(db: Database.Database): void {
    const generation = this.dataGeneration();
    if (generation > this.supportedDataGeneration) {
      this.enterProtected(`data_generation_newer:db=${generation}>app=${this.supportedDataGeneration}`);
      throw new StoreProtectedError(this.protectedReasonText!);
    }
    if (generation < this.supportedDataGeneration) {
      db.prepare(
        "INSERT INTO app_meta(key,value) VALUES('data_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(String(this.supportedDataGeneration));
    }
  }

  private assertWritable(): void {
    if (this.protectedState || !this.db) {
      throw new StoreProtectedError(this.protectedReasonText ?? 'protected');
    }
    this.ensureDataGenerationInDb(this.db);
  }

  private enterProtected(reason: string): void {
    this.protectedState = true;
    this.protectedReasonText = reason;
  }
}

export const SQLITE_SCHEMA_TARGET = SCHEMA_TARGET;
export const SQLITE_DATA_GENERATION = DATA_GENERATION_TARGET;
