import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error pure root ESM module
import { recoverJsonSetAtomic, writeFileSetAtomic } from '../../../scripts/lib/g11-acceptance.mjs';

// @ts-expect-error pure root ESM module
import {
  aggregateReleaseEvidence,
  buildRequirementCoverage,
  decideReleaseDisposition,
  loadReleaseAggregationInputs,
  validateReleaseEvidence,
  verifyCandidateArtifactSnapshot,
  verifyDefectAuditSource
} from '../../../scripts/lib/g11-release-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoots: string[] = [];

function makeFixtureRoot() {
  const path = join(root, 'reports', `.g11-release-test-${process.pid}-${Date.now()}-${fixtureRoots.length}`);
  mkdirSync(path, { recursive: true });
  fixtureRoots.push(path);
  return path;
}

function descriptor(path: string, content: string) {
  const bytes = Buffer.from(content);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
}

function minimalInput(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-20T00:01:00.000Z',
    acceptanceRun: {
      path: 'reports/acceptance-runs/run-20260920-abcdef0-01.json',
      sha256: '1'.repeat(64),
      sizeBytes: 100,
      value: {
        runId: 'run-20260920-abcdef0-01', sourceCommit: 'abcdef0123456789', repositoryDirty: true,
        results: [
          { caseId: 'CASE-A', status: 'PASS', blockerCode: null, externalInputIds: [] },
          { caseId: 'CASE-B', status: 'BLOCKED', blockerCode: 'BLOCKED_EXTERNAL_WINDOWS_ACCEPTANCE', externalInputIds: ['EXT02'] }
        ]
      }
    },
    candidateArtifact: {
      path: 'reports/release/candidate-artifact.json',
      sha256: '2'.repeat(64),
      sizeBytes: 100,
      value: {
        sourceCommit: 'abcdef0123456789', artifactPresent: false, artifactClass: 'NONE',
        expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe', sha256: null, sizeBytes: null
      }
    },
    requirements: {
      base: [{ requirementId: 'R001', priority: 'P1', caseIds: ['CASE-A'] }],
      cr001: [{ requirementId: 'CR001-R01', priority: 'P1', caseIds: ['CASE-B'] }]
    },
    caseDefinitions: [
      { caseId: 'CASE-A', severity: 'P1' },
      { caseId: 'CASE-B', severity: 'P1' }
    ],
    externalInputs: [{
      id: 'EXT02', status: 'NOT_PROVIDED', description: 'clean Windows',
      ownerAction: 'provide controlled environment', blocks: ['G11']
    }],
    defectAudit: {
      status: 'NOT_RUN', assessedCommit: null, executedAt: null, items: [],
      blockerCode: 'RELEASE_DEFECT_AUDIT_REQUIRED'
    },
    inputFiles: [],
    deliverables: [{ id: 'acceptance_run', path: 'reports/acceptance-runs/run-20260920-abcdef0-01.json', status: 'PRESENT' }],
    ...overrides
  };
}

