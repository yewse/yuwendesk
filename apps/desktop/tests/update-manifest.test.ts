import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalUpdateManifest,
  inspectUpdateContainer,
  type UpdateInspectionOptions,
  type UpdateManifestV1,
  UpdateValidationError
} from '../src/main/update/manifest';
import { buildUpdateContainer } from '../src/main/update/container';

const trusted = generateKeyPairSync('ed25519');
const untrusted = generateKeyPairSync('ed25519');
const packageBytes = Buffer.from('fictional signed installer fixture');

function manifest(overrides: Partial<UpdateManifestV1> = {}): UpdateManifestV1 {
  return {
    format: 'yuwendesk-update-manifest',
    version: 1,
    releaseId: 'release-0.2.0',
    appId: 'org.yuwendesk.app',
    targetVersion: '0.2.0',
    minimumSourceVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    packageName: 'YuwenDesk-0.2.0.exe',
    packageBytes: packageBytes.length,
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    signingKeyId: 'test-release-key',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides
  };
}

const options: UpdateInspectionOptions = {
  currentVersion: '0.1.0',
  appId: 'org.yuwendesk.app',
  platform: 'win32',
  arch: 'x64',
  trustedKeys: new Map([['test-release-key', trusted.publicKey]])
};

function containerFor(
  value: UpdateManifestV1 = manifest(),
  privateKey = trusted.privateKey,
  rawManifest = canonicalUpdateManifest(value)
): Buffer {
  return buildUpdateContainer({
    manifestBytes: rawManifest,
    signature: sign(null, rawManifest, privateKey),
    packageBytes
  });
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error('expected update validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateValidationError);
    expect((error as UpdateValidationError).code).toBe(code);
  }
}

describe('signed update manifest and fixed container', () => {
  it('accepts one canonical manifest signed by an installed trust anchor', () => {
    const result = inspectUpdateContainer(containerFor(), options);
    expect(result.manifest.targetVersion).toBe('0.2.0');
    expect(result.packageBytes.equals(packageBytes)).toBe(true);
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ['extra field', { ...manifest(), publicKey: 'self-asserted' }],
    ['missing field', Object.fromEntries(Object.entries(manifest()).filter(([key]) => key !== 'arch'))]
  ])('rejects a manifest with %s', (_label, value) => {
    const raw = Buffer.from(JSON.stringify(value));
    expectCode(() => inspectUpdateContainer(containerFor(manifest(), trusted.privateKey, raw), options), 'UPDATE_MANIFEST_INVALID');
  });

  it('rejects duplicate JSON keys and non-canonical whitespace', () => {
    const canonical = canonicalUpdateManifest(manifest()).toString('utf8');
    const duplicate = Buffer.from(canonical.replace('"version":1', '"version":1,"version":1'));
    const spaced = Buffer.from(canonical.replace('{', '{ '));
    expectCode(() => inspectUpdateContainer(containerFor(manifest(), trusted.privateKey, duplicate), options), 'UPDATE_MANIFEST_INVALID');
    expectCode(() => inspectUpdateContainer(containerFor(manifest(), trusted.privateKey, spaced), options), 'UPDATE_MANIFEST_INVALID');
  });

  it.each(['01.2.3', '1.2', '1.2.3-beta', '1.02.3'])('rejects unsupported semantic version %s', (targetVersion) => {
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ targetVersion })), options), 'UPDATE_MANIFEST_INVALID');
  });

  it.each([
    ['appId', { appId: 'org.example.other' }],
    ['platform', { platform: 'linux' }],
    ['arch', { arch: 'arm64' }]
  ])('rejects a wrong %s target', (_label, override) => {
    expectCode(
      () => inspectUpdateContainer(containerFor(manifest(override as Partial<UpdateManifestV1>)), options),
      'UPDATE_TARGET_MISMATCH'
    );
  });

  it.each([
    '../setup.exe',
    'folder\\setup.exe',
    'CON.exe',
    'NUL.tools.exe',
    'setup..exe',
    'setup.exe.'
  ])('rejects unsafe Windows package name %s', (packageName) => {
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ packageName })), options), 'UPDATE_MANIFEST_INVALID');
  });

  it.each(['release.', 'release..alias', 'CON', 'LPT1'])('rejects a release id that is unsafe as a Windows staging component: %s', (releaseId) => {
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ releaseId })), options), 'UPDATE_MANIFEST_INVALID');
  });

  it('rejects an unknown key id and an empty production trust set', () => {
    expectCode(
      () => inspectUpdateContainer(containerFor(manifest({ signingKeyId: 'unknown-key' })), options),
      'UPDATE_TRUST_NOT_CONFIGURED'
    );
    expectCode(
      () => inspectUpdateContainer(containerFor(), { ...options, trustedKeys: new Map() }),
      'UPDATE_TRUST_NOT_CONFIGURED'
    );
  });

  it('rejects a hash-correct package signed by an untrusted private key', () => {
    expectCode(() => inspectUpdateContainer(containerFor(manifest(), untrusted.privateKey), options), 'UPDATE_SIGNATURE_INVALID');
  });

  it('rejects same-version, downgrade and unmet minimum source', () => {
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ targetVersion: '0.1.0' })), options), 'UPDATE_VERSION_REJECTED');
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ targetVersion: '0.0.9' })), options), 'UPDATE_VERSION_REJECTED');
    expectCode(() => inspectUpdateContainer(containerFor(manifest({ minimumSourceVersion: '0.1.1' })), options), 'UPDATE_VERSION_REJECTED');
  });

  it.each(['manifest', 'signature', 'package'] as const)('rejects a one-bit %s mutation', (section) => {
    const original = containerFor();
    const mutated = Buffer.from(original);
    const manifestLength = mutated.readUInt32BE(9);
    const signatureLength = mutated.readUInt16BE(13);
    const headerLength = 19;
    const index = section === 'manifest'
      ? headerLength + 2
      : section === 'signature'
        ? headerLength + manifestLength + 2
        : headerLength + manifestLength + signatureLength + 2;
    mutated[index] ^= 1;
    expect(() => inspectUpdateContainer(mutated, options)).toThrow(UpdateValidationError);
  });

  it('rejects an invalid container length before reading sections', () => {
    expectCode(() => inspectUpdateContainer(containerFor().subarray(0, -1), options), 'UPDATE_CONTAINER_INVALID');
  });
});
