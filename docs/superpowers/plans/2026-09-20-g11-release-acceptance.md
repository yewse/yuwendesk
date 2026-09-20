# G11 Release Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed G11 release evidence pipeline that enumerates all 170 acceptance cases, aggregates requirements and blockers, produces an SBOM/hash/signature record, and publishes an honest Chinese final-status package without claiming a formal release.

**Architecture:** Keep acceptance definitions immutable and write append-only run records. Pure ESM libraries validate case records, aggregate four independent status dimensions, verify supply-chain artifacts, and decide the release disposition; thin root scripts read only fixed repository paths and atomically publish reports. `release:evidence` succeeds when it truthfully produces a structurally valid blocked report, while `release:verify` exits zero only for `RELEASE_READY`.

**Tech Stack:** Node.js ESM, TypeScript/Vitest, JSON Schema contracts, npm workspaces, npm built-in CycloneDX SBOM generation, SHA-256, Windows Authenticode inspection through a fixed PowerShell helper.

**Spec:** `docs/superpowers/specs/2026-09-20-g11-release-acceptance-design.md`

## Global Constraints

- `acceptance/cases.json` and `acceptance/addenda/classroom-delivery.cases.json` remain immutable definitions with every definition status `NOT_RUN`; execution results live only under `reports/acceptance-runs/`.
- The definition union is exactly 170 cases: 130 frozen base cases plus 40 CR-001 cases. Every full G11 run contains every ID exactly once.
- No PASS may be inferred from prose, file existence, contract parsing, or a broad suite result without an exact mapped test name and matching evidence level.
- Statuses are closed: case `PASS | FAIL | BLOCKED | NOT_RUN`; release `RELEASE_READY | CONTROLLED_TRIAL | UNSIGNED_TEST_BUILD | BLOCKED`.
- Formal artifacts require the `ENV_LOCK.json` toolchain Node 22.14.0 / npm 10.9.7. A different local version is recorded as engineering evidence and blocks formal release.
- Do not read or generate production private keys, upload artifacts, publish a release, disable Windows protection, use real student material, or call a paid API.
- Missing Win11, Office/WPS, signing, real API, privacy authorization, or teacher review is recorded as `BLOCKED_EXTERNAL`; it never becomes a simulated PASS.
- Add explicit non-secret external-input records `EXT10` for student-data processing/per-dispatch outbound authorization and `EXT11` for Office/WPS compatibility environments; blocker references may not use undeclared IDs.
- Evidence paths are repository-relative, symlink-safe, hash-verified, and limited to the allowlisted roots from the spec.
- All report writes use same-directory `.partial` files, read-back validation, and atomic rename. A failed run preserves the previous complete report.
- Each task starts RED, runs focused tests, then the full repository gates, updates `PROGRESS.md` and `HANDOFF.md`, and ends in one small commit.

## File Structure

- `contracts/AcceptanceRun.schema.json`: closed contract for one full acceptance run and every per-case result.
- `contracts/G11ReleaseEvidence.schema.json`: closed aggregate contract for requirements, cases, deliverables, external inputs, supply-chain status, and disposition.
- `planning/g11-acceptance-map.json`: explicit 170-entry map from every case to exact automation, external blocker, or not-run reason.
- `scripts/lib/g11-acceptance.mjs`: pure definition/map/run/candidate validation and hashing.
- `scripts/run-g11-acceptance.mjs`: fixed-path runner that executes the mapped Vitest command group once and atomically writes a full run.
- `scripts/lib/g11-release-evidence.mjs`: pure evidence aggregation and disposition rules.
- `scripts/generate-g11-release-evidence.mjs`: fixed-path aggregate report publisher.
- `scripts/lib/g11-supply-chain.mjs`: SBOM, lock coverage, checksum manifest, and signature-status validation.
- `scripts/generate-g11-supply-chain.mjs`: invokes npm SBOM and the fixed Authenticode helper, then publishes supply-chain reports.
- `scripts/inspect-g11-authenticode.ps1`: fixed helper that inspects one literal candidate path and emits a closed JSON result.
- `scripts/lib/g11-release-verify.mjs`: final consistency checks and exit-code decision.
- `scripts/release-verify.mjs`: fixed-path formal release gate.
- `apps/desktop/tests/g11-acceptance-run.test.ts`: T01 contract, mapping, evidence, and candidate tests.
- `apps/desktop/tests/g11-release-evidence.test.ts`: T02 aggregation, priority, and blocker tests.
- `apps/desktop/tests/g11-supply-chain.test.ts`: T03 SBOM, checksum, path, tamper, and signature tests.
- `apps/desktop/tests/g11-final-release.test.ts`: T04 manual and disposition/exit-code tests.
- `reports/release/candidate-artifact.json`: current-candidate inventory; missing artifacts stay explicit.
- `reports/release/release-evidence.json`: current machine-readable G11 aggregate.
- `reports/release/defect-audit.json`: explicit defect-triage state; an empty list with `status:NOT_RUN` cannot prove P0/P1 equals zero.
- `reports/release/yuwendesk.cdx.json`: npm-generated CycloneDX SBOM with environment record beside it.
- `reports/release/signing-status.json`: Authenticode outcome or exact NOT_RUN blocker.
- `reports/release/SHA256SUMS.txt`: canonical sorted manifest that excludes itself.
- `reports/release/KNOWN_LIMITATIONS.md`: user-facing limitations rendered from aggregate gaps.
- `reports/release/FINAL_STATUS.md`: Chinese final status bound to commit, candidate, evidence, and disposition.
- `reports/G11_EVIDENCE.md`: developer-facing commands, exits, environment, fixtures, hashes, and blocked gates.
- `docs/TEACHER_QUICK_GUIDE.md`: real UI-aligned Chinese guide without development commands.
- `package.json`: `acceptance:run`, `release:evidence`, `release:sbom`, and `release:verify` scripts.
- `PROGRESS.md`, `HANDOFF.md`: one update per task.

