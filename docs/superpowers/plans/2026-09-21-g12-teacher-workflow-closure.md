# G12 Teacher Workflow Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a persisted, recoverable teacher-facing workflow from class/textbook setup and selected sources through plan review, five-file export, classroom presentation, and one-change regeneration.

**Architecture:** Add a focused `preparation` orchestration subsystem over the existing source, model, LessonPlan, review, material, and change services. Persist only stable workflow state and selected source references in SQLite; keep the renderer thin through named IPC methods and split preparation components.

**Tech Stack:** Electron 44, React 18, TypeScript 5.5, better-sqlite3 13, Vitest 2, existing strict JSON contracts and NSIS packaging.

**Spec:** `docs/superpowers/specs/2026-09-21-g12-teacher-workflow-closure-design.md`

## Global Constraints

- Do not expose `lesson.buildDemo` through production IPC, preload, or renderer.
- DeepSeek is optional; local authored mode must complete without network access.
- At least one current, hash-verified source fragment is required for every plan.
- API keys, arbitrary paths, prompts, raw student work, and full model requests must not enter reports, logs, backups, or renderer-readable state.
- Every write requires `expectedRevision` and `idempotencyKey`; stale writes and key reuse with a different payload fail closed.
- Unreviewed or stale plans cannot be confirmed, exported, or presented.
- Preserve every prior revision, material bundle, acceptance case, and acceptance run.
- Update `PROGRESS.md` and `HANDOFF.md` in every G12 package.
- External API, WPS, clean standard-user VM, human review, signing, and distribution stay `BLOCKED/NOT_RUN` until actually executed against the current commit and candidate.

## File Structure

- `apps/desktop/src/main/preparation/types.ts`: closed preparation DTOs, statuses, payloads, and errors.
- `apps/desktop/src/main/preparation/stateMachine.ts`: legal transitions and restart reconciliation.
- `apps/desktop/src/main/preparation/localBuilder.ts`: deterministic local `LessonPlanSpec` construction without invented facts.
- `apps/desktop/src/main/preparation/modelSpec.ts`: strict `lesson_plan_spec` parser and selected-anchor binding.
- `apps/desktop/src/main/preparation/service.ts`: workflow orchestration and transaction boundaries.
- `apps/desktop/src/main/presentation/service.ts`: presentation eligibility and reveal-state logic.
- `apps/desktop/src/renderer/preparation/*`: context, source, build, review, and export steps.
- `apps/desktop/src/renderer/presentation/*`: read-only classroom presentation route.
- `apps/desktop/tests/g12-*.test.ts`: unit, SQLite, orchestration, privacy, and presentation tests.
- `apps/desktop/scripts/e2e-g12.cjs`: installed/packaged vertical workflow driver with isolated userData.

---

### Task 1: G12-T01 persisted context, session, sources, and state machine

**Files:**
- Create: `apps/desktop/src/main/preparation/types.ts`
- Create: `apps/desktop/src/main/preparation/stateMachine.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/tests/g12-preparation-state.test.ts`
- Create: `apps/desktop/tests/g12-preparation-sqlite.test.ts`
- Modify: `planning/work-packages.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces: `PreparationStatus`, `TeachingContext`, `PreparationSession`, `PreparationSourceSelection`, `PreparationStore`.
- Produces store methods:
  - `saveTeachingContext(input, expectedRevision, idempotencyKey): TeachingContext`
  - `createPreparationSession(contextId, mode, idempotencyKey): PreparationSession`
  - `replacePreparationSources(sessionId, sources, expectedRevision, idempotencyKey): PreparationSession`
  - `transitionPreparationSession(sessionId, fromRevision, nextStatus, patch, idempotencyKey): PreparationSession`
  - `getPreparationSession(sessionId): PreparationSession | null`
  - `listPreparationSessions(): PreparationSession[]`
- Consumes: existing SQLite idempotency and outbox transaction conventions.

- [ ] **Step 1: Write failing state-machine tests**

```ts
import { describe, expect, it } from 'vitest';
import { canTransition, reconcileInterruptedStatus } from '../src/main/preparation/stateMachine';

