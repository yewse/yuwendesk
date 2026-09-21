#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildAcceptanceRun,
  inspectCandidateArtifact,
  loadCandidateBuildProvenance,
  loadAcceptanceDefinitions,
  normalizeVitestReport,
  npmCliPathForNodeExecutable,
  recoverJsonSetAtomic,
  resolveVitestEntrypoint,
  validateCandidateArtifact,
  validateAcceptanceMap,
  validateAcceptanceRun,
  validateExternalEvidenceInput,
  validateG12VerticalEvidenceInput,
  validateNormalizedVitest,
  writeJsonAtomic,
  writeJsonSetAtomic
} from './lib/g11-acceptance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = resolve(root, 'apps', 'desktop');
const reportsRoot = resolve(root, 'reports', 'acceptance-runs');
const releaseTransactionPath = resolve(root, 'reports', 'release', '.g11-release-set-transaction.json');
mkdirSync(reportsRoot, { recursive: true });
recoverJsonSetAtomic({
  transactionPath: releaseTransactionPath,
  expectedTargetNames: ['candidate-artifact.json', 'release-input.json']
});

function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...options
  });
  if (outcome.error) throw outcome.error;
  return outcome;
}

function git(...args) {
  const outcome = run('git', args);
  if (outcome.status !== 0) throw new Error(`GIT_COMMAND_FAILED:${outcome.stderr.trim()}`);
  return outcome.stdout.trim();
}

function npmVersion() {
  const npmCli = npmCliPathForNodeExecutable(process.execPath);
  const outcome = run(process.execPath, [npmCli, '--version']);
  if (outcome.status !== 0) throw new Error(`NPM_VERSION_FAILED:${outcome.stderr.trim()}`);
  return outcome.stdout.trim();
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function nextRunId(date, sourceCommit) {
  const prefix = `run-${dateStamp(date)}-${sourceCommit.slice(0, 7)}-`;
  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const runId = `${prefix}${String(sequence).padStart(2, '0')}`;
    if (!existsSync(resolve(reportsRoot, `${runId}.json`)) &&
        !existsSync(resolve(reportsRoot, `vitest-${runId}.json`))) return runId;
  }
  throw new Error('ACCEPTANCE_RUN_SEQUENCE_EXHAUSTED');
}

function evidenceArguments(argv) {
  if (argv.length % 2 !== 0) {
    throw new Error('USAGE: npm run acceptance:run -- [--external-evidence <path>] [--g12-evidence <path>]');
  }
  const allowedRoot = resolve(root, 'apps', 'desktop', 'release', 'acceptance');
  const result = { external: null, g12: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flag === '--external-evidence' ? 'external' : flag === '--g12-evidence' ? 'g12' : null;
    if (key === null || result[key] !== null || !argv[index + 1]) {
      throw new Error('USAGE: npm run acceptance:run -- [--external-evidence <path>] [--g12-evidence <path>]');
    }
    const requested = resolve(root, argv[index + 1]);
    if (!existsSync(requested)) throw new Error(`${key.toUpperCase()}_EVIDENCE_FILE_MISSING`);
    const allowedReal = realpathSync(allowedRoot);
    const requestedReal = realpathSync(requested);
    const rel = relative(allowedReal, requestedReal);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
      throw new Error(`${key.toUpperCase()}_EVIDENCE_PATH_REJECTED`);
    }
    result[key] = requestedReal;
  }
  return result;
}

const started = new Date();
const sourceCommit = git('rev-parse', 'HEAD');
const repositoryDirty = git('status', '--porcelain').length > 0;
const runId = nextRunId(started, sourceCommit);
const evidenceInputPaths = evidenceArguments(process.argv.slice(2));
const externalEvidenceInputPath = evidenceInputPaths.external;
const externalReport = externalEvidenceInputPath === null
  ? null
  : JSON.parse(readFileSync(externalEvidenceInputPath, 'utf8'));
const g12Report = evidenceInputPaths.g12 === null ? null : JSON.parse(readFileSync(evidenceInputPaths.g12, 'utf8'));
const evidenceStartedAt = [externalReport?.startedAt, g12Report?.startedAt]
  .filter((value) => typeof value === 'string' && Date.parse(value) < started.getTime())
  .sort()[0];