---

### Task 1: G11-T01 — Full Acceptance Ledger and Candidate Inventory

**Files:**
- Create: `contracts/AcceptanceRun.schema.json`
- Create: `planning/g11-acceptance-map.json`
- Create: `scripts/lib/g11-acceptance.mjs`
- Create: `scripts/run-g11-acceptance.mjs`
- Create: `apps/desktop/tests/g11-acceptance-run.test.ts`
- Create: `reports/release/candidate-artifact.json`
- Create: `reports/release/release-input.json`
- Generate: `reports/acceptance-runs/run-${YYYYMMDD}-${sourceCommit.slice(0, 7)}-01.json`
- Modify: `planning/EXTERNAL_INPUTS.json`
- Modify: `reports/acceptance-runs/README.md`
- Modify: `scripts/verify-contracts.mjs`
- Modify: `package.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `acceptance/cases.json`, `acceptance/addenda/classroom-delivery.cases.json`, current Git HEAD/state, the Vitest JSON reporter output, and the fixed expected installer path `apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe`.
- Produces: `loadAcceptanceDefinitions(root)`, `validateAcceptanceMap(input)`, `validateAcceptanceRun(input)`, `buildAcceptanceRun(input)`, `inspectCandidateArtifact(input)`, plus one explicit 170-case map and one append-only run file.

- [ ] **Step 1: Write RED tests for immutable definitions and exact map coverage**

Create `apps/desktop/tests/g11-acceptance-run.test.ts` with repository checks and a minimal pure fixture:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error pure root ESM module
import { loadAcceptanceDefinitions, validateAcceptanceMap } from '../../../scripts/lib/g11-acceptance.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('G11-T01 acceptance definition and map boundary', () => {
  it('loads 130 frozen plus 40 addendum cases while definitions stay NOT_RUN', () => {
    const loaded = loadAcceptanceDefinitions(root);
    expect(loaded.definitions).toHaveLength(170);
    expect(new Set(loaded.definitions.map((item: { id: string }) => item.id)).size).toBe(170);
    expect(loaded.definitions.every((item: { status: string }) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('requires every definition exactly once and rejects unknown cases', () => {
    const result = validateAcceptanceMap({
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
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining(['ACCEPTANCE_MAP_DUPLICATE', 'ACCEPTANCE_MAP_MISSING', 'ACCEPTANCE_MAP_UNKNOWN'])
    );
  });
});
```

- [ ] **Step 2: Run the definition/map tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-acceptance-run.test.ts
```

Expected: FAIL because `scripts/lib/g11-acceptance.mjs` and `planning/g11-acceptance-map.json` do not exist.

- [ ] **Step 3: Add RED tests for case-state invariants, paths, hashes, and candidate absence**

Extend the test file with exact invalid states:

```ts
// @ts-expect-error pure root ESM module
import { validateAcceptanceRun, inspectCandidateArtifact } from '../../../scripts/lib/g11-acceptance.mjs';

it('rejects PASS without zero exit and evidence, BLOCKED without external IDs, and NOT_RUN with a command', () => {
  const result = validateAcceptanceRun({
    root,
    definitionIds: ['PASS-A', 'BLOCK-A', 'WAIT-A'],
    run: {
      schemaVersion: 1,
      runId: 'run-20260920-abcdef0-01',
      sourceCommit: 'abcdef0123456789',
      repositoryDirty: true,
      startedAt: '2026-09-20T00:00:00.000Z',
      completedAt: '2026-09-20T00:01:00.000Z',
      environment: { os: 'win32', release: 'test', arch: 'x64', node: 'v24.15.0', npm: '11.12.1' },
      definitionSources: [],
      results: [
        { caseId: 'PASS-A', status: 'PASS', evidenceLevel: 'engineering_automation', command: 'vitest', exitCode: 1, executedAt: '2026-09-20T00:00:10.000Z', environment: 'fixture', evidence: [], artifactHashes: [], blockerCode: null, externalInputIds: [], observedResult: 'bad pass' },
        { caseId: 'BLOCK-A', status: 'BLOCKED', evidenceLevel: null, command: null, exitCode: null, executedAt: null, environment: 'fixture', evidence: [], artifactHashes: [], blockerCode: 'BLOCKED_EXTERNAL_WINDOWS', externalInputIds: [], observedResult: 'missing ids' },
        { caseId: 'WAIT-A', status: 'NOT_RUN', evidenceLevel: null, command: 'vitest', exitCode: null, executedAt: null, environment: 'fixture', evidence: [], artifactHashes: [], blockerCode: null, externalInputIds: [], observedResult: 'not run' }
      ]
    }
  });
  expect(result.ok).toBe(false);
  expect(result.errors.map((error: { code: string }) => error.code)).toEqual(
    expect.arrayContaining(['ACCEPTANCE_PASS_INVALID', 'ACCEPTANCE_BLOCKER_INVALID', 'ACCEPTANCE_NOT_RUN_INVALID'])
  );
});

