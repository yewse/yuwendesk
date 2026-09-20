import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import type {
  BackupFileEntry,
  BackupKind,
  BackupManifest,
  BackupRetention
} from './types';

export interface BuildBackupManifestInput {
  backupId: string;
  kind: BackupKind;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  retention: BackupRetention[];
  files: BackupFileEntry[];
  sourceDocumentIds: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export function isSafeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (value === 'data/yuwendesk.db' || value === 'keys/workspace-key.json') return true;
  return parts.length >= 3 && parts[0] === 'materials' && parts.slice(1).every((part) => SAFE_ID.test(part));
}

export function buildBackupManifest(input: BuildBackupManifestInput): BackupManifest {
  return {
    format: 'yuwendesk-backup-manifest',
    version: 1,
    backupId: input.backupId,
    kind: input.kind,
    createdAt: input.createdAt,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    retention: [...input.retention],
    files: input.files.map((entry) => ({ ...entry })),
    sourceDocumentIds: [...input.sourceDocumentIds],
    credentialExcluded: true
  };
}

export function validateBackupManifest(value: BackupManifest): string[] {
  const errors: string[] = [];
  if (value.format !== 'yuwendesk-backup-manifest') errors.push('format');
  if (value.version !== 1) errors.push('version');
  if (!SAFE_ID.test(value.backupId)) errors.push('backup_id');
  if (!['local', 'portable'].includes(value.kind)) errors.push('kind');
  if (!Number.isFinite(Date.parse(value.createdAt))) errors.push('created_at');
  if (!value.appVersion || value.appVersion.length > 64) errors.push('app_version');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) errors.push('schema_version');
  if (value.credentialExcluded !== true) errors.push('credential_excluded');
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!isSafeArchivePath(entry.path)) errors.push(`unsafe_path:${entry.path}`);
    if (seen.has(entry.path)) errors.push(`duplicate_path:${entry.path}`);
    seen.add(entry.path);
    if (!HASH.test(entry.sha256)) errors.push(`bad_hash:${entry.path}`);
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) errors.push(`bad_size:${entry.path}`);
    if (!['database', 'material', 'workspace-key'].includes(entry.role)) errors.push(`bad_role:${entry.path}`);
  }
  if (!seen.has('data/yuwendesk.db')) errors.push('database_missing');
  if (new Set(value.retention).size !== value.retention.length || value.retention.some((tag) => !['daily', 'weekly'].includes(tag))) {
    errors.push('retention');
  }
  if (new Set(value.sourceDocumentIds).size !== value.sourceDocumentIds.length || value.sourceDocumentIds.some((id) => !SAFE_ID.test(id))) {
    errors.push('source_document_ids');
  }
  return errors;
}

export async function verifyBackupDirectory(
  root: string,
  manifest: BackupManifest
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const manifestErrors = validateBackupManifest(manifest);
  if (manifestErrors.length) return { ok: false, reason: `manifest:${manifestErrors[0]}` };
  const resolvedRoot = resolve(root);
  for (const entry of manifest.files) {
    const full = resolve(resolvedRoot, ...entry.path.split('/'));
    if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${sep}`)) return { ok: false, reason: `unsafe:${entry.path}` };
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(full);
    } catch {
      return { ok: false, reason: `missing:${entry.path}` };
    }
    if (bytes.length !== entry.byteSize) return { ok: false, reason: `size:${entry.path}` };
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return { ok: false, reason: `hash:${entry.path}` };
  }
  return { ok: true };
}

