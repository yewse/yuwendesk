import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { SafeStorageLike } from '../crypto/secrets';
import type { BackupRecord, BackupService } from './backup';
import type { ProtectionFaultHooks } from './types';
import {
  prepareLocalRestore,
  preparePortableRestore,
  writePendingRestore,
  type PreparedRestore,
  type RestoreConfirmationGrant,
  type RestorePreview
} from './restore';

interface BackupOperations {
  createLocal(): Promise<unknown>;
  exportPortable(passphrase: string): Promise<{ container: Buffer; manifest: { backupId: string } }>;
  list(): Promise<Array<Partial<BackupRecord> & { backupId: string }>>;
  deleteManaged(backupId: string): Promise<boolean>;
}

interface ProtectionServiceOptions {
  userDataDir: string;
  backup: BackupOperations | BackupService;
  idempotencyStore?: {
    getMaintenanceIdempotency(key: string): { fingerprint: string; operation: string; status: string; resultJson: string | null } | null;
    reserveMaintenanceIdempotency(input: { key: string; fingerprint: string; operation: string; updatedAt: string }): 'reserved' | 'existing';
    saveMaintenanceIdempotency(input: { key: string; fingerprint: string; operation: string; resultJson: string; updatedAt: string }): void;
    maintenanceRequestDigest?(value: string): string;
    recordMaintenanceFailure?(input: { scope: 'backup' | 'restore' | 'diagnostics'; code: string; automatic?: boolean; at: string }): void;
    recordMaintenanceSuccess?(input: { scope: 'backup' | 'restore'; code: string; at: string }): void;
  };
  safeStorage?: SafeStorageLike;
  choosePortableSavePath(): Promise<string | null>;
  choosePortableOpenPath(): Promise<string | null>;
  confirmRestore(preview: RestorePreview): Promise<boolean>;
  confirmDelete(backupId: string): Promise<boolean>;
  relaunch(): void;
  prepareRestore?: typeof preparePortableRestore;
  prepareLocalRestore?: typeof prepareLocalRestore;
  writePending?: typeof writePendingRestore;
  ids?: { restoreJobId(): string; token(): string };
  now?: () => number;
  faults?: Pick<ProtectionFaultHooks, 'beforePendingMarker'>;
}

type RestorePayload = {
  action: string;
  passphrase?: string;
  backupId?: string;
  restoreJobId?: string;
  previewHash?: string;
  confirmationToken?: string;
};

type DeletePayload = { action: string; backupId: string; confirmationToken?: string };

function omitLocalPath<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.path;
  return copy as T;
}

export class ProtectionService {
  private readonly prepareRestoreImpl: typeof preparePortableRestore;
  private readonly prepareLocalRestoreImpl: typeof prepareLocalRestore;
  private readonly writePendingImpl: typeof writePendingRestore;
  private readonly ids: { restoreJobId(): string; token(): string };
  private readonly now: () => number;
  private readonly prepared = new Map<string, PreparedRestore>();
  private readonly restoreTokens = new Map<string, RestoreConfirmationGrant & { consumed: boolean }>();
  private readonly deleteTokens = new Map<string, { backupId: string; expiresAt: number; consumed: boolean }>();
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  constructor(private readonly options: ProtectionServiceOptions) {
    this.prepareRestoreImpl = options.prepareRestore ?? preparePortableRestore;
    this.prepareLocalRestoreImpl = options.prepareLocalRestore ?? prepareLocalRestore;
    this.writePendingImpl = options.writePending ?? writePendingRestore;
    this.ids = options.ids ?? {
      restoreJobId: () => `restore_${randomUUID()}`,
      token: () => `confirm_${randomUUID()}`
    };
    this.now = options.now ?? (() => Date.now());
  }