it('records a missing fixed installer without borrowing a historical hash', () => {
  const result = inspectCandidateArtifact({ root, sourceCommit: 'abcdef0123456789' });
  if (!result.artifactPresent) {
    expect(result.sha256).toBeNull();
    expect(result.sizeBytes).toBeNull();
    expect(result.artifactClass).toBe('NONE');
  }
});
```

Add path cases for `../outside.log`, an absolute Windows path, an allowed evidence file with the wrong SHA-256, and a symlink resolving outside the repository. Expected closed codes: `EVIDENCE_PATH_REJECTED`, `EVIDENCE_HASH_MISMATCH`, and `EVIDENCE_SYMLINK_ESCAPE`.

- [ ] **Step 4: Implement the closed schema and pure acceptance library**

Create `contracts/AcceptanceRun.schema.json` with `additionalProperties:false` at every object level and the exact fields from the design spec. Start `scripts/lib/g11-acceptance.mjs` with the closed constants and exact case-state predicate:

```js
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

export function validateCaseState(result) {
  if (result.status === 'PASS') {
    return result.exitCode === 0 && result.executedAt !== null && result.evidence.length > 0 &&
      result.blockerCode === null && result.externalInputIds.length === 0;
  }
  if (result.status === 'BLOCKED') {
    return result.command === null && result.exitCode === null && result.executedAt === null &&
      typeof result.blockerCode === 'string' && result.externalInputIds.length > 0;
  }
  if (result.status === 'NOT_RUN') {
    return result.command === null && result.exitCode === null && result.executedAt === null &&
      result.blockerCode === null && result.externalInputIds.length === 0;
  }
  return result.status === 'FAIL' && result.executedAt !== null && result.evidence.length > 0;
}
```

Export `loadAcceptanceDefinitions(root)`, `validateAcceptanceMap({ definitionIds, map })`, `validateAcceptanceRun({ root, definitionIds, run })`, `buildAcceptanceRun({ root, definitions, map, automationReport, sourceCommit, repositoryDirty, startedAt, completedAt, environment })`, `inspectCandidateArtifact({ root, sourceCommit })`, and `writeJsonAtomic({ targetPath, value, validate })`. These functions return `{ ok, errors }` with closed codes, use `realpathSync` plus root containment for existing evidence, hash every evidence file with SHA-256, and require the result ID set to equal the definition ID set.

- [ ] **Step 5: Create the explicit 170-entry acceptance map**

Create `planning/g11-acceptance-map.json` with `schemaVersion:1` and exactly one entry per definition. Each entry must use one of these closed shapes:

```json
{
  "caseId": "SEC-004",
  "mode": "automation",
  "requiredEvidenceLevel": "engineering_automation",
  "commandGroup": "desktop-unit",
  "testFile": "tests/g09-threat-boundaries.test.ts",
  "testName": "accepts IPC only from the expected top frame and denies in-window navigation"
}
```

```json
{
  "caseId": "INS-007",
  "mode": "external",
  "requiredEvidenceLevel": "clean_windows_standard_user",
  "blockerCode": "BLOCKED_EXTERNAL_WINDOWS_ACCESSIBILITY",
  "externalInputIds": ["EXT02"]
}
```

```json
{
  "caseId": "BIZ-R001",
  "mode": "not_run",
  "requiredEvidenceLevel": "teacher_professional_review",
  "reasonCode": "FORMAL_CASE_NOT_EXECUTED"
}
```

Only promote an entry to `automation` when `testFile` and the full Vitest test name exist exactly. Cases requiring a higher environment stay `external` or `not_run` even when a lower-level unit test exists. Run `validateAcceptanceMap` against the repository definitions before continuing.

Before writing blocker entries, append these closed records to `planning/EXTERNAL_INPUTS.json` with `secret_value:null` and `status:"NOT_PROVIDED"`:

```json
{
  "id": "EXT10",
  "description": "真实学生资料处理授权与每次必要字段外发许可",
  "status": "NOT_PROVIDED",
  "secret_value": null,
  "owner_action": "由资料责任方明确本地处理范围；每次云端外发前确认必要字段，禁止把真实正文贴入仓库或提示词",
  "blocks": ["G08真实模型辅助归因", "G11隐私验收"]
}
```

```json
{
  "id": "EXT11",
  "description": "实际支持版本的 Microsoft Office 与 WPS 兼容性环境",
  "status": "NOT_PROVIDED",
  "secret_value": null,
  "owner_action": "提供受控测试环境，分别执行打开、编辑、保存、分页和放映验证",
  "blocks": ["G06真实成品保真", "G10正式导出性能", "G11兼容性验收"]
}
```

- [ ] **Step 6: Implement the fixed-path runner and candidate report**

Create `scripts/run-g11-acceptance.mjs`. It must:

1. read the two fixed definition files and the fixed map;
2. run one command group with `spawnSync(process.execPath, [vitestPath, 'run', '--reporter=json', '--outputFile', tempVitestReport])`, never `shell:true`;
3. match automation entries against both exact file and full test name;
4. create BLOCKED/NOT_RUN records without fabricated commands or evidence;
5. write the full run to `reports/acceptance-runs/run-${YYYYMMDD}-${sourceCommit.slice(0, 7)}-01.json` without overwriting an existing different run;
6. atomically write `reports/release/candidate-artifact.json` from `inspectCandidateArtifact`;
7. atomically write `reports/release/release-input.json` with the actual newly written run path and the fixed candidate report path.

Add the root script:

```json
"acceptance:run": "node scripts/run-g11-acceptance.mjs"
```

Extend `scripts/verify-contracts.mjs` to load the repository definitions and map through `loadAcceptanceDefinitions`/`validateAcceptanceMap`; it must fail when the map is not exactly 170 entries or any definition status changes from `NOT_RUN`.

- [ ] **Step 7: Run focused tests and generate the current engineering run**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-acceptance-run.test.ts
npm run acceptance:run
```

Expected: focused tests PASS; the runner exits 0 only when the 170-entry report is structurally complete. Formal cases may remain BLOCKED/NOT_RUN. The current candidate report must not claim an installer if the fixed EXE is absent.