const startedAt = evidenceStartedAt ?? started.toISOString();
const rawPath = resolve(reportsRoot, `.${runId}.${process.pid}-${randomUUID()}.vitest.raw.partial`);
const normalizedPath = resolve(reportsRoot, `vitest-${runId}.json`);
const normalizedRelativePath = relative(root, normalizedPath).replaceAll('\\', '/');
const externalPath = resolve(reportsRoot, `external-${runId}.json`);
const externalRelativePath = relative(root, externalPath).replaceAll('\\', '/');
const g12Path = resolve(reportsRoot, `g12-${runId}.json`);
const g12RelativePath = relative(root, g12Path).replaceAll('\\', '/');
const runPath = resolve(reportsRoot, `${runId}.json`);
const runRelativePath = relative(root, runPath).replaceAll('\\', '/');

const loaded = loadAcceptanceDefinitions(root);
if (loaded.definitions.length !== 170 || loaded.definitions.some((definition) => definition.status !== 'NOT_RUN')) {
  throw new Error('ACCEPTANCE_DEFINITIONS_NOT_FROZEN');
}
const acceptanceMap = JSON.parse(readFileSync(resolve(root, 'planning', 'g11-acceptance-map.json'), 'utf8'));
const externalInputs = JSON.parse(readFileSync(resolve(root, 'planning', 'EXTERNAL_INPUTS.json'), 'utf8'));
const externalInputIds = (externalInputs.items ?? []).map((item) => item.id);
if (new Set(externalInputIds).size !== externalInputIds.length) throw new Error('EXTERNAL_INPUT_DUPLICATE');
const mapValidation = validateAcceptanceMap({
  definitionIds: loaded.definitions.map((definition) => definition.id),
  map: acceptanceMap,
  knownExternalInputIds: externalInputIds
});
if (!mapValidation.ok) throw new Error(`ACCEPTANCE_MAP_INVALID:${JSON.stringify(mapValidation.errors)}`);
if (externalReport !== null) {
  const externalValidation = validateExternalEvidenceInput({
    root, map: acceptanceMap, externalInputs, sourceCommit, report: externalReport
  });
  if (!externalValidation.ok) {
    throw new Error(`EXTERNAL_EVIDENCE_INVALID:${JSON.stringify(externalValidation.errors)}`);
  }
}
if (g12Report !== null) {
  const g12Validation = validateG12VerticalEvidenceInput({ root, sourceCommit, report: g12Report });
  if (!g12Validation.ok) throw new Error(`G12_EVIDENCE_INVALID:${JSON.stringify(g12Validation.errors)}`);
}

const vitestPath = resolveVitestEntrypoint(root);
const vitestRelative = relative(desktopRoot, vitestPath).replaceAll('\\', '/');
const rawRelative = relative(desktopRoot, rawPath).replaceAll('\\', '/');
const vitestArgs = [vitestRelative, 'run', '--reporter=json', '--outputFile', rawRelative];
const recordedCommand = `node ${vitestArgs.join(' ')}`;
const selectedAssertionKeys = new Set(acceptanceMap.cases
  .filter((entry) => entry.mode === 'automation')
  .map((entry) => `${entry.testFile}\0${entry.testName}`));