  private async once<T>(
    key: string | undefined,
    fingerprint: string,
    action: () => Promise<T>,
    persistentOperation?: string
  ): Promise<T> {
    if (!key?.trim()) throw new Error('protection_idempotency_required');
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('protection_idempotency_key_reuse');
      return existing.result as T;
    }
    const active = this.inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error('protection_idempotency_key_reuse');
      return active.promise as Promise<T>;
    }
    if (persistentOperation && this.options.idempotencyStore) {
      const persisted = this.options.idempotencyStore.getMaintenanceIdempotency(key);
      if (persisted) {
        if (persisted.fingerprint !== fingerprint || persisted.operation !== persistentOperation) {
          throw new Error('protection_idempotency_key_reuse');
        }
        if (persisted.status !== 'succeeded' || !persisted.resultJson) throw new Error('protection_idempotency_incomplete');
        let result: T;
        try { result = JSON.parse(persisted.resultJson) as T; } catch { throw new Error('protection_idempotency_corrupt'); }
        this.idempotency.set(key, { fingerprint, result });
        return result;
      }
      const reservation = this.options.idempotencyStore.reserveMaintenanceIdempotency({
        key,
        fingerprint,
        operation: persistentOperation,
        updatedAt: new Date(this.now()).toISOString()
      });
      if (reservation === 'existing') {
        const raced = this.options.idempotencyStore.getMaintenanceIdempotency(key);
        if (!raced || raced.status !== 'succeeded' || !raced.resultJson) throw new Error('protection_idempotency_incomplete');
        let result: T;
        try { result = JSON.parse(raced.resultJson) as T; } catch { throw new Error('protection_idempotency_corrupt'); }
        this.idempotency.set(key, { fingerprint, result });
        return result;
      }
    }
    const promise = action().then((result) => {
      if (persistentOperation && this.options.idempotencyStore) {
        this.options.idempotencyStore.saveMaintenanceIdempotency({
          key,
          fingerprint,
          operation: persistentOperation,
          resultJson: JSON.stringify(result),
          updatedAt: new Date(this.now()).toISOString()
        });
      }
      this.idempotency.set(key, { fingerprint, result });
      return result;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, { fingerprint, promise });
    return promise;
  }

  async create(payload: { mode: string; passphrase?: string }, idempotencyKey?: string): Promise<unknown> {
    if (idempotencyKey?.trim() && this.options.idempotencyStore) {
      const persisted = this.options.idempotencyStore.getMaintenanceIdempotency(idempotencyKey);
      if (persisted && !persisted.fingerprint.startsWith(`create:${payload.mode}:`)) {
        throw new Error('protection_idempotency_key_reuse');
      }
    }
    const passphraseDigest = payload.mode === 'portable' && payload.passphrase
      ? (this.options.idempotencyStore?.maintenanceRequestDigest?.(payload.passphrase) ?? createHash('sha256').update(payload.passphrase).digest('hex'))
      : '';
    try {
      const result = await this.once(idempotencyKey, `create:${payload.mode}:${passphraseDigest}`, async () => {
        if (payload.mode === 'local') return omitLocalPath(await this.options.backup.createLocal());
        if (payload.mode !== 'portable' || !payload.passphrase) throw new Error('backup_create_invalid');
        const destination = await this.options.choosePortableSavePath();
        if (!destination) return { cancelled: true };
        const exported = await this.options.backup.exportPortable(payload.passphrase);
        const temporary = `${destination}.partial`;
        await fs.rm(temporary, { force: true });
        try {
          await fs.writeFile(temporary, exported.container);
          await fs.rename(temporary, destination);
          return {
            backupId: exported.manifest.backupId,
            saved: true,
            sha256: createHash('sha256').update(exported.container).digest('hex'),
            byteSize: exported.container.length
          };
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }, 'backup.create');
      if (!(result as { cancelled?: boolean }).cancelled) {
        try {
          this.options.idempotencyStore?.recordMaintenanceSuccess?.({
            scope: 'backup', code: 'BACKUP_OK', at: new Date(this.now()).toISOString()
          });
        } catch { /* the completed backup remains successful if status metadata cannot be updated */ }
      }
      return result;
    } catch (error) {
      try {
        this.options.idempotencyStore?.recordMaintenanceFailure?.({
          scope: 'backup', code: 'BACKUP_CREATE_FAILED', at: new Date(this.now()).toISOString()
        });
      } catch { /* preserve the original operation error */ }
      throw error;
    }
  }

  async list(): Promise<unknown[]> {
    return (await this.options.backup.list()).map((record) => omitLocalPath(record));
  }

  async restore(payload: RestorePayload, idempotencyKey?: string): Promise<unknown> {
    try {
      const result = await this.once(idempotencyKey, `restore:${payload.action}:${payload.backupId ?? ''}:${payload.restoreJobId ?? ''}:${payload.previewHash ?? ''}`, async () => {
      if (payload.action === 'local-preview') {
        const backupId = payload.backupId ?? '';
        const record = (await this.options.backup.list()).find((item) => item.backupId === backupId && item.valid === true);
        if (!record || typeof record.path !== 'string') throw new Error('backup_local_not_found');
        const jobId = this.ids.restoreJobId();
        const prepared = await this.prepareLocalRestoreImpl({
          backupDirectory: record.path,
          expectedBackupId: backupId,
          userDataDir: this.options.userDataDir,
          jobId,
          now: new Date(this.now())
        });
        this.prepared.set(jobId, prepared);
        return { restoreJobId: jobId, previewHash: prepared.previewHash, preview: prepared.preview };
      }
      if (payload.action === 'preview') {
        if (!payload.passphrase || !this.options.safeStorage) {
          if (!this.options.prepareRestore) throw new Error('restore_environment_unavailable');
        }
        const source = await this.options.choosePortableOpenPath();
        if (!source) return { cancelled: true };
        const container = await fs.readFile(source);
        const jobId = this.ids.restoreJobId();
        const prepared = await this.prepareRestoreImpl({
          container,
          passphrase: payload.passphrase ?? '',
          userDataDir: this.options.userDataDir,
          safeStorage: this.options.safeStorage as SafeStorageLike,
          jobId,
          now: new Date(this.now())
        });
        this.prepared.set(jobId, prepared);
        return { restoreJobId: jobId, previewHash: prepared.previewHash, preview: prepared.preview };
      }
      const jobId = payload.restoreJobId ?? '';
      const prepared = this.prepared.get(jobId);
      if (!prepared || prepared.previewHash !== payload.previewHash) throw new Error('restore_job_invalid');
      if (payload.action === 'request-confirmation') {
        if (!(await this.options.confirmRestore(prepared.preview))) return { cancelled: true };
        const token = this.ids.token();
        const grant = { token, jobId, previewHash: prepared.previewHash, expiresAt: this.now() + 120_000, consumed: false };
        this.restoreTokens.set(token, grant);
        return { confirmationToken: token, expiresAt: grant.expiresAt };
      }
      if (payload.action === 'confirm') {
        const token = payload.confirmationToken ?? '';
        const grant = this.restoreTokens.get(token);
        if (!grant || grant.consumed || grant.expiresAt <= this.now() || grant.jobId !== jobId || grant.previewHash !== prepared.previewHash) {
          throw new Error('restore_confirmation_invalid');
        }
        grant.consumed = true;
        this.options.faults?.beforePendingMarker?.();
        await this.writePendingImpl(this.options.userDataDir, prepared, grant);
        this.options.relaunch();
        return { restoreJobId: jobId, restartRequired: true };
      }
      throw new Error('restore_action_invalid');
      });
      if (!(result as { cancelled?: boolean }).cancelled) {
        try {
          this.options.idempotencyStore?.recordMaintenanceSuccess?.({
            scope: 'restore',
            code: payload.action === 'confirm' ? 'RESTORE_PENDING' : 'RESTORE_PREVIEW_OK',
            at: new Date(this.now()).toISOString()
          });
        } catch { /* a completed stage remains successful if status metadata cannot be updated */ }
      }
      return result;
    } catch (error) {
      try {
        this.options.idempotencyStore?.recordMaintenanceFailure?.({
          scope: 'restore', code: 'RESTORE_FAILED', at: new Date(this.now()).toISOString()
        });
      } catch { /* preserve the original operation error */ }
      throw error;
    }
  }

  async delete(payload: DeletePayload, idempotencyKey?: string): Promise<unknown> {
    return this.once(idempotencyKey, `delete:${payload.action}:${payload.backupId}`, async () => {
      if (payload.action === 'prepare') {
        if (!(await this.options.confirmDelete(payload.backupId))) return { cancelled: true };
        const token = this.ids.token();
        this.deleteTokens.set(token, { backupId: payload.backupId, expiresAt: this.now() + 120_000, consumed: false });
        return { confirmationToken: token, expiresAt: this.now() + 120_000 };
      }
      if (payload.action === 'confirm') {
        const grant = this.deleteTokens.get(payload.confirmationToken ?? '');
        if (!grant || grant.consumed || grant.expiresAt <= this.now() || grant.backupId !== payload.backupId) {
          throw new Error('backup_delete_confirmation_invalid');
        }
        grant.consumed = true;
        const deleted = await this.options.backup.deleteManaged(payload.backupId);
        return { backupId: payload.backupId, deleted };
      }
      throw new Error('backup_delete_action_invalid');
    }, payload.action === 'confirm' ? 'backups.delete' : undefined);
  }
}
