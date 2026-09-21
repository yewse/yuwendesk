#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseEvidence } from './lib/g11-release-evidence.mjs';
import {
  G11_T03_FIXED_CHECKSUM_PATHS,
  verifyChecksumManifest
} from './lib/g11-supply-chain.mjs';
import {
  canonicalizeReleaseText,
  releaseVerificationExitCode,
  renderFinalStatus,
  renderKnownLimitations,
  validatePublicReleaseText,
  validateTeacherGuide,
  verifyReleaseCandidate
} from './lib/g11-release-verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixedPaths = Object.freeze({
  evidence: 'reports/release/release-evidence.json',
  manifest: 'reports/release/SHA256SUMS.txt',
  finalStatus: 'reports/release/FINAL_STATUS.md',
  limitations: 'reports/release/KNOWN_LIMITATIONS.md',
  teacherGuide: 'docs/TEACHER_QUICK_GUIDE.md'
});

function readFixed(path) {
  const absolute = resolve(root, path);
  const actual = realpathSync(absolute);
  const rootReal = realpathSync(root);
  const rel = relative(rootReal, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isFile()) {
    throw new Error(`RELEASE_FIXED_PATH_REJECTED:${path}`);
  }
  return readFileSync(actual, 'utf8');
}

function manifestPaths(text) {
  return text.trimEnd().split('\n').map((line) => line.slice(66));
}

try {
  const evidence = JSON.parse(readFixed(fixedPaths.evidence));
  const manifestText = readFixed(fixedPaths.manifest);
  const structuralErrors = [];
  const evidenceValidation = validateReleaseEvidence({ root, evidence });
  if (!evidenceValidation.ok) structuralErrors.push(
    ...evidenceValidation.errors.map((item) => `${item.code}${item.detail ? `:${item.detail}` : ''}`)
  );
  const checksumValidation = verifyChecksumManifest({ root, manifestText });
  if (!checksumValidation.ok) structuralErrors.push(
    ...checksumValidation.errors.map((item) => `${item.code}${item.detail ? `:${item.detail}` : ''}`)
  );

  const requiredDocumentsPresent = [fixedPaths.finalStatus, fixedPaths.limitations, fixedPaths.teacherGuide]
    .every((path) => existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile());
  if (!requiredDocumentsPresent) structuralErrors.push('RELEASE_DOCUMENT_MISSING');
  if (requiredDocumentsPresent) {
    const finalStatusText = readFixed(fixedPaths.finalStatus);
    const limitationsText = readFixed(fixedPaths.limitations);
    const teacherGuideText = readFixed(fixedPaths.teacherGuide);
    if (canonicalizeReleaseText(finalStatusText) !== renderFinalStatus(evidence)) {
      structuralErrors.push('RELEASE_FINAL_STATUS_MISMATCH');
    }
    if (canonicalizeReleaseText(limitationsText) !== renderKnownLimitations(evidence)) {
      structuralErrors.push('RELEASE_LIMITATIONS_MISMATCH');
    }
    structuralErrors.push(...validatePublicReleaseText(finalStatusText).errors);
    structuralErrors.push(...validatePublicReleaseText(limitationsText).errors);
    structuralErrors.push(...validateTeacherGuide(teacherGuideText).errors);
  }

  const expectedManifestPaths = [...G11_T03_FIXED_CHECKSUM_PATHS, evidence.acceptanceRun.path];
  if (evidence.candidate.artifactPresent) expectedManifestPaths.push(evidence.candidate.expectedPath);
  const actualManifestPaths = manifestPaths(manifestText);
  if (actualManifestPaths.length !== expectedManifestPaths.length ||
      JSON.stringify([...actualManifestPaths].sort()) !== JSON.stringify([...expectedManifestPaths].sort())) {
    structuralErrors.push('RELEASE_CHECKSUM_PATH_SET_INVALID');
  }
  if (evidence.supplyChain.checksumPath !== fixedPaths.manifest ||
      evidence.supplyChain.checksumStatus !== 'PASS' ||
      evidence.supplyChain.signingStatusPath !== 'reports/release/signing-status.json' ||
      evidence.supplyChain.sbomPath !== 'reports/release/yuwendesk.cdx.json') {
    structuralErrors.push('RELEASE_SUPPLY_CHAIN_CROSSCHECK_FAILED');
  }
  const verification = verifyReleaseCandidate({
    releaseDisposition: evidence.statuses.releaseDisposition,
    checksumStatus: checksumValidation.ok ? 'VALID' : 'MISMATCH',
    requiredDocumentsPresent,
    formalEnvironmentMatch: evidence.supplyChain.formalEnvironmentMatch,
    signatureStatus: evidence.supplyChain.signatureStatus,
    cleanWindowsPassed: evidence.gates.cleanWindowsPassed,
    distributionAuthorized: evidence.gates.distributionAuthorized,
    defectAuditStatus: evidence.gates.defectAuditStatus
  });
  const finalExitCode = releaseVerificationExitCode({
    structuralErrors,
    disposition: evidence.statuses.releaseDisposition,
    verification
  });
  if (finalExitCode === 1) {
    const invalidErrors = structuralErrors.length > 0 ? structuralErrors : verification.errors;
    console.error(JSON.stringify({ status: 'INVALID', errors: [...new Set(invalidErrors)].sort() }, null, 2));
  } else {
    console.log(JSON.stringify({
      disposition: evidence.statuses.releaseDisposition,
      reasonCode: evidence.statuses.reasonCode,
      releaseReady: verification.ok,
      errors: verification.errors
    }, null, 2));
  }
  process.exitCode = finalExitCode;
} catch (cause) {
  console.error(JSON.stringify({ status: 'INVALID', errors: [cause instanceof Error ? cause.message : String(cause)] }, null, 2));
  process.exitCode = 1;
}
