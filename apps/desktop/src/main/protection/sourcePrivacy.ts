import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SourceDeletionInput, SourceDeletionResult, SourceDeletionWorkflow } from '../store';

export interface SensitiveSourcePayloadV1 {
  version: 1;
  originalBase64: string;
  mime: string;
  fullText: string;
  segments: Array<{
    ordinal: number;
    locatorKind: string;
    locator: string;
    text: string;
    charStart: number;
    charEnd: number;
    reliable: boolean;
  }>;
}

export interface SensitiveSourceContext {
  workspaceId: string;
  documentId: string;
  versionId: string;
}

export interface EncryptedSensitiveSourcePayload {
  ciphertext: Buffer;
  nonce: Buffer;
  aad: string;
  algorithmVersion: 1;
  plaintextHash: string;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function sensitiveSourceAad(context: SensitiveSourceContext): string {
  return JSON.stringify({
    document_id: context.documentId,
    object: 'source_sensitive_payload',
    payload_version: 1,
    version_id: context.versionId,
    workspace_id: context.workspaceId
  });
}

function isPayload(value: unknown): value is SensitiveSourcePayloadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.originalBase64 !== 'string' ||
    typeof payload.mime !== 'string' ||
    typeof payload.fullText !== 'string' ||
    !Array.isArray(payload.segments)
  ) return false;
  return payload.segments.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const segment = entry as Record<string, unknown>;
    return Number.isSafeInteger(segment.ordinal) && typeof segment.locatorKind === 'string' &&
      typeof segment.locator === 'string' && typeof segment.text === 'string' &&
      Number.isSafeInteger(segment.charStart) && Number.isSafeInteger(segment.charEnd) &&
      typeof segment.reliable === 'boolean';
  });
}

export function encryptSensitiveSourcePayload(
  dataKey: Buffer,
  payload: SensitiveSourcePayloadV1,
  context: SensitiveSourceContext
): EncryptedSensitiveSourcePayload {
  if (dataKey.length !== 32) throw new Error('invalid_data_key_length');
  if (!isPayload(payload)) throw new Error('invalid_sensitive_source_payload');
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aad = sensitiveSourceAad(context);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: Buffer.concat([cipher.getAuthTag(), encrypted]),
    nonce,
    aad,
    algorithmVersion: 1,
    plaintextHash: createHash('sha256').update(plaintext).digest('hex')
  };
}

export function decryptSensitiveSourcePayload(
  dataKey: Buffer,
  encrypted: EncryptedSensitiveSourcePayload,
  context: SensitiveSourceContext
): SensitiveSourcePayloadV1 {
  try {
    if (dataKey.length !== 32 || encrypted.algorithmVersion !== 1 || encrypted.nonce.length !== NONCE_BYTES || encrypted.ciphertext.length < TAG_BYTES) {
      throw new Error('invalid_envelope');
    }
    const expectedAad = sensitiveSourceAad(context);
    if (encrypted.aad !== expectedAad) throw new Error('aad_mismatch');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, encrypted.nonce);
    decipher.setAAD(Buffer.from(expectedAad, 'utf8'));
    decipher.setAuthTag(encrypted.ciphertext.subarray(0, TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.ciphertext.subarray(TAG_BYTES)),
      decipher.final()
    ]);
    if (createHash('sha256').update(plaintext).digest('hex') !== encrypted.plaintextHash) throw new Error('plaintext_hash_mismatch');
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isPayload(parsed)) throw new Error('payload_invalid');
    return parsed;
  } catch {
    throw new Error('sensitive_source_authentication_failed');
  }
}

export type SourceDeletePolicy = 'delete_managed_and_create_post_delete' | 'keep_managed';

interface SourcePrivacyStore {
  deleteSourcePermanently(input: SourceDeletionInput): SourceDeletionResult;
  getPendingSourceDeletionWorkflows?(): SourceDeletionWorkflow[];
  updateSourceDeletionWorkflow?(input: {
    idempotencyKey: string;
    status: SourceDeletionWorkflow['status'];
    managedBackupDeletedIds: string[];
    managedBackupRemainingIds: string[];
    postDeleteBackupId: string | null;
    updatedAt: string;
  }): void;
}

interface SourcePrivacyBackup {
  findManagedBackupsContainingSource(documentId: string): Promise<string[]>;
  deleteManagedBackups(backupIds: string[], tokenScope: string[]): Promise<{ deletedIds: string[]; remainingIds: string[] }>;
  createLocal(): Promise<{ backupId: string }>;
  createLocalForOperation?(backupId: string): Promise<{ backupId: string }>;
  withExclusive?<T>(action: (backup: SourcePrivacyBackup) => Promise<T>): Promise<T>;
}

interface SourcePrivacyServiceOptions {
  store: SourcePrivacyStore;
  backup: SourcePrivacyBackup;
  confirmDelete(input: {
    documentId: string;
    expectedRevision: number;
    managedBackupIds: string[];
  }): Promise<{ policy: SourceDeletePolicy } | null>;
  token?: () => string;
  now?: () => number;
}

