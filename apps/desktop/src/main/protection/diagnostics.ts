import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { ERROR_CODES } from '../../shared/ipc';
import type { ProtectionFaultHooks } from './types';

export interface DiagnosticsObjectCounts {
  sources: number;
  lessonPlans: number;
  materialBundles: number;
  teachingEvents: number;
  observations: number;
  modelJobs: number;
}

export interface DiagnosticsStorageSnapshot {
  schemaVersion: number;
  protected: boolean;
  credentialEncryption: boolean;
  objectCounts: DiagnosticsObjectCounts;
  maintenance: {
    lastBackupCode: string | null;
    lastRestoreCode: string | null;
    repeatedFailureCount: number;
  };
  errors: Array<{ code: string; count: number }>;
}

export interface DiagnosticsStoreLike {
  diagnosticsSnapshot(): DiagnosticsStorageSnapshot;
  getMaintenanceIdempotency?(key: string): { fingerprint: string; operation: string; status: string; resultJson: string | null } | null;
  reserveMaintenanceIdempotency?(input: {
    key: string; fingerprint: string; operation: string; updatedAt: string;
  }): 'reserved' | 'existing';
  saveMaintenanceIdempotency?(input: {
    key: string; fingerprint: string; operation: string; resultJson: string; updatedAt: string;
  }): void;
  recordMaintenanceFailure?(input: {
    scope: 'diagnostics'; code: string; at: string;
  }): void;
}

export interface DiagnosticsPreview {
  format: 'yuwendesk-diagnostics';
  version: 1;
  generatedAt: string;
  appVersion: string;
  buildMode: 'development' | 'production';
  platform: {
    targetSupported: boolean;
    identity: string;
    sandboxEnabled: boolean;
  };
  storage: {
    schemaVersion: number;
    protected: boolean;
    credentialEncryption: boolean;
    objectCounts: DiagnosticsObjectCounts;
  };
  maintenance: {
    validBackups: number;
    invalidBackups: number;
    lastBackupCode: string | null;
    lastRestoreCode: string | null;
    repeatedFailureCount: number;
  };
  errors: Array<{ code: string; count: number }>;
  network: {
    automaticUpload: false;
    localHttpService: 'not_started_by_design';
  };
}

interface DiagnosticsPreviewInput {
  generatedAt: string;
  appVersion: string;
  buildMode: 'development' | 'production';
  platform: { targetSupported: boolean; identity: string; sandboxEnabled: boolean };
  storage: DiagnosticsStorageSnapshot;
  backupSummary: { validBackups: number; invalidBackups: number };
}

export interface DiagnosticSaveResult {
  saved?: true;
  cancelled?: true;
  previewHash: string;
  sha256?: string;
  byteSize?: number;
}

interface DiagnosticsServiceOptions {
  appVersion: string;
  buildMode: 'development' | 'production';
  platform: { targetSupported: boolean; identity: string; sandboxEnabled: boolean };
  store: DiagnosticsStoreLike;
  backups: { diagnosticsSummary(): Promise<{ validBackups: number; invalidBackups: number }> };
  chooseSavePath(): Promise<string | null>;
  now?: () => Date;
  faults?: Pick<ProtectionFaultHooks, 'beforeDiagnosticsRename'>;
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000_000)
    : 0;
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value) ? value : fallback;
}

const DIAGNOSTIC_ERROR_CODES = new Set<string>([
  ...ERROR_CODES,
  'UNKNOWN',
  'JOB_CANCELLED_DISPATCHED',
  'AUTO_BACKUP_FAILED',
  'BACKUP_CREATE_FAILED',
  'BACKUP_OK',
  'RESTORE_FAILED',
  'RESTORE_PENDING',
  'RESTORE_PREVIEW_OK',
  'RESTORE_OK',
  'RESTORE_ROLLED_BACK',
  'DIAGNOSTIC_SAVE_FAILED'
]);

function safeCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && DIAGNOSTIC_ERROR_CODES.has(value) ? value : 'UNKNOWN';
}

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildDiagnosticsPreview(input: DiagnosticsPreviewInput): DiagnosticsPreview {
  const counts = input.storage.objectCounts;
  const combinedErrors = new Map<string, number>();
  for (const item of input.storage.errors) {
    const code = safeCode(item.code);
    const count = boundedCount(item.count);
    if (code && count > 0) combinedErrors.set(code, Math.min(1_000_000_000, (combinedErrors.get(code) ?? 0) + count));
  }
  const errors = [...combinedErrors]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, 100);
  return {
    format: 'yuwendesk-diagnostics',
    version: 1,
    generatedAt: new Date(input.generatedAt).toISOString(),
    appVersion: safeIdentifier(input.appVersion, 'unknown'),
    buildMode: input.buildMode === 'production' ? 'production' : 'development',
    platform: {
      targetSupported: input.platform.targetSupported === true,
      identity: safeIdentifier(input.platform.identity, 'unknown'),
      sandboxEnabled: input.platform.sandboxEnabled === true
    },
    storage: {
      schemaVersion: boundedCount(input.storage.schemaVersion),
      protected: input.storage.protected === true,
      credentialEncryption: input.storage.credentialEncryption === true,
      objectCounts: {
        sources: boundedCount(counts.sources),
        lessonPlans: boundedCount(counts.lessonPlans),
        materialBundles: boundedCount(counts.materialBundles),
        teachingEvents: boundedCount(counts.teachingEvents),
        observations: boundedCount(counts.observations),
        modelJobs: boundedCount(counts.modelJobs)
      }
    },
    maintenance: {
      validBackups: boundedCount(input.backupSummary.validBackups),
      invalidBackups: boundedCount(input.backupSummary.invalidBackups),
      lastBackupCode: safeCode(input.storage.maintenance.lastBackupCode),
      lastRestoreCode: safeCode(input.storage.maintenance.lastRestoreCode),
      repeatedFailureCount: boundedCount(input.storage.maintenance.repeatedFailureCount)
    },
    errors,
    network: { automaticUpload: false, localHttpService: 'not_started_by_design' }
  };
}

export function canonicalDiagnosticsJson(preview: DiagnosticsPreview): string {
  return JSON.stringify(preview);
}

const README = [
  '语文备课工作台最小诊断包',
  '',
  '本包只包含已在应用内完整预览的白名单状态和计数。',
  '不包含资料正文、学生作答、文件名、本地路径、API 密钥、提示词或模型完整输入输出。',
  '应用不会自动上传此诊断包；是否以及如何发送由持有人自行决定。',
  ''
].join('\n');

export class DiagnosticsService {
  private readonly now: () => Date;
  private readonly previews = new Map<string, DiagnosticsPreview>();
  private readonly saved = new Map<string, { previewHash: string; result: DiagnosticSaveResult }>();