afterEach(() => {
  for (const path of fixtureRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('G11-T02 release disposition priority', () => {
  it('blocks a missing candidate even when engineering tests pass', () => {
    expect(decideReleaseDisposition({
      requiredCaseResults: [{ caseId: 'UPD-006', severity: 'P1', status: 'BLOCKED' }],
      artifactPresent: false,
      artifactSigned: false,
      cleanWindowsPassed: false,
      distributionAuthorized: false,
      controlledTrialAuthorized: false,
      dataBoundaryApproved: false,
      costBoundaryApproved: false,
      defectAuditStatus: 'NOT_RUN',
      knownDefects: []
    })).toEqual({ artifactClass: 'NONE', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_ARTIFACT_MISSING' });
  });

  it('never upgrades an unsigned artifact to controlled trial or release ready', () => {
    expect(decideReleaseDisposition({
      requiredCaseResults: [],
      artifactPresent: true,
      artifactSigned: false,
      cleanWindowsPassed: true,
      distributionAuthorized: true,
      controlledTrialAuthorized: true,
      dataBoundaryApproved: true,
      costBoundaryApproved: true,
      defectAuditStatus: 'COMPLETE',
      knownDefects: []
    })).toEqual({
      artifactClass: 'UNSIGNED_TEST_BUILD',
      releaseDisposition: 'UNSIGNED_TEST_BUILD',
      reasonCode: 'RELEASE_SIGNATURE_MISSING'
    });
  });

  it('gives an observed P0/P1 failure priority over artifact state', () => {
    const result = decideReleaseDisposition({
      requiredCaseResults: [{ caseId: 'CASE-A', severity: 'P0', status: 'FAIL' }],
      artifactPresent: false, artifactSigned: false, cleanWindowsPassed: false,
      distributionAuthorized: false, controlledTrialAuthorized: false,
      dataBoundaryApproved: false, costBoundaryApproved: false,
      defectAuditStatus: 'NOT_RUN', knownDefects: []
    });
    expect(result.reasonCode).toBe('RELEASE_REQUIRED_CASE_FAILED');
    expect(result.releaseDisposition).toBe('BLOCKED');
  });

  it('blocks a dirty acceptance run even when artifact and external gates claim ready', () => {
    expect(decideReleaseDisposition({
      requiredCaseResults: [], artifactPresent: true, artifactSigned: true, sourceTreeClean: false,
      cleanWindowsPassed: true, distributionAuthorized: true, controlledTrialAuthorized: false,
      dataBoundaryApproved: true, costBoundaryApproved: true, defectAuditStatus: 'COMPLETE', knownDefects: []
    })).toEqual({
      artifactClass: 'SIGNED_TEST_BUILD', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_SOURCE_DIRTY'
    });
  });
});

describe('G11-T02 release aggregation boundary', () => {
  it('keeps software, resource, teaching, artifact, and release dimensions separate', () => {
    const evidence = aggregateReleaseEvidence(minimalInput());
    expect(evidence.statuses).toEqual({
      softwareStatus: 'BLOCKED',
      resourceCoverageStatus: 'BLOCKED',
      teachingValidationStatus: 'NOT_REVIEWED',
      artifactClass: 'NONE',
      releaseDisposition: 'BLOCKED',
      reasonCode: 'RELEASE_ARTIFACT_MISSING'
    });
    expect(evidence.requirements.base).toHaveLength(1);
    expect(evidence.requirements.cr001).toHaveLength(1);
    expect(evidence.cases).toHaveLength(2);
  });

  it('rejects a run and candidate from different source commits', () => {
    const candidateArtifact = minimalInput().candidateArtifact as Record<string, unknown>;
    expect(() => aggregateReleaseEvidence(minimalInput({
      candidateArtifact: {
        ...candidateArtifact,
        value: { ...(candidateArtifact.value as object), sourceCommit: 'deadbeefdeadbeef' }
      }
    }))).toThrow(/RELEASE_SOURCE_MISMATCH/);
  });

  it('rejects a case blocker that references an undeclared external input', () => {
    const input = minimalInput();
    const acceptanceRun = input.acceptanceRun as Record<string, unknown>;
    const value = acceptanceRun.value as { results: Array<Record<string, unknown>> };
    expect(() => aggregateReleaseEvidence(minimalInput({
      acceptanceRun: {
        ...acceptanceRun,
        value: {
          ...(acceptanceRun.value as object),
          results: value.results.map((item) => item.caseId === 'CASE-B' ? { ...item, externalInputIds: ['EXT99'] } : item)
        }
      }
    }))).toThrow(/RELEASE_EXTERNAL_INPUT_UNKNOWN/);
  });

  it('does not treat an empty NOT_RUN defect audit as zero known P0/P1 defects', () => {
    const acceptanceRun = minimalInput().acceptanceRun as Record<string, unknown>;
    const evidence = aggregateReleaseEvidence(minimalInput({
      acceptanceRun: {
        ...acceptanceRun,
        value: {
          ...(acceptanceRun.value as object),
          repositoryDirty: false,
          results: [
            { caseId: 'CASE-A', status: 'PASS', blockerCode: null, externalInputIds: [] },
            { caseId: 'CASE-B', status: 'PASS', blockerCode: null, externalInputIds: [] }
          ]
        }
      },
      candidateArtifact: {
        ...(minimalInput().candidateArtifact as object),
        value: {
          sourceCommit: 'abcdef0123456789', artifactPresent: true, artifactClass: 'SIGNED_TEST_BUILD',
          expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe', sha256: '3'.repeat(64), sizeBytes: 10
        }
      },
      externalInputs: [{ id: 'EXT02', status: 'PROVIDED', description: 'clean Windows', ownerAction: 'none', blocks: [] }]
    }));
    expect(evidence.statuses.releaseDisposition).toBe('BLOCKED');
    expect(evidence.statuses.reasonCode).toBe('RELEASE_REQUIRED_GATE_OPEN');
  });

  it('rejects a COMPLETE defect audit without candidate commit and execution time binding', () => {
    expect(() => aggregateReleaseEvidence(minimalInput({
      defectAudit: {
        status: 'COMPLETE', assessedCommit: null, executedAt: null, items: [], blockerCode: null
      }
    }))).toThrow(/RELEASE_DEFECT_AUDIT_INVALID/);
    expect(() => verifyDefectAuditSource({
      status: 'NOT_RUN', assessedCommit: null, executedAt: null, items: [],
      blockerCode: 'RELEASE_DEFECT_AUDIT_REQUIRED'
    }, 'abcdef0123456789')).toThrow(/RELEASE_DEFECT_AUDIT_INVALID/);
  });

  it('rejects unknown external-input states and sensitive output strings', () => {
    const input = minimalInput();
    expect(() => aggregateReleaseEvidence(minimalInput({
      externalInputs: [{ ...(input.externalInputs as Array<Record<string, unknown>>)[0], status: 'MAYBE' }]
    }))).toThrow(/RELEASE_EXTERNAL_INPUT_INVALID/);
    expect(() => aggregateReleaseEvidence(minimalInput({
      externalInputs: [{
        ...(input.externalInputs as Array<Record<string, unknown>>)[0],
        ownerAction: 'read C:\\Users\\Teacher\\secret.txt'
      }]
    }))).toThrow(/RELEASE_PRIVACY_VIOLATION/);
    expect(() => aggregateReleaseEvidence(minimalInput({
      externalInputs: [{
        ...(input.externalInputs as Array<Record<string, unknown>>)[0],
        ownerAction: 'inspect /opt/private/student.txt'
      }]
    }))).toThrow(/RELEASE_PRIVACY_VIOLATION/);
  });

  it('rejects changed fixed requirement IDs and unknown baseline priorities', () => {
    const baseTrace = JSON.parse(readFileSync(join(root, 'planning', 'requirements-traceability.json'), 'utf8'));
    const crTrace = JSON.parse(readFileSync(join(root, 'planning', 'changes', 'CR001', 'traceability.json'), 'utf8'));
    const baseCases = JSON.parse(readFileSync(join(root, 'acceptance', 'cases.json'), 'utf8')).cases;
    const addendumCases = JSON.parse(
      readFileSync(join(root, 'acceptance', 'addenda', 'classroom-delivery.cases.json'), 'utf8')
    ).cases;
    expect(() => buildRequirementCoverage({
      baseTrace: baseTrace.map((item: Record<string, unknown>, index: number) =>
        index === 0 ? { ...item, requirement_id: 'R999' } : item),
      crTrace,
      definitions: [...baseCases, ...addendumCases]
    })).toThrow(/RELEASE_REQUIREMENT_SOURCE_INVALID/);
    expect(() => buildRequirementCoverage({
      baseTrace: baseTrace.map((item: Record<string, unknown>, index: number) =>
        index === 0 ? { ...item, baseline_priority: '未知优先级' } : item),
      crTrace,
      definitions: [...baseCases, ...addendumCases]
    })).toThrow(/RELEASE_REQUIREMENT_SOURCE_INVALID/);
    const unrelatedCase = addendumCases.find((item: { requirement_ids: string[] }) =>
      !item.requirement_ids.includes(crTrace.links[0].requirement_id));
    expect(() => buildRequirementCoverage({
      baseTrace,
      crTrace: {
        ...crTrace,
        links: crTrace.links.map((item: Record<string, unknown>, index: number) =>
          index === 0 ? { ...item, case_ids: [unrelatedCase.id] } : item)
      },
      definitions: [...baseCases, ...addendumCases]
    })).toThrow(/RELEASE_REQUIREMENT_SOURCE_INVALID/);
  });

  it('recomputes the fixed candidate bytes instead of trusting inventory hash fields', () => {
    const fixtureRoot = makeFixtureRoot();
    const releaseDir = join(fixtureRoot, 'apps', 'desktop', 'release');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'YuwenDesk-Setup-0.1.0-x64.exe'), 'actual candidate bytes', 'utf8');
    expect(() => verifyCandidateArtifactSnapshot({
      root: fixtureRoot,
      candidateArtifact: {
        schemaVersion: 1,
        sourceCommit: 'abcdef0123456789',
        checkedAt: '2026-09-20T00:00:00.000Z',
        expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        artifactPresent: true,
        artifactClass: 'UNSIGNED_TEST_BUILD',
        sha256: '0'.repeat(64),
        sizeBytes: 22,
        buildCommand: 'npm run build:win',
        buildEnvironment: { os: 'win32', release: 'test', arch: 'x64', node: 'v22.14.0', npm: '10.9.7' }
      }
    })).toThrow(/RELEASE_CANDIDATE_ARTIFACT_DRIFT/);
  });

  it('restores JSON and Markdown together when grouped publication fails', () => {
    const fixtureRoot = makeFixtureRoot();
    const transactionPath = join(fixtureRoot, '.release-transaction.json');
    const evidencePath = join(fixtureRoot, 'release-evidence.json');
    const limitationsPath = join(fixtureRoot, 'KNOWN_LIMITATIONS.md');
    const inputPath = join(fixtureRoot, 'release-input.json');
    writeFileSync(evidencePath, '{"version":"old-evidence"}\n', 'utf8');
    writeFileSync(limitationsPath, '# old limitations\n', 'utf8');
    writeFileSync(inputPath, '{"version":"old-input"}\n', 'utf8');
    expect(() => writeFileSetAtomic({
      transactionPath,
      entries: [
        { targetPath: evidencePath, content: '{"version":"new-evidence"}\n', validateContent: () => true },
        { targetPath: limitationsPath, content: '# new limitations\n', validateContent: () => true },
        { targetPath: inputPath, content: '{"version":"new-input"}\n', validateContent: () => true }
      ],
      beforePublish: (index: number) => { if (index === 2) throw new Error('injected'); }
    })).toThrow(/injected/);
    expect(readFileSync(evidencePath, 'utf8')).toBe('{"version":"old-evidence"}\n');
    expect(readFileSync(limitationsPath, 'utf8')).toBe('# old limitations\n');
    expect(readFileSync(inputPath, 'utf8')).toBe('{"version":"old-input"}\n');

    const victimPath = join(fixtureRoot, 'unrelated-report.json');
    writeFileSync(victimPath, '{"must":"survive"}\n', 'utf8');
    writeFileSync(transactionPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'COMMITTED',
      entries: [{
        targetName: 'release-evidence.json',
        stageName: 'unrelated-report.json',
        backupName: 'also-unrelated.json',
        hadTarget: true
      }]
    })}\n`, 'utf8');
    expect(() => recoverJsonSetAtomic({
      transactionPath,
      expectedTargetNames: ['release-evidence.json', 'KNOWN_LIMITATIONS.md', 'release-input.json']
    })).toThrow(/JSON_SET_JOURNAL_INVALID/);
    expect(readFileSync(victimPath, 'utf8')).toBe('{"must":"survive"}\n');
  });

  it('re-reads aggregate input files and rejects changed evidence bytes', () => {
    const fixtureRoot = makeFixtureRoot();
    mkdirSync(join(fixtureRoot, 'reports'), { recursive: true });
    const content = '{"source":"original"}\n';
    writeFileSync(join(fixtureRoot, 'reports', 'input.json'), content, 'utf8');
    const evidence = aggregateReleaseEvidence(minimalInput({
      inputFiles: [descriptor('reports/input.json', content)]
    }));
    const before = validateReleaseEvidence({ root: fixtureRoot, evidence });
    expect(before.ok).toBe(false);
    expect(before.errors.map((error: { code: string }) => error.code)).toContain('RELEASE_SOURCE_INPUT_MISSING');
    expect(before.errors.map((error: { code: string }) => error.code)).not.toContain('RELEASE_EVIDENCE_INVALID');
    writeFileSync(join(fixtureRoot, 'reports', 'input.json'), '{"source":"changed"}\n', 'utf8');
    const invalid = validateReleaseEvidence({ root: fixtureRoot, evidence });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.map((error: { code: string }) => error.code)).toContain('RELEASE_EVIDENCE_INVALID');
  });

  it('rejects undeclared aggregate fields instead of widening the closed contract', () => {
    const evidence = { ...aggregateReleaseEvidence(minimalInput()), optimisticPassRate: 100 };
    const invalid = validateReleaseEvidence({ root, evidence });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.map((error: { code: string }) => error.code)).toContain('RELEASE_EVIDENCE_INVALID');
  });

  it('loads exact repository coverage for 60 base requirements, 24 CR-001 requirements, and 170 cases', () => {
    const releaseInput = JSON.parse(readFileSync(join(root, 'reports', 'release', 'release-input.json'), 'utf8'));
    const input = loadReleaseAggregationInputs({ root, releaseInput, generatedAt: '2026-09-20T00:01:00.000Z' });
    const evidence = aggregateReleaseEvidence(input);
    expect(evidence.requirements.base).toHaveLength(60);
    expect(evidence.requirements.cr001).toHaveLength(24);
    expect(evidence.cases).toHaveLength(170);
    expect(new Set(evidence.cases.map((item: { caseId: string }) => item.caseId)).size).toBe(170);
    expect(evidence.statuses.releaseDisposition).toBe('BLOCKED');
    expect(evidence.knownGaps.map((item: { gapId: string }) => item.gapId)).toContain('SOURCE_RUN_DIRTY');
    expect(validateReleaseEvidence({ root, evidence }).ok).toBe(true);
    const changedMapping = structuredClone(evidence);
    changedMapping.requirements.base[0].caseIds = [evidence.cases[1].caseId];
    expect(validateReleaseEvidence({ root, evidence: changedMapping }).errors
      .map((error: { code: string }) => error.code)).toContain('RELEASE_AGGREGATE_DERIVATION_MISMATCH');

    const forgedReady = structuredClone(evidence);
    forgedReady.requirements.base.pop();
    forgedReady.cases = forgedReady.cases.map((item: Record<string, unknown>) => ({
      ...item, status: 'PASS', blockerCode: null, externalInputIds: []
    }));
    forgedReady.caseSummary = { PASS: 170, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
    forgedReady.candidate.artifactPresent = true;
    forgedReady.candidate.artifactClass = 'SIGNED_RELEASE_CANDIDATE';
    forgedReady.candidate.sha256 = 'a'.repeat(64);
    forgedReady.candidate.sizeBytes = 1;
    forgedReady.statuses = {
      softwareStatus: 'PASS', resourceCoverageStatus: 'VERIFIED', teachingValidationStatus: 'TEACHER_REVIEWED',
      artifactClass: 'SIGNED_RELEASE_CANDIDATE', releaseDisposition: 'RELEASE_READY', reasonCode: 'RELEASE_ALL_GATES_PASS'
    };
    forgedReady.gates = {
      sourceTreeClean: true, cleanWindowsPassed: true, artifactSigned: true, distributionAuthorized: true,
      controlledTrialAuthorized: false, dataBoundaryApproved: true, costBoundaryApproved: true,
      defectAuditStatus: 'COMPLETE'
    };
    forgedReady.defectAudit = {
      status: 'COMPLETE', assessedCommit: forgedReady.sourceCommit,
      executedAt: forgedReady.generatedAt, blockerCode: null, items: []
    };
    const forgedValidation = validateReleaseEvidence({ root, evidence: forgedReady });
    expect(forgedValidation.ok).toBe(false);
    expect(forgedValidation.errors.map((error: { code: string }) => error.code))
      .toContain('RELEASE_AGGREGATE_DERIVATION_MISMATCH');
  });
});