interface DeleteGrant {
  token: string;
  workspaceId: string;
  documentId: string;
  expectedRevision: number;
  managedBackupIds: string[];
  policy: SourceDeletePolicy;
  expiresAt: number;
  consumed: boolean;
}

export interface PreparedSourceDelete {
  confirmationToken: string;
  expiresAt: number;
  managedBackupIds: string[];
  policy: SourceDeletePolicy;
  externalOrOfflineBackups: 'cannot_be_recalled';
  ssdPhysicalErasure: 'not_guaranteed';
}

export interface ConfirmSourceDeleteInput {
  workspaceId: string;
  documentId: string;
  expectedRevision: number;
  managedBackupIds: string[];
  policy: SourceDeletePolicy;
  confirmationToken: string;
  idempotencyKey: string;
  fingerprint: string;
}

export class SourcePrivacyService {
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly grants = new Map<string, DeleteGrant>();
  private readonly prepareIdempotency = new Map<string, { fingerprint: string; result: PreparedSourceDelete }>();

  constructor(private readonly options: SourcePrivacyServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.token = options.token ?? (() => `source-delete_${randomBytes(24).toString('hex')}`);
  }

  async reconcilePending(): Promise<void> {
    const workflows = this.options.store.getPendingSourceDeletionWorkflows?.() ?? [];
    for (const workflow of workflows) {
      const execute = async (backup: SourcePrivacyBackup) => {
        let status = workflow.status;
        let deletedIds = [...workflow.managedBackupDeletedIds];
        let remainingIds = [...workflow.managedBackupRemainingIds];
        let postDeleteBackupId = workflow.postDeleteBackupId;
        if (workflow.policy === 'delete_managed_and_create_post_delete' && status === 'database_deleted') {
          try {
            const outcome = await backup.deleteManagedBackups(workflow.managedBackupIds, workflow.managedBackupIds);
            deletedIds = outcome.deletedIds;
            remainingIds = outcome.remainingIds;
            status = 'managed_backups_processed';
          } catch { /* leave resumable */ }
        }
        if (workflow.policy === 'delete_managed_and_create_post_delete' && status === 'managed_backups_processed' && !postDeleteBackupId) {
          try {
            const deterministicId = `post_delete_${createHash('sha256').update(workflow.idempotencyKey).digest('hex').slice(0, 24)}`;
            postDeleteBackupId = backup.createLocalForOperation
              ? (await backup.createLocalForOperation(deterministicId)).backupId
              : (await backup.createLocal()).backupId;
            status = 'completed';
          } catch { /* leave resumable */ }
        } else if (workflow.policy === 'delete_managed_and_create_post_delete' && status === 'managed_backups_processed' && postDeleteBackupId) {
          status = 'completed';
        } else if (workflow.policy === 'keep_managed') {
          status = 'completed';
        }
        try {
          remainingIds = [...new Set([...remainingIds, ...(await backup.findManagedBackupsContainingSource(workflow.documentId))])].sort();
          const remaining = new Set(remainingIds);
          deletedIds = deletedIds.filter((backupId) => !remaining.has(backupId));
        } catch {
          status = status === 'completed' ? 'managed_backups_processed' : status;
        }
        this.options.store.updateSourceDeletionWorkflow?.({
          idempotencyKey: workflow.idempotencyKey,
          status,
          managedBackupDeletedIds: deletedIds,
          managedBackupRemainingIds: remainingIds,
          postDeleteBackupId,
          updatedAt: new Date(this.now()).toISOString()
        });
      };
      if (this.options.backup.withExclusive) await this.options.backup.withExclusive((locked) => execute(locked));
      else await execute(this.options.backup);
    }
  }

