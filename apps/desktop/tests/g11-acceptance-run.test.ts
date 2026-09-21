import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error pure root ESM module
import {
  buildAcceptanceRun,
  inspectCandidateArtifact,
  loadCandidateBuildProvenance,
  loadAcceptanceDefinitions,
  normalizeVitestReport,
  npmCliPathForNodeExecutable,
  recoverJsonSetAtomic,
  validateAcceptanceMap,
  validateAcceptanceRun,
  validateExternalEvidenceInput,
  validateNormalizedVitest,
  writeJsonAtomic,
  writeJsonSetAtomic
} from '../../../scripts/lib/g11-acceptance.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoots: string[] = [];

function makeFixtureRoot() {
  const fixtureRoot = join(root, 'reports', `.g11-test-${process.pid}-${Date.now()}-${fixtureRoots.length}`);
  mkdirSync(fixtureRoot, { recursive: true });
  fixtureRoots.push(fixtureRoot);
  return fixtureRoot;
}

function baseRun(results: unknown[]) {
  return {
    schemaVersion: 1,
    runId: 'run-20260920-abcdef0-01',
    sourceCommit: 'abcdef0123456789',
    repositoryDirty: true,
    startedAt: '2026-09-20T00:00:00.000Z',
    completedAt: '2026-09-20T00:01:00.000Z',
    environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
    definitionSources: [],
    results
  };
}

function result(overrides: Record<string, unknown>) {
  return {
    caseId: 'CASE-A',
    status: 'NOT_RUN',
    evidenceLevel: null,
    command: null,
    exitCode: null,
    executedAt: null,
    environment: 'fixture',
    evidence: [],
    artifactHashes: [],
    blockerCode: null,
    externalInputIds: [],
    observedResult: 'not run',
    ...overrides
  };
}

function seedFrozenDefinitions(fixtureRoot: string) {
  mkdirSync(join(fixtureRoot, 'acceptance', 'addenda'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'acceptance', 'cases.json'),
    readFileSync(join(root, 'acceptance', 'cases.json'))
  );
  writeFileSync(
    join(fixtureRoot, 'acceptance', 'addenda', 'classroom-delivery.cases.json'),
    readFileSync(join(root, 'acceptance', 'addenda', 'classroom-delivery.cases.json'))
  );
}

