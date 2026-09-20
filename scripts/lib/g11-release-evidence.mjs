import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  loadAcceptanceDefinitions,
  inspectCandidateArtifact,
  npmCliPathForNodeExecutable,
  validateAcceptanceMap,
  validateAcceptanceRun,
  validateCandidateArtifact
} from './g11-acceptance.mjs';
import {
  allowedScopedDisplayNamesFromPackageLock,
  G11_T03_FIXED_CHECKSUM_PATHS,
  inspectAuthenticodeStatus,
  lockedComponentsFromPackageLock,
  lockedDependencyGraphFromPackageLock,
  validateSbomEnvironmentRecord,
  validateCycloneDxSbom,
  validateSigningStatusRecord,
  verifyChecksumManifest
} from './g11-supply-chain.mjs';

export const SOFTWARE_STATUSES = Object.freeze(['PASS', 'PARTIAL', 'BLOCKED', 'FAIL']);
export const RESOURCE_STATUSES = Object.freeze(['VERIFIED', 'PARTIAL', 'BLOCKED', 'NOT_VERIFIED']);
export const TEACHING_STATUSES = Object.freeze(['TEACHER_REVIEWED', 'PARTIAL', 'BLOCKED', 'NOT_REVIEWED']);
export const ARTIFACT_CLASSES = Object.freeze(['NONE', 'UNSIGNED_TEST_BUILD', 'SIGNED_TEST_BUILD', 'SIGNED_RELEASE_CANDIDATE']);
export const RELEASE_DISPOSITIONS = Object.freeze(['RELEASE_READY', 'CONTROLLED_TRIAL', 'UNSIGNED_TEST_BUILD', 'BLOCKED']);

const INPUT_PREFIXES = ['reports/', 'planning/', 'acceptance/', 'docs/', 'apps/'];
const INPUT_FILES = new Set(['ENV_LOCK.json', 'package-lock.json']);
const DELIVERY_STATUSES = new Set(['PRESENT', 'GENERATED', 'MISSING']);

