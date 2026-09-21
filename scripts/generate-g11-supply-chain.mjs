#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  npmCliPathForNodeExecutable,
  recoverJsonSetAtomic,
  writeFileSetAtomic
} from './lib/g11-acceptance.mjs';
import {
  aggregateReleaseEvidence,
  loadReleaseAggregationInputs,
  validateReleaseEvidence,
  verifyCandidateArtifactSnapshot
} from './lib/g11-release-evidence.mjs';
import { canonicalizeReleaseText, renderFinalStatus, renderKnownLimitations } from './lib/g11-release-verify.mjs';
import {
  allowedScopedDisplayNamesFromPackageLock,
  buildChecksumManifest,
  G11_T03_FIXED_CHECKSUM_PATHS,
  inspectAuthenticodeStatus,
  lockedComponentsFromPackageLock,
  lockedDependencyGraphFromPackageLock,
  validateSbomEnvironmentRecord,
  validateCycloneDxSbom,
  validateSigningStatusRecord,
  verifyChecksumManifest
} from './lib/g11-supply-chain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, 'reports', 'release');
const transactionPath = resolve(releaseRoot, '.g11-supply-chain-transaction.json');
const outputPaths = {
  sbom: resolve(releaseRoot, 'yuwendesk.cdx.json'),
  environment: resolve(releaseRoot, 'sbom-environment.json'),
  signing: resolve(releaseRoot, 'signing-status.json'),
  evidence: resolve(releaseRoot, 'release-evidence.json'),
  limitations: resolve(releaseRoot, 'KNOWN_LIMITATIONS.md'),
  finalStatus: resolve(releaseRoot, 'FINAL_STATUS.md'),
  releaseInput: resolve(releaseRoot, 'release-input.json'),
  checksums: resolve(releaseRoot, 'SHA256SUMS.txt')
};
const outputNames = [
  'yuwendesk.cdx.json',
  'sbom-environment.json',
  'signing-status.json',
  'release-evidence.json',
  'KNOWN_LIMITATIONS.md',
  'FINAL_STATUS.md',
  'release-input.json',
  'SHA256SUMS.txt'
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function readRepositoryFile(path) {
  const rootReal = realpathSync(root);
  const lexical = resolve(rootReal, path);
  if (!isWithin(rootReal, lexical) || !existsSync(lexical)) throw new Error(`SUPPLY_CHAIN_INPUT_MISSING:${path}`);
  const actual = realpathSync(lexical);
  if (!isWithin(rootReal, actual)) throw new Error(`SUPPLY_CHAIN_INPUT_ESCAPE:${path}`);
  return readFileSync(actual);
}

function runNodeNpm(args) {
  const npmCli = npmCliPathForNodeExecutable(process.execPath);
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`SUPPLY_CHAIN_NPM_FAILED:${result.status ?? 'spawn'}:${(result.stderr ?? '').trim().slice(0, 500)}`);
  }
  return result.stdout.trim();
}

function versionWithoutPrefix(value) {
  return String(value ?? '').trim().replace(/^v/, '');
}

recoverJsonSetAtomic({ transactionPath, expectedTargetNames: outputNames });

const packageValue = JSON.parse(readRepositoryFile('package.json'));
const packageLockBytes = readRepositoryFile('package-lock.json');
const packageLock = JSON.parse(packageLockBytes);
const environmentLock = JSON.parse(readRepositoryFile('ENV_LOCK.json'));
const releaseInput = JSON.parse(readRepositoryFile('reports/release/release-input.json'));
const candidate = JSON.parse(readRepositoryFile('reports/release/candidate-artifact.json'));
verifyCandidateArtifactSnapshot({ root, candidateArtifact: candidate });
const generatedAt = new Date().toISOString();
const aggregationInput = loadReleaseAggregationInputs({ root, releaseInput, generatedAt });
const repositoryProvenance = aggregationInput.repositoryProvenance;

const sbom = JSON.parse(runNodeNpm([
  'sbom', '--package-lock-only', '--sbom-format=cyclonedx', '--sbom-type=application'
]));
const lockedComponents = lockedComponentsFromPackageLock(packageLock);
const lockedDependencyGraph = lockedDependencyGraphFromPackageLock(packageLock);
const allowedScopedDisplayNames = allowedScopedDisplayNamesFromPackageLock(packageLock);
const sbomValidation = validateCycloneDxSbom({
  sbom,
  lockedComponents,
  lockedDependencyGraph,
  allowedScopedDisplayNames,
  expectedRoot: { name: packageValue.name, version: packageValue.version }
});
if (!sbomValidation.ok) throw new Error(`SBOM_VALIDATION_FAILED:${JSON.stringify(sbomValidation.errors)}`);