afterEach(() => {
  for (const path of fixtureRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('G11-T01 acceptance definition and map boundary', () => {
  it('retains every failed test identity without persisting failure messages or stacks', () => {
    const selected = new Set(['tests/selected.test.ts\0selected case']);
    const report = normalizeVitestReport({
      raw: {
        success: false,
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [
          {
            name: join(root, 'apps', 'desktop', 'tests', 'selected.test.ts'),
            assertionResults: [{
              title: 'selected case', fullName: 'selected case', status: 'passed', duration: 4, failureMessages: []
            }]
          },
          {
            name: join(root, 'apps', 'desktop', 'tests', 'unmapped.test.ts'),
            assertionResults: [{
              title: 'unmapped failure', fullName: 'suite unmapped failure', status: 'failed', duration: 9,
              failureMessages: ['api_key=do-not-persist\n    at C:\\Users\\teacher\\private.ts:1:1']
            }]
          }
        ]
      },
      exitCode: 1,
      startedAt: '2026-09-20T00:00:00.000Z',
      completedAt: '2026-09-20T00:00:10.000Z',
      command: 'node vitest run',
      selectedKeys: selected,
      runId: 'run-20260920-abcdef0-01',
      sourceCommit: 'abcdef0123456789',
      repositoryDirty: false,
      desktopRoot: join(root, 'apps', 'desktop')
    });

    expect(report.assertions).toEqual([expect.objectContaining({
      testFile: 'tests/selected.test.ts', fullName: 'selected case', status: 'passed'
    })]);
    expect(report.failedAssertions).toEqual([{
      testFile: 'tests/unmapped.test.ts',
      testName: 'unmapped failure',
      fullName: 'suite unmapped failure',
      status: 'failed',
      failureCount: 1
    }]);
    expect(JSON.stringify(report)).not.toContain('do-not-persist');
    expect(JSON.stringify(report)).not.toContain('Users');
    expect(validateNormalizedVitest(report)).toBe(true);
  });

  it('invokes npm through its JavaScript CLI without a Windows command shell', () => {
    const outcome = spawnSync(process.execPath, [npmCliPathForNodeExecutable(process.execPath), '--version'], {
      encoding: 'utf8',
      shell: false
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe(0);
    expect(outcome.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('loads 130 frozen plus 40 addendum cases while definitions stay NOT_RUN', () => {
    const loaded = loadAcceptanceDefinitions(root);
    expect(loaded.definitions).toHaveLength(170);
    expect(new Set(loaded.definitions.map((item: { id: string }) => item.id)).size).toBe(170);
    expect(loaded.definitions.every((item: { status: string }) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('rejects a same-count acceptance definition whose frozen bytes changed', () => {
    const fixtureRoot = makeFixtureRoot();
    mkdirSync(join(fixtureRoot, 'acceptance', 'addenda'), { recursive: true });
    const base = readFileSync(join(root, 'acceptance', 'cases.json'), 'utf8').replace('任务以实际备课为中心', '任务以任意文案为中心');
    writeFileSync(join(fixtureRoot, 'acceptance', 'cases.json'), base, 'utf8');
    writeFileSync(
      join(fixtureRoot, 'acceptance', 'addenda', 'classroom-delivery.cases.json'),
      readFileSync(join(root, 'acceptance', 'addenda', 'classroom-delivery.cases.json'))
    );
    expect(() => loadAcceptanceDefinitions(fixtureRoot)).toThrow(/ACCEPTANCE_DEFINITION_HASH_MISMATCH/);
  });

  it('requires every definition exactly once and rejects unknown cases', () => {
    const validation = validateAcceptanceMap({
      definitionIds: ['CASE-A', 'CASE-B'],
      map: {
        schemaVersion: 1,
        cases: [
          { caseId: 'CASE-A', mode: 'not_run', requiredEvidenceLevel: 'engineering_automation', reasonCode: 'FORMAL_CASE_NOT_EXECUTED' },
          { caseId: 'CASE-A', mode: 'not_run', requiredEvidenceLevel: 'engineering_automation', reasonCode: 'FORMAL_CASE_NOT_EXECUTED' },
          { caseId: 'CASE-X', mode: 'not_run', requiredEvidenceLevel: 'engineering_automation', reasonCode: 'FORMAL_CASE_NOT_EXECUTED' }
        ]
      }
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining(['ACCEPTANCE_MAP_DUPLICATE', 'ACCEPTANCE_MAP_MISSING', 'ACCEPTANCE_MAP_UNKNOWN'])
    );
  });

  it('rejects malformed map modes and evidence levels', () => {
    const validation = validateAcceptanceMap({
      definitionIds: ['CASE-A', 'CASE-B'],
      map: {
        schemaVersion: 1,
        cases: [
          { caseId: 'CASE-A', mode: 'automation', requiredEvidenceLevel: 'unknown', commandGroup: 'desktop-unit' },
          { caseId: 'CASE-B', mode: 'external', requiredEvidenceLevel: 'office_wps', blockerCode: 'BLOCKED_EXTERNAL_OFFICE', externalInputIds: [] }
        ]
      }
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining(['ACCEPTANCE_MAP_ENTRY_INVALID'])
    );
  });

  it('rejects blocker references to undeclared external inputs', () => {
    const validation = validateAcceptanceMap({
      definitionIds: ['CASE-A'],
      knownExternalInputIds: ['EXT02'],
      map: {
        schemaVersion: 1,
        cases: [{
          caseId: 'CASE-A', mode: 'external', requiredEvidenceLevel: 'clean_windows_standard_user',
          blockerCode: 'BLOCKED_EXTERNAL_WINDOWS', externalInputIds: ['EXT99']
        }]
      }
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toContain('ACCEPTANCE_MAP_EXTERNAL_INPUT_UNKNOWN');
  });
});

describe('G11-T01 acceptance run invariants', () => {
  it('creates a missing fixed parent directory before an atomic JSON publication', () => {
    const fixtureRoot = makeFixtureRoot();
    const targetPath = join(fixtureRoot, 'nested', 'result.json');
    writeJsonAtomic({
      targetPath,
      value: { ok: true },
      validate: (value: { ok?: boolean }) => value.ok === true
    });
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({ ok: true });
  });

  it('does not promote an individually passed assertion when its command group failed', () => {
    const fixtureRoot = makeFixtureRoot();
    const evidencePath = relative(root, join(fixtureRoot, 'vitest.json')).replaceAll('\\', '/');
    writeFileSync(join(fixtureRoot, 'vitest.json'), '{"success":false}\n', 'utf8');
    const run = buildAcceptanceRun({
      root,
      definitions: [{ id: 'CASE-A' }],
      definitionSources: [],
      map: { cases: [{
        caseId: 'CASE-A', mode: 'automation', requiredEvidenceLevel: 'engineering_automation',
        commandGroup: 'desktop-unit', testFile: 'tests/example.test.ts', testName: 'exact test'
      }] },
      automationReport: {
        success: false,
        exitCode: 1,
        command: 'node vitest run',
        assertions: [{ testFile: 'tests/example.test.ts', testName: 'exact test', status: 'passed' }]
      },
      sourceCommit: 'abcdef0123456789', repositoryDirty: true, runId: 'run-20260920-abcdef0-01',
      startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
      environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
      evidencePath
    });
    expect(run.results[0].status).toBe('FAIL');
    expect(run.results[0].exitCode).toBe(1);
  });

  it('matches the full Vitest name instead of an ambiguous title', () => {
    const fixtureRoot = makeFixtureRoot();
    const evidencePath = relative(root, join(fixtureRoot, 'vitest.json')).replaceAll('\\', '/');
    writeFileSync(join(fixtureRoot, 'vitest.json'), '{"success":true}\n', 'utf8');
    const run = buildAcceptanceRun({
      root,
      definitions: [{ id: 'CASE-A' }], definitionSources: [],
      map: { cases: [{
        caseId: 'CASE-A', mode: 'automation', requiredEvidenceLevel: 'engineering_automation',
        commandGroup: 'desktop-unit', testFile: 'tests/example.test.ts', testName: 'suite B duplicate'
      }] },
      automationReport: {
        success: true, exitCode: 0, command: 'node vitest run',
        assertions: [
          { testFile: 'tests/example.test.ts', testName: 'duplicate', fullName: 'suite A duplicate', status: 'failed' },
          { testFile: 'tests/example.test.ts', testName: 'duplicate', fullName: 'suite B duplicate', status: 'passed' }
        ]
      },
      sourceCommit: 'abcdef0123456789', repositoryDirty: true, runId: 'run-20260920-abcdef0-01',
      startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
      environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
      evidencePath
    });
    expect(run.results[0].status).toBe('PASS');
  });

  it('rejects PASS without a declared evidence level', () => {
    const fixtureRoot = makeFixtureRoot();
    const path = join(fixtureRoot, 'evidence.txt');
    writeFileSync(path, 'evidence', 'utf8');
    const data = readFileSync(path);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['CASE-A'],
      run: baseRun([result({
        status: 'PASS', evidenceLevel: null, command: 'vitest', exitCode: 0,
        executedAt: '2026-09-20T00:00:10.000Z',
        evidence: [{ path: relativePath, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.byteLength }],
        observedResult: 'missing evidence level'
      })])
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toContain('ACCEPTANCE_PASS_INVALID');
  });

  it('rejects a PASS that contradicts its map mode, time window, and frozen sources', () => {
    const fixtureRoot = makeFixtureRoot();
    const path = join(fixtureRoot, 'evidence.txt');
    writeFileSync(path, 'unrelated evidence', 'utf8');
    const data = readFileSync(path);
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['CASE-A'],
      map: { schemaVersion: 1, cases: [{
        caseId: 'CASE-A', mode: 'not_run', requiredEvidenceLevel: 'teacher_professional_review',
        reasonCode: 'FORMAL_CASE_NOT_EXECUTED'
      }] },
      run: baseRun([result({
        status: 'PASS', evidenceLevel: 'engineering_automation', command: null, exitCode: 0,
        executedAt: '2020-01-01T00:00:00.000Z',
        evidence: [{
          path: relative(root, path).replaceAll('\\', '/'),
          sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.byteLength
        }],
        observedResult: 'counterfeit pass'
      })])
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toEqual(expect.arrayContaining([
      'ACCEPTANCE_PASS_INVALID',
      'ACCEPTANCE_RESULT_MAP_MISMATCH',
      'ACCEPTANCE_EXECUTION_TIME_INVALID',
      'ACCEPTANCE_DEFINITION_SOURCE_INVALID'
    ]));
  });

  it('rejects automation evidence borrowed from another source commit or run', () => {
    const fixtureRoot = makeFixtureRoot();
    const reportPath = join(fixtureRoot, 'vitest.json');
    const relativePath = relative(root, reportPath).replaceAll('\\', '/');
    const command = 'node vitest run';
    writeFileSync(reportPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: 'run-20260920-deadbee-01',
      sourceCommit: 'deadbeefdeadbeef',
      repositoryDirty: true,
      startedAt: '2026-09-20T00:00:01.000Z',
      completedAt: '2026-09-20T00:00:10.000Z',
      command,
      exitCode: 0,
      success: true,
      assertions: [{ testFile: 'tests/example.test.ts', fullName: 'suite exact test', status: 'passed' }]
    })}\n`, 'utf8');
    const data = readFileSync(reportPath);
    const loaded = loadAcceptanceDefinitions(root);
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['CASE-A'],
      map: { schemaVersion: 1, cases: [{
        caseId: 'CASE-A', mode: 'automation', requiredEvidenceLevel: 'engineering_automation',
        commandGroup: 'desktop-unit', testFile: 'tests/example.test.ts', testName: 'suite exact test'
      }] },
      run: {
        ...baseRun([result({
          status: 'PASS', evidenceLevel: 'engineering_automation', command, exitCode: 0,
          executedAt: '2026-09-20T00:00:10.000Z',
          evidence: [{ path: relativePath, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.byteLength }],
          observedResult: 'borrowed evidence'
        })]),
        definitionSources: loaded.definitionSources
      }
    });
    expect(validation.errors.map((error: { code: string }) => error.code))
      .toContain('ACCEPTANCE_AUTOMATION_EVIDENCE_INVALID');
  });

  it('rejects automation evidence whose report time runs backwards', () => {
    const fixtureRoot = makeFixtureRoot();
    mkdirSync(join(fixtureRoot, 'acceptance', 'addenda'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'reports', 'acceptance-runs'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'acceptance', 'cases.json'),
      readFileSync(join(root, 'acceptance', 'cases.json'))
    );
    writeFileSync(
      join(fixtureRoot, 'acceptance', 'addenda', 'classroom-delivery.cases.json'),
      readFileSync(join(root, 'acceptance', 'addenda', 'classroom-delivery.cases.json'))
    );
    const evidencePath = 'reports/acceptance-runs/vitest-run-20260920-abcdef0-01.json';
    const reportPath = join(fixtureRoot, ...evidencePath.split('/'));
    const command = 'node vitest run';
    writeFileSync(reportPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: 'run-20260920-abcdef0-01',
      sourceCommit: 'abcdef0123456789',
      repositoryDirty: true,
      startedAt: '2026-09-20T00:00:20.000Z',
      completedAt: '2026-09-20T00:00:10.000Z',
      command,
      exitCode: 0,
      success: true,
      assertions: [{ testFile: 'tests/example.test.ts', fullName: 'suite exact test', status: 'passed' }]
    })}\n`, 'utf8');
    const data = readFileSync(reportPath);
    const loaded = loadAcceptanceDefinitions(fixtureRoot);
    const validation = validateAcceptanceRun({
      root: fixtureRoot,
      definitionIds: ['CASE-A'],
      map: { schemaVersion: 1, cases: [{
        caseId: 'CASE-A', mode: 'automation', requiredEvidenceLevel: 'engineering_automation',
        commandGroup: 'desktop-unit', testFile: 'tests/example.test.ts', testName: 'suite exact test'
      }] },
      run: {
        ...baseRun([result({
          status: 'PASS', evidenceLevel: 'engineering_automation', command, exitCode: 0,
          executedAt: '2026-09-20T00:00:10.000Z',
          evidence: [{
            path: evidencePath,
            sha256: createHash('sha256').update(data).digest('hex'),
            sizeBytes: data.byteLength
          }],
          observedResult: 'impossible time order'
        })]),
        definitionSources: loaded.definitionSources
      }
    });
    expect(validation.errors.map((error: { code: string }) => error.code))
      .toContain('ACCEPTANCE_AUTOMATION_EVIDENCE_INVALID');
  });

  it('promotes only external evidence bound to the current source and fixed candidate bytes', () => {
    const fixtureRoot = makeFixtureRoot();
    seedFrozenDefinitions(fixtureRoot);
    mkdirSync(join(fixtureRoot, 'apps', 'desktop', 'release'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'reports', 'acceptance-runs'), { recursive: true });
    const candidatePath = join(fixtureRoot, 'apps', 'desktop', 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
    writeFileSync(candidatePath, 'candidate-bytes', 'utf8');
    const candidateBytes = readFileSync(candidatePath);
    const candidate = {
      path: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
      sha256: createHash('sha256').update(candidateBytes).digest('hex'),
      sizeBytes: candidateBytes.byteLength
    };
    const externalReport = {
      schemaVersion: 1,
      sourceCommit: 'abcdef0123456789',
      startedAt: '2026-09-20T00:00:05.000Z',
      completedAt: '2026-09-20T00:00:20.000Z',
      candidate,
      externalInputs: [{ id: 'EXT11', status: 'PROVIDED' }],
      cases: [{
        caseId: 'CASE-A', status: 'PASS', evidenceLevel: 'office_wps',
        command: 'WPS Office 12.1.0.28022 UI: open-edit-save', exitCode: 0,
        executedAt: '2026-09-20T00:00:15.000Z', environment: 'Windows 11 / WPS Office 12.1.0.28022',
        artifactHashes: [], observedResult: 'Opened, edited, saved, and reopened the generated PPTX.'
      }]
    };
    const runId = 'run-20260920-abcdef0-98';
    const externalEvidencePath = `reports/acceptance-runs/external-${runId}.json`;
    writeFileSync(join(fixtureRoot, ...externalEvidencePath.split('/')), `${JSON.stringify(externalReport)}\n`, 'utf8');
    const automationEvidencePath = 'reports/acceptance-runs/vitest-placeholder.json';
    writeFileSync(join(fixtureRoot, ...automationEvidencePath.split('/')), '{"success":true}\n', 'utf8');
    const map = { schemaVersion: 1, cases: [{
      caseId: 'CASE-A', mode: 'external', requiredEvidenceLevel: 'office_wps',
      blockerCode: 'BLOCKED_EXTERNAL_OFFICE_WPS_COMPATIBILITY', externalInputIds: ['EXT11']
    }] };
    const externalInputs = { items: [{ id: 'EXT11', status: 'PROVIDED' }] };
    const loaded = loadAcceptanceDefinitions(fixtureRoot);
    const run = buildAcceptanceRun({
      root: fixtureRoot,
      definitions: [{ id: 'CASE-A' }],
      definitionSources: loaded.definitionSources,
      map,
      automationReport: { success: true, exitCode: 0, command: 'node vitest run', assertions: [] },
      sourceCommit: 'abcdef0123456789', repositoryDirty: false, runId,
      startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
      environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
      evidencePath: automationEvidencePath,
      externalReport,
      externalEvidencePath,
      externalInputs
    });
    expect(run.results[0]).toMatchObject({
      caseId: 'CASE-A', status: 'PASS', evidenceLevel: 'office_wps',
      artifactHashes: [candidate], blockerCode: null, externalInputIds: []
    });
    expect(validateAcceptanceRun({ root: fixtureRoot, definitionIds: ['CASE-A'], map, run })).toEqual({ ok: true, errors: [] });

    const borrowed = { ...externalReport, sourceCommit: 'deadbeefdeadbeef' };
    const rejected = validateExternalEvidenceInput({
      root: fixtureRoot, map, externalInputs, sourceCommit: 'abcdef0123456789', report: borrowed
    });
    expect(rejected.errors.map((error: { code: string }) => error.code)).toContain('EXTERNAL_EVIDENCE_SOURCE_MISMATCH');
  });

  it('binds sanitized G12 supplemental evidence without changing frozen case status', () => {
    const fixtureRoot = makeFixtureRoot();
    seedFrozenDefinitions(fixtureRoot);
    mkdirSync(join(fixtureRoot, 'apps', 'desktop', 'release'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'reports', 'acceptance-runs'), { recursive: true });
    const candidatePath = join(fixtureRoot, 'apps', 'desktop', 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
    const candidateBytes = Buffer.from('g12-candidate');
    writeFileSync(candidatePath, candidateBytes);
    const sourceCommit = 'abcdef0123456789';
    const runId = 'run-20260920-abcdef0-97';
    const g12EvidencePath = `reports/acceptance-runs/g12-${runId}.json`;
    const g12Report = {
      schemaVersion: 1,
      sourceCommit,
      startedAt: '2026-09-20T00:00:05.000Z',
      completedAt: '2026-09-20T00:00:20.000Z',
      candidate: {
        path: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        sha256: createHash('sha256').update(candidateBytes).digest('hex'),
        sizeBytes: candidateBytes.byteLength
      },
      environment: { os: 'win32', release: 'test', arch: 'x64', electron: '44.4.3' },
      syntheticDataOnly: true,
      frozenAcceptanceCasesUpdated: false,
      observations: {
        artifactCount: 5, reviewDisposition: 'ready_for_teacher', presentationOpened: true,
        taskVisible: true, answerVisible: true, changedFileCount: 5, restartStatus: 'EXPORTED',
        revisionAdvanced: true, bundleAdvanced: true, sqliteIntegrity: 'ok'
      },
      passed: true
    };
    writeFileSync(join(fixtureRoot, ...g12EvidencePath.split('/')), `${JSON.stringify(g12Report)}\n`, 'utf8');
    const automationEvidencePath = 'reports/acceptance-runs/vitest-placeholder.json';
    writeFileSync(join(fixtureRoot, ...automationEvidencePath.split('/')), '{"success":true}\n', 'utf8');
    const map = { schemaVersion: 1, cases: [{
      caseId: 'CASE-A', mode: 'not_run', requiredEvidenceLevel: 'engineering_automation',
      reasonCode: 'FORMAL_CASE_NOT_EXECUTED'
    }] };
    const loaded = loadAcceptanceDefinitions(fixtureRoot);
    const run = buildAcceptanceRun({
      root: fixtureRoot,
      definitions: [{ id: 'CASE-A' }],
      definitionSources: loaded.definitionSources,
      map,
      automationReport: { success: true, exitCode: 0, command: 'node vitest run', assertions: [] },
      sourceCommit,
      repositoryDirty: false,
      runId,
      startedAt: '2026-09-20T00:00:00.000Z',
      completedAt: '2026-09-20T00:01:00.000Z',
      environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
      evidencePath: automationEvidencePath,
      supplementalEvidencePaths: [g12EvidencePath]
    });
    expect(run.results[0].status).toBe('NOT_RUN');
    expect(run.supplementalEvidence).toHaveLength(1);
    expect(validateAcceptanceRun({ root: fixtureRoot, definitionIds: ['CASE-A'], map, run })).toEqual({ ok: true, errors: [] });

    writeFileSync(candidatePath, 'candidate-drift', 'utf8');
    const validation = validateAcceptanceRun({ root: fixtureRoot, definitionIds: ['CASE-A'], map, run });
    expect(validation.errors.map((item: { code: string }) => item.code)).toContain('ACCEPTANCE_SUPPLEMENTAL_EVIDENCE_INVALID');
  });

  it('rejects external evidence containing an API key instead of publishing it into the ledger', () => {
    const fixtureRoot = makeFixtureRoot();
    mkdirSync(join(fixtureRoot, 'apps', 'desktop', 'release'), { recursive: true });
    const candidatePath = join(fixtureRoot, 'apps', 'desktop', 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
    writeFileSync(candidatePath, 'candidate-bytes', 'utf8');
    const candidateBytes = readFileSync(candidatePath);
    const report = {
      schemaVersion: 1,
      sourceCommit: 'abcdef0123456789',
      startedAt: '2026-09-20T00:00:05.000Z',
      completedAt: '2026-09-20T00:00:20.000Z',
      candidate: {
        path: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        sha256: createHash('sha256').update(candidateBytes).digest('hex'),
        sizeBytes: candidateBytes.byteLength
      },
      externalInputs: [{ id: 'EXT03', status: 'PROVIDED' }],
      cases: [{
        caseId: 'CASE-A', status: 'PASS', evidenceLevel: 'live_api_authorized', command: 'live probe', exitCode: 0,
        executedAt: '2026-09-20T00:00:15.000Z', environment: 'Windows 11 / DeepSeek', artifactHashes: [],
        observedResult: 'Authorization: Bearer sk-this-must-never-be-published'
      }]
    };
    const validation = validateExternalEvidenceInput({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789',
      report,
      externalInputs: { items: [{ id: 'EXT03', status: 'PROVIDED' }] },
      map: { schemaVersion: 1, cases: [{
        caseId: 'CASE-A', mode: 'external', requiredEvidenceLevel: 'live_api_authorized',
        blockerCode: 'BLOCKED_EXTERNAL_LIVE_API_AND_BUDGET', externalInputIds: ['EXT03']
      }] }
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toContain('EXTERNAL_EVIDENCE_SECRET_REJECTED');
  });

  it('rejects a machine-local absolute path embedded in external observations', () => {
    const fixtureRoot = makeFixtureRoot();
    mkdirSync(join(fixtureRoot, 'apps', 'desktop', 'release'), { recursive: true });
    const candidatePath = join(fixtureRoot, 'apps', 'desktop', 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
    writeFileSync(candidatePath, 'candidate-bytes', 'utf8');
    const candidateBytes = readFileSync(candidatePath);
    const report = {
      schemaVersion: 1,
      sourceCommit: 'abcdef0123456789',
      startedAt: '2026-09-20T00:00:05.000Z',
      completedAt: '2026-09-20T00:00:20.000Z',
      candidate: {
        path: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        sha256: createHash('sha256').update(candidateBytes).digest('hex'),
        sizeBytes: candidateBytes.byteLength
      },
      externalInputs: [{ id: 'EXT11', status: 'PROVIDED' }],
      cases: [{
        caseId: 'CASE-A', status: 'PASS', evidenceLevel: 'office_wps', command: 'WPS UI', exitCode: 0,
        executedAt: '2026-09-20T00:00:15.000Z', environment: 'Windows 11 / WPS', artifactHashes: [],
        observedResult: 'Opened C:\\Users\\teacher\\private\\lesson.pptx successfully.'
      }]
    };
    const validation = validateExternalEvidenceInput({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789',
      report,
      externalInputs: { items: [{ id: 'EXT11', status: 'PROVIDED' }] },
      map: { schemaVersion: 1, cases: [{
        caseId: 'CASE-A', mode: 'external', requiredEvidenceLevel: 'office_wps',
        blockerCode: 'BLOCKED_EXTERNAL_OFFICE_WPS_COMPATIBILITY', externalInputIds: ['EXT11']
      }] }
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toContain('EXTERNAL_EVIDENCE_LOCAL_PATH_REJECTED');
  });

  it('rejects PASS without zero exit and evidence, BLOCKED without external IDs, and NOT_RUN with a command', () => {
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['PASS-A', 'BLOCK-A', 'WAIT-A'],
      run: baseRun([
        result({ caseId: 'PASS-A', status: 'PASS', evidenceLevel: 'engineering_automation', command: 'vitest', exitCode: 1, executedAt: '2026-09-20T00:00:10.000Z', observedResult: 'bad pass' }),
        result({ caseId: 'BLOCK-A', status: 'BLOCKED', blockerCode: 'BLOCKED_EXTERNAL_WINDOWS', observedResult: 'missing ids' }),
        result({ caseId: 'WAIT-A', command: 'vitest' })
      ])
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining(['ACCEPTANCE_PASS_INVALID', 'ACCEPTANCE_BLOCKER_INVALID', 'ACCEPTANCE_NOT_RUN_INVALID'])
    );
  });

  it('rejects traversal and absolute evidence paths', () => {
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['CASE-A'],
      run: baseRun([result({
        status: 'FAIL',
        evidenceLevel: 'engineering_automation',
        command: 'vitest',
        exitCode: 1,
        executedAt: '2026-09-20T00:00:10.000Z',
        evidence: [
          { path: '../outside.log', sha256: '0'.repeat(64), sizeBytes: 1 },
          { path: 'C:/outside.log', sha256: '0'.repeat(64), sizeBytes: 1 },
          { path: 'reports/evidence.txt:secret', sha256: '0'.repeat(64), sizeBytes: 1 }
        ],
        observedResult: 'unsafe evidence'
      })])
    });
    expect(validation.errors.filter((error: { code: string }) => error.code === 'EVIDENCE_PATH_REJECTED')).toHaveLength(3);
  });

  it('re-reads allowed evidence and rejects a wrong SHA-256', () => {
    const fixtureRoot = makeFixtureRoot();
    const path = join(fixtureRoot, 'evidence.txt');
    writeFileSync(path, 'real evidence', 'utf8');
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const validation = validateAcceptanceRun({
      root,
      definitionIds: ['CASE-A'],
      run: baseRun([result({
        status: 'FAIL', evidenceLevel: 'engineering_automation', command: 'vitest', exitCode: 1,
        executedAt: '2026-09-20T00:00:10.000Z',
        evidence: [{ path: relativePath, sha256: '0'.repeat(64), sizeBytes: readFileSync(path).byteLength }],
        observedResult: 'hash mismatch'
      })])
    });
    expect(validation.errors.map((error: { code: string }) => error.code)).toContain('EVIDENCE_HASH_MISMATCH');
  });

  it('rejects an allowed-looking symlink that escapes the repository', () => {
    const fixtureRoot = makeFixtureRoot();
    const outside = join(tmpdir(), `g11-outside-${process.pid}-${Date.now()}`);
    const outsideFile = join(outside, 'evidence.txt');
    const link = join(fixtureRoot, 'escape');
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideFile, 'outside', 'utf8');
    try {
      symlinkSync(outside, link, 'junction');
      const relativePath = relative(root, join(link, 'evidence.txt')).replaceAll('\\', '/');
      const sha256 = createHash('sha256').update(readFileSync(outsideFile)).digest('hex');
      const validation = validateAcceptanceRun({
        root,
        definitionIds: ['CASE-A'],
        run: baseRun([result({
          status: 'FAIL', evidenceLevel: 'engineering_automation', command: 'vitest', exitCode: 1,
          executedAt: '2026-09-20T00:00:10.000Z',
          evidence: [{ path: relativePath, sha256, sizeBytes: readFileSync(outsideFile).byteLength }],
          observedResult: 'symlink escape'
        })])
      });
      expect(validation.errors.map((error: { code: string }) => error.code)).toContain('EVIDENCE_SYMLINK_ESCAPE');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('records a missing fixed installer without borrowing a historical hash', () => {
    const fixtureRoot = makeFixtureRoot();
    const inventory = inspectCandidateArtifact({ root: fixtureRoot, sourceCommit: 'abcdef0123456789' });
    expect(inventory.sha256).toBeNull();
    expect(inventory.sizeBytes).toBeNull();
    expect(inventory.artifactClass).toBe('NONE');
    expect(inventory.buildCommand).toBeNull();
    expect(inventory.buildEnvironment).toBeNull();
  });

  it('loads build provenance only when it matches the current commit and candidate bytes', () => {
    const fixtureRoot = makeFixtureRoot();
    const releaseRoot = join(fixtureRoot, 'apps', 'desktop', 'release');
    const acceptanceRoot = join(releaseRoot, 'acceptance');
    const candidatePath = join(releaseRoot, 'YuwenDesk-Setup-0.1.0-x64.exe');
    mkdirSync(acceptanceRoot, { recursive: true });
    writeFileSync(candidatePath, 'candidate bytes', 'utf8');
    const candidate = readFileSync(candidatePath);
    writeFileSync(join(acceptanceRoot, 'candidate-build-provenance.json'), `${JSON.stringify({
      schemaVersion: 1,
      sourceCommit: 'abcdef0123456789',
      builtAt: '2026-09-21T00:00:00.000Z',
      candidatePath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
      candidateSha256: createHash('sha256').update(candidate).digest('hex'),
      candidateSizeBytes: candidate.byteLength,
      buildCommand: 'npm run build:candidate',
      buildEnvironment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' }
    })}\n`, 'utf8');

    const provenance = loadCandidateBuildProvenance({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789'
    });
    const inventory = inspectCandidateArtifact({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789',
      checkedAt: provenance.builtAt,
      buildCommand: provenance.buildCommand,
      buildEnvironment: provenance.buildEnvironment
    });
    expect(inventory.sha256).toBe(provenance.candidateSha256);
    expect(inventory.sizeBytes).toBe(provenance.candidateSizeBytes);
  });

  it('rejects stale build provenance after candidate bytes change', () => {
    const fixtureRoot = makeFixtureRoot();
    const releaseRoot = join(fixtureRoot, 'apps', 'desktop', 'release');
    const acceptanceRoot = join(releaseRoot, 'acceptance');
    mkdirSync(acceptanceRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'YuwenDesk-Setup-0.1.0-x64.exe'), 'changed candidate', 'utf8');
    writeFileSync(join(acceptanceRoot, 'candidate-build-provenance.json'), `${JSON.stringify({
      schemaVersion: 1,
      sourceCommit: 'abcdef0123456789',
      builtAt: '2026-09-21T00:00:00.000Z',
      candidatePath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
      candidateSha256: '0'.repeat(64),
      candidateSizeBytes: 1,
      buildCommand: 'npm run build:candidate',
      buildEnvironment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' }
    })}\n`, 'utf8');

    expect(() => loadCandidateBuildProvenance({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789'
    })).toThrow(/CANDIDATE_BUILD_PROVENANCE_MISMATCH/);
  });

  it('rejects a fixed candidate path that resolves outside the repository', () => {
    const fixtureRoot = makeFixtureRoot();
    const outside = join(tmpdir(), `g11-candidate-${process.pid}-${Date.now()}`);
    mkdirSync(join(fixtureRoot, 'apps', 'desktop'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'YuwenDesk-Setup-0.1.0-x64.exe'), 'not a candidate', 'utf8');
    try {
      symlinkSync(outside, join(fixtureRoot, 'apps', 'desktop', 'release'), 'junction');
      expect(() => inspectCandidateArtifact({ root: fixtureRoot, sourceCommit: 'abcdef0123456789' }))
        .toThrow(/CANDIDATE_SYMLINK_ESCAPE/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a release junction redirected to another directory inside the repository', () => {
    const fixtureRoot = makeFixtureRoot();
    const redirected = join(fixtureRoot, 'other-artifacts');
    mkdirSync(join(fixtureRoot, 'apps', 'desktop'), { recursive: true });
    mkdirSync(redirected, { recursive: true });
    writeFileSync(join(redirected, 'YuwenDesk-Setup-0.1.0-x64.exe'), 'not a release build', 'utf8');
    symlinkSync(redirected, join(fixtureRoot, 'apps', 'desktop', 'release'), 'junction');
    expect(() => inspectCandidateArtifact({
      root: fixtureRoot,
      sourceCommit: 'abcdef0123456789',
      buildCommand: 'npm run build:win',
      buildEnvironment: { os: 'win32', release: 'test', arch: 'x64', node: 'v22.14.0', npm: '10.9.7' }
    })).toThrow(/CANDIDATE_SYMLINK_ESCAPE/);
  });

  it('uses no-clobber publication for append-only records', () => {
    const fixtureRoot = makeFixtureRoot();
    const targetPath = join(fixtureRoot, 'append-only.json');
    writeJsonAtomic({ targetPath, value: { sequence: 1 }, validate: () => true, noClobber: true });
    expect(() => writeJsonAtomic({
      targetPath, value: { sequence: 2 }, validate: () => true, noClobber: true
    })).toThrow();
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({ sequence: 1 });
  });

  it('never removes a partial file owned by another concurrent writer', () => {
    const fixtureRoot = makeFixtureRoot();
    const targetPath = join(fixtureRoot, 'concurrent.json');
    writeFileSync(targetPath, '{"existing":true}\n', 'utf8');
    writeFileSync(`${targetPath}.partial`, 'other-writer-owned', 'utf8');
    expect(() => writeJsonAtomic({
      targetPath, value: { sequence: 1 }, validate: () => true, noClobber: true
    })).toThrow();
    expect(readFileSync(`${targetPath}.partial`, 'utf8')).toBe('other-writer-owned');
  });

  it('restores every prior target when an atomic JSON set publication fails', () => {
    const fixtureRoot = makeFixtureRoot();
    const first = join(fixtureRoot, 'candidate.json');
    const second = join(fixtureRoot, 'release-input.json');
    writeFileSync(first, '{"version":"old-candidate"}\n', 'utf8');
    writeFileSync(second, '{"version":"old-input"}\n', 'utf8');
    expect(() => writeJsonSetAtomic({
      transactionPath: join(fixtureRoot, '.transaction.json'),
      entries: [
        { targetPath: first, value: { version: 'new-candidate' }, validate: () => true },
        { targetPath: second, value: { version: 'new-input' }, validate: () => true }
      ],
      beforePublish: (index: number) => { if (index === 1) throw new Error('injected'); }
    })).toThrow(/injected/);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ version: 'old-candidate' });
    expect(JSON.parse(readFileSync(second, 'utf8'))).toEqual({ version: 'old-input' });
  });

  it('recovers the prior complete JSON set after an interrupted publication', () => {
    const fixtureRoot = makeFixtureRoot();
    const transactionPath = join(fixtureRoot, '.transaction.json');
    const first = join(fixtureRoot, 'candidate.json');
    const second = join(fixtureRoot, 'release-input.json');
    writeFileSync(first, '{"version":"old-candidate"}\n', 'utf8');
    writeFileSync(second, '{"version":"old-input"}\n', 'utf8');
    expect(() => writeJsonSetAtomic({
      transactionPath,
      recoverOnError: false,
      entries: [
        { targetPath: first, value: { version: 'new-candidate' }, validate: () => true },
        { targetPath: second, value: { version: 'new-input' }, validate: () => true }
      ],
      beforePublish: (index: number) => { if (index === 1) throw new Error('simulated-crash'); }
    })).toThrow(/simulated-crash/);
    expect(() => readFileSync(transactionPath, 'utf8')).not.toThrow();
    recoverJsonSetAtomic({ transactionPath });
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ version: 'old-candidate' });
    expect(JSON.parse(readFileSync(second, 'utf8'))).toEqual({ version: 'old-input' });
  });
});
