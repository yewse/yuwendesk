import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const CASE_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
export const EVIDENCE_LEVELS = Object.freeze([
  'engineering_automation',
  'developer_windows',
  'clean_windows_standard_user',
  'office_wps',
  'live_api_authorized',
  'privacy_authorized_material',
  'teacher_professional_review'
]);

export const FROZEN_DEFINITION_SOURCES = Object.freeze([
  Object.freeze({
    path: 'acceptance/cases.json',
    count: 130,
    sha256: 'cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5'
  }),
  Object.freeze({
    path: 'acceptance/addenda/classroom-delivery.cases.json',
    count: 40,
    sha256: 'f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06'
  })
]);

export const BLOCKER_CODES = Object.freeze([
  'BLOCKED_EXTERNAL_WINDOWS_ACCEPTANCE',
  'BLOCKED_EXTERNAL_AUTHORIZED_SOURCE_MATERIAL',
  'BLOCKED_EXTERNAL_LIVE_API_AND_BUDGET',
  'BLOCKED_EXTERNAL_PRIVACY_AUTHORIZATION',
  'BLOCKED_EXTERNAL_OFFICE_WPS_RENDERING',
  'BLOCKED_EXTERNAL_WINDOWS_CLASSROOM_VIEW',
  'BLOCKED_EXTERNAL_SIGNING_IDENTITY',
  'BLOCKED_EXTERNAL_DISTRIBUTION_TARGET',
  'BLOCKED_EXTERNAL_OFFICE_WPS_COMPATIBILITY',
  'BLOCKED_EXTERNAL_WINDOWS_OFFLINE_CLASSROOM'
]);

