import { createHash, verify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseUpdateContainer } from './container';
import type {
  UpdateInspectionOptions,
  UpdateManifestV1,
  VerifiedUpdate
} from './types';
import { UpdateValidationError } from './types';

export { UpdateValidationError } from './types';
export type { UpdateInspectionOptions, UpdateManifestV1, VerifiedUpdate } from './types';

const MANIFEST_KEYS = [
  'format',
  'version',
  'releaseId',
  'appId',
  'targetVersion',
  'minimumSourceVersion',
  'platform',
  'arch',
  'packageName',
  'packageBytes',
  'packageSha256',
  'signingKeyId',
  'createdAt'
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalUpdateManifest(manifest: UpdateManifestV1): Buffer {
  const canonical = {
    format: manifest.format,
    version: manifest.version,
    releaseId: manifest.releaseId,
    appId: manifest.appId,
    targetVersion: manifest.targetVersion,
    minimumSourceVersion: manifest.minimumSourceVersion,
    platform: manifest.platform,
    arch: manifest.arch,
    packageName: manifest.packageName,
    packageBytes: manifest.packageBytes,
    packageSha256: manifest.packageSha256,
    signingKeyId: manifest.signingKeyId,
    createdAt: manifest.createdAt
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

function isStrictSemver(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
}

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map((part) => BigInt(part));
  const b = right.split('.').map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function isSafeWindowsComponent(value: string): boolean {
  if (value.includes('..') || value.endsWith('.') || value.endsWith(' ')) return false;
  const deviceStem = value.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceStem);
}

function isSafePackageName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/u.test(value)) return false;
  return isSafeWindowsComponent(value);
}

function parseManifest(bytes: Buffer): UpdateManifestV1 {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new UpdateValidationError('UPDATE_MANIFEST_INVALID');
  }
  if (!isPlainRecord(parsed)) throw new UpdateValidationError('UPDATE_MANIFEST_INVALID');
  const keys = Object.keys(parsed);
  if (keys.length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))) {
    throw new UpdateValidationError('UPDATE_MANIFEST_INVALID');
  }
  const value = parsed as unknown as UpdateManifestV1;
  if (
    value.format !== 'yuwendesk-update-manifest' ||
    value.version !== 1 ||
    typeof value.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.releaseId) ||
    !isSafeWindowsComponent(value.releaseId) ||
    typeof value.appId !== 'string' || value.appId.length === 0 || value.appId.length > 128 ||
    !isStrictSemver(value.targetVersion) ||
    !isStrictSemver(value.minimumSourceVersion) ||
    typeof value.platform !== 'string' || value.platform.length === 0 || value.platform.length > 32 ||
    typeof value.arch !== 'string' || value.arch.length === 0 || value.arch.length > 32 ||
    !isSafePackageName(value.packageName) ||
    !Number.isSafeInteger(value.packageBytes) || value.packageBytes <= 0 ||
    typeof value.packageSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.packageSha256) ||
    typeof value.signingKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.signingKeyId) ||
    typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new UpdateValidationError('UPDATE_MANIFEST_INVALID');
  }
  if (!canonicalUpdateManifest(value).equals(bytes)) {
    // This also rejects duplicate keys, alternate key order, whitespace and ambiguous encodings.
    throw new UpdateValidationError('UPDATE_MANIFEST_INVALID');
  }
  return value;
}

export function verifyUpdateMetadata(
  sections: { manifestBytes: Buffer; signature: Buffer },
  options: UpdateInspectionOptions
): Omit<VerifiedUpdate, 'containerSha256' | 'packageBytes'> {
  if (!isStrictSemver(options.currentVersion)) throw new UpdateValidationError('UPDATE_VERSION_REJECTED');
  if (sections.signature.length !== 64) throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  const manifest = parseManifest(sections.manifestBytes);
  const key = options.trustedKeys.get(manifest.signingKeyId);
  if (!key) throw new UpdateValidationError('UPDATE_TRUST_NOT_CONFIGURED');
  let signatureValid = false;
  try {
    signatureValid = verify(null, sections.manifestBytes, key, sections.signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new UpdateValidationError('UPDATE_SIGNATURE_INVALID');
  if (manifest.appId !== options.appId || manifest.platform !== options.platform || manifest.arch !== options.arch) {
    throw new UpdateValidationError('UPDATE_TARGET_MISMATCH');
  }
  if (
    compareSemver(manifest.minimumSourceVersion, options.currentVersion) > 0 ||
    compareSemver(options.currentVersion, manifest.targetVersion) >= 0
  ) {
    throw new UpdateValidationError('UPDATE_VERSION_REJECTED');
  }
  return {
    manifest,
    manifestBytes: sections.manifestBytes,
    manifestSignature: sections.signature,
    manifestSha256: createHash('sha256').update(sections.manifestBytes).digest('hex')
  };
}

export function verifyUpdateSections(
  sections: { manifestBytes: Buffer; signature: Buffer; packageBytes: Buffer },
  options: UpdateInspectionOptions
): Omit<VerifiedUpdate, 'containerSha256'> {
  const metadata = verifyUpdateMetadata(sections, options);
  if (
    sections.packageBytes.length !== metadata.manifest.packageBytes ||
    createHash('sha256').update(sections.packageBytes).digest('hex') !== metadata.manifest.packageSha256
  ) {
    throw new UpdateValidationError('UPDATE_PACKAGE_INVALID');
  }
  return { ...metadata, packageBytes: sections.packageBytes };
}

export function inspectUpdateContainer(container: Buffer, options: UpdateInspectionOptions): VerifiedUpdate {
  const sections = parseUpdateContainer(container, options.maxPackageBytes);
  return {
    ...verifyUpdateSections(sections, options),
    containerSha256: createHash('sha256').update(container).digest('hex')
  };
}
