import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { platform as hostPlatform, release as hostRelease } from 'node:os';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

const CHECKSUM_PREFIXES = ['reports/', 'docs/', 'apps/desktop/release/'];
const CHECKSUM_ROOT_FILES = new Set(['ENV_LOCK.json', 'package-lock.json']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const G11_T03_FIXED_CHECKSUM_PATHS = Object.freeze([
  'package-lock.json',
  'ENV_LOCK.json',
  'reports/release/candidate-artifact.json',
  'reports/release/release-evidence.json',
  'reports/release/defect-audit.json',
  'reports/release/yuwendesk.cdx.json',
  'reports/release/sbom-environment.json',
  'reports/release/signing-status.json',
  'docs/TEACHER_QUICK_GUIDE.md',
  'reports/release/KNOWN_LIMITATIONS.md',
  'reports/release/FINAL_STATUS.md'
]);

function error(code, detail = '') {
  return { code, detail };
}

function sha256FileSync(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isIsoDate(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function containsSensitiveSupplyValue(value) {
  if (typeof value === 'string') {
    return /(?:^|[\s"'(：])[A-Za-z]:[\\/]|(?:^|[\s"'(：])\\\\|file:\/\/|(?:^|[\s"'(：])\/(?!\/)[^\s]+/i.test(value) ||
      /\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
      /(?:api[_ -]?key|password|secret[_ -]?value)\s*[:=：]/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveSupplyValue);
  if (isPlainObject(value)) {
    if (typeof value.name === 'string' && /^(?:api[_ -]?key|password|secret[_ -]?value)$/i.test(value.name) &&
        typeof value.value === 'string' && value.value.length > 0) return true;
    return Object.entries(value).some(([key, item]) =>
      (/^(?:api[_ -]?key|password|secret[_ -]?value)$/i.test(key) && item !== null && item !== '') ||
      containsSensitiveSupplyValue(item));
  }
  return false;
}

export function normalizeNpmSbomRoot({ sbom, expectedRoot, workingDirectoryName }) {
  const component = sbom?.metadata?.component;
  if (component?.name === expectedRoot?.name) return sbom;
  const expectedReference = `${expectedRoot?.name}@${expectedRoot?.version}`;
  if (
    !isPlainObject(component) ||
    component.name !== workingDirectoryName ||
    component.version !== expectedRoot?.version ||
    component['bom-ref'] !== expectedReference
  ) {
    throw new Error('SBOM_ROOT_NORMALIZATION_REJECTED');
  }
  return {
    ...sbom,
    metadata: {
      ...sbom.metadata,
      component: { ...component, name: expectedRoot.name }
    }
  };
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function normalizeChecksumPath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes(':') || value.includes('\\')) {
    throw new Error(`CHECKSUM_PATH_REJECTED:${value ?? ''}`);
  }
  const segments = value.split('/');
  const lowerValue = value.toLowerCase();
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      (![...CHECKSUM_ROOT_FILES].some((path) => path.toLowerCase() === lowerValue) &&
       !CHECKSUM_PREFIXES.some((prefix) => lowerValue.startsWith(prefix.toLowerCase())))) {
    throw new Error(`CHECKSUM_PATH_REJECTED:${value}`);
  }
  if (lowerValue === 'reports/release/sha256sums.txt') {
    throw new Error('CHECKSUM_SELF_REFERENCE');
  }
  return value;
}

function packageNameFromLockPath(path, entry) {
  if (typeof entry?.name === 'string' && entry.name.length > 0) return entry.name;
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = path.slice(index + marker.length);
  const segments = suffix.split('/');
  if (segments[0]?.startsWith('@') && segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return segments[0] || null;
}

export function lockedComponentsFromPackageLock(lock) {
  if (!isPlainObject(lock?.packages)) throw new Error('SBOM_PACKAGE_LOCK_INVALID');
  const components = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry?.link === true || typeof entry?.version !== 'string' || entry.version.length === 0) continue;
    const name = packageNameFromLockPath(path, entry);
    if (name === null) continue;
    components.set(`${name}\0${entry.version}`, { name, version: entry.version });
  }
  return [...components.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'));
}

export function allowedScopedDisplayNamesFromPackageLock(lock) {
  if (!isPlainObject(lock?.packages)) throw new Error('SBOM_PACKAGE_LOCK_INVALID');
  const aliases = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || path.includes('node_modules/') || entry?.link === true) continue;
    const identity = lockIdentity(path, entry);
    if (identity?.name.startsWith('@') && identity.name.includes('/')) {
      aliases.set(`${identity.name}\0${identity.version}`, identity.name.split('/').at(-1));
    }
  }
  return aliases;
}