describe('G12 preparation state machine', () => {
  it('allows only the documented forward path', () => {
    expect(canTransition('CONTEXT_DRAFT', 'SOURCES_SELECTED')).toBe(true);
    expect(canTransition('SOURCES_SELECTED', 'BUILDING')).toBe(true);
    expect(canTransition('BUILDING', 'PLAN_REVIEW')).toBe(true);
    expect(canTransition('PLAN_REVIEW', 'READY_TO_EXPORT')).toBe(true);
    expect(canTransition('READY_TO_EXPORT', 'EXPORTING')).toBe(true);
    expect(canTransition('EXPORTING', 'EXPORTED')).toBe(true);
    expect(canTransition('CONTEXT_DRAFT', 'EXPORTED')).toBe(false);
  });

  it('returns interrupted work to the last safe state', () => {
    expect(reconcileInterruptedStatus('BUILDING')).toEqual({ status: 'SOURCES_SELECTED', errorCode: 'PREPARATION_INTERRUPTED' });
    expect(reconcileInterruptedStatus('EXPORTING')).toEqual({ status: 'READY_TO_EXPORT', errorCode: 'PREPARATION_INTERRUPTED' });
  });
});
```

- [ ] **Step 2: Run the state test and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-state.test.ts`

Expected: FAIL because `preparation/stateMachine` does not exist.

- [ ] **Step 3: Implement closed types and transitions**

```ts
export type StablePreparationStatus = 'CONTEXT_DRAFT' | 'SOURCES_SELECTED' | 'PLAN_REVIEW' | 'READY_TO_EXPORT' | 'EXPORTED';
export type PreparationStatus = StablePreparationStatus | 'BUILDING' | 'EXPORTING';
export type PreparationMode = 'local_authored' | 'model_assisted';
export type PreparationContentOrigin = 'teacher_authored' | 'model_assisted_real' | 'model_assisted_simulated';
export type PreparationErrorCode =
  | 'PREPARATION_INTERRUPTED'
  | 'PREPARATION_STALE'
  | 'PREPARATION_SOURCE_REQUIRED'
  | 'PREPARATION_SOURCE_CHANGED'
  | 'PREPARATION_MODEL_UNAVAILABLE'
  | 'PREPARATION_MODEL_INVALID'
  | 'PREPARATION_REVIEW_REQUIRED'
  | 'PREPARATION_EXPORT_FAILED';
```

Implement `canTransition()` from an explicit `Record<PreparationStatus, readonly PreparationStatus[]>`; do not infer transitions by ordinal comparison.

- [ ] **Step 4: Write failing SQLite migration and store tests**

The tests must open a schema-12 fixture, verify migration to schema 13, save one context/session/two source selections, reopen the database, and assert exact values. Add assertions that stale revision and same-key/different-payload writes throw existing conflict/key-reuse error types, and that `BUILDING` reconciles to `SOURCES_SELECTED` after reopen.

- [ ] **Step 5: Run SQLite tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-sqlite.test.ts`

Expected: FAIL because schema 13 tables and store methods are absent.

- [ ] **Step 6: Add schema-13 migration and store implementation**

Create `teaching_context`, `preparation_session`, and `preparation_source` with CHECK constraints matching the design. Use a single SQLite transaction for source replacement plus session transition. Reuse canonical JSON hashing for idempotency payload binding. On store open, reconcile only `BUILDING` and `EXPORTING`; never advance a session based on partial files alone.

- [ ] **Step 7: Add named DTO contracts without business implementation**

Add operations `preparation.context.save/get`, `preparation.session.create/get/list`, and `preparation.sources.set` to the shared operation union, schema gate, catalog, and preload. Validate plain objects, exact keys, enum values, integer ranges, string length, unique ordinals, non-negative source spans, and required idempotency/revision fields.

- [ ] **Step 8: Run T01 verification**

Run:

```powershell
npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-state.test.ts tests/g12-preparation-sqlite.test.ts tests/schemaGate.test.ts tests/ipc.test.ts
npm run typecheck
npm run verify:contracts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 9: Update package records and commit**

Mark only G12-T01 local implementation complete in `planning/work-packages.json`, `PROGRESS.md`, and `HANDOFF.md`; list external gates unchanged.

