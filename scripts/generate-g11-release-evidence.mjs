#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverJsonSetAtomic, writeFileSetAtomic } from './lib/g11-acceptance.mjs';
import {
  aggregateReleaseEvidence,
  loadReleaseAggregationInputs,
  validateReleaseEvidence
} from './lib/g11-release-evidence.mjs';
import { renderFinalStatus, renderKnownLimitations } from './lib/g11-release-verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, 'reports', 'release');
const releaseInputPath = resolve(releaseRoot, 'release-input.json');
const evidencePath = resolve(releaseRoot, 'release-evidence.json');
const limitationsPath = resolve(releaseRoot, 'KNOWN_LIMITATIONS.md');
const finalStatusPath = resolve(releaseRoot, 'FINAL_STATUS.md');
const transactionPath = resolve(releaseRoot, '.g11-release-evidence-transaction.json');

recoverJsonSetAtomic({
  transactionPath,
  expectedTargetNames: ['release-evidence.json', 'KNOWN_LIMITATIONS.md', 'FINAL_STATUS.md', 'release-input.json']
});

const releaseInput = JSON.parse(readFileSync(releaseInputPath, 'utf8'));
const generatedAt = new Date().toISOString();
const aggregationInput = loadReleaseAggregationInputs({ root, releaseInput, generatedAt });
const evidence = aggregateReleaseEvidence(aggregationInput);
const validation = validateReleaseEvidence({ root, evidence });
if (!validation.ok) throw new Error(`RELEASE_EVIDENCE_INVALID:${JSON.stringify(validation.errors)}`);

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
writeFileSetAtomic({
  transactionPath,
  entries: [
    {
      targetPath: evidencePath,
      content: `${JSON.stringify(evidence, null, 2)}\n`,
      validateContent: (content) => validateReleaseEvidence({ root, evidence: JSON.parse(content) })
    },
    {
      targetPath: limitationsPath,
      content: limitations,
      validateContent: (content) => content === limitations
    },
    {
      targetPath: finalStatusPath,
      content: finalStatus,
      validateContent: (content) => content === finalStatus
    },
    {
      targetPath: releaseInputPath,
      content: `${JSON.stringify(nextReleaseInput, null, 2)}\n`,
      validateContent: (content) => {
        const value = JSON.parse(content);
        return value?.schemaVersion === 1 && value?.sourceCommit === evidence.sourceCommit &&
          value?.acceptanceRunPath === evidence.acceptanceRun.path &&
          value?.candidateArtifactPath === evidence.candidate.inventoryPath &&
          value?.releaseEvidenceGeneratedAt === generatedAt &&
          value?.defectAuditPath === 'reports/release/defect-audit.json' &&
          value?.releaseEvidencePath === 'reports/release/release-evidence.json' &&
          value?.knownLimitationsPath === 'reports/release/KNOWN_LIMITATIONS.md' &&
          value?.finalStatusPath === 'reports/release/FINAL_STATUS.md';
      }
    }
  ]
});

console.log(JSON.stringify({
  sourceCommit: evidence.sourceCommit,
  runId: evidence.acceptanceRun.runId,
  statuses: evidence.statuses,
  caseSummary: evidence.caseSummary,
  requirementCounts: {
    base: evidence.requirements.base.length,
    cr001: evidence.requirements.cr001.length
  },
  gapCount: evidence.knownGaps.length
}, null, 2));