export const G11_GENERATED_OUTPUT_PATHS = Object.freeze([
  'reports/release/release-evidence.json',
  'reports/release/KNOWN_LIMITATIONS.md',
  'reports/release/release-input.json',
  'reports/release/yuwendesk.cdx.json',
  'reports/release/sbom-environment.json',
  'reports/release/signing-status.json',
  'reports/release/SHA256SUMS.txt',
  'reports/release/FINAL_STATUS.md',
  'reports/release/.g11-supply-chain-transaction.json',
  'reports/release/*.set-*',
  'reports/release/*.rollback-*'
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code, detail = '') {
  throw new Error(detail ? `${code}:${detail}` : code);
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

function containsSensitiveOutput(value) {
  if (typeof value === 'string') {
    return /(?:^|[^\p{L}\p{N}+.\-])[A-Za-z]:[\\/]/u.test(value) ||
      /(?:^|[^\\])\\\\[^\\\s]+\\/u.test(value) || /file:\/\//i.test(value) ||
      /(?:^|[^\p{L}\p{N}+.\-:/])\/(?!\/)[^\s`<>)\]}]+/u.test(value) ||
      /\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
      /(?:api[_ -]?key|password|secret[_ -]?value|学生姓名|学生原文|完整提示词|full prompt)\s*[:=：]/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitiveOutput);
  if (isPlainObject(value)) return Object.values(value).some(containsSensitiveOutput);
  return false;
}

function assertSafeReleaseOutput(value) {
  if (containsSensitiveOutput(value)) fail('RELEASE_PRIVACY_VIOLATION');
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function inspectRepositoryProvenance({ root, sourceCommit, allowedDirtyPaths = [] }) {
  const rootReal = realpathSync(root);
  const normalizedAllowed = [];
  for (const path of allowedDirtyPaths) {
    if (normalizeInputPath(path) === null) fail('RELEASE_REPOSITORY_PATH_REJECTED', path ?? '');
    normalizedAllowed.push(path);
  }
  const runGit = (args) => spawnSync('git', ['-C', rootReal, ...args], {
    cwd: rootReal,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const headResult = runGit(['rev-parse', '--verify', 'HEAD']);
  const statusResult = runGit([
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.',
    ...normalizedAllowed.map((path) => `:(exclude)${path}`)
  ]);
  const head = headResult.status === 0 ? headResult.stdout.trim().toLowerCase() : null;
  return {
    head,
    headMatchesSource: typeof sourceCommit === 'string' && head === sourceCommit.toLowerCase(),
    relevantTreeClean: statusResult.status === 0 && statusResult.stdout.length === 0
  };
}

function normalizeInputPath(value) {
  if (!isNonEmptyString(value) || isAbsolute(value) || value.includes(':') || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (!INPUT_FILES.has(value) && !INPUT_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  return value;
}

function readDescriptor(root, path) {
  if (normalizeInputPath(path) === null) fail('RELEASE_EVIDENCE_PATH_REJECTED', path);
  const rootReal = realpathSync(root);
  const lexical = resolve(rootReal, path);
  if (!isWithin(rootReal, lexical) || !existsSync(lexical)) fail('RELEASE_EVIDENCE_MISSING', path);
  const actual = realpathSync(lexical);
  if (!isWithin(rootReal, actual)) fail('RELEASE_EVIDENCE_PATH_REJECTED', path);
  const bytes = readFileSync(actual);
  return { path, sha256: sha256(bytes), sizeBytes: bytes.byteLength };
}

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function uniqueBy(items, key, code) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    if (!isNonEmptyString(value) || seen.has(value)) fail(code, value ?? '');
    seen.add(value);
  }
  return seen;
}

function priorityFromBaseline(value) {
  return value === '必须' ? 'P1' : 'P2';
}

function highestPriority(caseIds, definitions) {
  const ranks = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return caseIds.map((caseId) => definitions.get(caseId)?.severity ?? 'P1')
    .sort((left, right) => ranks[left] - ranks[right])[0] ?? 'P1';
}

export function buildRequirementCoverage({ baseTrace, crTrace, definitions }) {
  const definitionMap = new Map(definitions.map((item) => [item.id, item]));
  const expectedBaseIds = Array.from({ length: 60 }, (_, index) => `R${String(index + 1).padStart(3, '0')}`);
  const expectedCrIds = Array.from({ length: 24 }, (_, index) => `CR001-R${String(index + 1).padStart(2, '0')}`);
  const actualBaseIds = Array.isArray(baseTrace) ? baseTrace.map((item) => item.requirement_id) : [];
  const actualCrIds = Array.isArray(crTrace?.links) ? crTrace.links.map((item) => item.requirement_id) : [];
  if (new Set(actualBaseIds).size !== 60 || JSON.stringify([...actualBaseIds].sort()) !== JSON.stringify(expectedBaseIds) ||
      new Set(actualCrIds).size !== 24 || JSON.stringify([...actualCrIds].sort()) !== JSON.stringify(expectedCrIds)) {
    fail('RELEASE_REQUIREMENT_SOURCE_INVALID', 'id-set');
  }
  const base = baseTrace.map((item) => {
    if (!['必须', '应有'].includes(item.baseline_priority) || !definitionMap.has(item.test_id) ||
        !definitionMap.get(item.test_id).requirement_ids?.includes(item.requirement_id)) {
      fail('RELEASE_REQUIREMENT_SOURCE_INVALID', item.requirement_id ?? '');
    }
    return {
      requirementId: item.requirement_id,
      priority: priorityFromBaseline(item.baseline_priority),
      caseIds: [item.test_id]
    };
  });
  const cr001 = crTrace.links.map((item) => {
    if (!Array.isArray(item.case_ids) || item.case_ids.length === 0 ||
        new Set(item.case_ids).size !== item.case_ids.length || item.case_ids.some((id) =>
          !definitionMap.has(id) || !definitionMap.get(id).requirement_ids?.includes(item.requirement_id))) {
      fail('RELEASE_REQUIREMENT_SOURCE_INVALID', item.requirement_id ?? '');
    }
    return {
      requirementId: item.requirement_id,
      priority: highestPriority(item.case_ids, definitionMap),
      caseIds: item.case_ids
    };
  });
  return { base, cr001 };
}

function validateDefectAuditValue(audit, sourceCommit) {
  const allowed = new Set(['schemaVersion', 'status', 'assessedCommit', 'executedAt', 'items', 'blockerCode']);
  if (!hasOnlyKeys(audit, allowed) || (audit.schemaVersion !== undefined && audit.schemaVersion !== 1) ||
      !Array.isArray(audit.items)) return false;
  const ids = new Set();
  for (const item of audit.items) {
    if (!hasOnlyKeys(item, new Set(['id', 'severity', 'status', 'title'])) || !isNonEmptyString(item.id) ||
        ids.has(item.id) || !['P0', 'P1', 'P2', 'P3'].includes(item.severity) ||
        !['OPEN', 'CLOSED'].includes(item.status) || !isNonEmptyString(item.title)) return false;
    ids.add(item.id);
  }
  if (audit.status === 'NOT_RUN') {
    return audit.assessedCommit === null && audit.executedAt === null && audit.items.length === 0 &&
      audit.blockerCode === 'RELEASE_DEFECT_AUDIT_REQUIRED';
  }
  return audit.status === 'COMPLETE' && audit.assessedCommit === sourceCommit && isIsoDate(audit.executedAt) &&
    audit.blockerCode === null;
}

export function verifyDefectAuditSource(audit, sourceCommit) {
  if (audit?.schemaVersion !== 1 || !validateDefectAuditValue(audit, sourceCommit)) {
    fail('RELEASE_DEFECT_AUDIT_INVALID');
  }
  return audit;
}

function normalizeExternalInputs(items, { requireFixedSet = false } = {}) {
  if (!Array.isArray(items)) fail('RELEASE_EXTERNAL_INPUT_INVALID');
  const expected = Array.from({ length: 11 }, (_, index) => `EXT${String(index + 1).padStart(2, '0')}`);
  const ids = new Set();
  const normalized = items.map((item) => {
    if (!hasOnlyKeys(item, new Set(['id', 'status', 'description', 'ownerAction', 'blocks'])) ||
        !/^EXT\d{2}$/.test(item.id ?? '') || ids.has(item.id) ||
        !['PROVIDED', 'NOT_PROVIDED'].includes(item.status) || !isNonEmptyString(item.description) ||
        !isNonEmptyString(item.ownerAction) || !Array.isArray(item.blocks) || item.blocks.some((value) => !isNonEmptyString(value))) {
      fail('RELEASE_EXTERNAL_INPUT_INVALID', item?.id ?? '');
    }
    ids.add(item.id);
    return { id: item.id, status: item.status, description: item.description, ownerAction: item.ownerAction, blocks: [...item.blocks] };
  });
  if (requireFixedSet && JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) {
    fail('RELEASE_EXTERNAL_INPUT_INVALID', 'id-set');
  }
  assertSafeReleaseOutput(normalized);
  return normalized;
}

function normalizeExternalCatalog(catalog) {
  if (!hasOnlyKeys(catalog, new Set(['schema_version', 'items'])) || catalog.schema_version !== '1.0.0' ||
      !Array.isArray(catalog.items)) fail('RELEASE_EXTERNAL_INPUT_INVALID', 'catalog');
  const items = catalog.items.map((item) => {
    if (!hasOnlyKeys(item, new Set(['id', 'description', 'status', 'secret_value', 'owner_action', 'blocks'])) ||
        item.secret_value !== null) fail('RELEASE_EXTERNAL_INPUT_INVALID', item?.id ?? '');
    return {
      id: item.id,
      status: item.status,
      description: item.description,
      ownerAction: item.owner_action,
      blocks: item.blocks
    };
  });
  return normalizeExternalInputs(items, { requireFixedSet: true });
}

export function decideReleaseDisposition(input) {
  const artifactClass = !input.artifactPresent
    ? 'NONE'
    : input.artifactSigned ? 'SIGNED_TEST_BUILD' : 'UNSIGNED_TEST_BUILD';
  const requiredFailure = input.requiredCaseResults.some(
    (item) => ['P0', 'P1'].includes(item.severity) && item.status === 'FAIL'
  );
  const openCriticalDefect = input.knownDefects.some(
    (item) => ['P0', 'P1'].includes(item.severity) && item.status !== 'CLOSED'
  );
  if (requiredFailure || openCriticalDefect) {
    return { artifactClass, releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_REQUIRED_CASE_FAILED' };
  }
  if (!input.artifactPresent) {
    return { artifactClass: 'NONE', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_ARTIFACT_MISSING' };
  }
  if (input.sourceTreeClean === false) {
    return {
      artifactClass: input.artifactSigned ? 'SIGNED_TEST_BUILD' : 'UNSIGNED_TEST_BUILD',
      releaseDisposition: 'BLOCKED',
      reasonCode: 'RELEASE_SOURCE_DIRTY'
    };
  }
  if (!input.cleanWindowsPassed) {
    return {
      artifactClass: input.artifactSigned ? 'SIGNED_TEST_BUILD' : 'UNSIGNED_TEST_BUILD',
      releaseDisposition: 'BLOCKED',
      reasonCode: 'RELEASE_WINDOWS_EVIDENCE_REQUIRED'
    };
  }
  if (input.defectAuditStatus !== 'COMPLETE') {
    return {
      artifactClass: input.artifactSigned ? 'SIGNED_TEST_BUILD' : 'UNSIGNED_TEST_BUILD',
      releaseDisposition: 'BLOCKED',
      reasonCode: 'RELEASE_REQUIRED_GATE_OPEN'
    };
  }
  if (!input.artifactSigned) {
    return {
      artifactClass: 'UNSIGNED_TEST_BUILD',
      releaseDisposition: 'UNSIGNED_TEST_BUILD',
      reasonCode: 'RELEASE_SIGNATURE_MISSING'
    };
  }
  if (input.supplyChainReady !== true) {
    return {
      artifactClass: 'SIGNED_TEST_BUILD',
      releaseDisposition: 'BLOCKED',
      reasonCode: 'RELEASE_SUPPLY_CHAIN_NOT_READY'
    };
  }
  if (input.defectAuditStatus === 'COMPLETE' && input.controlledTrialAuthorized &&
      input.dataBoundaryApproved && input.costBoundaryApproved && !input.distributionAuthorized) {
    return {
      artifactClass: 'SIGNED_TEST_BUILD',
      releaseDisposition: 'CONTROLLED_TRIAL',
      reasonCode: 'RELEASE_CONTROLLED_TRIAL_ONLY'
    };
  }
  if (input.defectAuditStatus === 'COMPLETE' && input.distributionAuthorized &&
      input.dataBoundaryApproved && input.costBoundaryApproved && input.requiredCaseResults.length === 170 &&
      input.requiredCaseResults.every((item) => item.status === 'PASS')) {
    return {
      artifactClass: 'SIGNED_RELEASE_CANDIDATE',
      releaseDisposition: 'RELEASE_READY',
      reasonCode: 'RELEASE_ALL_GATES_PASS'
    };
  }
  return {
    artifactClass: 'SIGNED_TEST_BUILD',
    releaseDisposition: 'BLOCKED',
    reasonCode: 'RELEASE_REQUIRED_GATE_OPEN'
  };
}

function deriveSoftwareStatus(cases) {
  if (cases.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (cases.every((item) => item.status === 'PASS')) return 'PASS';
  if (cases.some((item) => item.status === 'BLOCKED')) return 'BLOCKED';
  return 'PARTIAL';
}

function externalProvided(externalInputs, id) {
  return externalInputs.find((item) => item.id === id)?.status === 'PROVIDED';
}

function deriveKnownGaps({ cases, candidate, externalInputs, defectAudit, deliverables, sourceTreeClean, supplyChain }) {
  const gaps = externalInputs.filter((item) => item.status !== 'PROVIDED').map((item) => ({
    gapId: `EXTERNAL_${item.id}`,
    scope: item.blocks.length > 0 ? item.blocks.join('；') : item.description,
    status: 'BLOCKED',
    blockerCode: 'BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED',
    externalInputIds: [item.id],
    safeAction: item.ownerAction
  }));
  if (!candidate.artifactPresent) {
    gaps.push({
      gapId: 'CURRENT_CANDIDATE_MISSING',
      scope: candidate.expectedPath,
      status: 'BLOCKED',
      blockerCode: 'RELEASE_ARTIFACT_MISSING',
      externalInputIds: [],
      safeAction: '在锁定构建环境从当前源码生成候选；不得复用历史安装包或哈希。'
    });
  }
  if (defectAudit.status !== 'COMPLETE') {
    gaps.push({
      gapId: 'DEFECT_AUDIT_NOT_COMPLETE',
      scope: 'P0/P1 已知缺陷审计',
      status: 'NOT_RUN',
      blockerCode: 'RELEASE_DEFECT_AUDIT_REQUIRED',
      externalInputIds: [],
      safeAction: '在候选 commit 上完成缺陷审计；空 items 只有在 COMPLETE 时才表示未发现已知缺陷。'
    });
  }
  if (!sourceTreeClean) {
    gaps.push({
      gapId: 'SOURCE_RUN_DIRTY',
      scope: '验收运行无法唯一绑定 sourceCommit',
      status: 'BLOCKED',
      blockerCode: 'RELEASE_SOURCE_DIRTY',
      externalInputIds: [],
      safeAction: '在干净工作树对同一候选 commit 创建新的追加验收运行；不得改写本次 dirty 运行。'
    });
  }
  const failedCases = cases.filter((item) => item.status === 'FAIL');
  if (failedCases.length > 0) {
    gaps.push({
      gapId: 'REQUIRED_CASE_FAILURES',
      scope: failedCases.map((item) => item.caseId).join('、'),
      status: 'BLOCKED',
      blockerCode: 'RELEASE_REQUIRED_CASE_FAILED',
      externalInputIds: [],
      safeAction: '保留失败证据，修复根因后创建新的追加验收运行；不得把 FAIL 改写为 BLOCKED 或 PASS。'
    });
  }
  const openCritical = defectAudit.items.filter((item) =>
    ['P0', 'P1'].includes(item.severity) && item.status !== 'CLOSED');
  if (openCritical.length > 0) {
    gaps.push({
      gapId: 'OPEN_CRITICAL_DEFECTS',
      scope: openCritical.map((item) => item.id).join('、'),
      status: 'BLOCKED',
      blockerCode: 'RELEASE_REQUIRED_CASE_FAILED',
      externalInputIds: [],
      safeAction: '关闭 P0/P1 根因，并以绑定当前候选 commit 与执行时间的新缺陷审计重新归集。'
    });
  }
  if (cases.some((item) => item.status === 'NOT_RUN')) {
    gaps.push({
      gapId: 'FORMAL_CASES_NOT_RUN',
      scope: '尚未执行的正式验收案例',
      status: 'NOT_RUN',
      blockerCode: 'RELEASE_REQUIRED_GATE_OPEN',
      externalInputIds: [],
      safeAction: '在对应证据层级创建新的追加验收运行；不得改写历史 NOT_RUN。'
    });
  }
  if (supplyChain.sbomStatus === 'FAIL') {
    gaps.push({
      gapId: 'SUPPLY_CHAIN_SBOM_INVALID',
      scope: supplyChain.sbomPath,
      status: 'BLOCKED',
      blockerCode: 'RELEASE_SBOM_INVALID',
      externalInputIds: [],
      safeAction: '修复 SBOM 生成或锁文件覆盖错误，重新生成并验证；不得把不完整 SBOM 标记为通过。'
    });
  }
  if (supplyChain.checksumStatus === 'FAIL') {
    gaps.push({
      gapId: 'SUPPLY_CHAIN_CHECKSUM_INVALID',
      scope: supplyChain.checksumPath,
      status: 'BLOCKED',
      blockerCode: 'RELEASE_CHECKSUM_INVALID',
      externalInputIds: [],
      safeAction: '从固定输入重新生成校验清单并逐项复读验证；不得手工替换单条哈希。'
    });
  }
  if (supplyChain.formalEnvironmentMatch === false) {
    gaps.push({
      gapId: 'SUPPLY_CHAIN_ENVIRONMENT_MISMATCH',
      scope: 'SBOM 生成工具链与 ENV_LOCK.json 锁定版本不一致',
      status: 'BLOCKED',
      blockerCode: 'RELEASE_FORMAL_ENVIRONMENT_MISMATCH',
      externalInputIds: [],
      safeAction: '在 ENV_LOCK.json 锁定的 Node/npm 环境重新生成供应链证据；当前 SBOM 仅作工程证据。'
    });
  }
  if (candidate.artifactPresent && supplyChain.signatureStatus !== 'SIGNED_VALID') {
    const signatureGap = {
      NOT_RUN: {
        gapId: 'SUPPLY_CHAIN_SIGNATURE_NOT_RUN',
        blockerCode: 'RELEASE_SIGNATURE_CHECK_NOT_RUN',
        safeAction: '在受支持的 Windows 环境对固定候选运行 Authenticode 与时间戳检查。'
      },
      UNSIGNED: {
        gapId: 'SUPPLY_CHAIN_SIGNATURE_MISSING',
        blockerCode: 'RELEASE_SIGNATURE_MISSING',
        safeAction: '由获授权的发布身份签名固定候选并加入可信时间戳，再重新检查。'
      },
      SIGNED_INVALID: {
        gapId: 'SUPPLY_CHAIN_SIGNATURE_INVALID',
        blockerCode: 'RELEASE_SIGNATURE_INVALID',
        safeAction: '保留失败证据，修复签名或时间戳链后生成新候选并重新检查。'
      }
    }[supplyChain.signatureStatus] ?? {
      gapId: 'SUPPLY_CHAIN_SIGNATURE_INVALID',
      blockerCode: 'RELEASE_SIGNATURE_INVALID',
      safeAction: '修复签名状态记录并重新检查固定候选。'
    };
    gaps.push({
      gapId: signatureGap.gapId,
      scope: supplyChain.signingStatusPath,
      status: 'BLOCKED',
      blockerCode: signatureGap.blockerCode,
      externalInputIds: [],
      safeAction: signatureGap.safeAction
    });
  }
  for (const item of deliverables.filter((entry) => entry.status === 'MISSING' && entry.id !== 'candidate_installer')) {
    gaps.push({
      gapId: `DELIVERABLE_${item.id.toUpperCase()}_MISSING`,
      scope: item.path,
      status: 'NOT_RUN',
      blockerCode: 'RELEASE_REQUIRED_DELIVERABLE_MISSING',
      externalInputIds: [],
      safeAction: '执行负责该固定交付物的后续 G11 工作包，并在生成后重新归集证据。'
    });
  }
  return gaps.sort((left, right) => left.gapId.localeCompare(right.gapId, 'en'));
}

export function aggregateReleaseEvidence(input) {
  const run = input.acceptanceRun?.value;
  const candidate = input.candidateArtifact?.value;
  if (!isPlainObject(run) || !isPlainObject(candidate)) fail('RELEASE_INPUT_INVALID');
  if (run.sourceCommit !== candidate.sourceCommit) fail('RELEASE_SOURCE_MISMATCH');
  if (!validateDefectAuditValue(input.defectAudit, run.sourceCommit)) fail('RELEASE_DEFECT_AUDIT_INVALID');

  const definitionIds = uniqueBy(input.caseDefinitions, 'caseId', 'RELEASE_CASE_DEFINITION_DUPLICATE');
  const resultIds = uniqueBy(run.results ?? [], 'caseId', 'RELEASE_CASE_RESULT_DUPLICATE');
  if (definitionIds.size !== resultIds.size || [...definitionIds].some((id) => !resultIds.has(id))) {
    fail('RELEASE_CASE_COVERAGE_INVALID');
  }
  const definitions = new Map(input.caseDefinitions.map((item) => [item.caseId, item]));
  const normalizedExternal = normalizeExternalInputs(input.externalInputs);
  const knownExternal = new Set(normalizedExternal.map((item) => item.id));
  const cases = run.results.map((item) => {
    for (const externalId of item.externalInputIds ?? []) {
      if (!knownExternal.has(externalId)) fail('RELEASE_EXTERNAL_INPUT_UNKNOWN', `${item.caseId}:${externalId}`);
    }
    return {
      caseId: item.caseId,
      severity: definitions.get(item.caseId).severity,
      status: item.status,
      blockerCode: item.blockerCode,
      externalInputIds: [...(item.externalInputIds ?? [])]
    };
  }).sort((left, right) => left.caseId.localeCompare(right.caseId, 'en'));

  const requirements = {};
  for (const group of ['base', 'cr001']) {
    const entries = input.requirements?.[group] ?? [];
    uniqueBy(entries, 'requirementId', 'RELEASE_REQUIREMENT_DUPLICATE');
    requirements[group] = entries.map((item) => {
      if (!Array.isArray(item.caseIds) || item.caseIds.length === 0 ||
          new Set(item.caseIds).size !== item.caseIds.length || item.caseIds.some((id) => !definitionIds.has(id))) {
        fail('RELEASE_REQUIREMENT_COVERAGE_INVALID', item.requirementId);
      }
      return { requirementId: item.requirementId, priority: item.priority, caseIds: [...item.caseIds].sort() };
    }).sort((left, right) => left.requirementId.localeCompare(right.requirementId, 'en'));
  }

  const externalInputs = normalizedExternal.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const supplyChain = input.supplyChain ?? {
    sbomStatus: 'NOT_RUN',
    checksumStatus: 'NOT_RUN',
    signatureStatus: 'NOT_RUN',
    sbomPath: 'reports/release/yuwendesk.cdx.json',
    checksumPath: 'reports/release/SHA256SUMS.txt',
    signingStatusPath: 'reports/release/signing-status.json',
    formalEnvironmentMatch: null,
    componentCount: null,
    dependencyCount: null
  };
  const artifactSigned = supplyChain.signatureStatus === 'SIGNED_VALID';
  const supplyChainReady = supplyChain.sbomStatus === 'PASS' && supplyChain.checksumStatus === 'PASS' &&
    supplyChain.signatureStatus === 'SIGNED_VALID' && supplyChain.formalEnvironmentMatch === true;
  const allCasesPassed = cases.length > 0 && cases.every((item) => item.status === 'PASS');
  const gates = {
    sourceTreeClean: run.repositoryDirty === false &&
      input.repositoryProvenance?.headMatchesSource === true &&
      input.repositoryProvenance?.relevantTreeClean === true,
    cleanWindowsPassed: externalProvided(externalInputs, 'EXT02') && allCasesPassed,
    artifactSigned,
    distributionAuthorized: externalProvided(externalInputs, 'EXT08'),
    controlledTrialAuthorized: false,
    dataBoundaryApproved: externalProvided(externalInputs, 'EXT10'),
    costBoundaryApproved: externalProvided(externalInputs, 'EXT04'),
    defectAuditStatus: input.defectAudit.status
  };
  const disposition = decideReleaseDisposition({
    requiredCaseResults: cases,
    artifactPresent: candidate.artifactPresent,
    ...gates,
    supplyChainReady,
    knownDefects: input.defectAudit.items
  });
  const resourceIds = ['EXT05', 'EXT06', 'EXT11'];
  const resourceCoverageStatus = resourceIds.every((id) => externalProvided(externalInputs, id))
    ? (allCasesPassed ? 'VERIFIED' : 'PARTIAL')
    : 'BLOCKED';
  const teachingValidationStatus = !externalProvided(externalInputs, 'EXT09')
    ? 'NOT_REVIEWED'
    : (allCasesPassed ? 'TEACHER_REVIEWED' : 'PARTIAL');
  const caseSummary = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const item of cases) caseSummary[item.status] += 1;

  const evidence = {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    sourceCommit: run.sourceCommit,
    acceptanceRun: {
      runId: run.runId,
      path: input.acceptanceRun.path,
      sha256: input.acceptanceRun.sha256,
      sizeBytes: input.acceptanceRun.sizeBytes,
      repositoryDirty: run.repositoryDirty
    },
    candidate: {
      inventoryPath: input.candidateArtifact.path,
      inventorySha256: input.candidateArtifact.sha256,
      inventorySizeBytes: input.candidateArtifact.sizeBytes,
      expectedPath: candidate.expectedPath,
      artifactPresent: candidate.artifactPresent,
      artifactClass: disposition.artifactClass,
      sha256: candidate.sha256,
      sizeBytes: candidate.sizeBytes
    },
    statuses: {
      softwareStatus: deriveSoftwareStatus(cases),
      resourceCoverageStatus,
      teachingValidationStatus,
      artifactClass: disposition.artifactClass,
      releaseDisposition: disposition.releaseDisposition,
      reasonCode: disposition.reasonCode
    },
    gates,
    caseSummary,
    cases,
    requirements,
    deliverables: input.deliverables.map((item) => ({ ...item })),
    externalInputs,
    defectAudit: {
      status: input.defectAudit.status,
      assessedCommit: input.defectAudit.assessedCommit,
      executedAt: input.defectAudit.executedAt,
      blockerCode: input.defectAudit.blockerCode,
      items: input.defectAudit.items.map((item) => ({ ...item }))
    },
    supplyChain: { ...supplyChain },
    inputFiles: input.inputFiles.map((item) => ({ ...item })).sort((left, right) => left.path.localeCompare(right.path, 'en')),
    knownGaps: deriveKnownGaps({
      cases, candidate, externalInputs, defectAudit: input.defectAudit, deliverables: input.deliverables,
      sourceTreeClean: gates.sourceTreeClean,
      supplyChain
    })
  };
  assertSafeReleaseOutput(evidence);
  return evidence;
}

function validateDescriptor(root, descriptor) {
  try {
    const actual = readDescriptor(root, descriptor?.path);
    return actual.sha256 === descriptor.sha256 && actual.sizeBytes === descriptor.sizeBytes;
  } catch {
    return false;
  }
}

export function validateReleaseEvidence({ root, evidence }) {
  const errors = [];
  const add = (code, detail = '') => errors.push({ code, detail });
  const rootKeys = new Set([
    'schemaVersion', 'generatedAt', 'sourceCommit', 'acceptanceRun', 'candidate', 'statuses', 'gates',
    'caseSummary', 'cases', 'requirements', 'deliverables', 'externalInputs', 'defectAudit', 'supplyChain',
    'inputFiles', 'knownGaps'
  ]);
  if (!hasOnlyKeys(evidence, rootKeys) || evidence.schemaVersion !== 1 || !isIsoDate(evidence.generatedAt) ||
      !/^[a-f0-9]{7,64}$/.test(evidence.sourceCommit ?? '')) add('RELEASE_EVIDENCE_INVALID');
  if (containsSensitiveOutput(evidence)) add('RELEASE_PRIVACY_VIOLATION');
  if (!hasOnlyKeys(evidence?.acceptanceRun, new Set(['runId', 'path', 'sha256', 'sizeBytes', 'repositoryDirty'])) ||
      !hasOnlyKeys(evidence?.candidate, new Set([
        'inventoryPath', 'inventorySha256', 'inventorySizeBytes', 'expectedPath', 'artifactPresent',
        'artifactClass', 'sha256', 'sizeBytes'
      ])) ||
      !hasOnlyKeys(evidence?.statuses, new Set([
        'softwareStatus', 'resourceCoverageStatus', 'teachingValidationStatus', 'artifactClass',
        'releaseDisposition', 'reasonCode'
      ])) ||
      !hasOnlyKeys(evidence?.gates, new Set([
        'sourceTreeClean', 'cleanWindowsPassed', 'artifactSigned', 'distributionAuthorized', 'controlledTrialAuthorized',
        'dataBoundaryApproved', 'costBoundaryApproved', 'defectAuditStatus'
      ])) ||
      !hasOnlyKeys(evidence?.caseSummary, new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'])) ||
      !hasOnlyKeys(evidence?.requirements, new Set(['base', 'cr001'])) ||
      !hasOnlyKeys(evidence?.supplyChain, new Set([
        'sbomStatus', 'checksumStatus', 'signatureStatus', 'sbomPath', 'checksumPath', 'signingStatusPath',
        'formalEnvironmentMatch', 'componentCount', 'dependencyCount'
      ]))) {
    add('RELEASE_EVIDENCE_INVALID');
  }
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(evidence?.supplyChain?.sbomStatus) ||
      !['PASS', 'FAIL', 'NOT_RUN'].includes(evidence?.supplyChain?.checksumStatus) ||
      !['SIGNED_VALID', 'SIGNED_INVALID', 'UNSIGNED', 'NOT_RUN'].includes(evidence?.supplyChain?.signatureStatus) ||
      evidence?.supplyChain?.sbomPath !== 'reports/release/yuwendesk.cdx.json' ||
      evidence?.supplyChain?.checksumPath !== 'reports/release/SHA256SUMS.txt' ||
      evidence?.supplyChain?.signingStatusPath !== 'reports/release/signing-status.json' ||
      ![true, false, null].includes(evidence?.supplyChain?.formalEnvironmentMatch) ||
      ![evidence?.supplyChain?.componentCount, evidence?.supplyChain?.dependencyCount]
        .every((value) => value === null || (Number.isInteger(value) && value >= 0))) {
    add('RELEASE_SUPPLY_CHAIN_INVALID');
  }
  if (!SOFTWARE_STATUSES.includes(evidence?.statuses?.softwareStatus) ||
      !RESOURCE_STATUSES.includes(evidence?.statuses?.resourceCoverageStatus) ||
      !TEACHING_STATUSES.includes(evidence?.statuses?.teachingValidationStatus) ||
      !ARTIFACT_CLASSES.includes(evidence?.statuses?.artifactClass) ||
      !RELEASE_DISPOSITIONS.includes(evidence?.statuses?.releaseDisposition)) add('RELEASE_STATUS_INVALID');
  if (evidence?.sourceCommit !== evidence?.acceptanceRun?.runId?.split('-')[2] &&
      !evidence?.acceptanceRun?.runId?.includes(`-${evidence?.sourceCommit?.slice(0, 7)}-`)) add('RELEASE_SOURCE_MISMATCH');

  const cases = Array.isArray(evidence?.cases) ? evidence.cases : [];
  let caseIds = new Set();
  try { caseIds = uniqueBy(cases, 'caseId', 'RELEASE_CASE_RESULT_DUPLICATE'); } catch (cause) { add('RELEASE_CASE_COVERAGE_INVALID', cause.message); }
  const summary = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const item of cases) {
    if (!hasOnlyKeys(item, new Set(['caseId', 'severity', 'status', 'blockerCode', 'externalInputIds']))) {
      add('RELEASE_CASE_STATUS_INVALID', item?.caseId ?? '');
    }
    if (!Object.hasOwn(summary, item.status)) add('RELEASE_CASE_STATUS_INVALID', item.caseId);
    else summary[item.status] += 1;
  }
  if (JSON.stringify(summary) !== JSON.stringify(evidence?.caseSummary)) add('RELEASE_CASE_SUMMARY_INVALID');

  for (const group of ['base', 'cr001']) {
    const entries = Array.isArray(evidence?.requirements?.[group]) ? evidence.requirements[group] : [];
    try { uniqueBy(entries, 'requirementId', 'RELEASE_REQUIREMENT_DUPLICATE'); } catch (cause) { add('RELEASE_REQUIREMENT_COVERAGE_INVALID', cause.message); }
    for (const item of entries) {
      if (!hasOnlyKeys(item, new Set(['requirementId', 'priority', 'caseIds'])) ||
          !Array.isArray(item.caseIds) || item.caseIds.length === 0 || item.caseIds.some((id) => !caseIds.has(id))) {
        add('RELEASE_REQUIREMENT_COVERAGE_INVALID', item.requirementId);
      }
    }
  }
  let externalIds = new Set();
  try {
    const normalized = normalizeExternalInputs(evidence?.externalInputs ?? []);
    externalIds = new Set(normalized.map((item) => item.id));
  } catch (cause) {
    add('RELEASE_EXTERNAL_INPUT_INVALID', cause.message);
  }
  for (const item of [...cases, ...(evidence?.knownGaps ?? [])]) {
    for (const id of item.externalInputIds ?? []) if (!externalIds.has(id)) add('RELEASE_EXTERNAL_INPUT_UNKNOWN', id);
  }
  for (const item of evidence?.deliverables ?? []) {
    if (!hasOnlyKeys(item, new Set(['id', 'path', 'status'])) || !isNonEmptyString(item.id) ||
        normalizeInputPath(item.path) === null || !DELIVERY_STATUSES.has(item.status)) {
      add('RELEASE_DELIVERABLE_INVALID', item?.id ?? '');
    }
  }
  for (const item of evidence?.knownGaps ?? []) {
    if (!hasOnlyKeys(item, new Set(['gapId', 'scope', 'status', 'blockerCode', 'externalInputIds', 'safeAction']))) {
      add('RELEASE_GAP_INVALID', item?.gapId ?? '');
    }
  }
  for (const descriptor of evidence?.inputFiles ?? []) {
    if (!validateDescriptor(root, descriptor)) add('RELEASE_EVIDENCE_INVALID', descriptor?.path ?? '');
  }
  if (!validateDefectAuditValue(evidence?.defectAudit, evidence?.sourceCommit)) add('RELEASE_DEFECT_AUDIT_INVALID');
  const recomputed = decideReleaseDisposition({
    requiredCaseResults: cases,
    artifactPresent: evidence?.candidate?.artifactPresent,
    artifactSigned: evidence?.gates?.artifactSigned,
    sourceTreeClean: evidence?.gates?.sourceTreeClean,
    cleanWindowsPassed: evidence?.gates?.cleanWindowsPassed,
    distributionAuthorized: evidence?.gates?.distributionAuthorized,
    controlledTrialAuthorized: evidence?.gates?.controlledTrialAuthorized,
    dataBoundaryApproved: evidence?.gates?.dataBoundaryApproved,
    costBoundaryApproved: evidence?.gates?.costBoundaryApproved,
    defectAuditStatus: evidence?.gates?.defectAuditStatus,
    supplyChainReady: evidence?.supplyChain?.sbomStatus === 'PASS' &&
      evidence?.supplyChain?.checksumStatus === 'PASS' &&
      evidence?.supplyChain?.signatureStatus === 'SIGNED_VALID' &&
      evidence?.supplyChain?.formalEnvironmentMatch === true,
    knownDefects: evidence?.defectAudit?.items ?? []
  });
  if (recomputed.artifactClass !== evidence?.statuses?.artifactClass ||
      recomputed.releaseDisposition !== evidence?.statuses?.releaseDisposition ||
      recomputed.reasonCode !== evidence?.statuses?.reasonCode) add('RELEASE_DISPOSITION_INVALID');
  const releaseInputPath = resolve(root, 'reports', 'release', 'release-input.json');
  if (existsSync(releaseInputPath)) {
    try {
      const releaseInput = JSON.parse(readFileSync(releaseInputPath, 'utf8'));
      const expected = aggregateReleaseEvidence(loadReleaseAggregationInputs({
        root, releaseInput, generatedAt: evidence.generatedAt
      }));
      if (JSON.stringify(expected) !== JSON.stringify(evidence)) add('RELEASE_AGGREGATE_DERIVATION_MISMATCH');
    } catch (cause) {
      add('RELEASE_AGGREGATE_DERIVATION_MISMATCH', cause.message);
    }
  } else {
    add('RELEASE_SOURCE_INPUT_MISSING', 'reports/release/release-input.json');
  }
  return { ok: errors.length === 0, errors };
}

function deliverable(root, id, path, generated = false) {
  return { id, path, status: generated ? 'GENERATED' : existsSync(resolve(root, path)) ? 'PRESENT' : 'MISSING' };
}

export function verifyCandidateArtifactSnapshot({ root, candidateArtifact }) {
  if (!validateCandidateArtifact(candidateArtifact)) fail('RELEASE_CANDIDATE_INVALID');
  const actual = inspectCandidateArtifact({
    root,
    sourceCommit: candidateArtifact.sourceCommit,
    checkedAt: candidateArtifact.checkedAt,
    buildCommand: candidateArtifact.buildCommand,
    buildEnvironment: candidateArtifact.buildEnvironment
  });
  const fields = [
    'schemaVersion', 'sourceCommit', 'checkedAt', 'expectedPath', 'artifactPresent', 'artifactClass',
    'sha256', 'sizeBytes', 'buildCommand', 'buildEnvironment'
  ];
  if (fields.some((field) => JSON.stringify(actual[field]) !== JSON.stringify(candidateArtifact[field]))) {
    fail('RELEASE_CANDIDATE_ARTIFACT_DRIFT');
  }
  return actual;
}

function loadSupplyChainEvidence(root, sourceCommit, candidateArtifact, acceptanceRunPath, repositoryProvenance) {
  const sbomPath = 'reports/release/yuwendesk.cdx.json';
  const environmentPath = 'reports/release/sbom-environment.json';
  const checksumPath = 'reports/release/SHA256SUMS.txt';
  const signingStatusPath = 'reports/release/signing-status.json';
  let sbomStatus = 'NOT_RUN';
  let checksumStatus = 'NOT_RUN';
  let signatureStatus = 'NOT_RUN';
  let formalEnvironmentMatch = null;
  let componentCount = null;
  let dependencyCount = null;
  if (existsSync(resolve(root, sbomPath)) || existsSync(resolve(root, environmentPath))) {
    try {
      const sbom = readJson(root, sbomPath);
      const environment = readJson(root, environmentPath);
      const packageLock = readJson(root, 'package-lock.json');
      const packageValue = readJson(root, 'package.json');
      const environmentLock = readJson(root, 'ENV_LOCK.json');
      const npmCliPath = npmCliPathForNodeExecutable(process.execPath);
      const installedNpm = readJson(dirname(dirname(npmCliPath)), 'package.json');
      const lockedComponents = lockedComponentsFromPackageLock(packageLock);
      const lockedDependencyGraph = lockedDependencyGraphFromPackageLock(packageLock);
      const allowedScopedDisplayNames = allowedScopedDisplayNamesFromPackageLock(packageLock);
      const validation = validateCycloneDxSbom({
        sbom,
        lockedComponents,
        lockedDependencyGraph,
        allowedScopedDisplayNames,
        expectedRoot: { name: packageValue.name, version: packageValue.version }
      });
      const environmentValidation = validateSbomEnvironmentRecord({
        record: environment,
        sourceCommit,
        sbom,
        lockedComponentCount: lockedComponents.length,
        packageLockSha256: sha256(readFileSync(resolve(root, 'package-lock.json'))),
        actualToolchain: { node: process.version.replace(/^v/, ''), npm: installedNpm.version },
        requiredToolchain: {
          node: String(environmentLock?.build_host?.node ?? '').replace(/^v/, ''),
          npm: String(environmentLock?.build_host?.npm ?? '').replace(/^v/, '')
        },
        repositoryProvenance
      });
      sbomStatus = validation.ok && environmentValidation.ok ? 'PASS' : 'FAIL';
      if (environmentValidation.ok) {
        formalEnvironmentMatch = environment.formalEnvironmentMatch;
        componentCount = environment.componentCount;
        dependencyCount = environment.dependencyCount;
      }
    } catch {
      sbomStatus = 'FAIL';
    }
  }
  if (existsSync(resolve(root, checksumPath))) {
    try {
      const manifestText = readFileSync(resolve(root, checksumPath), 'utf8');
      const checksumValidation = verifyChecksumManifest({
        root,
        manifestText
      });
      const actualPaths = manifestText.trimEnd().split('\n').map((line) => line.slice(66));
      const expectedPaths = [...G11_T03_FIXED_CHECKSUM_PATHS, acceptanceRunPath];
      if (candidateArtifact.artifactPresent) expectedPaths.push(candidateArtifact.expectedPath);
      const exactPathSet = actualPaths.length === expectedPaths.length &&
        JSON.stringify([...actualPaths].sort()) === JSON.stringify([...expectedPaths].sort());
      checksumStatus = checksumValidation.ok && exactPathSet ? 'PASS' : 'FAIL';
    } catch {
      checksumStatus = 'FAIL';
    }
  }
  if (existsSync(resolve(root, signingStatusPath))) {
    try {
      const signing = readJson(root, signingStatusPath);
      const observedSigning = inspectAuthenticodeStatus({
        root,
        candidate: candidateArtifact,
        checkedAt: signing?.checkedAt
      });
      const signingValidation = validateSigningStatusRecord({
        record: signing,
        sourceCommit,
        candidate: candidateArtifact,
        platform: platform(),
        observed: observedSigning
      });
      signatureStatus = signingValidation.ok ? signing.status : 'SIGNED_INVALID';
    } catch {
      signatureStatus = 'SIGNED_INVALID';
    }
  }
  return {
    sbomStatus,
    checksumStatus,
    signatureStatus,
    sbomPath,
    checksumPath,
    signingStatusPath,
    formalEnvironmentMatch,
    componentCount,
    dependencyCount
  };
}

export function loadReleaseAggregationInputs({ root, releaseInput, generatedAt }) {
  const runPath = releaseInput?.acceptanceRunPath;
  const candidatePath = releaseInput?.candidateArtifactPath;
  if (!/^reports\/acceptance-runs\/run-\d{8}-[a-f0-9]{7}-\d{2}\.json$/.test(runPath ?? '')) {
    fail('RELEASE_INPUT_PATH_REJECTED', runPath ?? '');
  }
  if (candidatePath !== 'reports/release/candidate-artifact.json') fail('RELEASE_INPUT_PATH_REJECTED', candidatePath ?? '');
  const acceptanceRun = readJson(root, runPath);
  const candidateArtifact = readJson(root, candidatePath);
  verifyCandidateArtifactSnapshot({ root, candidateArtifact });
  if (releaseInput.sourceCommit !== acceptanceRun.sourceCommit || candidateArtifact.sourceCommit !== acceptanceRun.sourceCommit) {
    fail('RELEASE_SOURCE_MISMATCH');
  }
  const loaded = loadAcceptanceDefinitions(root);
  const map = readJson(root, 'planning/g11-acceptance-map.json');
  const externalCatalog = readJson(root, 'planning/EXTERNAL_INPUTS.json');
  const externalInputs = normalizeExternalCatalog(externalCatalog);
  const externalIds = externalInputs.map((item) => item.id);
  const mapValidation = validateAcceptanceMap({
    definitionIds: loaded.definitions.map((item) => item.id), map, knownExternalInputIds: externalIds
  });
  if (!mapValidation.ok) fail('RELEASE_ACCEPTANCE_MAP_INVALID', JSON.stringify(mapValidation.errors));
  const runValidation = validateAcceptanceRun({
    root, definitionIds: loaded.definitions.map((item) => item.id), map, run: acceptanceRun
  });
  if (!runValidation.ok) fail('RELEASE_ACCEPTANCE_RUN_INVALID', JSON.stringify(runValidation.errors));

  const baseTrace = readJson(root, 'planning/requirements-traceability.json');
  const crTrace = readJson(root, 'planning/changes/CR001/traceability.json');
  const defectAudit = readJson(root, 'reports/release/defect-audit.json');
  verifyDefectAuditSource(defectAudit, acceptanceRun.sourceCommit);
  const requirements = buildRequirementCoverage({ baseTrace, crTrace, definitions: loaded.definitions });
  const inputs = [
    runPath,
    candidatePath,
    'planning/requirements-traceability.json',
    'planning/changes/CR001/traceability.json',
    'acceptance/cases.json',
    'acceptance/addenda/classroom-delivery.cases.json',
    'planning/EXTERNAL_INPUTS.json',
    'planning/g11-acceptance-map.json',
    'reports/release/defect-audit.json'
  ];
  if (candidateArtifact.artifactPresent) inputs.push(candidateArtifact.expectedPath);
  const allowedDirtyPaths = [
    ...G11_GENERATED_OUTPUT_PATHS,
    runPath,
    candidatePath,
    'reports/release/defect-audit.json'
  ];
  if (candidateArtifact.artifactPresent) allowedDirtyPaths.push(candidateArtifact.expectedPath);
  const repositoryProvenance = inspectRepositoryProvenance({
    root,
    sourceCommit: acceptanceRun.sourceCommit,
    allowedDirtyPaths
  });
  return {
    generatedAt,
    acceptanceRun: { ...readDescriptor(root, runPath), value: acceptanceRun },
    candidateArtifact: { ...readDescriptor(root, candidatePath), value: candidateArtifact },
    requirements,
    caseDefinitions: loaded.definitions.map((item) => ({ caseId: item.id, severity: item.severity })),
    externalInputs,
    defectAudit,
    repositoryProvenance,
    supplyChain: loadSupplyChainEvidence(
      root, acceptanceRun.sourceCommit, candidateArtifact, runPath, repositoryProvenance
    ),
    inputFiles: inputs.map((path) => readDescriptor(root, path)),
    deliverables: [
      deliverable(root, 'acceptance_run', runPath),
      deliverable(root, 'candidate_inventory', candidatePath),
      deliverable(root, 'candidate_installer', candidateArtifact.expectedPath),
      deliverable(root, 'release_evidence', 'reports/release/release-evidence.json', true),
      deliverable(root, 'defect_audit', 'reports/release/defect-audit.json'),
      deliverable(root, 'known_limitations', 'reports/release/KNOWN_LIMITATIONS.md', true),
      deliverable(root, 'cyclonedx_sbom', 'reports/release/yuwendesk.cdx.json'),
      deliverable(root, 'checksum_manifest', 'reports/release/SHA256SUMS.txt'),
      deliverable(root, 'signing_status', 'reports/release/signing-status.json'),
      deliverable(root, 'teacher_guide', 'docs/TEACHER_QUICK_GUIDE.md'),
      deliverable(root, 'final_status', 'reports/release/FINAL_STATUS.md', true)
    ]
  };
}

export function renderKnownGap(evidence) {
  const lines = [
    '# 已知限制与未关闭发行门',
    '',
    `当前发行判定：\`${evidence.statuses.releaseDisposition}\`（\`${evidence.statuses.reasonCode}\`）。`,
    '',
    '本文件列出当前证据中的真实缺口。不得通过关闭 SmartScreen、系统保护、签名校验或隐私授权绕过这些门。',
    ''
  ];
  for (const gap of evidence.knownGaps) {
    lines.push(`## ${gap.gapId}`, '', `- 范围：${gap.scope}`, `- 状态：${gap.status}`,
      `- 阻断码：\`${gap.blockerCode}\``,
      `- 外部输入：${gap.externalInputIds.length > 0 ? gap.externalInputIds.join('、') : '无；属于尚未执行的本地发行步骤'}`,
      `- 安全下一步：${gap.safeAction}`, '');
  }
  return `${lines.join('\n')}\n`;
}