function lockIdentity(path, entry) {
  const name = packageNameFromLockPath(path, entry);
  return name !== null && typeof entry?.version === 'string' && entry.version.length > 0
    ? { name, version: entry.version }
    : null;
}

function resolveLockDependencyPath(packages, sourcePath, dependencyName) {
  let directory = sourcePath;
  while (true) {
    const candidate = directory === ''
      ? `node_modules/${dependencyName}`
      : `${directory}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate) && packages[candidate]?.link !== true) return candidate;
    if (directory === '') break;
    const parent = posix.dirname(directory);
    directory = parent === '.' ? '' : parent;
  }
  const workspace = Object.entries(packages).find(([path, entry]) =>
    path !== '' && !path.includes('node_modules/') && entry?.link !== true && entry?.name === dependencyName);
  return workspace?.[0] ?? null;
}

export function lockedDependencyGraphFromPackageLock(lock) {
  if (!isPlainObject(lock?.packages)) throw new Error('SBOM_PACKAGE_LOCK_INVALID');
  const packages = lock.packages;
  const rootIdentity = lockIdentity('', packages['']);
  if (rootIdentity === null) throw new Error('SBOM_PACKAGE_LOCK_ROOT_INVALID');
  const edges = new Map();
  const addEdge = (from, to) => {
    const key = `${from.name}\0${from.version}\0${to.name}\0${to.version}`;
    edges.set(key, { from, to });
  };
  for (const [path, entry] of Object.entries(packages)) {
    if (entry?.link === true) continue;
    const from = lockIdentity(path, entry);
    if (from === null) continue;
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.devDependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {})
    ]);
    for (const dependencyName of names) {
      const targetPath = resolveLockDependencyPath(packages, path, dependencyName);
      if (targetPath === null) continue;
      const to = lockIdentity(targetPath, packages[targetPath]);
      if (to !== null) addEdge(from, to);
    }
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || path.includes('node_modules/') || entry?.link === true) continue;
    const workspace = lockIdentity(path, entry);
    if (workspace !== null) addEdge(rootIdentity, workspace);
  }
  return {
    root: rootIdentity,
    edges: [...edges.values()].sort((left, right) =>
      `${left.from.name}@${left.from.version}->${left.to.name}@${left.to.version}`.localeCompare(
        `${right.from.name}@${right.from.version}->${right.to.name}@${right.to.version}`, 'en'))
  };
}

export function validateCycloneDxSbom({
  sbom,
  lockedComponents,
  lockedDependencyGraph,
  expectedRoot,
  allowedScopedDisplayNames = new Map()
}) {
  const errors = [];
  const add = (code, detail = '') => errors.push(error(code, detail));
  if (containsSensitiveSupplyValue(sbom)) add('SBOM_PRIVACY_VIOLATION');
  if (!isPlainObject(sbom) || sbom.bomFormat !== 'CycloneDX' ||
      !['1.4', '1.5', '1.6', '1.7'].includes(sbom.specVersion)) {
    add('SBOM_FORMAT_INVALID');
  }
  const root = sbom?.metadata?.component;
  if (!isPlainObject(root) || root.type !== 'application' || root.name !== expectedRoot?.name ||
      root.version !== expectedRoot?.version || typeof root['bom-ref'] !== 'string' || root['bom-ref'].length === 0) {
    add('SBOM_ROOT_INVALID');
  }
  const components = Array.isArray(sbom?.components) ? sbom.components : [];
  if (components.length === 0) add('SBOM_COMPONENTS_MISSING');
  const componentPairRefs = new Map();
  const componentRefs = new Set();
  const addComponentPair = (pair, ref) => {
    const refs = componentPairRefs.get(pair) ?? new Set();
    refs.add(ref);
    componentPairRefs.set(pair, refs);
  };
  for (const component of components) {
    const ref = component?.['bom-ref'];
    if (typeof ref !== 'string' || ref.length === 0) {
      add('SBOM_COMPONENT_REF_INVALID', component?.name ?? '');
      add('SBOM_COMPONENT_UNREACHABLE', component?.name ?? '');
      continue;
    }
    if (componentRefs.has(ref)) add('SBOM_COMPONENT_REF_DUPLICATE', ref);
    componentRefs.add(ref);
    let purlName = null;
    let purlVersion = null;
    if (typeof component?.purl === 'string' && component.purl.startsWith('pkg:npm/')) {
      const identity = component.purl.slice('pkg:npm/'.length).split(/[?#]/, 1)[0];
      const separator = identity.lastIndexOf('@');
      try {
        if (separator > 0) {
          purlName = decodeURIComponent(identity.slice(0, separator));
          purlVersion = decodeURIComponent(identity.slice(separator + 1));
        }
      } catch {
        purlName = null;
        purlVersion = null;
      }
    }
    const canonicalRef = purlName !== null && purlVersion !== null ? `${purlName}@${purlVersion}` : null;
    const allowedDisplayName = purlName !== null && purlVersion !== null && allowedScopedDisplayNames instanceof Map
      ? allowedScopedDisplayNames.get(`${purlName}\0${purlVersion}`)
      : undefined;
    if (purlName === null || purlVersion === null || purlName.length === 0 || purlVersion.length === 0 ||
        component?.version !== purlVersion ||
        (component?.name !== purlName && component?.name !== allowedDisplayName) || ref !== canonicalRef) {
      add('SBOM_COMPONENT_IDENTITY_INVALID', ref);
    } else {
      addComponentPair(`${purlName}\0${purlVersion}`, ref);
    }
  }
  for (const [pair, refs] of componentPairRefs) {
    if (refs.size > 1) add('SBOM_COMPONENT_PAIR_DUPLICATE', pair.replace('\0', '@'));
  }
  const expectedPairs = new Set();
  for (const component of Array.isArray(lockedComponents) ? lockedComponents : []) {
    if (typeof component?.name !== 'string' || typeof component?.version !== 'string') {
      add('SBOM_LOCK_COMPONENT_INVALID');
      continue;
    }
    const key = `${component.name}\0${component.version}`;
    if (expectedPairs.has(key)) add('SBOM_LOCK_COMPONENT_DUPLICATE', `${component.name}@${component.version}`);
    expectedPairs.add(key);
    const refs = componentPairRefs.get(key);
    if (refs === undefined || refs.size === 0) add('SBOM_LOCK_COMPONENT_MISSING', `${component.name}@${component.version}`);
    else if (refs.size !== 1) add('SBOM_LOCK_COMPONENT_AMBIGUOUS', `${component.name}@${component.version}`);
  }
  const dependencies = Array.isArray(sbom?.dependencies) ? sbom.dependencies : [];
  if (dependencies.length === 0) {
    add('SBOM_DEPENDENCY_GRAPH_MISSING');
  }
  const knownRefs = new Set(componentRefs);
  if (typeof root?.['bom-ref'] === 'string') knownRefs.add(root['bom-ref']);
  const graph = new Map();
  for (const dependency of dependencies) {
    if (typeof dependency?.ref !== 'string' || !Array.isArray(dependency.dependsOn) || !knownRefs.has(dependency.ref)) {
      add('SBOM_DEPENDENCY_GRAPH_INVALID', dependency?.ref ?? '');
      continue;
    }
    if (graph.has(dependency.ref)) {
      add('SBOM_DEPENDENCY_NODE_DUPLICATE', dependency.ref);
      continue;
    }
    graph.set(dependency.ref, dependency.dependsOn);
    for (const dependedOn of dependency.dependsOn) {
      if (typeof dependedOn !== 'string' || !knownRefs.has(dependedOn)) {
        add('SBOM_DEPENDENCY_REFERENCE_UNKNOWN', dependedOn ?? '');
      }
    }
  }
  if (typeof root?.['bom-ref'] === 'string' && !graph.has(root['bom-ref'])) add('SBOM_ROOT_DEPENDENCY_MISSING');
  for (const ref of componentRefs) {
    if (!graph.has(ref)) add('SBOM_COMPONENT_DEPENDENCY_NODE_MISSING', ref);
  }
  if (typeof root?.['bom-ref'] === 'string') {
    const reachable = new Set([root['bom-ref']]);
    const pending = [root['bom-ref']];
    while (pending.length > 0) {
      for (const ref of graph.get(pending.shift()) ?? []) {
        if (knownRefs.has(ref) && !reachable.has(ref)) {
          reachable.add(ref);
          pending.push(ref);
        }
      }
    }
    for (const ref of componentRefs) {
      if (!reachable.has(ref)) add('SBOM_COMPONENT_UNREACHABLE', ref);
    }
  }
  if (!isPlainObject(lockedDependencyGraph) || !Array.isArray(lockedDependencyGraph.edges) ||
      lockedDependencyGraph.root?.name !== expectedRoot?.name ||
      lockedDependencyGraph.root?.version !== expectedRoot?.version) {
    add('SBOM_LOCK_GRAPH_INVALID');
  } else if (typeof root?.['bom-ref'] === 'string') {
    const resolveIdentityRef = (identity) => {
      if (identity?.name === expectedRoot.name && identity?.version === expectedRoot.version) return root['bom-ref'];
      const refs = componentPairRefs.get(`${identity?.name ?? ''}\0${identity?.version ?? ''}`);
      return refs?.size === 1 ? [...refs][0] : null;
    };
    const actualEdges = new Set();
    for (const [from, targets] of graph) {
      for (const to of targets) actualEdges.add(`${from}\0${to}`);
    }
    const expectedEdges = new Set();
    for (const edge of lockedDependencyGraph.edges) {
      const from = resolveIdentityRef(edge?.from);
      const to = resolveIdentityRef(edge?.to);
      if (from !== null && to !== null) expectedEdges.add(`${from}\0${to}`);
      if (from === null || to === null || !actualEdges.has(`${from}\0${to}`)) {
        add('SBOM_LOCK_EDGE_MISSING', `${edge?.from?.name ?? ''}@${edge?.from?.version ?? ''}->${edge?.to?.name ?? ''}@${edge?.to?.version ?? ''}`);
      }
    }
    for (const edge of actualEdges) {
      if (!expectedEdges.has(edge)) add('SBOM_DEPENDENCY_EDGE_UNEXPECTED', edge.replace('\0', '->'));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateSbomEnvironmentRecord({
  record,
  sourceCommit,
  sbom,
  lockedComponentCount,
  packageLockSha256,
  actualToolchain,
  requiredToolchain,
  repositoryProvenance
}) {
  const errors = [];
  const add = (code, detail = '') => errors.push(error(code, detail));
  if (containsSensitiveSupplyValue(record)) add('SBOM_ENVIRONMENT_PRIVACY_VIOLATION');
  const allowed = new Set([
    'schemaVersion', 'generatedAt', 'sourceCommit', 'command', 'validationStatus', 'sbomSpecVersion',
    'componentCount', 'dependencyCount', 'lockedComponentCount', 'packageLockSha256', 'actualToolchain',
    'requiredToolchain', 'repositoryHead', 'sourceCommitMatch', 'sourceTreeClean', 'formalEnvironmentMatch'
  ]);
  const toolchainKeys = new Set(['node', 'npm']);
  if (!hasOnlyKeys(record, allowed) || record.schemaVersion !== 1 || !isIsoDate(record.generatedAt) ||
      record.sourceCommit !== sourceCommit ||
      record.command !== 'npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application' ||
      record.validationStatus !== 'PASS' || record.sbomSpecVersion !== sbom?.specVersion ||
      record.componentCount !== sbom?.components?.length || record.dependencyCount !== sbom?.dependencies?.length ||
      record.lockedComponentCount !== lockedComponentCount || record.packageLockSha256 !== packageLockSha256 ||
      !hasOnlyKeys(record.actualToolchain, toolchainKeys) || !hasOnlyKeys(record.requiredToolchain, toolchainKeys) ||
      JSON.stringify(record.actualToolchain) !== JSON.stringify(actualToolchain) ||
      JSON.stringify(record.requiredToolchain) !== JSON.stringify(requiredToolchain)) {
    add('SBOM_ENVIRONMENT_RECORD_INVALID');
  }
  const expectedSourceCommitMatch = repositoryProvenance?.headMatchesSource === true;
  const expectedSourceTreeClean = expectedSourceCommitMatch && repositoryProvenance?.relevantTreeClean === true;
  if ((record?.repositoryHead !== null && !/^[a-f0-9]{40}$/.test(record?.repositoryHead ?? '')) ||
      typeof record?.sourceCommitMatch !== 'boolean' || typeof record?.sourceTreeClean !== 'boolean' ||
      record.sourceCommitMatch !== expectedSourceCommitMatch || record.sourceTreeClean !== expectedSourceTreeClean ||
      (record.sourceCommitMatch && record.repositoryHead !== sourceCommit)) {
    add('SBOM_REPOSITORY_PROVENANCE_INVALID');
  }
  const expectedMatch = actualToolchain?.node === requiredToolchain?.node &&
    actualToolchain?.npm === requiredToolchain?.npm;
  if (record?.formalEnvironmentMatch !== expectedMatch) add('SBOM_ENVIRONMENT_MATCH_INVALID');
  return { ok: errors.length === 0, errors };
}

export function validateSigningStatusRecord({ record, sourceCommit, candidate, platform, observed }) {
  const errors = [];
  const add = (code, detail = '') => errors.push(error(code, detail));
  if (containsSensitiveSupplyValue(record)) add('SIGNING_STATUS_PRIVACY_VIOLATION');
  const allowed = new Set([
    'schemaVersion', 'sourceCommit', 'expectedPath', 'artifactPresent', 'status', 'reasonCode',
    'signerSubject', 'timestampPresent', 'timestampSubject', 'checkedAt', 'artifactSha256', 'environment'
  ]);
  if (!hasOnlyKeys(record, allowed) || record.schemaVersion !== 1 || record.sourceCommit !== sourceCommit ||
      record.expectedPath !== candidate?.expectedPath || record.artifactPresent !== candidate?.artifactPresent ||
      !isIsoDate(record.checkedAt) || typeof record.environment !== 'string' ||
      !record.environment.startsWith(`${platform} `)) {
    add('SIGNING_STATUS_RECORD_INVALID');
    return { ok: false, errors };
  }
  const emptyIdentity = record.signerSubject === null && record.timestampSubject === null;
  if (!candidate.artifactPresent) {
    if (record.status !== 'NOT_RUN' || record.reasonCode !== 'RELEASE_ARTIFACT_MISSING' ||
        record.artifactSha256 !== null || record.timestampPresent !== false || !emptyIdentity) {
      add('SIGNING_STATUS_INVARIANT_INVALID');
    }
    return { ok: errors.length === 0, errors };
  }
  if (record.artifactSha256 !== candidate.sha256 || !SHA256_PATTERN.test(record.artifactSha256 ?? '')) {
    add('SIGNING_STATUS_ARTIFACT_MISMATCH');
  }
  const validSignature = platform === 'win32' && record.status === 'SIGNED_VALID' &&
    record.reasonCode === 'SIGNATURE_AND_TIMESTAMP_VALID' && record.timestampPresent === true &&
    typeof record.signerSubject === 'string' && record.signerSubject.length > 0 &&
    typeof record.timestampSubject === 'string' && record.timestampSubject.length > 0;
  const invalidSignature = platform === 'win32' && record.status === 'SIGNED_INVALID' &&
    ['RELEASE_TIMESTAMP_REQUIRED', 'RELEASE_SIGNATURE_INVALID'].includes(record.reasonCode) &&
    record.timestampPresent === false && emptyIdentity;
  const unsigned = platform === 'win32' && record.status === 'UNSIGNED' &&
    record.reasonCode === 'RELEASE_SIGNATURE_MISSING' && record.timestampPresent === false && emptyIdentity;
  const nonWindows = platform !== 'win32' && record.status === 'NOT_RUN' &&
    record.reasonCode === 'BLOCKED_EXTERNAL_WINDOWS_SIGNATURE_CHECK' && record.timestampPresent === false && emptyIdentity;
  if (!validSignature && !invalidSignature && !unsigned && !nonWindows) add('SIGNING_STATUS_INVARIANT_INVALID');
  const observedKeys = [
    'status', 'reasonCode', 'signerSubject', 'timestampPresent', 'timestampSubject',
    'checkedAt', 'artifactSha256', 'environment'
  ];
  if (!isPlainObject(observed) ||
      observedKeys.some((key) => JSON.stringify(record[key]) !== JSON.stringify(observed[key]))) {
    add('SIGNING_STATUS_LIVE_EVIDENCE_REQUIRED');
  }
  return { ok: errors.length === 0, errors };
}

export function resolveWindowsPowerShell(options) {
  if (!hasOnlyKeys(options, new Set(['repositoryRoot', 'platformName']))) {
    throw new Error('POWERSHELL_OPTIONS_REJECTED');
  }
  const { repositoryRoot, platformName = hostPlatform() } = options;
  if (platformName !== 'win32') throw new Error('POWERSHELL_PLATFORM_REJECTED');
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot)) {
    throw new Error('POWERSHELL_REPOSITORY_ROOT_REJECTED');
  }
  const repositoryReal = realpathSync(repositoryRoot);
  const kernelAnchoredPath = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
  let executable;
  try {
    executable = realpathSync.native(kernelAnchoredPath);
  } catch {
    throw new Error('POWERSHELL_EXECUTABLE_REJECTED');
  }
  if (isWithin(repositoryReal, executable) || !statSync(executable).isFile()) {
    throw new Error('POWERSHELL_EXECUTABLE_REJECTED');
  }
  return executable;
}

export function inspectAuthenticodeStatus({
  root,
  candidate,
  checkedAt,
  platformName = hostPlatform(),
  platformRelease = hostRelease()
}) {
  const base = {
    platform: platformName,
    artifactPresent: candidate?.artifactPresent === true,
    checkedAt,
    artifactSha256: candidate?.sha256 ?? null,
    environment: `${platformName} ${platformRelease}`
  };
  if (!candidate?.artifactPresent || platformName !== 'win32') return normalizeAuthenticodeResult(base);
  const rootReal = realpathSync(root);
  const lexicalArtifact = resolve(rootReal, candidate.expectedPath);
  if (!isWithin(rootReal, lexicalArtifact) || !existsSync(lexicalArtifact)) {
    throw new Error('AUTHENTICODE_ARTIFACT_PATH_REJECTED');
  }
  const artifactPath = realpathSync(lexicalArtifact);
  if (!isWithin(rootReal, artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error('AUTHENTICODE_ARTIFACT_PATH_REJECTED');
  }
  const beforeHash = sha256FileSync(artifactPath);
  if (beforeHash !== candidate.sha256) throw new Error('AUTHENTICODE_ARTIFACT_DRIFT');
  const scriptPath = realpathSync(resolve(rootReal, 'scripts', 'inspect-g11-authenticode.ps1'));
  if (!isWithin(rootReal, scriptPath) || !statSync(scriptPath).isFile()) {
    throw new Error('AUTHENTICODE_SCRIPT_PATH_REJECTED');
  }
  const powershellPath = resolveWindowsPowerShell({ repositoryRoot: rootReal, platformName });
  const result = spawnSync(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-LiteralArtifactPath', artifactPath
  ], { cwd: rootReal, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 });
  const afterHash = sha256FileSync(artifactPath);
  if (afterHash !== candidate.sha256 || afterHash !== beforeHash) throw new Error('AUTHENTICODE_ARTIFACT_DRIFT');
  if (result.error || result.status !== 0) {
    return normalizeAuthenticodeResult({ ...base, status: 'InspectionFailed' });
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  } catch {
    raw = { status: 'InspectionFailed' };
  }
  if (String(raw?.artifactSha256Before ?? '').toLowerCase() !== candidate.sha256 ||
      String(raw?.artifactSha256After ?? '').toLowerCase() !== candidate.sha256) {
    throw new Error('AUTHENTICODE_ARTIFACT_DRIFT');
  }
  return normalizeAuthenticodeResult({
    ...base,
    status: raw?.status,
    signerSubject: raw?.signerSubject,
    timestampPresent: raw?.timestampPresent,
    timestampSubject: raw?.timestampSubject
  });
}

export function buildChecksumManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('CHECKSUM_ENTRIES_REQUIRED');
  const aliases = new Set();
  const normalized = entries.map((entry) => {
    const path = normalizeChecksumPath(entry?.path);
    const alias = path.toLowerCase();
    if (aliases.has(alias)) throw new Error(`CHECKSUM_PATH_ALIAS:${path}`);
    aliases.add(alias);
    if (typeof entry?.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`CHECKSUM_HASH_INVALID:${path}`);
    }
    return { path, sha256: entry.sha256 };
  });
  return normalized
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join('');
}

export function verifyChecksumManifest({ root, manifestText }) {
  const errors = [];
  const add = (code, detail = '') => errors.push(error(code, detail));
  if (typeof manifestText !== 'string' || manifestText.length === 0 || !manifestText.endsWith('\n')) {
    return { ok: false, errors: [error('CHECKSUM_MANIFEST_INVALID')] };
  }
  const entries = [];
  for (const line of manifestText.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match === null) {
      add('CHECKSUM_MANIFEST_INVALID', line);
      continue;
    }
    entries.push({ sha256: match[1], path: match[2] });
  }
  let canonical = null;
  try {
    canonical = buildChecksumManifest(entries);
  } catch (cause) {
    add('CHECKSUM_MANIFEST_INVALID', cause.message);
  }
  if (canonical !== null && canonical !== manifestText) add('CHECKSUM_MANIFEST_NOT_CANONICAL');
  let rootReal = null;
  try {
    rootReal = realpathSync(root);
  } catch (cause) {
    add('CHECKSUM_ROOT_INVALID', cause.message);
  }
  if (rootReal === null) return { ok: false, errors };
  for (const entry of entries) {
    let path;
    try {
      path = normalizeChecksumPath(entry.path);
    } catch (cause) {
      add('CHECKSUM_PATH_REJECTED', cause.message);
      continue;
    }
    const lexical = resolve(rootReal, path);
    if (!isWithin(rootReal, lexical) || !existsSync(lexical)) {
      add(existsSync(lexical) ? 'CHECKSUM_PATH_ESCAPE' : 'CHECKSUM_FILE_MISSING', path);
      continue;
    }
    let actual;
    try {
      actual = realpathSync(lexical);
    } catch (cause) {
      add('CHECKSUM_FILE_MISSING', path);
      continue;
    }
    if (!isWithin(rootReal, actual)) {
      add('CHECKSUM_PATH_ESCAPE', path);
      continue;
    }
    if (!statSync(actual).isFile()) {
      add('CHECKSUM_NOT_FILE', path);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(actual)).digest('hex');
    if (digest !== entry.sha256) add('CHECKSUM_HASH_MISMATCH', path);
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeAuthenticodeResult(input) {
  let status;
  let reasonCode;
  if (input?.artifactPresent !== true) {
    status = 'NOT_RUN';
    reasonCode = 'RELEASE_ARTIFACT_MISSING';
  } else if (input?.platform !== 'win32') {
    status = 'NOT_RUN';
    reasonCode = 'BLOCKED_EXTERNAL_WINDOWS_SIGNATURE_CHECK';
  } else if (input?.status === 'Valid' && input?.timestampPresent === true) {
    status = 'SIGNED_VALID';
    reasonCode = 'SIGNATURE_AND_TIMESTAMP_VALID';
  } else if (input?.status === 'Valid') {
    status = 'SIGNED_INVALID';
    reasonCode = 'RELEASE_TIMESTAMP_REQUIRED';
  } else if (input?.status === 'NotSigned') {
    status = 'UNSIGNED';
    reasonCode = 'RELEASE_SIGNATURE_MISSING';
  } else {
    status = 'SIGNED_INVALID';
    reasonCode = 'RELEASE_SIGNATURE_INVALID';
  }
  const signedAndValid = status === 'SIGNED_VALID';
  return {
    status,
    reasonCode,
    signerSubject: signedAndValid && typeof input?.signerSubject === 'string' ? input.signerSubject : null,
    timestampPresent: signedAndValid,
    timestampSubject: signedAndValid && typeof input?.timestampSubject === 'string' ? input.timestampSubject : null,
    checkedAt: typeof input?.checkedAt === 'string' ? input.checkedAt : null,
    artifactSha256: typeof input?.artifactSha256 === 'string' && SHA256_PATTERN.test(input.artifactSha256)
      ? input.artifactSha256 : null,
    environment: typeof input?.environment === 'string' ? input.environment : null
  };
}

export function writeTextAtomic({ targetPath, text, validate }) {
  if (typeof targetPath !== 'string' || typeof text !== 'string' || typeof validate !== 'function') {
    throw new Error('ATOMIC_TEXT_INPUT_INVALID');
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const stagePath = resolve(dirname(targetPath), `${basename(targetPath)}.stage-${token}`);
  const backupPath = resolve(dirname(targetPath), `${basename(targetPath)}.rollback-${token}`);
  let descriptor;
  let hadTarget = false;
  try {
    descriptor = openSync(stagePath, 'wx');
    writeFileSync(descriptor, text, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    const stagedText = readFileSync(stagePath, 'utf8');
    const validation = validate(stagedText);
    if (validation === false || (isPlainObject(validation) && validation.ok === false)) {
      throw new Error('ATOMIC_TEXT_VALIDATION_FAILED');
    }
    hadTarget = existsSync(targetPath);
    if (hadTarget) renameSync(targetPath, backupPath);
    renameSync(stagePath, targetPath);
    rmSync(backupPath, { force: true });
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(stagePath, { force: true });
    if (hadTarget && existsSync(backupPath)) {
      rmSync(targetPath, { force: true });
      renameSync(backupPath, targetPath);
    }
    throw cause;
  }
}
