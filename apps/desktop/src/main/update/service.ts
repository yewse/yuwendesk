import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  parseUpdateContainerHeader,
  UPDATE_CONTAINER_HEADER_BYTES,
  UPDATE_MANIFEST_MAX_BYTES,
  UPDATE_PACKAGE_MAX_BYTES
} from './container';
import { UpdateValidationError, verifyUpdateMetadata } from './manifest';
import type { UpdateInspectionOptions, UpdateManifestV1, UpdatePublicKey, UpdateSummary } from './types';

const TOKEN_TTL_MS = 2 * 60_000;
const STAGING_MARGIN_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const SMALL_FILE_MAX_BYTES = 64 * 1024;
const LEDGER_MAX_ENTRIES = 4096;
const DEFAULT_LEDGER_MAX_BYTES = 1024 * 1024;

export interface UpdateServiceOptions {
  userDataDir: string;
  currentVersion: string;
  appId: string;
  platform: string;
  arch: string;
  trustedKeys: ReadonlyMap<string, UpdatePublicKey>;
  maxPackageBytes?: number;
  ioChunkBytes?: number;
  ledgerMaxBytes?: number;
  chooseOfflinePath: () => Promise<string | null>;
  now?: () => number;
  availableBytes?: (directory: string) => Promise<number>;
  hooks?: {
    beforeReadback?: (partialDir: string) => void | Promise<void>;
    beforeReadyRename?: (partialDir: string) => void | Promise<void>;
    onPackageChunk?: (bytes: number) => void;
    beforeLedgerWrite?: () => void | Promise<void>;
    beforeLedgerRename?: () => void | Promise<void>;
  };
}

export interface UpdateInspectionResult {
  cancelled: false;
  state: 'verified';
  summary: UpdateSummary;
  confirmationToken: string;
  expiresAt: number;
  noticeZh: string;
}

export interface UpdateStageInput {
  confirmationToken: string;
  manifestSha256: string;
  currentVersion: string;
  targetVersion: string;
  idempotencyKey: string;
}

export interface UpdateStageResult {
  state: 'verified_ready';
  releaseId: string;
  targetVersion: string;
  manifestSha256: string;
  packageSha256: string;
  replayed: boolean;
}

export type UpdateReadyStatus = Omit<UpdateStageResult, 'state' | 'replayed'> & {
  state: 'verified_ready' | 'superseded';
};

interface VerifiedUpdateFile {
  manifest: UpdateManifestV1;
  manifestBytes: Buffer;
  manifestSignature: Buffer;
  manifestSha256: string;
  packageOffset: number;
  packageBytes: number;
  containerBytes: number;
  containerSha256: string;
}

interface Selection {
  sourcePath: string;
  verified: VerifiedUpdateFile;
  summary: UpdateSummary;
  expiresAt: number;
}

interface VerificationRecord {
  format: 'yuwendesk-update-verification';
  version: 1;
  verifiedAt: string;
  installation: 'not_started';
  manifestSignatureBase64: string;
  initialIdempotencyKey: string;
  initialFingerprint: string;
  result: Omit<UpdateStageResult, 'replayed'>;
}

interface IdempotencyEntry {
  idempotencyKey: string;
  fingerprint: string;
  result: Omit<UpdateStageResult, 'replayed'>;
}

interface IdempotencyLedger {
  format: 'yuwendesk-update-idempotency';
  version: 1;
  entries: IdempotencyEntry[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isStageResult(value: unknown): value is Omit<UpdateStageResult, 'replayed'> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['state', 'releaseId', 'targetVersion', 'manifestSha256', 'packageSha256'])) return false;
  return value.state === 'verified_ready' && typeof value.releaseId === 'string' && typeof value.targetVersion === 'string' &&
    typeof value.manifestSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.manifestSha256) &&
    typeof value.packageSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.packageSha256);
}