const actualNode = versionWithoutPrefix(process.version);
const actualNpm = versionWithoutPrefix(runNodeNpm(['--version']));
const requiredNode = versionWithoutPrefix(environmentLock?.build_host?.node);
const requiredNpm = versionWithoutPrefix(environmentLock?.build_host?.npm);
const environment = {
  schemaVersion: 1,
  generatedAt,
  sourceCommit: releaseInput.sourceCommit,
  command: 'npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application',
  validationStatus: 'PASS',
  sbomSpecVersion: sbom.specVersion,
  componentCount: sbom.components.length,
  dependencyCount: sbom.dependencies.length,
  lockedComponentCount: lockedComponents.length,
  packageLockSha256: sha256(packageLockBytes),
  actualToolchain: { node: actualNode, npm: actualNpm },
  requiredToolchain: { node: requiredNode, npm: requiredNpm },
  repositoryHead: repositoryProvenance.head,
  sourceCommitMatch: repositoryProvenance.headMatchesSource,
  sourceTreeClean: repositoryProvenance.headMatchesSource && repositoryProvenance.relevantTreeClean,
  formalEnvironmentMatch: actualNode === requiredNode && actualNpm === requiredNpm
};
const observedSigning = inspectAuthenticodeStatus({ root, candidate, checkedAt: generatedAt });
const signing = {
  schemaVersion: 1,
  sourceCommit: releaseInput.sourceCommit,
  expectedPath: candidate.expectedPath,
  artifactPresent: candidate.artifactPresent,
  ...observedSigning
};
const environmentValidation = validateSbomEnvironmentRecord({
  record: environment,
  sourceCommit: releaseInput.sourceCommit,
  sbom,
  lockedComponentCount: lockedComponents.length,
  packageLockSha256: sha256(packageLockBytes),
  actualToolchain: { node: actualNode, npm: actualNpm },
  requiredToolchain: { node: requiredNode, npm: requiredNpm },
  repositoryProvenance
});
if (!environmentValidation.ok) {
  throw new Error(`SBOM_ENVIRONMENT_INVALID:${JSON.stringify(environmentValidation.errors)}`);
}
const signingValidation = validateSigningStatusRecord({
  record: signing,
  sourceCommit: releaseInput.sourceCommit,
  candidate,
  platform: process.platform,
  observed: observedSigning
});
if (!signingValidation.ok) {
  throw new Error(`SIGNING_STATUS_INVALID:${JSON.stringify(signingValidation.errors)}`);
}
verifyCandidateArtifactSnapshot({ root, candidateArtifact: candidate });

const prospectiveSupplyChain = {
  sbomStatus: 'PASS',
  checksumStatus: 'PASS',
  signatureStatus: signing.status,
  sbomPath: 'reports/release/yuwendesk.cdx.json',
  checksumPath: 'reports/release/SHA256SUMS.txt',
  signingStatusPath: 'reports/release/signing-status.json',
  formalEnvironmentMatch: environment.formalEnvironmentMatch,
  componentCount: environment.componentCount,
  dependencyCount: environment.dependencyCount
};
aggregationInput.supplyChain = prospectiveSupplyChain;
aggregationInput.deliverables = aggregationInput.deliverables.map((item) => {
  if (['release_evidence', 'known_limitations', 'final_status'].includes(item.id)) {
    return { ...item, status: 'GENERATED' };
  }
  if (['cyclonedx_sbom', 'checksum_manifest', 'signing_status'].includes(item.id)) {
    return { ...item, status: 'PRESENT' };
  }
  return item;
});
const evidence = aggregateReleaseEvidence(aggregationInput);
const limitations = renderKnownLimitations(evidence);
const finalStatus = renderFinalStatus(evidence);
const nextReleaseInput = {
  ...releaseInput,
  releaseEvidenceGeneratedAt: generatedAt,
  defectAuditPath: 'reports/release/defect-audit.json',
  releaseEvidencePath: 'reports/release/release-evidence.json',
  knownLimitationsPath: 'reports/release/KNOWN_LIMITATIONS.md',
  finalStatusPath: 'reports/release/FINAL_STATUS.md'
};