- [ ] **Step 8: Run T01 gates, document truthfully, and commit**

Run:

```powershell
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Update `reports/acceptance-runs/README.md`, `PROGRESS.md`, and `HANDOFF.md` with the exact run ID, counts by PASS/FAIL/BLOCKED/NOT_RUN, source state, environment, and missing-candidate result. Do not describe the full ledger as full acceptance PASS.

Commit:

```powershell
git add contracts/AcceptanceRun.schema.json planning/g11-acceptance-map.json planning/EXTERNAL_INPUTS.json scripts/lib/g11-acceptance.mjs scripts/run-g11-acceptance.mjs scripts/verify-contracts.mjs apps/desktop/tests/g11-acceptance-run.test.ts reports/acceptance-runs reports/release/candidate-artifact.json reports/release/release-input.json package.json PROGRESS.md HANDOFF.md
git commit -m "test(G11-T01): record complete acceptance evidence ledger"
```

---

### Task 2: G11-T02 — Release Evidence Aggregation and Known Gaps

**Files:**
- Create: `contracts/G11ReleaseEvidence.schema.json`
- Create: `scripts/lib/g11-release-evidence.mjs`
- Create: `scripts/generate-g11-release-evidence.mjs`
- Create: `apps/desktop/tests/g11-release-evidence.test.ts`
- Create: `reports/release/release-evidence.json`
- Create: `reports/release/defect-audit.json`
- Create: `reports/release/KNOWN_LIMITATIONS.md`
- Modify: `reports/release/release-input.json`
- Modify: `scripts/verify-contracts.mjs`
- Modify: `package.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `AcceptanceRunV1`, candidate inventory, both requirement traceability files, both acceptance definition files, `planning/EXTERNAL_INPUTS.json`, and fixed deliverable paths.
- Produces: `aggregateReleaseEvidence(input)`, `validateReleaseEvidence(input)`, `decideReleaseDisposition(input)`, and the fixed `G11ReleaseEvidenceV1` report used by Tasks 3–4.

- [ ] **Step 1: Write RED tests for separated dimensions and fail-closed priority**

Create `apps/desktop/tests/g11-release-evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error pure root ESM module
import { decideReleaseDisposition } from '../../../scripts/lib/g11-release-evidence.mjs';

describe('G11-T02 release disposition priority', () => {
  it('blocks a missing candidate or clean-Windows gate even when engineering tests pass', () => {
    expect(decideReleaseDisposition({
      requiredCaseResults: [{ caseId: 'UPD-006', severity: 'P1', status: 'BLOCKED' }],
      artifactPresent: false,
      artifactSigned: false,
      cleanWindowsPassed: false,
      distributionAuthorized: false,
      controlledTrialAuthorized: false,
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
      knownDefects: []
    })).toEqual({ artifactClass: 'UNSIGNED_TEST_BUILD', releaseDisposition: 'UNSIGNED_TEST_BUILD', reasonCode: 'RELEASE_SIGNATURE_MISSING' });
  });
});
```