```powershell
git add apps/desktop/src/main/preparation apps/desktop/src/main/store.ts apps/desktop/src/main/db/sqliteStore.ts apps/desktop/src/main/schemaGate.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/tests/g12-preparation-state.test.ts apps/desktop/tests/g12-preparation-sqlite.test.ts planning/work-packages.json PROGRESS.md HANDOFF.md
git commit -m "feat(G12-T01): persist recoverable preparation sessions"
```

### Task 2: G12-T02 local and model-assisted orchestration

**Files:**
- Create: `apps/desktop/src/main/preparation/localBuilder.ts`
- Create: `apps/desktop/src/main/preparation/modelSpec.ts`
- Create: `apps/desktop/src/main/preparation/service.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/model/types.ts`
- Modify: `apps/desktop/src/main/model/prompt.ts`
- Modify: `apps/desktop/src/main/model/service.ts`
- Modify: `apps/desktop/src/main/materials/generate.ts`
- Create: `apps/desktop/tests/g12-local-builder.test.ts`
- Create: `apps/desktop/tests/g12-model-spec.test.ts`
- Create: `apps/desktop/tests/g12-preparation-service.test.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 1 store methods, `buildLessonPlan`, `validateLessonPlan`, `reviewLessonPlan`, `ModelService.run`, source read methods.
- Produces: `PreparationService.build()`, `.review()`, `.confirm()`, and `.export()`.
- Produces strict parser `parseModelLessonPlanSpec(value, allowedAnchors): LessonPlanSpec`.

- [ ] **Step 1: Write failing local-builder tests**

Use one exact source selection and assert the resulting spec uses the selected quote verbatim, includes the teacher-entered `focus`, `coreTask`, and `answerScope`, binds every task anchor to the selection, respects duration, and records missing edition/curriculum as unknowns. Add a negative test for zero sources.

- [ ] **Step 2: Run local-builder tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-local-builder.test.ts`

- [ ] **Step 3: Implement deterministic local construction**

`buildLocalLessonPlanSpec(input)` must create no quotation other than the verified source text. It may generate structural labels and time slices, but factual claims remain absent and unknown curriculum/learner information is preserved in `unknowns`.

- [ ] **Step 4: Write failing strict model parser tests**

Test one valid model object and rejection of extra keys, unknown anchor IDs, copied local paths, missing answer scope, overlong fields, invalid durations, and executable-looking fields. Test that only the selected anchor IDs can be resolved into `LessonAnchorInput`.

- [ ] **Step 5: Run model parser tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-model-spec.test.ts`

- [ ] **Step 6: Implement the `lesson_plan_spec` contract**

Register a fixed task identifier and fixed system instruction in the main process. Parse a closed object shaped as:

```ts
interface ModelLessonPlanSpecV1 {
  title: string;
  objectives: { description: string; cognitive_demand: Objective['cognitive_demand'] }[];
  tasks: { prompt: string; cognitive_demand: Task['cognitive_demand']; support_level: Task['support_level']; teacher_notes: string; acceptable_variants: string[]; insufficient_examples: string[]; anchor_ids: string[] }[];
  activities: { title: string; start_sec: number; end_sec: number; actor: Activity['actor']; student_action: string; teacher_action: string; priority: Activity['priority']; task_indexes: number[] }[];
  teacher_summary: string;
  unknowns: string[];
}
```

Reject any property not listed above. Convert `anchor_ids` only through the verified selected-anchor map.

- [ ] **Step 7: Write failing service tests for local/model/recovery boundaries**

Cover local success; real model success; simulated model identity; model unavailable fallback without automatic network retry; timeout/cancel/budget/invalid JSON; source hash drift; review invalidation after context change; confirm only after `ready_for_teacher`; export rollback on each injected publication boundary; and idempotent replay.

- [ ] **Step 8: Run service tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-service.test.ts`

- [ ] **Step 9: Implement PreparationService and IPC handlers**

Implement service transitions exactly as specified. A failed build removes no prior stable plan. `review()` stores the report and moves to `PLAN_REVIEW`; `confirm()` requires the current plan hash, context revision, source hashes, and `ready_for_teacher`, then moves to `READY_TO_EXPORT`; `export()` delegates to the existing staged material publication path and moves to `EXPORTED` only after hash re-read and database registration.

