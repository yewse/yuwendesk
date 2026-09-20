import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export const MIGRATION_PHASES = [
  'prepared',
  'recovery_ready',
  'candidate_ready',
  'original_moved',
  'candidate_moved',
  'completed',
  'rolled_back',
  'blocked'
] as const;

export const MIGRATION_ERROR_CODES = [
  'MIGRATION_SPACE_INSUFFICIENT',
  'MIGRATION_SOURCE_INVALID',
  'MIGRATION_APPLY_FAILED',
  'MIGRATION_CANDIDATE_INVALID',
  'MIGRATION_SWITCH_FAILED',
  'MIGRATION_RECOVERY_REQUIRED',
  'MIGRATION_LOCKED',
  'MIGRATION_INCOMPATIBLE'
] as const;

export type MigrationPhase = typeof MIGRATION_PHASES[number];
export type MigrationErrorCode = typeof MIGRATION_ERROR_CODES[number];

export interface MigrationJournal {
  format: 'yuwendesk-migration-journal';
  version: 1;
  jobId: string;
  recoveryPointId: string;
  createdAt: string;
  updatedAt: string;
  sourceAppVersion: string;
  targetAppVersion: string;
  sourceSchema: number;
  targetSchema: number;
  sourceGeneration: number;
  targetGeneration: number;
  sourceSha256: string;
  recoverySha256: string | null;
  candidateSha256: string | null;
  phase: MigrationPhase;
  errorCode: MigrationErrorCode | null;
}

const JOURNAL_KEYS = [
  'format', 'version', 'jobId', 'recoveryPointId', 'createdAt', 'updatedAt',
  'sourceAppVersion', 'targetAppVersion', 'sourceSchema', 'targetSchema',
  'sourceGeneration', 'targetGeneration', 'sourceSha256', 'recoverySha256',
  'candidateSha256', 'phase', 'errorCode'
].sort();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;

function exactKeys(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(JOURNAL_KEYS);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseMigrationJournal(value: unknown): MigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration_journal_invalid');
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record) || record.format !== 'yuwendesk-migration-journal' || record.version !== 1 ||
    typeof record.jobId !== 'string' || !ID_RE.test(record.jobId) ||
    typeof record.recoveryPointId !== 'string' || !ID_RE.test(record.recoveryPointId) ||
    typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt)) ||
    typeof record.sourceAppVersion !== 'string' || !(record.sourceAppVersion === 'unknown' || VERSION_RE.test(record.sourceAppVersion)) ||
    typeof record.targetAppVersion !== 'string' || !VERSION_RE.test(record.targetAppVersion) ||
    !nonNegativeInteger(record.sourceSchema) || !nonNegativeInteger(record.targetSchema) ||
    !nonNegativeInteger(record.sourceGeneration) || !nonNegativeInteger(record.targetGeneration) ||
    typeof record.sourceSha256 !== 'string' || !SHA_RE.test(record.sourceSha256) ||
    !(record.recoverySha256 === null || (typeof record.recoverySha256 === 'string' && SHA_RE.test(record.recoverySha256))) ||
    !(record.candidateSha256 === null || (typeof record.candidateSha256 === 'string' && SHA_RE.test(record.candidateSha256))) ||
    !MIGRATION_PHASES.includes(record.phase as MigrationPhase) ||
    !(record.errorCode === null || MIGRATION_ERROR_CODES.includes(record.errorCode as MigrationErrorCode))
  ) throw new Error('migration_journal_invalid');
  return record as unknown as MigrationJournal;
}

export function migrationJournalPath(userDataDir: string): string {
  return join(userDataDir, 'migration-journal.json');
}

export async function readMigrationJournal(userDataDir: string): Promise<MigrationJournal | null> {
  const path = migrationJournalPath(userDataDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error('migration_journal_invalid');
  }
  return parseMigrationJournal(parsed);
}

export async function writeMigrationJournal(userDataDir: string, journal: MigrationJournal): Promise<void> {
  const safe = parseMigrationJournal(journal);
  const path = migrationJournalPath(userDataDir);
  const partial = `${path}.partial`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.rm(partial, { force: true });
  await fs.writeFile(partial, JSON.stringify(safe), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(partial, path);
}