export function npmCliPathForNodeExecutable(nodeExecutable) {
  return resolve(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

const MAP_MODES = new Set(['automation', 'external', 'not_run']);
const EVIDENCE_LEVEL_SET = new Set(EVIDENCE_LEVELS);
const CASE_STATUS_SET = new Set(CASE_STATUSES);
const BLOCKER_CODE_SET = new Set(BLOCKER_CODES);
const ALLOWED_PREFIXES = ['reports/', 'docs/', 'acceptance/', 'planning/', 'apps/desktop/release/'];
const ALLOWED_FILES = new Set(['ENV_LOCK.json', 'package-lock.json']);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function error(code, detail = '') {
  return { code, detail };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDate(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function normalizeRepositoryPath(value) {
  if (!isNonEmptyString(value)) return null;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return null;
  if (value.includes(':') || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (!ALLOWED_FILES.has(value) && !ALLOWED_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  return value;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateEvidenceFile(root, entry, label) {
  const errors = [];
  if (!hasOnlyKeys(entry, new Set(['path', 'sha256', 'sizeBytes'])) ||
      normalizeRepositoryPath(entry?.path) === null ||
      !/^[a-f0-9]{64}$/i.test(entry?.sha256 ?? '') ||
      !Number.isSafeInteger(entry?.sizeBytes) || entry.sizeBytes < 0) {
    errors.push(error('EVIDENCE_PATH_REJECTED', `${label}:${entry?.path ?? ''}`));
    return errors;
  }

  const rootReal = realpathSync(root);
  const lexical = resolve(rootReal, entry.path);
  if (!isWithin(rootReal, lexical)) {
    errors.push(error('EVIDENCE_PATH_REJECTED', `${label}:${entry.path}`));
    return errors;
  }
  if (!existsSync(lexical)) {
    errors.push(error('EVIDENCE_FILE_MISSING', `${label}:${entry.path}`));
    return errors;
  }

  const actual = realpathSync(lexical);
  if (!isWithin(rootReal, actual)) {
    errors.push(error('EVIDENCE_SYMLINK_ESCAPE', `${label}:${entry.path}`));
    return errors;
  }
  const data = readFileSync(actual);
  if (data.byteLength !== entry.sizeBytes) errors.push(error('EVIDENCE_SIZE_MISMATCH', `${label}:${entry.path}`));
  if (sha256(data) !== entry.sha256.toLowerCase()) errors.push(error('EVIDENCE_HASH_MISMATCH', `${label}:${entry.path}`));
  return errors;
}

export function loadAcceptanceDefinitions(root) {
  const definitions = [];
  const definitionSources = FROZEN_DEFINITION_SOURCES.map((source) => {
    const bytes = readFileSync(resolve(root, source.path));
    const actualHash = sha256(bytes);
    if (actualHash !== source.sha256) throw new Error(`ACCEPTANCE_DEFINITION_HASH_MISMATCH:${source.path}`);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(parsed.cases) || parsed.cases.length !== source.count) {
      throw new Error(`ACCEPTANCE_DEFINITION_COUNT_MISMATCH:${source.path}`);
    }
    definitions.push(...parsed.cases);
    return { path: source.path, sha256: actualHash };
  });
  return { definitions, definitionSources };
}

function validMapEntry(entry) {
  if (!isPlainObject(entry) || !isNonEmptyString(entry.caseId) || !MAP_MODES.has(entry.mode) ||
      !EVIDENCE_LEVEL_SET.has(entry.requiredEvidenceLevel)) return false;

  if (entry.mode === 'automation') {
    return hasOnlyKeys(entry, new Set(['caseId', 'mode', 'requiredEvidenceLevel', 'commandGroup', 'testFile', 'testName'])) &&
      entry.requiredEvidenceLevel === 'engineering_automation' && entry.commandGroup === 'desktop-unit' &&
      /^tests\/[A-Za-z0-9._/-]+\.test\.ts$/.test(entry.testFile ?? '') && isNonEmptyString(entry.testName);
  }
  if (entry.mode === 'external') {
    return hasOnlyKeys(entry, new Set(['caseId', 'mode', 'requiredEvidenceLevel', 'blockerCode', 'externalInputIds'])) &&
      BLOCKER_CODE_SET.has(entry.blockerCode) && Array.isArray(entry.externalInputIds) &&
      entry.externalInputIds.length > 0 && new Set(entry.externalInputIds).size === entry.externalInputIds.length &&
      entry.externalInputIds.every((id) => /^EXT\d{2}$/.test(id));
  }
  return hasOnlyKeys(entry, new Set(['caseId', 'mode', 'requiredEvidenceLevel', 'reasonCode'])) &&
    entry.reasonCode === 'FORMAL_CASE_NOT_EXECUTED';
}

export function validateAcceptanceMap({ definitionIds, map, knownExternalInputIds = null }) {
  const errors = [];
  const expected = new Set(definitionIds);
  const entries = Array.isArray(map?.cases) ? map.cases : [];
  if (!hasOnlyKeys(map, new Set(['schemaVersion', 'cases'])) || map?.schemaVersion !== 1 || !Array.isArray(map?.cases)) {
    errors.push(error('ACCEPTANCE_MAP_INVALID'));
  }

  const counts = new Map();
  const knownExternal = knownExternalInputIds === null ? null : new Set(knownExternalInputIds);
  for (const entry of entries) {
    if (!validMapEntry(entry)) errors.push(error('ACCEPTANCE_MAP_ENTRY_INVALID', entry?.caseId ?? ''));
    if (entry?.mode === 'external') {
      if (knownExternal === null) {
        errors.push(error('ACCEPTANCE_MAP_EXTERNAL_INPUT_CATALOG_REQUIRED', entry.caseId));
      } else {
        for (const id of entry.externalInputIds ?? []) {
          if (!knownExternal.has(id)) errors.push(error('ACCEPTANCE_MAP_EXTERNAL_INPUT_UNKNOWN', `${entry.caseId}:${id}`));
        }
      }
    }
    if (isNonEmptyString(entry?.caseId)) counts.set(entry.caseId, (counts.get(entry.caseId) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) errors.push(error('ACCEPTANCE_MAP_DUPLICATE', id));
    if (!expected.has(id)) errors.push(error('ACCEPTANCE_MAP_UNKNOWN', id));
  }
  for (const id of expected) {
    if (!counts.has(id)) errors.push(error('ACCEPTANCE_MAP_MISSING', id));
  }
  return { ok: errors.length === 0, errors };
}

export function validateCaseState(result) {
  if (result.status === 'PASS') {
    return result.exitCode === 0 && isNonEmptyString(result.command) && EVIDENCE_LEVEL_SET.has(result.evidenceLevel) &&
      isIsoDate(result.executedAt) && result.evidence.length > 0 &&
      result.blockerCode === null && result.externalInputIds.length === 0;
  }
  if (result.status === 'BLOCKED') {
    return result.command === null && result.exitCode === null && result.executedAt === null &&
      result.evidenceLevel === null && result.evidence.length === 0 && result.artifactHashes.length === 0 &&
      BLOCKER_CODE_SET.has(result.blockerCode) && result.externalInputIds.length > 0;
  }
  if (result.status === 'NOT_RUN') {
    return result.command === null && result.exitCode === null && result.executedAt === null &&
      result.blockerCode === null && result.externalInputIds.length === 0 && result.evidence.length === 0 &&
      result.artifactHashes.length === 0 && result.evidenceLevel === null;
  }
  return result.status === 'FAIL' && isNonEmptyString(result.command) && EVIDENCE_LEVEL_SET.has(result.evidenceLevel) &&
    Number.isInteger(result.exitCode) && isIsoDate(result.executedAt) && result.evidence.length > 0 &&
    result.blockerCode === null && result.externalInputIds.length === 0;
}

function validateResultShape(result) {
  const allowed = new Set([
    'caseId', 'status', 'evidenceLevel', 'command', 'exitCode', 'executedAt', 'environment',
    'evidence', 'artifactHashes', 'blockerCode', 'externalInputIds', 'observedResult'
  ]);
  return hasOnlyKeys(result, allowed) && isNonEmptyString(result.caseId) && CASE_STATUS_SET.has(result.status) &&
    (result.evidenceLevel === null || EVIDENCE_LEVEL_SET.has(result.evidenceLevel)) &&
    (result.command === null || isNonEmptyString(result.command)) &&
    (result.exitCode === null || Number.isInteger(result.exitCode)) &&
    (result.executedAt === null || isIsoDate(result.executedAt)) && isNonEmptyString(result.environment) &&
    Array.isArray(result.evidence) && Array.isArray(result.artifactHashes) &&
    (result.blockerCode === null || isNonEmptyString(result.blockerCode)) &&
    Array.isArray(result.externalInputIds) && result.externalInputIds.every(isNonEmptyString) &&
    isNonEmptyString(result.observedResult);
}

function validateDefinitionSources(root, sources) {
  if (!Array.isArray(sources) || sources.length !== FROZEN_DEFINITION_SOURCES.length) return false;
  return FROZEN_DEFINITION_SOURCES.every((expected) => {
    const matches = sources.filter((source) => source?.path === expected.path);
    if (matches.length !== 1 || matches[0].sha256 !== expected.sha256) return false;
    return sha256(readFileSync(resolve(root, expected.path))) === expected.sha256;
  });
}

function validateAutomationEvidence(root, result, mapEntry, run) {
  if (result.evidence.length !== 1) return false;
  try {
    const report = JSON.parse(readFileSync(resolve(root, result.evidence[0].path), 'utf8'));
    const expectedPath = `reports/acceptance-runs/vitest-${run.runId}.json`;
    if (result.evidence[0].path !== expectedPath || report.schemaVersion !== 1 || report.runId !== run.runId ||
        report.sourceCommit !== run.sourceCommit || report.repositoryDirty !== run.repositoryDirty ||
        result.command !== report.command || !isIsoDate(report.startedAt) || !isIsoDate(report.completedAt) ||
        Date.parse(report.startedAt) > Date.parse(report.completedAt) ||
        Date.parse(report.startedAt) < Date.parse(run.startedAt) || Date.parse(report.completedAt) > Date.parse(run.completedAt) ||
        result.executedAt !== report.completedAt) return false;
    const matches = (report.assertions ?? []).filter((assertion) =>
      assertion.testFile === mapEntry.testFile && assertion.fullName === mapEntry.testName);
    if (matches.length !== 1) return false;
    if (result.status === 'PASS') {
      return report.success === true && report.exitCode === 0 && matches[0].status === 'passed';
    }
    return report.success !== true || report.exitCode !== 0 || matches[0].status !== 'passed';
  } catch {
    return false;
  }
}

export function validateAcceptanceRun({ root, definitionIds, map, run }) {
  const errors = [];
  const runKeys = new Set([
    'schemaVersion', 'runId', 'sourceCommit', 'repositoryDirty', 'startedAt', 'completedAt',
    'environment', 'definitionSources', 'results'
  ]);
  const envKeys = new Set(['os', 'release', 'arch', 'node', 'npm']);
  const sourceKeys = new Set(['path', 'sha256']);
  const structurallyValid = hasOnlyKeys(run, runKeys) && run?.schemaVersion === 1 &&
    /^run-\d{8}-[a-f0-9]{7}-\d{2}$/.test(run?.runId ?? '') && /^[a-f0-9]{7,64}$/.test(run?.sourceCommit ?? '') &&
    typeof run?.repositoryDirty === 'boolean' && isIsoDate(run?.startedAt) && isIsoDate(run?.completedAt) &&
    hasOnlyKeys(run?.environment, envKeys) && Object.values(run.environment).every(isNonEmptyString) &&
    Array.isArray(run?.definitionSources) && run.definitionSources.every((source) =>
      hasOnlyKeys(source, sourceKeys) && normalizeRepositoryPath(source.path) !== null && /^[a-f0-9]{64}$/.test(source.sha256)) &&
    Array.isArray(run?.results);
  if (!structurallyValid) errors.push(error('ACCEPTANCE_RUN_INVALID'));
  if (!validateDefinitionSources(root, run?.definitionSources)) errors.push(error('ACCEPTANCE_DEFINITION_SOURCE_INVALID'));
  if (isIsoDate(run?.startedAt) && isIsoDate(run?.completedAt) && Date.parse(run.startedAt) > Date.parse(run.completedAt)) {
    errors.push(error('ACCEPTANCE_RUN_TIME_INVALID'));
  }
  if (isNonEmptyString(run?.runId) && isNonEmptyString(run?.sourceCommit) &&
      !run.runId.includes(`-${run.sourceCommit.slice(0, 7)}-`)) errors.push(error('ACCEPTANCE_RUN_SOURCE_MISMATCH'));

  const expected = new Set(definitionIds);
  const mapById = new Map((map?.cases ?? []).map((entry) => [entry.caseId, entry]));
  if (!map || mapById.size !== expected.size) errors.push(error('ACCEPTANCE_RUN_MAP_INVALID'));
  const counts = new Map();
  for (const result of Array.isArray(run?.results) ? run.results : []) {
    if (!validateResultShape(result)) {
      errors.push(error('ACCEPTANCE_RESULT_INVALID', result?.caseId ?? ''));
      continue;
    }
    counts.set(result.caseId, (counts.get(result.caseId) ?? 0) + 1);
    if (!expected.has(result.caseId)) errors.push(error('ACCEPTANCE_RUN_UNKNOWN', result.caseId));
    if (!validateCaseState(result)) {
      const code = result.status === 'PASS' ? 'ACCEPTANCE_PASS_INVALID'
        : result.status === 'BLOCKED' ? 'ACCEPTANCE_BLOCKER_INVALID'
          : result.status === 'NOT_RUN' ? 'ACCEPTANCE_NOT_RUN_INVALID' : 'ACCEPTANCE_FAIL_INVALID';
      errors.push(error(code, result.caseId));
    }
    const mapEntry = mapById.get(result.caseId);
    const statusMatchesMap = mapEntry && (
      (mapEntry.mode === 'automation' && ['PASS', 'FAIL'].includes(result.status) &&
        result.evidenceLevel === mapEntry.requiredEvidenceLevel && isNonEmptyString(result.command)) ||
      (mapEntry.mode === 'external' && result.status === 'BLOCKED' && result.blockerCode === mapEntry.blockerCode &&
        JSON.stringify(result.externalInputIds) === JSON.stringify(mapEntry.externalInputIds)) ||
      (mapEntry.mode === 'not_run' && result.status === 'NOT_RUN')
    );
    if (!statusMatchesMap) errors.push(error('ACCEPTANCE_RESULT_MAP_MISMATCH', result.caseId));
    if (result.executedAt !== null && isIsoDate(run?.startedAt) && isIsoDate(run?.completedAt) &&
        (Date.parse(result.executedAt) < Date.parse(run.startedAt) || Date.parse(result.executedAt) > Date.parse(run.completedAt))) {
      errors.push(error('ACCEPTANCE_EXECUTION_TIME_INVALID', result.caseId));
    }
    let evidenceFilesValid = true;
    for (const [index, entry] of result.evidence.entries()) {
      const evidenceErrors = validateEvidenceFile(root, entry, `${result.caseId}:evidence:${index}`);
      if (evidenceErrors.length > 0) evidenceFilesValid = false;
      errors.push(...evidenceErrors);
    }
    for (const [index, entry] of result.artifactHashes.entries()) {
      errors.push(...validateEvidenceFile(root, entry, `${result.caseId}:artifact:${index}`));
    }
    if (mapEntry?.mode === 'automation' && evidenceFilesValid && !validateAutomationEvidence(root, result, mapEntry, run)) {
      errors.push(error('ACCEPTANCE_AUTOMATION_EVIDENCE_INVALID', result.caseId));
    }
  }
  for (const [id, count] of counts) if (count > 1) errors.push(error('ACCEPTANCE_RUN_DUPLICATE', id));
  for (const id of expected) if (!counts.has(id)) errors.push(error('ACCEPTANCE_RUN_MISSING', id));
  return { ok: errors.length === 0, errors };
}

function evidenceDescriptor(root, path) {
  const data = readFileSync(resolve(root, path));
  return { path, sha256: sha256(data), sizeBytes: data.byteLength };
}

export function buildAcceptanceRun({
  root, definitions, definitionSources, map, automationReport, sourceCommit, repositoryDirty,
  runId, startedAt, completedAt, environment, evidencePath
}) {
  const assertions = new Map();
  for (const item of automationReport?.assertions ?? []) assertions.set(`${item.testFile}\0${item.fullName}`, item);
  const evidence = evidenceDescriptor(root, evidencePath);
  const mapById = new Map(map.cases.map((entry) => [entry.caseId, entry]));
  const results = definitions.map((definition) => {
    const entry = mapById.get(definition.id);
    if (entry.mode === 'external') {
      return {
        caseId: definition.id, status: 'BLOCKED', evidenceLevel: null, command: null, exitCode: null,
        executedAt: null, environment: entry.requiredEvidenceLevel, evidence: [], artifactHashes: [],
        blockerCode: entry.blockerCode, externalInputIds: entry.externalInputIds,
        observedResult: `缺少 ${entry.externalInputIds.join(', ')}，未执行所需外部环境验收。`
      };
    }
    if (entry.mode === 'not_run') {
      return {
        caseId: definition.id, status: 'NOT_RUN', evidenceLevel: null, command: null, exitCode: null,
        executedAt: null, environment: entry.requiredEvidenceLevel, evidence: [], artifactHashes: [],
        blockerCode: null, externalInputIds: [], observedResult: '正式案例尚未执行；未从文档或宽泛测试结果推断通过。'
      };
    }

    const assertion = assertions.get(`${entry.testFile}\0${entry.testName}`);
    const passed = assertion?.status === 'passed' && automationReport?.success === true && automationReport?.exitCode === 0;
    return {
      caseId: definition.id,
      status: passed ? 'PASS' : 'FAIL',
      evidenceLevel: entry.requiredEvidenceLevel,
      command: automationReport.command,
      exitCode: passed ? 0 : (Number.isInteger(automationReport?.exitCode) ? automationReport.exitCode : 1),
      executedAt: completedAt,
      environment: 'desktop-unit / local engineering automation',
      evidence: [evidence],
      artifactHashes: [],
      blockerCode: null,
      externalInputIds: [],
      observedResult: assertion
        ? (passed ? `精确匹配并通过：${entry.testFile} :: ${entry.testName}` : `精确匹配但未通过：${entry.testFile} :: ${entry.testName}`)
        : `验收映射未在 Vitest JSON 中找到：${entry.testFile} :: ${entry.testName}`
    };
  });

  return {
    schemaVersion: 1, runId, sourceCommit, repositoryDirty, startedAt, completedAt, environment,
    definitionSources,
    results
  };
}

export function inspectCandidateArtifact({
  root, sourceCommit, checkedAt = new Date().toISOString(), buildCommand = null, buildEnvironment = null
}) {
  const expectedPath = 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe';
  const absolute = resolve(root, expectedPath);
  const artifactPresent = existsSync(absolute) && statSync(absolute).isFile();
  if (!artifactPresent) {
    return {
      schemaVersion: 1, sourceCommit, checkedAt, expectedPath, artifactPresent: false,
      artifactClass: 'NONE', sha256: null, sizeBytes: null, buildCommand: null, buildEnvironment: null
    };
  }
  const rootReal = realpathSync(root);
  const releaseRoot = resolve(rootReal, 'apps', 'desktop', 'release');
  const actualReleaseRoot = realpathSync(releaseRoot);
  const actual = realpathSync(absolute);
  if (relative(releaseRoot, actualReleaseRoot) !== '' || !isWithin(releaseRoot, actual)) {
    throw new Error('CANDIDATE_SYMLINK_ESCAPE');
  }
  if (!isNonEmptyString(buildCommand) || !isPlainObject(buildEnvironment)) {
    throw new Error('CANDIDATE_BUILD_PROVENANCE_MISSING');
  }
  const data = readFileSync(actual);
  return {
    schemaVersion: 1, sourceCommit, checkedAt, expectedPath, artifactPresent: true,
    artifactClass: 'UNSIGNED_TEST_BUILD', sha256: sha256(data), sizeBytes: data.byteLength,
    buildCommand, buildEnvironment
  };
}

export function validateCandidateArtifact(value) {
  const allowed = new Set([
    'schemaVersion', 'sourceCommit', 'checkedAt', 'expectedPath', 'artifactPresent', 'artifactClass',
    'sha256', 'sizeBytes', 'buildCommand', 'buildEnvironment'
  ]);
  if (!hasOnlyKeys(value, allowed) || value.schemaVersion !== 1 || !/^[a-f0-9]{7,64}$/.test(value.sourceCommit ?? '') ||
      !isIsoDate(value.checkedAt) || value.expectedPath !== 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe' ||
      typeof value.artifactPresent !== 'boolean') return false;
  if (!value.artifactPresent) {
    return value.artifactClass === 'NONE' && value.sha256 === null && value.sizeBytes === null &&
      value.buildCommand === null && value.buildEnvironment === null;
  }
  const environmentKeys = new Set(['os', 'release', 'arch', 'node', 'npm']);
  return value.artifactClass === 'UNSIGNED_TEST_BUILD' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '') &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && isNonEmptyString(value.buildCommand) &&
    hasOnlyKeys(value.buildEnvironment, environmentKeys) && Object.values(value.buildEnvironment).every(isNonEmptyString);
}

export function writeJsonAtomic({ targetPath, value, validate, noClobber = false }) {
  const partial = `${targetPath}.${process.pid}-${randomUUID()}.partial`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(partial, serialized, { encoding: 'utf8', flag: 'wx' });
    const parsed = JSON.parse(readFileSync(partial, 'utf8'));
    const validation = validate(parsed);
    if (validation === false || (isPlainObject(validation) && validation.ok === false)) {
      const details = isPlainObject(validation) ? JSON.stringify(validation.errors ?? []) : '';
      throw new Error(`ATOMIC_JSON_VALIDATION_FAILED:${details}`);
    }
    if (noClobber) {
      linkSync(partial, targetPath);
      unlinkSync(partial);
    } else {
      renameSync(partial, targetPath);
    }
  } catch (cause) {
    rmSync(partial, { force: true });
    throw cause;
  }
}

function transactionEntryPaths(directory, entry) {
  return {
    targetPath: resolve(directory, entry.targetName),
    stagePath: resolve(directory, entry.stageName),
    backupPath: resolve(directory, entry.backupName)
  };
}

export function recoverJsonSetAtomic({ transactionPath, expectedTargetNames = null }) {
  if (!existsSync(transactionPath)) return { recovered: false };
  const directory = dirname(transactionPath);
  const journal = JSON.parse(readFileSync(transactionPath, 'utf8'));
  if (journal?.schemaVersion !== 1 || !['PREPARED', 'COMMITTED'].includes(journal.phase) ||
      !Array.isArray(journal.entries)) throw new Error('JSON_SET_JOURNAL_INVALID');
  const targetNames = journal.entries.map((entry) => entry?.targetName);
  const targetSet = new Set(targetNames);
  if (targetSet.size !== journal.entries.length || targetSet.has(basename(transactionPath))) {
    throw new Error('JSON_SET_JOURNAL_INVALID');
  }
  if (expectedTargetNames !== null) {
    const expected = new Set(expectedTargetNames);
    if (expected.size !== expectedTargetNames.length || expected.size !== targetSet.size ||
        [...expected].some((name) => !targetSet.has(name))) throw new Error('JSON_SET_JOURNAL_INVALID');
  }
  let transactionToken = null;
  const allNames = new Set(targetNames);
  for (const entry of journal.entries) {
    if (![entry.targetName, entry.stageName, entry.backupName].every((name) =>
      typeof name === 'string' && name === basename(name) && name.length > 0) || typeof entry.hadTarget !== 'boolean') {
      throw new Error('JSON_SET_JOURNAL_INVALID');
    }
    const stagePrefix = `${entry.targetName}.set-`;
    if (!entry.stageName.startsWith(stagePrefix)) throw new Error('JSON_SET_JOURNAL_INVALID');
    const token = entry.stageName.slice(stagePrefix.length);
    if (!/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token) ||
        entry.backupName !== `${entry.targetName}.rollback-${token}` ||
        (transactionToken !== null && transactionToken !== token) ||
        allNames.has(entry.stageName) || allNames.has(entry.backupName)) throw new Error('JSON_SET_JOURNAL_INVALID');
    transactionToken = token;
    allNames.add(entry.stageName);
    allNames.add(entry.backupName);
  }
  for (const entry of journal.entries) {
    const paths = transactionEntryPaths(directory, entry);
    if (journal.phase === 'PREPARED') {
      if (entry.hadTarget && existsSync(paths.backupPath)) {
        rmSync(paths.targetPath, { force: true });
        renameSync(paths.backupPath, paths.targetPath);
      } else if (!entry.hadTarget) {
        rmSync(paths.targetPath, { force: true });
      }
    } else if (!existsSync(paths.targetPath)) {
      throw new Error(`JSON_SET_COMMITTED_TARGET_MISSING:${entry.targetName}`);
    }
    rmSync(paths.stagePath, { force: true });
    rmSync(paths.backupPath, { force: true });
  }
  rmSync(transactionPath, { force: true });
  return { recovered: true, phase: journal.phase };
}

export function writeFileSetAtomic({
  entries, transactionPath, beforePublish = () => {}, beforeCommit = () => {}, recoverOnError = true
}) {
  if (!isNonEmptyString(transactionPath)) throw new Error('JSON_SET_TRANSACTION_PATH_REQUIRED');
  const expectedTargetNames = entries.map((entry) => basename(entry.targetPath));
  recoverJsonSetAtomic({ transactionPath, expectedTargetNames });
  const directory = dirname(transactionPath);
  if (entries.some((entry) => dirname(entry.targetPath) !== directory)) throw new Error('JSON_SET_DIRECTORY_MISMATCH');
  const token = `${process.pid}-${randomUUID()}`;
  const staged = entries.map((entry) => ({
    ...entry,
    targetName: basename(entry.targetPath),
    stageName: `${basename(entry.targetPath)}.set-${token}`,
    backupName: `${basename(entry.targetPath)}.rollback-${token}`,
    hadTarget: existsSync(entry.targetPath)
  }));
  let journalWritten = false;
  try {
    for (const entry of staged) {
      const stagePath = resolve(directory, entry.stageName);
      writeFileSync(stagePath, entry.content, { encoding: 'utf8', flag: 'wx' });
      const validation = entry.validateContent(readFileSync(stagePath, 'utf8'));
      if (validation === false || (isPlainObject(validation) && validation.ok === false)) {
        const details = isPlainObject(validation) ? JSON.stringify(validation.errors ?? []) : '';
        throw new Error(`ATOMIC_FILE_VALIDATION_FAILED:${details}`);
      }
    }
    const journalValue = {
      schemaVersion: 1,
      phase: 'PREPARED',
      entries: staged.map(({ targetName, stageName, backupName, hadTarget }) =>
        ({ targetName, stageName, backupName, hadTarget }))
    };
    writeJsonAtomic({ targetPath: transactionPath, value: journalValue, validate: () => true, noClobber: true });
    journalWritten = true;
    for (const entry of staged) {
      const paths = transactionEntryPaths(directory, entry);
      if (entry.hadTarget) renameSync(paths.targetPath, paths.backupPath);
    }
    for (const [index, entry] of staged.entries()) {
      beforePublish(index);
      const paths = transactionEntryPaths(directory, entry);
      renameSync(paths.stagePath, paths.targetPath);
    }
    beforeCommit();
    writeJsonAtomic({
      targetPath: transactionPath,
      value: { ...journalValue, phase: 'COMMITTED' },
      validate: () => true
    });
    recoverJsonSetAtomic({ transactionPath, expectedTargetNames });
  } catch (cause) {
    if (journalWritten && recoverOnError) {
      recoverJsonSetAtomic({ transactionPath, expectedTargetNames });
    } else if (!journalWritten) {
      for (const entry of staged) rmSync(resolve(directory, entry.stageName), { force: true });
    }
    throw cause;
  }
}

export function writeJsonSetAtomic({
  entries, transactionPath, beforePublish = () => {}, beforeCommit = () => {}, recoverOnError = true
}) {
  return writeFileSetAtomic({
    transactionPath,
    beforePublish,
    beforeCommit,
    recoverOnError,
    entries: entries.map((entry) => ({
      targetPath: entry.targetPath,
      content: `${JSON.stringify(entry.value, null, 2)}\n`,
      validateContent: (content) => entry.validate(JSON.parse(content))
    }))
  });
}