const serialized = new Map([
  ['reports/release/yuwendesk.cdx.json', `${JSON.stringify(sbom, null, 2)}\n`],
  ['reports/release/sbom-environment.json', `${JSON.stringify(environment, null, 2)}\n`],
  ['reports/release/signing-status.json', `${JSON.stringify(signing, null, 2)}\n`],
  ['reports/release/release-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`],
  ['reports/release/KNOWN_LIMITATIONS.md', limitations],
  ['reports/release/FINAL_STATUS.md', finalStatus],
  ['reports/release/release-input.json', `${JSON.stringify(nextReleaseInput, null, 2)}\n`]
]);
const checksumPaths = [...G11_T03_FIXED_CHECKSUM_PATHS];
if (!checksumPaths.includes(releaseInput.acceptanceRunPath)) checksumPaths.push(releaseInput.acceptanceRunPath);
if (candidate.artifactPresent) checksumPaths.push(candidate.expectedPath);
const checksumEntries = checksumPaths.map((path) => {
  const bytes = serialized.has(path) ? Buffer.from(serialized.get(path), 'utf8') : readRepositoryFile(path);
  return { path, sha256: sha256(bytes) };
});
const manifest = buildChecksumManifest(checksumEntries);

writeFileSetAtomic({
  transactionPath,
  beforeCommit: () => {
    verifyCandidateArtifactSnapshot({ root, candidateArtifact: candidate });
    const validation = verifyChecksumManifest({
      root,
      manifestText: readFileSync(outputPaths.checksums, 'utf8')
    });
    if (!validation.ok) throw new Error(`CHECKSUM_VERIFICATION_FAILED:${JSON.stringify(validation.errors)}`);
    const publishedEvidence = JSON.parse(readFileSync(outputPaths.evidence, 'utf8'));
    const evidenceValidation = validateReleaseEvidence({ root, evidence: publishedEvidence });
    if (!evidenceValidation.ok) {
      throw new Error(`RELEASE_EVIDENCE_INVALID:${JSON.stringify(evidenceValidation.errors)}`);
    }
    if (canonicalizeReleaseText(readFileSync(outputPaths.limitations, 'utf8')) !== renderKnownLimitations(publishedEvidence)) {
      throw new Error('RELEASE_LIMITATIONS_MISMATCH');
    }
    if (canonicalizeReleaseText(readFileSync(outputPaths.finalStatus, 'utf8')) !== renderFinalStatus(publishedEvidence)) {
      throw new Error('RELEASE_FINAL_STATUS_MISMATCH');
    }
  },
  entries: [
    {
      targetPath: outputPaths.sbom,
      content: serialized.get('reports/release/yuwendesk.cdx.json'),
      validateContent: (content) => validateCycloneDxSbom({
        sbom: JSON.parse(content), lockedComponents, lockedDependencyGraph, allowedScopedDisplayNames,
        expectedRoot: { name: packageValue.name, version: packageValue.version }
      })
    },
    {
      targetPath: outputPaths.environment,
      content: serialized.get('reports/release/sbom-environment.json'),
      validateContent: (content) => JSON.stringify(JSON.parse(content)) === JSON.stringify(environment)
    },
    {
      targetPath: outputPaths.signing,
      content: serialized.get('reports/release/signing-status.json'),
      validateContent: (content) => JSON.stringify(JSON.parse(content)) === JSON.stringify(signing)
    },
    {
      targetPath: outputPaths.evidence,
      content: serialized.get('reports/release/release-evidence.json'),
      validateContent: (content) => JSON.stringify(JSON.parse(content)) === JSON.stringify(evidence)
    },
    {
      targetPath: outputPaths.limitations,
      content: serialized.get('reports/release/KNOWN_LIMITATIONS.md'),
      validateContent: (content) => content === limitations
    },
    {
      targetPath: outputPaths.finalStatus,
      content: serialized.get('reports/release/FINAL_STATUS.md'),
      validateContent: (content) => content === finalStatus
    },
    {
      targetPath: outputPaths.releaseInput,
      content: serialized.get('reports/release/release-input.json'),
      validateContent: (content) => JSON.stringify(JSON.parse(content)) === JSON.stringify(nextReleaseInput)
    },
    {
      targetPath: outputPaths.checksums,
      content: manifest,
      validateContent: (content) => content === buildChecksumManifest(checksumEntries)
    }
  ]
});

console.log(JSON.stringify({
  sbom: {
    specVersion: environment.sbomSpecVersion,
    components: environment.componentCount,
    dependencies: environment.dependencyCount,
    lockedComponents: environment.lockedComponentCount,
    validationStatus: environment.validationStatus
  },
  environment: {
    actual: environment.actualToolchain,
    required: environment.requiredToolchain,
    formalEnvironmentMatch: environment.formalEnvironmentMatch
  },
  signing: { status: signing.status, reasonCode: signing.reasonCode },
  checksumEntries: checksumEntries.length,
  releaseDisposition: evidence.statuses.releaseDisposition,
  releaseReasonCode: evidence.statuses.reasonCode,
  gapCount: evidence.knownGaps.length
}, null, 2));