Update `versionStamp()` to label `teacher_authored`, `model_assisted_real`, and `model_assisted_simulated` exactly. Do not treat simulated output as real.

- [ ] **Step 10: Run T02 verification and commit**

Run:

```powershell
npm --workspace @yuwendesk/desktop exec vitest run tests/g12-local-builder.test.ts tests/g12-model-spec.test.ts tests/g12-preparation-service.test.ts tests/model-deepseek.test.ts tests/g07-bundle-failure.test.ts
npm run typecheck
npm run lint
npm run verify:contracts
git diff --check
```

Update `PROGRESS.md` and `HANDOFF.md`, then commit only T02 files:

```powershell
git commit -m "feat(G12-T02): orchestrate reviewed lesson preparation"
```

### Task 3: G12-T03 teacher workflow UI and classroom presentation

**Files:**
- Create: `apps/desktop/src/renderer/preparation/types.ts`
- Create: `apps/desktop/src/renderer/preparation/viewModel.ts`
- Create: `apps/desktop/src/renderer/preparation/PreparePage.tsx`
- Create: `apps/desktop/src/renderer/preparation/ContextStep.tsx`
- Create: `apps/desktop/src/renderer/preparation/SourceSelectionStep.tsx`
- Create: `apps/desktop/src/renderer/preparation/BuildStep.tsx`
- Create: `apps/desktop/src/renderer/preparation/PlanReviewStep.tsx`
- Create: `apps/desktop/src/renderer/preparation/ExportStep.tsx`
- Create: `apps/desktop/src/main/presentation/service.ts`
- Create: `apps/desktop/src/renderer/presentation/ClassroomPresentation.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Create: `apps/desktop/tests/g12-preparation-view.test.ts`
- Create: `apps/desktop/tests/g12-presentation.test.ts`
- Create: `apps/desktop/scripts/e2e-g12.cjs`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: all Task 1/2 named preload methods and existing change APIs.
- Produces: `buildPreparationView(session): PreparationView`, `PresentationService.open(sessionId)`, and the packaged renderer routes `main` / `presentation`.

- [x] **Step 1: Write failing view-model tests**

Assert each state exposes only its legal primary action, displays content-origin labels and unknowns, disables export before confirmation, offers local fallback after model failure, and never includes API keys, raw model prompts, or arbitrary paths.

- [x] **Step 2: Run view tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-view.test.ts`

- [x] **Step 3: Implement the split preparation UI**

Replace the hard-coded disabled `PreparePage` in `App.tsx` with the new orchestrated page. Keep one primary action per step, visible progress, keyboard labels, live regions, and explicit local/model identity. Context saves before source selection; selected sources show title/version/span and separate model permission. Do not add a prompt text area.

On `EXPORTED`, show five artifacts, plan/revision/bundle IDs, hashes, classroom display, and existing one-change navigation. `My Courses` lists and resumes sessions; it no longer creates demo lessons.

- [x] **Step 4: Remove the production demo path**

Delete `lessonBuildDemo` from preload, shared operations, schema gate, production IPC dispatch, and renderer. Move any fixture-only use to test imports of `demoLessonSpec`. Add a contract assertion that production bundles do not contain the operation string `lesson.buildDemo`.

- [x] **Step 5: Write failing presentation tests**

Test refusal for unreviewed/stale sessions; one active presentation per main window; task-first rendering; explicit hint reveal; explicit answer reveal; close without mutation; and no file path/network API in the presentation DTO.