- [ ] **Step 2: Run the disposition tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-release-evidence.test.ts
```

Expected: FAIL because the aggregation library does not exist.

- [ ] **Step 3: Add RED tests for requirement/case coverage, stale evidence, and blocked report generation**

Add tests that assert:

- 60 base requirements and 24 CR-001 requirements each resolve to at least one known acceptance case;
- all 170 case results appear in the aggregate exactly once;
- a run source commit that differs from the candidate source commit produces `RELEASE_SOURCE_MISMATCH`;
- a missing evidence file or changed hash produces `RELEASE_EVIDENCE_INVALID`;
- external IDs not present in `EXTERNAL_INPUTS.json` produce `RELEASE_EXTERNAL_INPUT_UNKNOWN`;
- an empty defect list with audit status `NOT_RUN` cannot satisfy the known-P0/P1-zero gate;
- a structurally valid BLOCKED aggregate passes `validateReleaseEvidence` while `releaseDisposition` stays `BLOCKED`.

Use two minimal cases and two requirements in pure fixtures, then add one repository integration assertion for exact counts 60/24/170.

- [ ] **Step 4: Implement the closed aggregate contract and pure rules**

Create `contracts/G11ReleaseEvidence.schema.json` with the five exact enums:

```js
export const SOFTWARE_STATUSES = ['PASS', 'PARTIAL', 'BLOCKED', 'FAIL'];
export const RESOURCE_STATUSES = ['VERIFIED', 'PARTIAL', 'BLOCKED', 'NOT_VERIFIED'];
export const TEACHING_STATUSES = ['TEACHER_REVIEWED', 'PARTIAL', 'BLOCKED', 'NOT_REVIEWED'];
export const ARTIFACT_CLASSES = ['NONE', 'UNSIGNED_TEST_BUILD', 'SIGNED_TEST_BUILD', 'SIGNED_RELEASE_CANDIDATE'];
export const RELEASE_DISPOSITIONS = ['RELEASE_READY', 'CONTROLLED_TRIAL', 'UNSIGNED_TEST_BUILD', 'BLOCKED'];
```

Implement the priority rule in `scripts/lib/g11-release-evidence.mjs` exactly as follows, then export `aggregateReleaseEvidence(input)`, `validateReleaseEvidence({ root, evidence })`, and `renderKnownGap(input)` around it:

```js
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
  if (!input.cleanWindowsPassed) {
    return { artifactClass: input.artifactSigned ? 'SIGNED_TEST_BUILD' : 'UNSIGNED_TEST_BUILD', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_WINDOWS_EVIDENCE_REQUIRED' };
  }
  if (!input.artifactSigned) {
    return { artifactClass: 'UNSIGNED_TEST_BUILD', releaseDisposition: 'UNSIGNED_TEST_BUILD', reasonCode: 'RELEASE_SIGNATURE_MISSING' };
  }
  if (input.defectAuditStatus === 'COMPLETE' && input.controlledTrialAuthorized &&
      input.dataBoundaryApproved && input.costBoundaryApproved && !input.distributionAuthorized) {
    return { artifactClass: 'SIGNED_TEST_BUILD', releaseDisposition: 'CONTROLLED_TRIAL', reasonCode: 'RELEASE_CONTROLLED_TRIAL_ONLY' };
  }
  if (input.defectAuditStatus === 'COMPLETE' && input.distributionAuthorized && input.dataBoundaryApproved && input.costBoundaryApproved &&
      input.requiredCaseResults.length === 170 && input.requiredCaseResults.every((item) => item.status === 'PASS')) {
    return { artifactClass: 'SIGNED_RELEASE_CANDIDATE', releaseDisposition: 'RELEASE_READY', reasonCode: 'RELEASE_ALL_GATES_PASS' };
  }
  return { artifactClass: 'SIGNED_TEST_BUILD', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_REQUIRED_GATE_OPEN' };
}
```

Decision order is fixed: P0/P1 FAIL or invalid signature/evidence → BLOCKED; missing artifact or clean Windows → BLOCKED; unsigned otherwise eligible artifact → UNSIGNED_TEST_BUILD; explicitly authorized controlled trial with signed/Windows-tested artifact → CONTROLLED_TRIAL; every required formal gate and distribution authorization → RELEASE_READY.

- [ ] **Step 5: Implement fixed-path generation and atomic publication**

Create `scripts/generate-g11-release-evidence.mjs` that reads the explicit run path already written by T01 in `reports/release/release-input.json`. T01 constructs the closed object from the actual atomic-write result:

```js
const releaseInput = {
  schemaVersion: 1,
  acceptanceRunPath: relative(root, actualRunPath).replaceAll('\\', '/'),
  candidateArtifactPath: 'reports/release/candidate-artifact.json'
};
```

The script rejects absolute paths and any path outside the two fixed report roots, recomputes every referenced hash, builds the aggregate, validates it, atomically publishes `reports/release/release-evidence.json`, and renders the initial `reports/release/KNOWN_LIMITATIONS.md` from the sorted aggregate gaps.

Create `reports/release/defect-audit.json` with the honest initial state:

```json
{
  "schemaVersion": 1,
  "status": "NOT_RUN",
  "assessedCommit": null,
  "executedAt": null,
  "items": [],
  "blockerCode": "RELEASE_DEFECT_AUDIT_REQUIRED"
}
```

The aggregate must keep the release blocked until a future append-only audit bound to the candidate commit has `status:"COMPLETE"`; an empty `items` array alone never means known P0/P1 equals zero. Extend `scripts/verify-contracts.mjs` to validate the aggregate's closed enums, exact 60+24 requirement counts, and exact 170 case references.

Add:

```json
"release:evidence": "node scripts/generate-g11-release-evidence.mjs"
```

- [ ] **Step 6: Run focused tests and generate the current blocked aggregate**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-release-evidence.test.ts
npm run release:evidence
```

Expected: focused tests PASS; generation exits 0 with a valid report whose current `releaseDisposition` is `BLOCKED`, with no percentage-based success claim.

- [ ] **Step 7: Run T02 gates, update evidence docs, and commit**

Run typecheck, lint, `verify:contracts`, desktop build, the complete unit suite, and `git diff --check`. Update `PROGRESS.md` and `HANDOFF.md` with exact dimension statuses and blockers.

Commit:

```powershell
git add contracts/G11ReleaseEvidence.schema.json scripts/lib/g11-release-evidence.mjs scripts/generate-g11-release-evidence.mjs scripts/verify-contracts.mjs apps/desktop/tests/g11-release-evidence.test.ts reports/release/release-input.json reports/release/release-evidence.json reports/release/defect-audit.json reports/release/KNOWN_LIMITATIONS.md package.json PROGRESS.md HANDOFF.md
git commit -m "feat(G11-T02): aggregate release evidence and blockers"
```

---

### Task 3: G11-T03 — CycloneDX SBOM, Checksums, and Signature Boundary

**Files:**
- Create: `scripts/lib/g11-supply-chain.mjs`
- Create: `scripts/generate-g11-supply-chain.mjs`
- Create: `scripts/inspect-g11-authenticode.ps1`
- Create: `apps/desktop/tests/g11-supply-chain.test.ts`
- Generate: `reports/release/yuwendesk.cdx.json`
- Create: `reports/release/sbom-environment.json`
- Create: `reports/release/signing-status.json`
- Generate: `reports/release/SHA256SUMS.txt`
- Modify: `package.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `package-lock.json`, `ENV_LOCK.json`, candidate inventory, acceptance run, release evidence, current teacher guide, and existing release reports.
- Produces: `validateCycloneDxSbom(input)`, `buildChecksumManifest(input)`, `verifyChecksumManifest(input)`, `normalizeAuthenticodeResult(input)`, plus SBOM/environment/signing/checksum artifacts used by Task 4.

- [ ] **Step 1: Write RED tests for SBOM identity and transitive lock coverage**

Create `apps/desktop/tests/g11-supply-chain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error pure root ESM module
import { validateCycloneDxSbom } from '../../../scripts/lib/g11-supply-chain.mjs';

describe('G11-T03 CycloneDX validation', () => {
  it('requires the application root, components, dependency graph, and every locked name/version pair', () => {
    const result = validateCycloneDxSbom({
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { component: { type: 'application', name: 'yuwendesk', version: '0.1.0' } },
        components: [{ name: 'react', version: '18.3.1' }],
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
});
```

- [ ] **Step 2: Run the SBOM test and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-supply-chain.test.ts
```

Expected: FAIL because the supply-chain library does not exist.

- [ ] **Step 3: Add RED tests for canonical checksums and signature distinctions**

Add tests for:

```ts
// @ts-expect-error pure root ESM module
import { buildChecksumManifest, verifyChecksumManifest, normalizeAuthenticodeResult } from '../../../scripts/lib/g11-supply-chain.mjs';

it('sorts forward-slash paths and excludes the checksum file itself', () => {
  const manifest = buildChecksumManifest([
    { path: 'reports/release/z.json', sha256: 'b'.repeat(64) },
    { path: 'reports/release/a.json', sha256: 'a'.repeat(64) }
  ]);
  expect(manifest).toBe(`${'a'.repeat(64)}  reports/release/a.json\n${'b'.repeat(64)}  reports/release/z.json\n`);
});

it('keeps unsigned, invalid, valid, and not-run signature states distinct', () => {
  expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'NotSigned' }).status).toBe('UNSIGNED');
  expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'HashMismatch' }).status).toBe('SIGNED_INVALID');
  expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'Valid', timestampPresent: false }).reasonCode).toBe('RELEASE_TIMESTAMP_REQUIRED');
  expect(normalizeAuthenticodeResult({ platform: 'win32', artifactPresent: true, status: 'Valid', timestampPresent: true }).status).toBe('SIGNED_VALID');
  expect(normalizeAuthenticodeResult({ platform: 'linux', artifactPresent: true, status: null }).status).toBe('NOT_RUN');
});
```

Also reject absolute paths, `..`, backslashes, duplicate normalized names, case aliases, symlink escape, wrong file size/hash, and any attempt to include `reports/release/SHA256SUMS.txt` in itself.

- [ ] **Step 4: Implement supply-chain pure functions**

Create `scripts/lib/g11-supply-chain.mjs`. The checksum and signature-normalization core is:

```js
export function buildChecksumManifest(entries) {
  return [...entries]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join('');
}

export function normalizeAuthenticodeResult(input) {
  if (!input.artifactPresent) return { status: 'NOT_RUN', reasonCode: 'RELEASE_ARTIFACT_MISSING' };
  if (input.platform !== 'win32') return { status: 'NOT_RUN', reasonCode: 'BLOCKED_EXTERNAL_WINDOWS_SIGNATURE_CHECK' };
  if (input.status === 'Valid' && input.timestampPresent === true) return { status: 'SIGNED_VALID', reasonCode: 'SIGNATURE_AND_TIMESTAMP_VALID' };
  if (input.status === 'Valid') return { status: 'SIGNED_INVALID', reasonCode: 'RELEASE_TIMESTAMP_REQUIRED' };
  if (input.status === 'NotSigned') return { status: 'UNSIGNED', reasonCode: 'RELEASE_SIGNATURE_MISSING' };
  return { status: 'SIGNED_INVALID', reasonCode: 'RELEASE_SIGNATURE_INVALID' };
}
```

Also export `lockedComponentsFromPackageLock(lock)`, `validateCycloneDxSbom({ sbom, lockedComponents, expectedRoot })`, `verifyChecksumManifest({ root, manifestText })`, and `writeTextAtomic({ targetPath, text, validate })`. Lock coverage compares every non-root, non-workspace-link `packages` entry that has `name` and `version` against a CycloneDX component name/version pair. Signature output may contain only closed status, fixed reason code, signer subject when valid, timestamp status, checked time, artifact hash, and environment; arbitrary PowerShell messages are discarded.

- [ ] **Step 5: Implement fixed Authenticode inspection**

Create `scripts/inspect-g11-authenticode.ps1`:

```powershell
param([Parameter(Mandatory = $true)][string]$LiteralArtifactPath)
$signature = Get-AuthenticodeSignature -LiteralPath $LiteralArtifactPath
[ordered]@{
  status = [string]$signature.Status
  signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
  timestampPresent = [bool]$signature.TimeStamperCertificate
  timestampSubject = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { $null }
} | ConvertTo-Json -Compress
```

The Node caller supplies only the realpath of the fixed candidate from `candidate-artifact.json`; the script is never exposed through application IPC.

- [ ] **Step 6: Implement SBOM/signature/checksum generation**

Create `scripts/generate-g11-supply-chain.mjs` using `spawnSync` without a shell. Select `npm.cmd` on Windows and `npm` elsewhere, and run:

```text
npm sbom --package-lock-only --sbom-format=cyclonedx --sbom-type=application
```

Parse stdout before writing. Record actual Node/npm and required ENV_LOCK versions in `sbom-environment.json`; version mismatch sets `formalEnvironmentMatch:false` but does not falsify the SBOM. If the candidate is absent, write signing state `NOT_RUN` with reason `RELEASE_ARTIFACT_MISSING`. Build the checksum list from an explicit constant array; do not glob the repository.

The explicit checksum inputs are `package-lock.json`, `ENV_LOCK.json`, the selected acceptance run from `release-input.json`, `candidate-artifact.json`, `release-evidence.json`, `defect-audit.json`, `yuwendesk.cdx.json`, `sbom-environment.json`, `signing-status.json`, `docs/TEACHER_QUICK_GUIDE.md`, and `KNOWN_LIMITATIONS.md`; add the actual installer only when `artifactPresent:true`. T04 extends the same constant list with `FINAL_STATUS.md`. `SHA256SUMS.txt` is never an input to itself.

Add:

```json
"release:sbom": "node scripts/generate-g11-supply-chain.mjs"
```

- [ ] **Step 7: Run focused tests and generate engineering supply-chain artifacts**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-supply-chain.test.ts
npm run release:sbom
```

Expected: tests PASS; SBOM/checksum generation exits 0 if the files are internally valid. Current environment mismatch, missing candidate, or missing signature remains explicit and prevents formal readiness. Then run `npm run release:evidence` followed by `npm run release:sbom` once more so the aggregate sees the new SBOM/signing records and the final checksum manifest covers the unchanged aggregate. The aggregate records the checksum path/status but never embeds the checksum file's own hash.

- [ ] **Step 8: Run T03 gates, update docs, and commit**

Run the full unit suite, typecheck, lint, `verify:contracts`, desktop build, `git diff --check`, and `verifyChecksumManifest` against the generated file. Record SBOM spec version, component count, dependency count, tool versions, package-lock hash, signature state, and checksum-entry count in `PROGRESS.md`/`HANDOFF.md`.

Commit:

```powershell
git add scripts/lib/g11-supply-chain.mjs scripts/generate-g11-supply-chain.mjs scripts/inspect-g11-authenticode.ps1 apps/desktop/tests/g11-supply-chain.test.ts reports/release/yuwendesk.cdx.json reports/release/sbom-environment.json reports/release/signing-status.json reports/release/SHA256SUMS.txt package.json PROGRESS.md HANDOFF.md
git commit -m "build(G11-T03): generate SBOM checksums and signing status"
```

---

### Task 4: G11-T04 — Chinese Manual, Final Status, and Formal Release Gate

**Files:**
- Create: `scripts/lib/g11-release-verify.mjs`
- Create: `scripts/release-verify.mjs`
- Create: `apps/desktop/tests/g11-final-release.test.ts`
- Modify: `reports/release/KNOWN_LIMITATIONS.md`
- Create: `reports/release/FINAL_STATUS.md`
- Create: `reports/G11_EVIDENCE.md`
- Modify: `docs/TEACHER_QUICK_GUIDE.md`
- Modify: `scripts/generate-g11-release-evidence.mjs`
- Modify: `scripts/generate-g11-supply-chain.mjs`
- Modify: `reports/release/release-evidence.json`
- Modify: `reports/release/SHA256SUMS.txt`
- Modify: `package.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: final aggregate evidence, verified checksum manifest, SBOM environment, signing status, candidate inventory, actual renderer workflow names, and known external blockers.
- Produces: `verifyReleaseCandidate(input)`, `exitCodeForDisposition(disposition)`, root `release:verify`, final Chinese documentation, and the complete G11 evidence report.

- [ ] **Step 1: Write RED tests for final gate exit codes and fail-closed inputs**

Create `apps/desktop/tests/g11-final-release.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error pure root ESM module
import { exitCodeForDisposition, verifyReleaseCandidate } from '../../../scripts/lib/g11-release-verify.mjs';

describe('G11-T04 formal release gate', () => {
  it('returns zero only for RELEASE_READY', () => {
    expect(exitCodeForDisposition('RELEASE_READY')).toBe(0);
    expect(exitCodeForDisposition('CONTROLLED_TRIAL')).toBe(2);
    expect(exitCodeForDisposition('UNSIGNED_TEST_BUILD')).toBe(2);
    expect(exitCodeForDisposition('BLOCKED')).toBe(2);
  });

  it('rejects stale checksums, missing final documents, environment mismatch, and non-valid signatures', () => {
    const result = verifyReleaseCandidate({
      releaseDisposition: 'RELEASE_READY',
      checksumStatus: 'MISMATCH',
      requiredDocumentsPresent: false,
      formalEnvironmentMatch: false,
      signatureStatus: 'UNSIGNED',
      cleanWindowsPassed: false,
      distributionAuthorized: false,
      defectAuditStatus: 'NOT_RUN'
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'RELEASE_CHECKSUM_INVALID',
      'RELEASE_DOCUMENT_MISSING',
      'RELEASE_ENVIRONMENT_MISMATCH',
      'RELEASE_SIGNATURE_REQUIRED',
      'RELEASE_WINDOWS_EVIDENCE_REQUIRED',
      'RELEASE_DISTRIBUTION_NOT_AUTHORIZED',
      'RELEASE_DEFECT_AUDIT_REQUIRED'
    ]));
  });
});
```

- [ ] **Step 2: Run final-gate tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-final-release.test.ts
```

Expected: FAIL because the release verification module does not exist.

- [ ] **Step 3: Add RED documentation contract tests**

Read `docs/TEACHER_QUICK_GUIDE.md`, `reports/release/KNOWN_LIMITATIONS.md`, and `reports/release/FINAL_STATUS.md`. Assert that the guide contains these exact topics: 安装与打开、第一次设置、备下一课、三类五文件、课堂展示、只改一处、课后观察、模型辅助归因、隐私与外发、备份与换电脑、离线更新、诊断、卸载与数据、已知限制. Assert it does not contain `npm run`, `node scripts/`, `PowerShell`, “关闭 SmartScreen”, “全部通过”, or “保证提分”. Assert final status contains the current disposition and the same blocker codes as `release-evidence.json`.

- [ ] **Step 4: Implement pure final verification and fixed CLI**

Create `scripts/lib/g11-release-verify.mjs`:

```js
export function exitCodeForDisposition(disposition) {
  return disposition === 'RELEASE_READY' ? 0 : 2;
}

export function verifyReleaseCandidate(input) {
  const errors = [];
  if (input.checksumStatus !== 'VALID') errors.push('RELEASE_CHECKSUM_INVALID');
  if (!input.requiredDocumentsPresent) errors.push('RELEASE_DOCUMENT_MISSING');
  if (!input.formalEnvironmentMatch) errors.push('RELEASE_ENVIRONMENT_MISMATCH');
  if (input.signatureStatus !== 'SIGNED_VALID') errors.push('RELEASE_SIGNATURE_REQUIRED');
  if (!input.cleanWindowsPassed) errors.push('RELEASE_WINDOWS_EVIDENCE_REQUIRED');
  if (!input.distributionAuthorized) errors.push('RELEASE_DISTRIBUTION_NOT_AUTHORIZED');
  if (input.defectAuditStatus !== 'COMPLETE') errors.push('RELEASE_DEFECT_AUDIT_REQUIRED');
  return { ok: errors.length === 0 && input.releaseDisposition === 'RELEASE_READY', errors };
}
```

Export `renderFinalStatus(input)` and `renderKnownLimitations(input)` as deterministic Markdown renderers sorted by blocker code and affected scope. Create `scripts/release-verify.mjs` that reads only the fixed release report paths, recomputes every checksum, cross-checks aggregate/signature/SBOM/environment/final docs, prints the disposition and closed errors, and sets `process.exitCode` from `exitCodeForDisposition` only after structural verification. Invalid structure or tampering exits 1; a truthful non-ready candidate exits 2.

Add:

```json
"release:verify": "node scripts/release-verify.mjs"
```

- [ ] **Step 5: Rewrite the teacher guide from the actual UI**

Inspect navigation and user-facing labels in `apps/desktop/src/renderer/`. Rewrite `docs/TEACHER_QUICK_GUIDE.md` in teacher language only. State these boundaries explicitly:

- existing local content remains usable offline; new model generation needs configured authorized service;
- model-assisted attribution starts only after the five local measurement checks and is a hypothesis, not a teaching-effect conclusion;
- student material is local-only unless a per-run authorized minimum payload is approved;
- exported Word/PPT editing needs Office/WPS, while built-in classroom view does not;
- backup passwords cannot be recovered, API credentials do not migrate, and uninstall retains data by default;
- offline updates must show trusted publisher verification; the current test build is not a formally signed teacher release.

- [ ] **Step 6: Render final limitation/status reports and remove the checksum cycle**

Generate `KNOWN_LIMITATIONS.md` from aggregate gaps, then `FINAL_STATUS.md` from the same JSON. Neither document embeds the hash of `SHA256SUMS.txt`; both name its path. Regenerate in this order:

1. `npm run release:evidence`;
2. render `KNOWN_LIMITATIONS.md` and `FINAL_STATUS.md`;
3. `npm run release:sbom` to rebuild `SHA256SUMS.txt` over the final documents;
4. run `release:verify` to rehash every listed file.

`SHA256SUMS.txt` excludes itself. `release-evidence.json` records the checksum-manifest path and verification responsibility but not the manifest's own hash, so the dependency graph is acyclic.

- [ ] **Step 7: Run focused tests and the current truthful release commands**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g11-final-release.test.ts
npm run release:evidence
npm run release:sbom
npm run release:verify
```

Expected now: focused tests PASS; evidence/SBOM generation exit 0; `release:verify` exits 2 with `BLOCKED` because required external gates and/or the current candidate are absent. Exit 2 is expected evidence, not a pass and not a reason to weaken the gate.

- [ ] **Step 8: Run full final verification**

Run and record exact exits:

```powershell
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Recompute and compare the frozen hashes for `acceptance/cases.json`, `acceptance/addenda/classroom-delivery.cases.json`, and `package-lock.json`. Run a sensitive-string scan across `reports/release/` for absolute user paths, key-like values, student identifiers, prompt/model payloads, and stack traces. Record any pdfjs optional canvas/font warnings without converting them to failures or suppressing assertions.

- [ ] **Step 9: Write G11 evidence, update progress/handoff, and commit**

Create `reports/G11_EVIDENCE.md` with source commits, commands, exits, 170-case counts, SBOM/checksum counts, disposition, external blocker IDs, environment mismatch, and manual verification boundaries. Update `PROGRESS.md` to “G11 local engineering packages complete; formal release blocked” only if all four package implementations and internal gates are actually complete. Update `HANDOFF.md` with the next external actions and do not label G11 formally DONE.

Commit:

```powershell
git add scripts/lib/g11-release-verify.mjs scripts/release-verify.mjs apps/desktop/tests/g11-final-release.test.ts docs/TEACHER_QUICK_GUIDE.md reports/release reports/G11_EVIDENCE.md package.json PROGRESS.md HANDOFF.md
git commit -m "docs(G11-T04): publish truthful release status and guide"
```

## Plan Self-Review

- Spec coverage: T01 covers immutable definitions, 170-case mapping/run records, evidence levels, fixed paths, and candidate inventory. T02 covers 60+24 requirement traceability, four status dimensions, gaps, and fail-closed disposition. T03 covers the ENV_LOCK toolchain, npm CycloneDX SBOM, transitive lock coverage, checksums, Authenticode, and tamper detection. T04 covers the Chinese guide, limitations, final status, formal verification exit codes, privacy scan, and final evidence.
- Dependency order: T01 produces the selected run/candidate; T02 consumes both; T03 consumes T02 and produces supply-chain files; T04 renders final docs, regenerates evidence and checksums in an acyclic order, then verifies.
- Type consistency: `CaseStatus`, evidence levels, the four dimension enums, `artifactClass`, `releaseDisposition`, and signature states match the approved design exactly.
- No release claim is based on a percentage, old report, missing file, lower evidence level, unsigned artifact, non-ENV_LOCK toolchain, or simulated external evidence.
