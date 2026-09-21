import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error pure root ESM module
import {
  buildChecksumManifest,
  lockedComponentsFromPackageLock,
  allowedScopedDisplayNamesFromPackageLock,
  normalizeAuthenticodeResult,
  normalizeNpmSbomRoot,
  resolveWindowsPowerShell,
  validateSbomEnvironmentRecord,
  validateCycloneDxSbom,
  validateSigningStatusRecord,
  verifyChecksumManifest
} from '../../../scripts/lib/g11-supply-chain.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoots: string[] = [];

function makeFixtureRoot() {
  const path = join(root, 'reports', `.g11-supply-test-${process.pid}-${Date.now()}-${fixtureRoots.length}`);
  mkdirSync(path, { recursive: true });
  fixtureRoots.push(path);
  return path;
}

afterEach(() => {
  for (const path of fixtureRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('G11-T03 CycloneDX validation', () => {
  it('normalizes only npm worktree display-name drift when the locked root identity still matches', () => {
    const raw = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: {
        component: {
          type: 'application', name: 'g12-teacher-workflow', version: '0.1.0', 'bom-ref': 'yuwendesk@0.1.0'
        }
      },
      components: [],
      dependencies: []
    };
    const normalized = normalizeNpmSbomRoot({
      sbom: raw,
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' },
      workingDirectoryName: 'g12-teacher-workflow'
    });
    expect(normalized.metadata.component.name).toBe('yuwendesk');
    expect(raw.metadata.component.name).toBe('g12-teacher-workflow');
    expect(() => normalizeNpmSbomRoot({
      sbom: { ...raw, metadata: { component: { ...raw.metadata.component, 'bom-ref': 'other@0.1.0' } } },
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' },
      workingDirectoryName: 'g12-teacher-workflow'
    })).toThrow(/SBOM_ROOT_NORMALIZATION_REJECTED/);
  });

  it('requires the application root, components, dependency graph, and every locked name/version pair', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'yuwendesk@0.1.0' } },
        components: [{ name: 'react', version: '18.3.1', 'bom-ref': 'react@18.3.1' }],
        dependencies: [{ ref: 'yuwendesk@0.1.0', dependsOn: ['react@18.3.1'] }]
      },
      lockedComponents: [
        { name: 'react', version: '18.3.1' },
        { name: 'jszip', version: '3.10.1' }
      ],
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_LOCK_COMPONENT_MISSING');
  });

  it('extracts every non-root, non-link name/version pair from package-lock', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const components = lockedComponentsFromPackageLock(lock);
    expect(components.length).toBeGreaterThan(100);
    expect(components).toContainEqual({ name: 'react', version: '18.3.1' });
    expect(new Set(components.map((item: { name: string; version: string }) => `${item.name}\0${item.version}`)).size)
      .toBe(components.length);
  });

  it('rejects lock-looking components that are not uniquely represented and reachable from the application root', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
        components: [
          { name: 'react', version: '18.3.1' },
          { name: 'jszip', version: '3.10.1' }
        ],
        dependencies: [{ ref: 'root', dependsOn: [] }]
      },
      lockedComponents: [
        { name: 'react', version: '18.3.1' },
        { name: 'jszip', version: '3.10.1' }
      ],
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_COMPONENT_REF_INVALID');
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_COMPONENT_UNREACHABLE');
  });

  it('fails closed on an unknown CycloneDX spec version', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.999',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
        components: [{ name: 'react', version: '18.3.1', 'bom-ref': 'react@18.3.1' }],
        dependencies: [
          { ref: 'root', dependsOn: ['react@18.3.1'] },
          { ref: 'react@18.3.1', dependsOn: [] }
        ]
      },
      lockedComponents: [{ name: 'react', version: '18.3.1' }],
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_FORMAT_INVALID');
  });

  it('rejects a reachable star graph that does not preserve package-lock dependency edges', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
        components: [
          { name: 'react', version: '18.3.1', 'bom-ref': 'react' },
          { name: 'jszip', version: '3.10.1', 'bom-ref': 'jszip' }
        ],
        dependencies: [
          { ref: 'root', dependsOn: ['react', 'jszip'] },
          { ref: 'react', dependsOn: [] },
          { ref: 'jszip', dependsOn: [] }
        ]
      },
      lockedComponents: [
        { name: 'react', version: '18.3.1' },
        { name: 'jszip', version: '3.10.1' }
      ],
      lockedDependencyGraph: {
        root: { name: 'yuwendesk', version: '0.1.0' },
        edges: [
          { from: { name: 'yuwendesk', version: '0.1.0' }, to: { name: 'react', version: '18.3.1' } },
          { from: { name: 'react', version: '18.3.1' }, to: { name: 'jszip', version: '3.10.1' } }
        ]
      },
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_LOCK_EDGE_MISSING');
  });

  it('rejects a component whose displayed identity contradicts its npm purl', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
        components: [{
          name: 'forged-react', version: '18.3.1', 'bom-ref': 'react@18.3.1',
          purl: 'pkg:npm/react@18.3.1'
        }],
        dependencies: [
          { ref: 'root', dependsOn: ['react@18.3.1'] },
          { ref: 'react@18.3.1', dependsOn: [] }
        ]
      },
      lockedComponents: [{ name: 'react', version: '18.3.1' }],
      lockedDependencyGraph: {
        root: { name: 'yuwendesk', version: '0.1.0' },
        edges: [{
          from: { name: 'yuwendesk', version: '0.1.0' },
          to: { name: 'react', version: '18.3.1' }
        }]
      },
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_COMPONENT_IDENTITY_INVALID');
  });

  it('allows shortened scoped display names only for package-lock workspaces', () => {
    const base = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
      dependencies: [
        { ref: 'root', dependsOn: ['@electron/rebuild@3.7.2'] },
        { ref: '@electron/rebuild@3.7.2', dependsOn: [] }
      ]
    };
    const result = validateCycloneDxSbom({
      sbom: {
        ...base,
        components: [{
          name: 'rebuild', version: '3.7.2', 'bom-ref': '@electron/rebuild@3.7.2',
          purl: 'pkg:npm/%40electron/rebuild@3.7.2'
        }]
      },
      lockedComponents: [{ name: '@electron/rebuild', version: '3.7.2' }],
      lockedDependencyGraph: {
        root: { name: 'yuwendesk', version: '0.1.0' },
        edges: [{
          from: { name: 'yuwendesk', version: '0.1.0' },
          to: { name: '@electron/rebuild', version: '3.7.2' }
        }]
      },
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' },
      allowedScopedDisplayNames: new Map()
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_COMPONENT_IDENTITY_INVALID');

    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const aliases = allowedScopedDisplayNamesFromPackageLock(lock);
    expect(aliases.get(['@yuwendesk/desktop', '0.1.0'].join('\0'))).toBe('desktop');
    expect(aliases.has(['@electron/rebuild', '3.7.2'].join('\0'))).toBe(false);
  });

  it('rejects local paths and secrets embedded in otherwise valid SBOM metadata', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0', 'bom-ref': 'root' } },
        components: [{
          name: 'react', version: '18.3.1', 'bom-ref': 'react@18.3.1',
          purl: 'pkg:npm/react@18.3.1',
          properties: [{ name: 'buildPath', value: 'C:\\Users\\alice\\private' }]
        }],
        dependencies: [
          { ref: 'root', dependsOn: ['react@18.3.1'] },
          { ref: 'react@18.3.1', dependsOn: [] }
        ]
      },
      lockedComponents: [{ name: 'react', version: '18.3.1' }],
      lockedDependencyGraph: {
        root: { name: 'yuwendesk', version: '0.1.0' },
        edges: [{
          from: { name: 'yuwendesk', version: '0.1.0' },
          to: { name: 'react', version: '18.3.1' }
        }]
      },
      expectedRoot: { name: 'yuwendesk', version: '0.1.0' }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_PRIVACY_VIOLATION');
  });
});