- [x] **Step 6: Run presentation tests and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-presentation.test.ts`

- [x] **Step 7: Implement the restricted presentation route/window**

Build a `PresentationDTO` from the reviewed current LessonPlan. Create the BrowserWindow with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, the packaged local renderer URL, no HTTP/WebSocket listener, and IPC authorization bound to that window sender/top frame. Keep reveal state in the renderer only; the DTO remains immutable.

- [x] **Step 8: Add an Electron vertical e2e script**

The script uses isolated userData and synthetic source material. It drives named IPC through a real BrowserWindow to save context, import/select a fragment, build locally, review, confirm, export, open presentation, reveal answer, apply one change, verify a new revision/bundle, restart, and resume. It writes only a sanitized JSON result under the ignored acceptance-input directory and never upgrades frozen cases itself.

- [x] **Step 9: Run T03 verification and commit**

Run:

```powershell
npm --workspace @yuwendesk/desktop exec vitest run tests/g12-preparation-view.test.ts tests/g12-presentation.test.ts tests/packaging-config.test.ts tests/security.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:contracts
git diff --check
```

Update `PROGRESS.md` and `HANDOFF.md`, then commit:

```powershell
git commit -m "feat(G12-T03): deliver teacher preparation and presentation UI"
```

### Task 4: G12-T04 current-candidate vertical acceptance and delivery evidence

**Files:**
- Create: `apps/desktop/tests/g12-vertical-contract.test.ts`
- Modify: `scripts/run-g11-acceptance.mjs` only to ingest the new sanitized execution evidence without changing frozen cases.
- Modify: `docs/TEACHER_QUICK_GUIDE.md`
- Modify: `reports/G12_EVIDENCE.md`
- Modify: `planning/work-packages.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`
- Generated after the final code/docs commit: candidate, acceptance run, release evidence, SBOM, checksums, signature status, and final status.

**Interfaces:**
- Consumes: the complete Task 1–3 workflow and existing G11 evidence transaction.
- Produces: one clean-source commit, one fixed candidate installer, one append-only acceptance run, and one engineering delivery ZIP.

- [x] **Step 1: Add failing release/guide contracts**

Assert the teacher guide no longer says the start button is disabled only when the renderer and production IPC expose the complete preparation path. Assert it still says model output needs review, WPS fidelity is separate, and unsigned candidates are not formal releases. Assert frozen acceptance definitions and hashes are unchanged.

- [x] **Step 2: Run contracts and confirm RED**

Run: `npm --workspace @yuwendesk/desktop exec vitest run tests/g12-vertical-contract.test.ts`

- [x] **Step 3: Update guide, evidence, package ledger, and final code docs**

Record exact commands and exit codes. Set G12-T01–T04 local scope to complete only after their tests pass. Keep API/WPS/human/signing/distribution gates unchanged unless their execution evidence exists.

- [ ] **Step 4: Run the full pre-commit verification**

Run:

```powershell
npm run test:unit
npm run typecheck
npm run lint
npm run verify:contracts
npm run build
git diff --check
```

Expected: all exit 0; the one pre-existing intentional skip remains explicit unless separately resolved.

- [ ] **Step 5: Commit the complete T04 source/docs transaction**

Stage only source, tests, guide, G12 evidence, work-package ledger, `PROGRESS.md`, and `HANDOFF.md`. Do not stage a candidate built from an earlier commit.

```powershell
git commit -m "test(G12-T04): close teacher workflow acceptance"
```

- [ ] **Step 6: Build a clean candidate from the new commit**

Run `npm run build:candidate`. Record commit, installer path, size, SHA-256, OS, Node/npm, and Authenticode status. A failed or dirty candidate stays engineering-only.

- [ ] **Step 7: Execute the installed/current-candidate vertical run**

Run the G12 e2e using the candidate-bound evidence input. Execute `npm run acceptance:run`, then regenerate release evidence/SBOM and run `npm run release:verify`. Expected release verification remains exit 2 until every external gate is satisfied; exit 2 is not a test failure when the reason codes are truthful.

- [ ] **Step 8: Verify evidence integrity and package the delivery**

Recompute every package hash from bytes, scan text/nested source archive for live-key patterns, verify ZIP entries have no absolute/traversal paths, and confirm the acceptance run source commit/candidate hash/time window. Package installer, source archive, guide, acceptance summary, SBOM, checksums, signature status, and known limitations under `outputs/`.

- [ ] **Step 9: Final verification-before-completion**

Freshly rerun the full tests, contracts, `release:verify`, installed launch smoke, SQLite integrity check, package checksum verification, and `git diff --check`. Report exact PASS/BLOCKED/NOT_RUN counts and never call the unsigned engineering package a formal release.