function isVerificationRecord(value: unknown): value is VerificationRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'format', 'version', 'verifiedAt', 'installation', 'manifestSignatureBase64',
    'initialIdempotencyKey', 'initialFingerprint', 'result'
  ])) return false;
  return value.format === 'yuwendesk-update-verification' && value.version === 1 &&
    value.installation === 'not_started' && typeof value.verifiedAt === 'string' &&
    !Number.isNaN(Date.parse(value.verifiedAt)) &&
    typeof value.manifestSignatureBase64 === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(value.manifestSignatureBase64) &&
    typeof value.initialIdempotencyKey === 'string' && value.initialIdempotencyKey.length > 0 && value.initialIdempotencyKey.length <= 256 &&
    typeof value.initialFingerprint === 'string' && /^[0-9a-f]{64}$/u.test(value.initialFingerprint) &&
    isStageResult(value.result);
}

function isIdempotencyEntry(value: unknown): value is IdempotencyEntry {
  return isPlainRecord(value) && hasExactKeys(value, ['idempotencyKey', 'fingerprint', 'result']) &&
    typeof value.idempotencyKey === 'string' && value.idempotencyKey.length > 0 && value.idempotencyKey.length <= 256 &&
    typeof value.fingerprint === 'string' && /^[0-9a-f]{64}$/u.test(value.fingerprint) && isStageResult(value.result);
}

function isIdempotencyLedger(value: unknown): value is IdempotencyLedger {
  return isPlainRecord(value) && hasExactKeys(value, ['format', 'version', 'entries']) &&
    value.format === 'yuwendesk-update-idempotency' && value.version === 1 && Array.isArray(value.entries) &&
    value.entries.length <= LEDGER_MAX_ENTRIES && value.entries.every(isIdempotencyEntry);
}

function normalizedResult(result: Omit<UpdateStageResult, 'replayed'>): Omit<UpdateStageResult, 'replayed'> {
  return {
    state: 'verified_ready',
    releaseId: result.releaseId,
    targetVersion: result.targetVersion,
    manifestSha256: result.manifestSha256,
    packageSha256: result.packageSha256
  };
}

function stageFingerprint(input: Pick<UpdateStageInput, 'manifestSha256' | 'currentVersion' | 'targetVersion'>): string {
  return createHash('sha256').update(JSON.stringify({
    manifestSha256: input.manifestSha256,
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion
  })).digest('hex');
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => BigInt(part));
  const b = right.split('.').map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

async function defaultAvailableBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