const vitestStartedAt = new Date().toISOString();
let vitestOutcome;
let normalizedPublished = false;
let externalPublished = false;
let g12Published = false;
let runPublished = false;
try {
  vitestOutcome = run(process.execPath, vitestArgs, {
    cwd: desktopRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (!existsSync(rawPath)) throw new Error(`VITEST_JSON_MISSING:${vitestOutcome.stderr.trim()}`);
  const rawReport = JSON.parse(readFileSync(rawPath, 'utf8'));
  const completedAt = new Date().toISOString();
  const normalizedReport = normalizeVitestReport({
    raw: rawReport,
    exitCode: vitestOutcome.status ?? 1,
    startedAt: vitestStartedAt,
    completedAt,
    command: recordedCommand,
    selectedKeys: selectedAssertionKeys,
    runId,
    sourceCommit,
    repositoryDirty,
    desktopRoot
  });
  writeJsonAtomic({
    targetPath: normalizedPath, value: normalizedReport, validate: validateNormalizedVitest, noClobber: true
  });
  normalizedPublished = true;
  if (externalReport !== null) {
    writeJsonAtomic({
      targetPath: externalPath,
      value: externalReport,
      validate: (value) => validateExternalEvidenceInput({
        root, map: acceptanceMap, externalInputs, sourceCommit, report: value
      }),
      noClobber: true
    });
    externalPublished = true;
  }
  if (g12Report !== null) {
    writeJsonAtomic({
      targetPath: g12Path,
      value: g12Report,
      validate: (value) => validateG12VerticalEvidenceInput({ root, sourceCommit, report: value }),
      noClobber: true
    });
    g12Published = true;
  }

  const acceptanceRun = buildAcceptanceRun({
    root,
    definitions: loaded.definitions,
    definitionSources: loaded.definitionSources,
    map: acceptanceMap,
    automationReport: normalizedReport,
    sourceCommit,
    repositoryDirty,
    runId,
    startedAt,
    completedAt,
    environment: {
      os: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      npm: npmVersion()
    },
    evidencePath: normalizedRelativePath,
    supplementalEvidencePaths: g12Report === null ? [] : [g12RelativePath],
    externalReport,
    externalEvidencePath: externalReport === null ? null : externalRelativePath,
    externalInputs
  });
  const validateRun = (value) => validateAcceptanceRun({
    root,
    definitionIds: loaded.definitions.map((definition) => definition.id),
    map: acceptanceMap,
    run: value
  });
  const runValidation = validateRun(acceptanceRun);
  if (!runValidation.ok) throw new Error(`ACCEPTANCE_RUN_INVALID:${JSON.stringify(runValidation.errors)}`);
  writeJsonAtomic({ targetPath: runPath, value: acceptanceRun, validate: validateRun, noClobber: true });
  runPublished = true;

  const candidateBuild = loadCandidateBuildProvenance({ root, sourceCommit });
  const candidate = inspectCandidateArtifact({
    root,
    sourceCommit,
    checkedAt: completedAt,
    buildCommand: candidateBuild?.buildCommand ?? null,
    buildEnvironment: candidateBuild?.buildEnvironment ?? null
  });
  const candidatePath = resolve(root, 'reports', 'release', 'candidate-artifact.json');
  const releaseInput = {
    schemaVersion: 1,
    generatedAt: completedAt,
    sourceCommit,
    acceptanceRunPath: runRelativePath,
    candidateArtifactPath: 'reports/release/candidate-artifact.json'
  };
  writeJsonSetAtomic({ transactionPath: releaseTransactionPath, entries: [
    { targetPath: candidatePath, value: candidate, validate: validateCandidateArtifact },
    {
      targetPath: resolve(root, 'reports', 'release', 'release-input.json'),
      value: releaseInput,
      validate: (value) => value?.schemaVersion === 1 && value?.sourceCommit === sourceCommit &&
        value?.acceptanceRunPath === runRelativePath &&
        value?.candidateArtifactPath === 'reports/release/candidate-artifact.json'
    }
  ] });

  const counts = acceptanceRun.results.reduce((summary, item) => {
    summary[item.status] += 1;
    return summary;
  }, { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 });
  console.log(JSON.stringify({
    runId,
    sourceCommit,
    repositoryDirty,
    counts,
    artifactPresent: candidate.artifactPresent,
    artifactClass: candidate.artifactClass,
    runPath: runRelativePath
  }, null, 2));
} catch (cause) {
  if (normalizedPublished) rmSync(normalizedPath, { force: true });
  if (externalPublished) rmSync(externalPath, { force: true });
  if (g12Published) rmSync(g12Path, { force: true });
  if (runPublished) rmSync(runPath, { force: true });
  throw cause;
} finally {
  rmSync(rawPath, { force: true });
}