describe('G11-T03 canonical checksums and signature states', () => {
  it('sorts forward-slash paths and excludes the checksum file itself', () => {
    const manifest = buildChecksumManifest([
      { path: 'reports/release/z.json', sha256: 'b'.repeat(64) },
      { path: 'reports/release/a.json', sha256: 'a'.repeat(64) }
    ]);
    expect(manifest).toBe(`${'a'.repeat(64)}  reports/release/a.json\n${'b'.repeat(64)}  reports/release/z.json\n`);
    expect(() => buildChecksumManifest([
      { path: 'reports/release/SHA256SUMS.txt', sha256: 'a'.repeat(64) }
    ])).toThrow(/CHECKSUM_SELF_REFERENCE/);
  });

  it('rejects absolute, traversal, backslash, duplicate, and case-alias paths', () => {
    for (const path of ['C:/secret.txt', '../secret.txt', 'reports\\secret.txt']) {
      expect(() => buildChecksumManifest([{ path, sha256: 'a'.repeat(64) }])).toThrow(/CHECKSUM_PATH_REJECTED/);
    }
    expect(() => buildChecksumManifest([
      { path: 'reports/release/a.json', sha256: 'a'.repeat(64) },
      { path: 'REPORTS/release/A.json', sha256: 'b'.repeat(64) }
    ])).toThrow(/CHECKSUM_PATH_ALIAS/);
  });

  it('re-reads listed files and rejects changed bytes and symlink escapes', () => {
    const fixtureRoot = makeFixtureRoot();
    const reports = join(fixtureRoot, 'reports');
    mkdirSync(reports, { recursive: true });
    const path = join(reports, 'evidence.json');
    writeFileSync(path, '{"ok":true}\n', 'utf8');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const manifest = buildChecksumManifest([{ path: 'reports/evidence.json', sha256 }]);
    expect(verifyChecksumManifest({ root: fixtureRoot, manifestText: manifest }).ok).toBe(true);
    writeFileSync(path, '{"ok":false}\n', 'utf8');
    expect(verifyChecksumManifest({ root: fixtureRoot, manifestText: manifest }).errors
      .map((error: { code: string }) => error.code)).toContain('CHECKSUM_HASH_MISMATCH');

    const outside = join(tmpdir(), `g11-supply-outside-${process.pid}-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'outside.json'), '{}\n', 'utf8');
    try {
      symlinkSync(outside, join(reports, 'escape'), 'junction');
      const escaped = buildChecksumManifest([{
        path: 'reports/escape/outside.json',
        sha256: createHash('sha256').update('{}\n').digest('hex')
      }]);
      expect(verifyChecksumManifest({ root: fixtureRoot, manifestText: escaped }).errors
        .map((error: { code: string }) => error.code)).toContain('CHECKSUM_PATH_ESCAPE');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps unsigned, invalid, valid, and not-run signature states distinct', () => {
    expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'NotSigned' }).status).toBe('UNSIGNED');
    expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'HashMismatch' }).status).toBe('SIGNED_INVALID');
    expect(normalizeAuthenticodeResult({
      platform: 'win32', artifactPresent: true, status: 'Valid', timestampPresent: false
    }).reasonCode).toBe('RELEASE_TIMESTAMP_REQUIRED');
    expect(normalizeAuthenticodeResult({
      platform: 'win32', artifactPresent: true, status: 'Valid', timestampPresent: true
    }).status).toBe('SIGNED_VALID');
    expect(normalizeAuthenticodeResult({ platform: 'linux', artifactPresent: true, status: null }).status).toBe('NOT_RUN');
    expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: false, status: null }).reasonCode)
      .toBe('RELEASE_ARTIFACT_MISSING');
  });

  it('recomputes the formal environment match instead of trusting the recorded boolean', () => {
    const record = {
      schemaVersion: 1,
      generatedAt: '2026-09-20T00:00:00.000Z',
      sourceCommit: 'a'.repeat(40),
      command: 'npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application',
      validationStatus: 'PASS',
      sbomSpecVersion: '1.5',
      componentCount: 1,
      dependencyCount: 2,
      lockedComponentCount: 1,
      packageLockSha256: 'b'.repeat(64),
      actualToolchain: { node: '24.15.0', npm: '11.12.1' },
      requiredToolchain: { node: '22.14.0', npm: '10.9.7' },
      repositoryHead: 'a'.repeat(40),
      sourceCommitMatch: true,
      sourceTreeClean: true,
      formalEnvironmentMatch: true
    };
    const result = validateSbomEnvironmentRecord({
      record,
      sourceCommit: 'a'.repeat(40),
      sbom: { specVersion: '1.5', components: [{}], dependencies: [{}, {}] },
      lockedComponentCount: 1,
      packageLockSha256: 'b'.repeat(64),
      actualToolchain: { node: '24.15.0', npm: '11.12.1' },
      requiredToolchain: { node: '22.14.0', npm: '10.9.7' },
      repositoryProvenance: {
        head: 'a'.repeat(40), headMatchesSource: true, relevantTreeClean: true
      }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_ENVIRONMENT_MATCH_INVALID');
  });

  it('recomputes repository provenance instead of trusting recorded clean fields', () => {
    const record = {
      schemaVersion: 1,
      generatedAt: '2026-09-20T00:00:00.000Z',
      sourceCommit: 'a'.repeat(40),
      command: 'npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application',
      validationStatus: 'PASS',
      sbomSpecVersion: '1.5',
      componentCount: 1,
      dependencyCount: 2,
      lockedComponentCount: 1,
      packageLockSha256: 'b'.repeat(64),
      actualToolchain: { node: '22.14.0', npm: '10.9.7' },
      requiredToolchain: { node: '22.14.0', npm: '10.9.7' },
      repositoryHead: 'a'.repeat(40),
      sourceCommitMatch: true,
      sourceTreeClean: true,
      formalEnvironmentMatch: true
    };
    const result = validateSbomEnvironmentRecord({
      record,
      sourceCommit: 'a'.repeat(40),
      sbom: { specVersion: '1.5', components: [{}], dependencies: [{}, {}] },
      lockedComponentCount: 1,
      packageLockSha256: 'b'.repeat(64),
      actualToolchain: { node: '22.14.0', npm: '10.9.7' },
      requiredToolchain: { node: '22.14.0', npm: '10.9.7' },
      repositoryProvenance: {
        head: 'c'.repeat(40), headMatchesSource: false, relevantTreeClean: false
      }
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SBOM_REPOSITORY_PROVENANCE_INVALID');
  });

  it('rejects a fabricated valid signature without a timestamp and certificate subjects', () => {
    const result = validateSigningStatusRecord({
      record: {
        schemaVersion: 1,
        sourceCommit: 'a'.repeat(40),
        expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        artifactPresent: true,
        status: 'SIGNED_VALID',
        reasonCode: 'SIGNATURE_AND_TIMESTAMP_VALID',
        signerSubject: null,
        timestampPresent: false,
        timestampSubject: null,
        checkedAt: '2026-09-20T00:00:00.000Z',
        artifactSha256: 'b'.repeat(64),
        environment: 'win32 test'
      },
      sourceCommit: 'a'.repeat(40),
      candidate: {
        expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        artifactPresent: true,
        sha256: 'b'.repeat(64)
      },
      platform: 'win32'
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('SIGNING_STATUS_INVARIANT_INVALID');
  });

  it('never resolves the Authenticode interpreter from the repository or PATH', () => {
    expect(() => resolveWindowsPowerShell({ repositoryRoot: root, platformName: 'linux' }))
      .toThrow(/POWERSHELL_PLATFORM_REJECTED/);
    expect(() => resolveWindowsPowerShell({
      repositoryRoot: root,
      platformName: 'win32',
      systemRoot: join(root, 'attacker-controlled')
    } as never)).toThrow(/POWERSHELL_OPTIONS_REJECTED/);
  });

  it('anchors Authenticode and hashing cmdlets to the system PowerShell modules', () => {
    const script = readFileSync(join(root, 'scripts', 'inspect-g11-authenticode.ps1'), 'utf8');
    expect(script).toContain('$PSHOME');
    expect(script).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature');
    expect(script).toContain('Microsoft.PowerShell.Utility\\Get-FileHash');
    expect(script).toContain('Microsoft.PowerShell.Utility\\ConvertTo-Json');
  });

  it('uses the validated release aggregation provenance instead of a second dirty-path allowlist', () => {
    const script = readFileSync(join(root, 'scripts', 'generate-g11-supply-chain.mjs'), 'utf8');
    expect(script).not.toContain('inspectRepositoryProvenance');
    expect(script).not.toContain('G11_GENERATED_OUTPUT_PATHS');
    expect(script).toContain('const repositoryProvenance = aggregationInput.repositoryProvenance;');
    expect(script.indexOf('loadReleaseAggregationInputs({ root, releaseInput, generatedAt })'))
      .toBeLessThan(script.indexOf('const environment = {'));
  });
});