export class UpdateService {
  private readonly now: () => number;
  private readonly selections = new Map<string, Selection>();
  private readonly inspectionOptions: UpdateInspectionOptions;
  private readonly chunkBytes: number;
  private readonly ledgerMaxBytes: number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now;
    this.chunkBytes = Number.isSafeInteger(options.ioChunkBytes) && (options.ioChunkBytes as number) > 0
      ? Math.min(options.ioChunkBytes as number, 4 * 1024 * 1024)
      : DEFAULT_CHUNK_BYTES;
    this.ledgerMaxBytes = Number.isSafeInteger(options.ledgerMaxBytes) && (options.ledgerMaxBytes as number) >= 512
      ? Math.min(options.ledgerMaxBytes as number, DEFAULT_LEDGER_MAX_BYTES)
      : DEFAULT_LEDGER_MAX_BYTES;
    this.inspectionOptions = {
      currentVersion: options.currentVersion,
      appId: options.appId,
      platform: options.platform,
      arch: options.arch,
      trustedKeys: options.trustedKeys,
      maxPackageBytes: options.maxPackageBytes
    };
  }

  private get updateRoot(): string { return join(this.options.userDataDir, 'updates'); }
  private get ledgerPath(): string { return join(this.updateRoot, 'idempotency.json'); }

  async status(): Promise<{
    state: 'trust_not_configured' | 'idle' | 'verified_ready';
    trustConfigured: boolean;
    currentVersion: string;
    ready: UpdateReadyStatus[];
    noticeZh: string;
  }> {
    const records = await this.readVerificationRecords();
    records.sort((left, right) => compareVersions(left.result.targetVersion, right.result.targetVersion) ||
      left.verifiedAt.localeCompare(right.verifiedAt));
    const ready = records.map((record, index): UpdateReadyStatus => ({
      ...normalizedResult(record.result),
      state: index === records.length - 1 ? 'verified_ready' : 'superseded'
    }));
    const trustConfigured = this.options.trustedKeys.size > 0;
    return {
      state: !trustConfigured ? 'trust_not_configured' : ready.length > 0 ? 'verified_ready' : 'idle',
      trustConfigured,
      currentVersion: this.options.currentVersion,
      ready,
      noticeZh: !trustConfigured
        ? '尚未配置可信发布身份，离线更新验证被阻止。'
        : ready.length > 0
          ? '更新已验证并暂存，尚未安装；应用不会自动关闭或重启。'
          : '可选择由可信发布身份签名的离线更新包进行验证。'
    };
  }

  async inspectOffline(): Promise<{ cancelled: true } | UpdateInspectionResult> {
    this.clearExpiredSelections();
    if (this.options.trustedKeys.size === 0) throw new UpdateValidationError('UPDATE_TRUST_NOT_CONFIGURED');
    const sourcePath = await this.options.chooseOfflinePath();
    if (!sourcePath) return { cancelled: true };
    const verified = await this.inspectUpdateFile(sourcePath, 'UPDATE_CONTAINER_INVALID');
    const summary: UpdateSummary = {
      releaseId: verified.manifest.releaseId,
      currentVersion: this.options.currentVersion,
      targetVersion: verified.manifest.targetVersion,
      packageBytes: verified.manifest.packageBytes,
      packageSha256: verified.manifest.packageSha256,
      manifestSha256: verified.manifestSha256,
      createdAt: verified.manifest.createdAt
    };
    this.selections.clear();
    const confirmationToken = `update_${randomBytes(24).toString('hex')}`;
    const expiresAt = this.now() + TOKEN_TTL_MS;
    this.selections.set(confirmationToken, { sourcePath, verified, summary, expiresAt });
    return {
      cancelled: false, state: 'verified', summary, confirmationToken, expiresAt,
      noticeZh: '签名和包完整性已验证；确认后只会暂存，不会安装、关闭或重启应用。'
    };
  }

  async stageOffline(input: UpdateStageInput): Promise<UpdateStageResult> {
    this.clearExpiredSelections();
    if (
      typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256 ||
      !/^[0-9a-f]{64}$/u.test(input.manifestSha256) || input.currentVersion !== this.options.currentVersion
    ) throw new UpdateValidationError('UPDATE_STATE_CHANGED');

    const fingerprint = stageFingerprint(input);
    const ledger = await this.readLedger();
    const prior = ledger.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      const stillReady = (await this.readVerificationRecords()).find((record) =>
        JSON.stringify(record.result) === JSON.stringify(normalizedResult(prior.result)));
      if (!stillReady) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      return { ...normalizedResult(stillReady.result), replayed: true };
    }

    const selection = this.selections.get(input.confirmationToken);
    this.selections.delete(input.confirmationToken);
    if (!selection) {
      const reserved = (await this.readVerificationRecords()).find((record) =>
        record.initialIdempotencyKey === input.idempotencyKey && record.initialFingerprint === fingerprint &&
        record.result.manifestSha256 === input.manifestSha256 && record.result.targetVersion === input.targetVersion);
      if (!reserved) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      await this.persistLedger(ledger, input.idempotencyKey, fingerprint, reserved.result);
      return { ...normalizedResult(reserved.result), replayed: true };
    }
    if (
      this.now() > selection.expiresAt || input.currentVersion !== selection.summary.currentVersion ||
      input.targetVersion !== selection.summary.targetVersion || input.manifestSha256 !== selection.summary.manifestSha256
    ) throw new UpdateValidationError('UPDATE_STATE_CHANGED');

    const verified = await this.inspectUpdateFile(selection.sourcePath, 'UPDATE_STATE_CHANGED');
    if (
      verified.containerSha256 !== selection.verified.containerSha256 ||
      verified.manifestSha256 !== selection.verified.manifestSha256 || verified.manifest.targetVersion !== input.targetVersion
    ) throw new UpdateValidationError('UPDATE_STATE_CHANGED');

    const partialDir = join(this.updateRoot, `${verified.manifest.releaseId}.partial`);
    const readyDir = join(this.updateRoot, `${verified.manifest.releaseId}.ready`);
    const result: Omit<UpdateStageResult, 'replayed'> = {
      state: 'verified_ready', releaseId: verified.manifest.releaseId,
      targetVersion: verified.manifest.targetVersion, manifestSha256: verified.manifestSha256,
      packageSha256: verified.manifest.packageSha256
    };
    const record: VerificationRecord = {
      format: 'yuwendesk-update-verification', version: 1,
      verifiedAt: new Date(this.now()).toISOString(), installation: 'not_started',
      manifestSignatureBase64: verified.manifestSignature.toString('base64'),
      initialIdempotencyKey: input.idempotencyKey, initialFingerprint: fingerprint, result
    };
    const verificationBytes = Buffer.from(JSON.stringify(record), 'utf8');
    let published = false;

    try {
      await mkdir(this.updateRoot, { recursive: true });
      const existing = await this.readVerificationRecord(readyDir);
      if (existing) {
        if (existing.result.manifestSha256 !== verified.manifestSha256) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
        await this.persistLedger(ledger, input.idempotencyKey, fingerprint, existing.result);
        return { ...normalizedResult(existing.result), replayed: true };
      }
      await rm(partialDir, { recursive: true, force: true });
      const available = await (this.options.availableBytes ?? defaultAvailableBytes)(this.updateRoot);
      const required = verified.packageBytes + verified.manifestBytes.length + verificationBytes.length + STAGING_MARGIN_BYTES;
      if (!Number.isFinite(available) || available < required) throw new UpdateValidationError('UPDATE_SPACE_INSUFFICIENT');
      await mkdir(partialDir, { recursive: false, mode: 0o700 });
      await this.copyVerifiedPackage(selection.sourcePath, verified, join(partialDir, 'installer.exe'));
      await writeFile(join(partialDir, 'manifest.json'), verified.manifestBytes, { flag: 'wx' });
      await writeFile(join(partialDir, 'verification.json'), verificationBytes, { flag: 'wx' });
      await this.options.hooks?.beforeReadback?.(partialDir);
      this.assertRecordMatches(await this.readVerificationRecord(partialDir), result);
      await this.options.hooks?.beforeReadyRename?.(partialDir);
      this.assertRecordMatches(await this.readVerificationRecord(partialDir), result);
      await rename(partialDir, readyDir);
      published = true;
      this.assertRecordMatches(await this.readVerificationRecord(readyDir), result);
    } catch (error) {
      await rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
      if (published) await rm(readyDir, { recursive: true, force: true }).catch(() => undefined);
      this.restoreSelection(input.confirmationToken, selection);
      if (error instanceof UpdateValidationError && ['UPDATE_SPACE_INSUFFICIENT', 'UPDATE_STATE_CHANGED'].includes(error.code)) throw error;
      throw new UpdateValidationError('UPDATE_STAGE_FAILED');
    }

    try {
      await this.persistLedger(ledger, input.idempotencyKey, fingerprint, result);
    } catch (error) {
      await rm(readyDir, { recursive: true, force: true }).catch(() => undefined);
      this.restoreSelection(input.confirmationToken, selection);
      if (error instanceof UpdateValidationError && error.code === 'UPDATE_STATE_CHANGED') throw error;
      throw new UpdateValidationError('UPDATE_STAGE_FAILED');
    }
    return { ...result, replayed: false };
  }

  private clearExpiredSelections(): void {
    const now = this.now();
    for (const [token, selection] of this.selections) if (now > selection.expiresAt) this.selections.delete(token);
  }

  private restoreSelection(token: string, selection: Selection): void {
    if (this.now() <= selection.expiresAt) this.selections.set(token, selection);
  }

  private async readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await handle.read(bytes, offset, length - offset, position + offset);
      if (chunk.bytesRead === 0) throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
      offset += chunk.bytesRead;
    }
    return bytes;
  }

  private async readRange(
    handle: FileHandle,
    position: number,
    length: number,
    consume: (chunk: Buffer) => Promise<void> | void
  ): Promise<void> {
    const buffer = Buffer.allocUnsafe(Math.min(this.chunkBytes, length));
    let offset = 0;
    while (offset < length) {
      const requested = Math.min(buffer.length, length - offset);
      const chunk = await handle.read(buffer, 0, requested, position + offset);
      if (chunk.bytesRead === 0) throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
      const slice = buffer.subarray(0, chunk.bytesRead);
      this.options.hooks?.onPackageChunk?.(slice.length);
      await consume(slice);
      offset += chunk.bytesRead;
    }
  }

  private async inspectUpdateFile(sourcePath: string, failureCode: 'UPDATE_CONTAINER_INVALID' | 'UPDATE_STATE_CHANGED'): Promise<VerifiedUpdateFile> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(sourcePath, 'r');
      const before = await handle.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new UpdateValidationError(failureCode);
      const header = await this.readExact(handle, UPDATE_CONTAINER_HEADER_BYTES, 0);
      const layout = parseUpdateContainerHeader(header, before.size, this.options.maxPackageBytes ?? UPDATE_PACKAGE_MAX_BYTES);
      const manifestBytes = await this.readExact(handle, layout.manifestLength, layout.manifestOffset);
      const signature = await this.readExact(handle, layout.signatureLength, layout.signatureOffset);
      const metadata = verifyUpdateMetadata({ manifestBytes, signature }, this.inspectionOptions);
      if (metadata.manifest.packageBytes !== layout.packageLength) throw new UpdateValidationError('UPDATE_PACKAGE_INVALID');
      const packageHash = createHash('sha256');
      const containerHash = createHash('sha256').update(header).update(manifestBytes).update(signature);
      await this.readRange(handle, layout.packageOffset, layout.packageLength, (chunk) => {
        packageHash.update(chunk); containerHash.update(chunk);
      });
      const after = await handle.stat();
      if (after.size !== before.size || packageHash.digest('hex') !== metadata.manifest.packageSha256) {
        throw new UpdateValidationError('UPDATE_PACKAGE_INVALID');
      }
      return {
        ...metadata, packageOffset: layout.packageOffset, packageBytes: layout.packageLength,
        containerBytes: layout.totalLength, containerSha256: containerHash.digest('hex')
      };
    } catch (error) {
      if (error instanceof UpdateValidationError) {
        if (failureCode === 'UPDATE_STATE_CHANGED') throw new UpdateValidationError(failureCode);
        throw error;
      }
      throw new UpdateValidationError(failureCode);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async copyVerifiedPackage(sourcePath: string, verified: VerifiedUpdateFile, destinationPath: string): Promise<void> {
    let source: FileHandle | undefined;
    let destination: FileHandle | undefined;
    try {
      source = await open(sourcePath, 'r');
      const before = await source.stat();
      if (before.size !== verified.containerBytes) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      destination = await open(destinationPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let destinationOffset = 0;
      await this.readRange(source, verified.packageOffset, verified.packageBytes, async (chunk) => {
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const result = await destination?.write(chunk, written, chunk.length - written, destinationOffset + written);
          if (!result || result.bytesWritten === 0) throw new UpdateValidationError('UPDATE_STAGE_FAILED');
          written += result.bytesWritten;
        }
        destinationOffset += chunk.length;
      });
      if ((await source.stat()).size !== before.size || hash.digest('hex') !== verified.manifest.packageSha256) {
        throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      }
      await destination.sync();
    } finally {
      await destination?.close().catch(() => undefined);
      await source?.close().catch(() => undefined);
    }
  }

  private async readSmallFile(path: string, maxBytes = SMALL_FILE_MAX_BYTES): Promise<Buffer> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'r');
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) throw new Error('small file bound');
      return await this.readExact(handle, stats.size, 0);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async hashPackageFile(path: string, expectedBytes: number): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'r');
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== expectedBytes) throw new Error('package size mismatch');
      const hash = createHash('sha256');
      await this.readRange(handle, 0, expectedBytes, (chunk) => { hash.update(chunk); });
      if ((await handle.stat()).size !== expectedBytes) throw new Error('package changed');
      return hash.digest('hex');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readVerificationRecord(directory: string): Promise<VerificationRecord | null> {
    try {
      const parsed = JSON.parse((await this.readSmallFile(join(directory, 'verification.json'))).toString('utf8')) as unknown;
      if (!isVerificationRecord(parsed)) return null;
      const signature = Buffer.from(parsed.manifestSignatureBase64, 'base64');
      if (signature.toString('base64') !== parsed.manifestSignatureBase64) return null;
      const manifestBytes = await this.readSmallFile(join(directory, 'manifest.json'), UPDATE_MANIFEST_MAX_BYTES);
      const metadata = verifyUpdateMetadata({ manifestBytes, signature }, this.inspectionOptions);
      const packageSha256 = await this.hashPackageFile(join(directory, 'installer.exe'), metadata.manifest.packageBytes);
      const expectedDirectory = new Set([`${metadata.manifest.releaseId}.ready`, `${metadata.manifest.releaseId}.partial`]);
      if (
        !expectedDirectory.has(basename(directory)) || packageSha256 !== metadata.manifest.packageSha256 ||
        metadata.manifest.releaseId !== parsed.result.releaseId || metadata.manifest.targetVersion !== parsed.result.targetVersion ||
        metadata.manifestSha256 !== parsed.result.manifestSha256 || metadata.manifest.packageSha256 !== parsed.result.packageSha256
      ) return null;
      return {
        format: 'yuwendesk-update-verification', version: 1, verifiedAt: parsed.verifiedAt,
        installation: 'not_started', manifestSignatureBase64: parsed.manifestSignatureBase64,
        initialIdempotencyKey: parsed.initialIdempotencyKey, initialFingerprint: parsed.initialFingerprint,
        result: normalizedResult(parsed.result)
      };
    } catch {
      return null;
    }
  }

  private assertRecordMatches(record: VerificationRecord | null, expected: Omit<UpdateStageResult, 'replayed'>): void {
    if (!record || JSON.stringify(record.result) !== JSON.stringify(normalizedResult(expected))) {
      throw new UpdateValidationError('UPDATE_STAGE_FAILED');
    }
  }

  private async readVerificationRecords(): Promise<VerificationRecord[]> {
    let entries;
    try { entries = await readdir(this.updateRoot, { withFileTypes: true }); } catch { return []; }
    const records: VerificationRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.ready')) continue;
      const record = await this.readVerificationRecord(join(this.updateRoot, entry.name));
      if (record) records.push(record);
    }
    return records;
  }

  private async readLedger(): Promise<IdempotencyLedger> {
    try {
      const parsed = JSON.parse((await this.readSmallFile(this.ledgerPath, this.ledgerMaxBytes)).toString('utf8')) as unknown;
      if (!isIdempotencyLedger(parsed)) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      return {
        format: 'yuwendesk-update-idempotency', version: 1,
        entries: parsed.entries.map((entry) => ({
          idempotencyKey: entry.idempotencyKey, fingerprint: entry.fingerprint,
          result: normalizedResult(entry.result)
        }))
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { format: 'yuwendesk-update-idempotency', version: 1, entries: [] };
      }
      if (error instanceof UpdateValidationError) throw error;
      throw new UpdateValidationError('UPDATE_STATE_CHANGED');
    }
  }

  private async persistLedger(
    ledger: IdempotencyLedger,
    idempotencyKey: string,
    fingerprint: string,
    result: Omit<UpdateStageResult, 'replayed'>
  ): Promise<void> {
    const existing = ledger.entries.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
      return;
    }
    if (ledger.entries.length >= LEDGER_MAX_ENTRIES) ledger.entries.shift();
    ledger.entries.push({ idempotencyKey, fingerprint, result: normalizedResult(result) });
    let ledgerBytes = Buffer.from(JSON.stringify(ledger), 'utf8');
    while (ledgerBytes.length > this.ledgerMaxBytes && ledger.entries.length > 1) {
      ledger.entries.shift();
      ledgerBytes = Buffer.from(JSON.stringify(ledger), 'utf8');
    }
    if (ledgerBytes.length > this.ledgerMaxBytes) throw new UpdateValidationError('UPDATE_STATE_CHANGED');
    await mkdir(this.updateRoot, { recursive: true });
    const temporary = join(this.updateRoot, `idempotency-${process.pid}-${randomBytes(8).toString('hex')}.partial`);
    try {
      await this.options.hooks?.beforeLedgerWrite?.();
      await writeFile(temporary, ledgerBytes, { flag: 'wx', mode: 0o600 });
      await this.options.hooks?.beforeLedgerRename?.();
      await rename(temporary, this.ledgerPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