  constructor(private readonly options: DiagnosticsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private async collect(generatedAt: string): Promise<DiagnosticsPreview> {
    return buildDiagnosticsPreview({
      generatedAt,
      appVersion: this.options.appVersion,
      buildMode: this.options.buildMode,
      platform: this.options.platform,
      storage: this.options.store.diagnosticsSnapshot(),
      backupSummary: await this.options.backups.diagnosticsSummary()
    });
  }

  private async assertReviewedState(reviewed: DiagnosticsPreview, previewHash: string): Promise<void> {
    const current = await this.collect(reviewed.generatedAt);
    if (hash(canonicalDiagnosticsJson(current)) !== previewHash) throw new Error('diagnostics_preview_stale');
  }

  async preview(): Promise<{ preview: DiagnosticsPreview; previewHash: string }> {
    const preview = await this.collect(this.now().toISOString());
    const previewHash = hash(canonicalDiagnosticsJson(preview));
    this.previews.set(previewHash, preview);
    if (this.previews.size > 8) this.previews.delete(this.previews.keys().next().value as string);
    return { preview, previewHash };
  }

  async save(input: { previewHash: string; idempotencyKey: string }): Promise<DiagnosticSaveResult> {
    if (!input || Object.keys(input).sort().join(',') !== 'idempotencyKey,previewHash' ||
        typeof input.previewHash !== 'string' || !/^[0-9a-f]{64}$/u.test(input.previewHash) ||
        typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new Error('diagnostics_save_input_invalid');
    }
    const replay = this.saved.get(input.idempotencyKey);
    if (replay) {
      if (replay.previewHash !== input.previewHash) throw new Error('diagnostics_idempotency_key_reuse');
      return replay.result;
    }
    const persisted = this.options.store.getMaintenanceIdempotency?.(input.idempotencyKey);
    if (persisted) {
      if (persisted.fingerprint !== input.previewHash || persisted.operation !== 'diagnostics.export') {
        throw new Error('diagnostics_idempotency_key_reuse');
      }
      if (persisted.status !== 'succeeded' || !persisted.resultJson) throw new Error('diagnostics_idempotency_incomplete');
      let result: DiagnosticSaveResult;
      try { result = JSON.parse(persisted.resultJson) as DiagnosticSaveResult; } catch { throw new Error('diagnostics_idempotency_corrupt'); }
      this.saved.set(input.idempotencyKey, { previewHash: input.previewHash, result });
      return result;
    }
    const reviewed = this.previews.get(input.previewHash);
    if (!reviewed) throw new Error('diagnostics_preview_required');
    await this.assertReviewedState(reviewed, input.previewHash);

    const destination = await this.options.chooseSavePath();
    if (!destination) {
      const result: DiagnosticSaveResult = { cancelled: true, previewHash: input.previewHash };
      this.saved.set(input.idempotencyKey, { previewHash: input.previewHash, result });
      return result;
    }
    await this.assertReviewedState(reviewed, input.previewHash);
    const temporary = `${destination}.partial`;
    await fs.rm(temporary, { force: true });
    try {
      const json = canonicalDiagnosticsJson(reviewed);
      const zip = new JSZip();
      zip.file('diagnostics.json', json);
      zip.file('README.txt', README);
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      await fs.writeFile(temporary, bytes);
      const reread = await fs.readFile(temporary);
      const verified = await JSZip.loadAsync(reread);
      if (Object.keys(verified.files).sort().join(',') !== 'README.txt,diagnostics.json') {
        throw new Error('diagnostics_archive_entries_invalid');
      }
      if (await verified.file('diagnostics.json')?.async('string') !== json ||
          await verified.file('README.txt')?.async('string') !== README) {
        throw new Error('diagnostics_archive_verification_failed');
      }
      await this.assertReviewedState(reviewed, input.previewHash);
      this.options.faults?.beforeDiagnosticsRename?.();
      await this.assertReviewedState(reviewed, input.previewHash);
      if (this.options.store.reserveMaintenanceIdempotency) {
        try {
          const reservation = this.options.store.reserveMaintenanceIdempotency({
            key: input.idempotencyKey,
            fingerprint: input.previewHash,
            operation: 'diagnostics.export',
            updatedAt: this.now().toISOString()
          });
          if (reservation === 'existing') throw new Error('diagnostics_idempotency_incomplete');
        } catch (error) {
          if ((error as Error).message.includes('key_reuse')) throw new Error('diagnostics_idempotency_key_reuse');
          throw error;
        }
      }
      await fs.rename(temporary, destination);
      const result: DiagnosticSaveResult = {
        saved: true,
        previewHash: input.previewHash,
        sha256: hash(reread),
        byteSize: reread.length
      };
      this.options.store.saveMaintenanceIdempotency?.({
        key: input.idempotencyKey,
        fingerprint: input.previewHash,
        operation: 'diagnostics.export',
        resultJson: JSON.stringify(result),
        updatedAt: this.now().toISOString()
      });
      this.saved.set(input.idempotencyKey, { previewHash: input.previewHash, result });
      return result;
    } catch (error) {
      try {
        this.options.store.recordMaintenanceFailure?.({
          scope: 'diagnostics', code: 'DIAGNOSTIC_SAVE_FAILED', at: this.now().toISOString()
        });
      } catch { /* preserve the original export failure */ }
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