  async prepareDelete(input: {
    workspaceId: string;
    documentId: string;
    expectedRevision: number;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<PreparedSourceDelete | null> {
    if (!input.idempotencyKey.trim() || !input.fingerprint.trim()) throw new Error('source_delete_prepare_idempotency_required');
    const existing = this.prepareIdempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new Error('source_delete_prepare_key_reuse');
      const grant = this.grants.get(existing.result.confirmationToken);
      if (grant && !grant.consumed && grant.expiresAt > this.now()) return existing.result;
      this.grants.delete(existing.result.confirmationToken);
      this.prepareIdempotency.delete(input.idempotencyKey);
    }
    const managedBackupIds = await this.options.backup.findManagedBackupsContainingSource(input.documentId);
    const confirmation = await this.options.confirmDelete({
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
      managedBackupIds
    });
    if (!confirmation) return null;
    if (!['delete_managed_and_create_post_delete', 'keep_managed'].includes(confirmation.policy)) {
      throw new Error('source_delete_policy_invalid');
    }
    const token = this.token();
    const grant: DeleteGrant = {
      token,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
      managedBackupIds: [...managedBackupIds].sort(),
      policy: confirmation.policy,
      expiresAt: this.now() + 120_000,
      consumed: false
    };
    this.grants.set(token, grant);
    const result: PreparedSourceDelete = {
      confirmationToken: token,
      expiresAt: grant.expiresAt,
      managedBackupIds: [...grant.managedBackupIds],
      policy: grant.policy,
      externalOrOfflineBackups: 'cannot_be_recalled',
      ssdPhysicalErasure: 'not_guaranteed'
    };
    this.prepareIdempotency.set(input.idempotencyKey, { fingerprint: input.fingerprint, result });
    return result;
  }

  async delete(input: ConfirmSourceDeleteInput): Promise<SourceDeletionResult | (Extract<SourceDeletionResult, { status: 'succeeded' }> & {
    managedBackupDeletedIds: string[];
    managedBackupRemainingIds: string[];
    postDeleteBackupId: string | null;
    externalOrOfflineBackups: 'not_recalled';
    ssdPhysicalErasure: 'not_guaranteed';
  })> {
    const grant = this.grants.get(input.confirmationToken);
    const requestedIds = [...new Set(input.managedBackupIds)].sort();
    if (
      !grant || grant.consumed || grant.expiresAt <= this.now() ||
      grant.workspaceId !== input.workspaceId || grant.documentId !== input.documentId ||
      grant.expectedRevision !== input.expectedRevision || grant.policy !== input.policy ||
      JSON.stringify(grant.managedBackupIds) !== JSON.stringify(requestedIds)
    ) throw new Error('source_delete_confirmation_invalid');
    const execute = async (backup: SourcePrivacyBackup) => {
      const currentScope = [...new Set(await backup.findManagedBackupsContainingSource(input.documentId))].sort();
      if (JSON.stringify(currentScope) !== JSON.stringify(grant.managedBackupIds)) {
        grant.consumed = true;
        throw new Error('source_delete_scope_changed');
      }
      grant.consumed = true;
      const deleted = this.options.store.deleteSourcePermanently({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        expectedRevision: input.expectedRevision,
        managedBackupIds: grant.managedBackupIds,
        policy: grant.policy,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        deletedAt: new Date(this.now()).toISOString()
      });
      if (deleted.status !== 'succeeded') return deleted;

      let managedBackupDeletedIds: string[] = [];
      let managedBackupRemainingIds = [...grant.managedBackupIds];
      let postDeleteBackupId: string | null = null;
      let workflowStatus: SourceDeletionWorkflow['status'] = grant.policy === 'keep_managed' ? 'completed' : 'database_deleted';
      if (grant.policy === 'delete_managed_and_create_post_delete') {
        try {
          const backupDeletion = await backup.deleteManagedBackups(grant.managedBackupIds, grant.managedBackupIds);
          managedBackupDeletedIds = backupDeletion.deletedIds;
          managedBackupRemainingIds = backupDeletion.remainingIds;
          workflowStatus = 'managed_backups_processed';
        } catch {
          managedBackupDeletedIds = [];
          managedBackupRemainingIds = [...grant.managedBackupIds];
        }
        try {
          const deterministicId = `post_delete_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`;
          postDeleteBackupId = backup.createLocalForOperation
            ? (await backup.createLocalForOperation(deterministicId)).backupId
            : (await backup.createLocal()).backupId;
          if (workflowStatus === 'managed_backups_processed') workflowStatus = 'completed';
        } catch {
          postDeleteBackupId = null;
        }
      }
      try {
        const stillContaining = await backup.findManagedBackupsContainingSource(input.documentId);
        managedBackupRemainingIds = [...new Set([...managedBackupRemainingIds, ...stillContaining])].sort();
        const remaining = new Set(managedBackupRemainingIds);
        managedBackupDeletedIds = managedBackupDeletedIds.filter((backupId) => !remaining.has(backupId));
      } catch {
        managedBackupRemainingIds = [...new Set([...managedBackupRemainingIds, ...grant.managedBackupIds])].sort();
        managedBackupDeletedIds = [];
        if (workflowStatus === 'completed') workflowStatus = 'managed_backups_processed';
      }
      this.options.store.updateSourceDeletionWorkflow?.({
        idempotencyKey: input.idempotencyKey,
        status: workflowStatus,
        managedBackupDeletedIds,
        managedBackupRemainingIds,
        postDeleteBackupId,
        updatedAt: new Date(this.now()).toISOString()
      });
      return {
        ...deleted,
        managedBackupDeletedIds,
        managedBackupRemainingIds,
        postDeleteBackupId,
        externalOrOfflineBackups: 'not_recalled' as const,
        ssdPhysicalErasure: 'not_guaranteed' as const
      };
    };
    return this.options.backup.withExclusive
      ? this.options.backup.withExclusive((locked) => execute(locked))
      : execute(this.options.backup);
  }
}
