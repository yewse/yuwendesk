# G08 Feedback, Model-Assisted Attribution, and Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement G08-T01–T04 so a teacher can explicitly record actual teaching, optionally capture bounded local observations, obtain measurement-gated model-assisted attribution hypotheses, and accept, reject, or revert a minimal correction without conflating preference, adoption, or observed performance with teaching effectiveness.

**Architecture:** Add a focused `feedback` domain beside the existing lesson, review, change, and model domains. Persist an append-only feedback stream in SQLite; run deterministic measurement checks before constructing a de-identified allowlisted model context; reuse the G04 provider authorization, budget, retry, cache, cancellation, and content-origin machinery; expose only named IPC calls and a single optional feedback path in “我的课程”.

**Tech Stack:** Electron 44.4.3, TypeScript 5.5.4, React 18.3.1, better-sqlite3 13.0.3, Vitest 2.1.1, existing G04 model providers and G07 immutable lesson/change pipeline.

**Spec:** `docs/superpowers/specs/2026-09-20-g08-feedback-attribution-design.md`

## Global Constraints

- Do not redo G00–G07 or alter frozen acceptance definitions.
- Adoption, actual teaching, observation, and effect evidence remain separate states; no automatic promotion is permitted.
- G08 v1 stores no original student-work body. `Observation.sensitive_payload_ref` is `null` and `Observation.cloud_allowed` is always `false`.
- Never serialize an Observation object, arbitrary teacher text, source file, student identity, or arbitrary path into a real-provider request.
- A provider is called only after deterministic measurement checks pass. A real provider additionally requires protected credentials, `allowRealNetwork`, budget, and per-run `dispatchConsent=true`.
- Model output is a hypothesis set, never an effectiveness proof, class error rate, permanent student label, personality/intelligence/family attribution, or causal guarantee.
- Typical or voluntary samples cannot produce a class percentage. Missing work cannot mean inability. Skipped feedback stays unknown.
- A correction replaces or reduces work before adding load and records prediction, disconfirmation, next normal task, and return modules.
- Preference and effect evidence are append-only, separate tracks. Accept, reject, and revert never overwrite their prior evidence.
- Every write uses persistent idempotency plus an expected feedback-stream revision. Same key/different payload is rejected.
- Each task follows red-green-refactor, updates `PROGRESS.md` and `HANDOFF.md`, records actual evidence, and ends in one small commit.
- Windows UI, real API quality, professional teaching review, Office/WPS fidelity, and signing remain `BLOCKED_EXTERNAL` unless actually executed.

## File and Responsibility Map

- `apps/desktop/src/main/feedback/types.ts`: closed G08 types shared by pure functions, storage, IPC, and renderer DTOs.
- `apps/desktop/src/main/feedback/validation.ts`: closed-key runtime validators for all G08 records and persisted JSON.
- `apps/desktop/src/main/feedback/teaching.ts`: pure TeachingEvent construction and state invariants.
- `apps/desktop/src/main/feedback/observation.ts`: Observation/ObservationOutcome validation, sample boundaries, and local privacy checks.
- `apps/desktop/src/main/feedback/measurement.ts`: deterministic M11 measurement gate.
- `apps/desktop/src/main/feedback/attribution.ts`: allowlisted AttributionContext construction and strict model-result validation.
- `apps/desktop/src/main/feedback/correction.ts`: minimal CorrectionProposal plus preference/effect event transitions.
- `apps/desktop/src/main/feedback/service.ts`: orchestration across SQLite, ModelService, idempotency, and feedback-stream versions.
- `apps/desktop/src/renderer/feedbackView.ts`: pure renderer presentation model and stable request-key helpers.
- `contracts/ObservationOutcome.schema.json`: strict four-choice companion contract without modifying Observation.
- `contracts/TeachingAttribution.schema.json`: strict `$defs.ModelOutput` for provider text and `$defs.AttributionResult` for the persisted service wrapper.
- `apps/desktop/src/main/db/sqliteStore.ts`: schema v10 and atomic feedback persistence.
- `apps/desktop/src/main/model/prompt.ts`: versioned `teaching_attribution.v1` prompt and output validation.
- `apps/desktop/src/main/model/service.ts`: narrow structured-task entry that reuses G04 protections.
- `apps/desktop/src/main/ipc.ts`, `schemaGate.ts`, `shared/ipc.ts`, `preload/index.ts`: named G08 boundary only.
- `apps/desktop/src/renderer/App.tsx`, `styles.css`, `global.d.ts`: optional feedback flow in “我的课程”.

---

### Task 1: G08-T01 Separate Adoption from Actual Teaching

**Files:**
- Create: `apps/desktop/src/main/feedback/types.ts`
- Create: `apps/desktop/src/main/feedback/validation.ts`
- Create: `apps/desktop/src/main/feedback/teaching.ts`
- Create: `apps/desktop/src/renderer/feedbackView.ts`
- Create: `apps/desktop/tests/feedback-teaching.test.ts`
- Create: `apps/desktop/tests/g08-feedback-store.test.ts`
- Create: `apps/desktop/tests/feedbackView.test.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces: `createTeachingEvent(input, ids): TeachingEvent`
- Produces: `validateTeachingEvent(value): string[]`
- Produces: `FeedbackStore.recordTeaching(input): FeedbackWriteResult<TeachingEvent>`
- Produces: `FeedbackStore.getFeedbackHistory(planId): FeedbackHistory`
- Produces: IPC `plans.recordTeaching` with expected revision and idempotency key.
- Consumes: existing `LessonRevisionRecord`, `lesson_plan.current_revision_id`, IPC envelope, and SQLite transaction/fault-injection conventions.

- [ ] **Step 1: Write failing pure TeachingEvent tests**

Create `feedback-teaching.test.ts` with a fixed authored lesson fixture:

```ts
import { describe, expect, it } from 'vitest';
import { createTeachingEvent, validateTeachingEvent } from '../src/main/feedback/teaching';

const ids = { eventId: () => 'teach_1', now: () => '2026-09-20T08:00:00.000Z' };

it('records actual teaching without changing adoption or claiming effectiveness', () => {
  const event = createTeachingEvent({
    workspaceId: 'workspace_default',
    planId: 'plan_1',
    planRevisionId: 'revision_1',
    taughtAt: '2026-09-20T07:30:00.000Z',
    actualDurationSec: 2340,
    implementationState: 'partial',
    adjustmentSummary: '临时删去教师补充说明，核心学生任务已完成'
  }, ids);
  expect(event).toMatchObject({ event_id: 'teach_1', implementation_state: 'partial' });
  expect(event).not.toHaveProperty('effectiveness');
  expect(event).not.toHaveProperty('plan_status');
  expect(validateTeachingEvent(event)).toEqual([]);
});

it('rejects extra fields and an implausible duration', () => {
  expect(validateTeachingEvent({
    event_id: 'teach_1', workspace_id: 'workspace_default', plan_id: 'plan_1',
    plan_revision_id: 'revision_1', taught_at: '2026-09-20T07:30:00.000Z',
    actual_duration_sec: 0, implementation_state: 'completed', adjustment_summary: '',
    created_at: '2026-09-20T08:00:00.000Z', effectiveness: 'proved'
  })).toEqual(expect.arrayContaining(['actual_duration_sec', 'extra:effectiveness']));
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-teaching.test.ts
```

Expected: FAIL because `src/main/feedback/teaching.ts` is absent.

- [ ] **Step 3: Define closed G08 types and implement TeachingEvent construction**

Define the exact Task 1 types in `feedback/types.ts`:

```ts
export type ImplementationState = 'completed' | 'partial' | 'stopped';

export interface TeachingEvent {
  event_id: string;
  workspace_id: string;
  plan_id: string;
  plan_revision_id: string;
  taught_at: string;
  actual_duration_sec: number;
  implementation_state: ImplementationState;
  adjustment_summary: string;
  created_at: string;
}

export interface FeedbackWriteResult<T> {
  streamRevision: number;
  value: T;
  replayed: boolean;
}
```

`createTeachingEvent` trims IDs/summary, requires an ISO timestamp, bounds duration to 60–14,400 seconds, allows a 4,000-character adjustment summary, and never accepts derived status fields. `validateTeachingEvent` rejects missing, extra, wrong-type, non-ISO, unsafe-integer, and enum-invalid values.

- [ ] **Step 4: Run the pure test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing real-SQLite, idempotency, concurrency, and IPC tests**

Create `g08-feedback-store.test.ts`. Open a real temporary `SqliteStore`, save `buildLessonPlan(demoLessonSpec())`, and assert:

```ts
const first = store.recordTeaching({
  planId: plan.plan_id,
  planRevisionId: plan.revision_id,
  workspaceId: 'workspace_default',
  expectedRevision: 0,
  idempotencyKey: 'teach-key',
  fingerprint: 'fingerprint-a',
  event
});
expect(first.streamRevision).toBe(1);
expect(store.getLessonRevision(plan.plan_id)?.revisionId).toBe(plan.revision_id);

store.close();
const reopened = await openStore(dir);
expect(reopened.recordTeaching(sameInput)).toMatchObject({ replayed: true, streamRevision: 1 });
expect(() => reopened.recordTeaching({ ...sameInput, fingerprint: 'fingerprint-b' })).toThrow(/idempotency/i);
```

Also race two distinct keys at `expectedRevision: 0`; exactly one commits and the other throws `FeedbackVersionConflictError`. Add IPC cases for missing idempotency, missing expected revision, extra payload keys, unknown lesson revision, and successful `plans.recordTeaching`.

- [ ] **Step 6: Run the SQLite/IPC test and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g08-feedback-store.test.ts
```

Expected: FAIL because schema v10, store methods, and the IPC route are absent.

- [ ] **Step 7: Add schema v10 once for the whole G08 stage**

Append one migration after schema v9 and increment `SQLITE_SCHEMA_TARGET` to 10. Create all G08 tables now so later tasks do not mutate schema piecemeal:

```sql
CREATE TABLE feedback_stream (
  plan_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE teaching_event (
  event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_teaching_plan ON teaching_event(workspace_id, plan_id, created_at);
CREATE TABLE learning_observation (
  observation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  teaching_event_id TEXT NOT NULL, observation_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE observation_outcome (
  observation_id TEXT PRIMARY KEY, outcome_json TEXT NOT NULL
);
CREATE TABLE observation_tombstone (
  observation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL, backup_scope_json TEXT NOT NULL
);
CREATE TABLE measurement_review (
  review_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  teaching_event_id TEXT NOT NULL, review_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE attribution_run (
  run_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  teaching_event_id TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL,
  result_json TEXT, model_job_id TEXT, content_origin TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE correction_proposal (
  proposal_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL, state_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE preference_event (
  event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE effect_evidence_event (
  event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE feedback_idempotency (
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation TEXT NOT NULL,
  status TEXT NOT NULL, result_json TEXT, updated_at TEXT NOT NULL
);
```

Do not add student names, raw work, arbitrary paths, or free-form model prompts to any column.

- [ ] **Step 8: Implement the atomic TeachingEvent store boundary**

Add focused `FeedbackStore` methods to `store.ts` and implement them in `sqliteStore.ts`. `recordTeaching` runs an `IMMEDIATE` transaction that:

1. validates the lesson revision belongs to the plan;
2. compares/creates `feedback_stream.revision`;
3. checks persistent idempotency fingerprint;
4. inserts the event JSON;
5. increments the feedback revision;
6. writes the exact successful result to `feedback_idempotency`.

Parse persisted event JSON through `validateTeachingEvent` on every read. Invalid persisted JSON raises a protected-data error rather than returning an empty history.

- [ ] **Step 9: Expose `plans.recordTeaching` through a strict named IPC**

Add the operation to `IMPLEMENTED_OPERATIONS`, schema gate, switch, preload, renderer declarations, and `contracts/ipc-catalog.json` verification if needed. Use this payload shape:

```ts
{
  planId: string;
  planRevisionId: string;
  taughtAt: string;
  actualDurationSec: number;
  implementationState: 'completed' | 'partial' | 'stopped';
  adjustmentSummary: string;
}
```

The IPC envelope carries `expected_revision` and `idempotency_key`; the service computes the request fingerprint. Map stale streams to `VERSION_CONFLICT`, unknown revisions to `SOURCE_MISSING`, key reuse to `INPUT_INVALID`, and protected storage to `DATABASE_LOCKED`.

- [ ] **Step 10: Write and implement the first renderer view-model test**

In `feedbackView.test.ts`, assert `buildTeachingStatus` keeps adoption and teaching separate:

```ts
expect(buildTeachingStatus({ adopted: true, events: [] })).toEqual({
  adoptionLabel: '已采用', teachingLabel: '尚未记录授课', canRecordTeaching: true
});
expect(buildTeachingStatus({ adopted: true, events: [event] }).teachingLabel).toContain('已记录授课');
```

Implement the pure helper, then add a compact “记录已授课” form to the existing course panel. Generate one stable idempotency key per unchanged form submission and block double-click while in flight. Do not display effectiveness language.

- [ ] **Step 11: Verify, document, and commit G08-T01**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-teaching.test.ts tests/g08-feedback-store.test.ts tests/feedbackView.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Update `PROGRESS.md` and `HANDOFF.md` with actual counts, environment, and remaining blockers. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests contracts/ipc-catalog.json PROGRESS.md HANDOFF.md
git commit -m "feat(G08-T01): separate adoption from teaching events"
```

---

### Task 2: G08-T02 Optional Observation and Transparent Sample Scope

**Files:**
- Create: `contracts/ObservationOutcome.schema.json`
- Create: `apps/desktop/src/main/feedback/observation.ts`
- Create: `apps/desktop/tests/feedback-observation.test.ts`
- Create: `apps/desktop/tests/g08-observation-store.test.ts`
- Modify: `apps/desktop/src/main/feedback/types.ts`
- Modify: `apps/desktop/src/main/feedback/validation.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/feedbackView.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `contracts/ipc-catalog.json`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 1 TeachingEvent, feedback stream, idempotency, and named IPC conventions.
- Produces: `createObservationRecord(input, ids): { observation: Observation; outcome: ObservationOutcome }`
- Produces: `validateObservation`, `validateObservationOutcome`, and `observationCoverageSummary`.
- Produces: `observations.add`, `observations.list`, `observations.prepareDelete`, and `observations.delete`.
- Produces: transactionally deleted observation body plus content-free tombstone.

- [ ] **Step 1: Add strict companion-contract verification and failing domain tests**

Create `ObservationOutcome.schema.json` with `additionalProperties:false`, required `observation_id`, and:

```json
{
  "outcome": {
    "enum": ["met_expectation", "needed_prompt", "clear_difficulty", "insufficient_evidence"]
  }
}
```

Create `feedback-observation.test.ts` and assert:

```ts
const result = createObservationRecord({
  workspaceId: 'workspace_default', planRevisionId: plan.revision_id,
  teachingEventId: event.event_id, taskId: plan.tasks[0].task_id,
  sourceKind: 'teacher_observation', observedAt: '2026-09-20T08:10:00.000Z',
  outcome: 'needed_prompt', supportLevel: 'partial_prompt',
  materialRelation: 'same_item', delayDays: 0, sampleCount: 6,
  populationCount: 42, selection: 'typical_cases',
  coverageCaveat: '六份为教师刻意选择的典型作答，不能推算全班比例',
  summary: '部分作答能指出关键词，但书面证据联系仍需提示'
}, ids);
expect(result.observation).toMatchObject({ sensitive_payload_ref: null, cloud_allowed: false });
expect(observationCoverageSummary(result.observation)).not.toContain('%');
expect(result.observation.quality_state).toBe('usable_with_limits');
```

Add negative cases for `sampleCount > populationCount`, `typical_cases` with a percentage claim, missing caveat, missing TeachingEvent reference at service level, `insufficient_evidence` not mapped to `needs_measurement_review`, unexpected path fields, names/contact patterns, and extra keys.

- [ ] **Step 2: Run domain and contract checks and verify RED**

Run:

```powershell
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-observation.test.ts
```

Expected: contract verification can discover the new schema, but the test fails because the observation module is absent.

- [ ] **Step 3: Implement Observation and sample/privacy invariants**

Use the exact existing `Observation` keys from `contracts/Observation.schema.json`; do not add `outcome` to it. Add:

```ts
export type ObservationOutcomeValue =
  | 'met_expectation' | 'needed_prompt' | 'clear_difficulty' | 'insufficient_evidence';

export interface ObservationOutcome {
  observation_id: string;
  outcome: ObservationOutcomeValue;
}
```

Set `sensitive_payload_ref:null` and `cloud_allowed:false` inside the constructor, never from caller input. Reject keys matching `name`, `studentName`, `phone`, `contact`, `rawText`, `filePath`, or `originalWork`. Apply a conservative local warning/block rule for obvious phone/ID-number patterns in `summary`; tests must use fictional data and verify the exact returned privacy error. Do not claim this is general anonymization.

The coverage helper returns counts and an explicit caveat. Only `selection='all_available'` with non-null, equal `sample_count` and `population_count` may include a computed percentage; all other selections return no ratio.

- [ ] **Step 4: Run domain tests and verify GREEN**

Run the Task 2 domain test command. Expected: PASS.

- [ ] **Step 5: Write failing persistence, deletion, and IPC tests**

Create `g08-observation-store.test.ts` covering:

- no TeachingEvent → `SOURCE_MISSING` and no row;
- valid Observation + outcome + stream increment commit atomically;
- skipped feedback creates no Observation and `history.knowledgeState === 'unknown'`;
- restart returns the exact validated record;
- same key replays, different payload rejects, stale revision conflicts;
- injected failure between observation and outcome leaves neither row;
- deletion without confirmation token rejects;
- confirmed deletion removes observation/outcome, writes a tombstone with only IDs/timestamps/backup scope, and no summary fragments;
- injected deletion failure leaves the original record and no success tombstone.

Use a test-only injected `confirmObservationDelete` callback that returns a short-lived token bound to observation ID, workspace, and expiry. The real main-process callback uses `dialog.showMessageBox` before issuance.

- [ ] **Step 6: Run store tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g08-observation-store.test.ts
```

Expected: FAIL because store and IPC methods are absent.

- [ ] **Step 7: Implement atomic observation persistence and content-free deletion**

Add store methods `addObservation`, `listObservations`, `deleteObservation`, and `feedbackKnowledgeState`. Reuse Task 1 feedback-stream and idempotency checks. Validate JSON before insert and after read.

`deleteObservation` verifies and consumes the token, then in one transaction deletes `observation_outcome` and `learning_observation`, inserts `observation_tombstone`, increments the stream revision, and records the idempotent result. The tombstone JSON contains only `observationId`, `planId`, `deletedAt`, and `backupScopesNotCovered`; it cannot contain summary, task response, student data, or source excerpts.

- [ ] **Step 8: Expose strict observation IPC and optional UI**

Implement existing catalog routes `observations.add/list/delete` plus `observations.prepareDelete`. The prepare call invokes the injected main-process confirmation and returns a token only after an affirmative native response. Add exact payload schemas; reject arbitrary paths and extra fields.

In “我的课程”, show the four outcome choices once after TeachingEvent creation. “暂不反馈” closes the card and stores nothing. Additional sample fields are collapsed until needed. Always display selection and coverage caveat; never render a class percentage for typical/voluntary/unknown samples.

- [ ] **Step 9: Verify, document, and commit G08-T02**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-observation.test.ts tests/g08-observation-store.test.ts tests/feedbackView.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Record the actually covered parts of BIZ-R016–R020, BIZ-R051–R052, JOB-005, PED-004, and PED-008 without changing frozen statuses. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests contracts PROGRESS.md HANDOFF.md
git commit -m "feat(G08-T02): add bounded local lesson observations"
```

---

### Task 3: G08-T03 Measurement Gate and Model-Assisted Attribution

**Files:**
- Create: `contracts/TeachingAttribution.schema.json`
- Create: `apps/desktop/src/main/feedback/measurement.ts`
- Create: `apps/desktop/src/main/feedback/attribution.ts`
- Create: `apps/desktop/src/main/feedback/service.ts`
- Create: `apps/desktop/tests/feedback-measurement.test.ts`
- Create: `apps/desktop/tests/feedback-attribution.test.ts`
- Create: `apps/desktop/tests/g08-attribution-flow.test.ts`
- Modify: `apps/desktop/src/main/feedback/types.ts`
- Modify: `apps/desktop/src/main/feedback/validation.ts`
- Modify: `apps/desktop/src/main/model/prompt.ts`
- Modify: `apps/desktop/src/main/model/providers.ts`
- Modify: `apps/desktop/src/main/model/service.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/feedbackView.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 2 Observation records, lesson task/rubric IDs, Task 1 TeachingEvent, and existing G04 ModelService protections.
- Produces: `reviewMeasurement(input, ids): MeasurementReview`
- Produces: `buildAttributionContext(input): AttributionContext`
- Produces: `validateTeachingAttributionModelOutput(value, allowedObservationIds): string[]`
- Produces: `validateAttributionResult(value): string[]`
- Produces: `ModelService.runStructuredAttribution(input): Promise<RunResult>`
- Produces: `FeedbackService.analyze(input): Promise<FeedbackAnalysisResult>`
- Produces: IPC `feedback.analyze` and `feedback.history`.

- [ ] **Step 1: Write failing deterministic measurement tests**

Create `feedback-measurement.test.ts` with the fixed checks:

```ts
const ready = reviewMeasurement({ plan, teachingEvent, observations, rubricMode: 'versioned' }, ids);
expect(ready.disposition).toBe('ready_for_attribution');
expect(ready.checks.map((x) => [x.check_id, x.status])).toEqual([
  ['target_alignment', 'pass'], ['scoring_available', 'pass'],
  ['task_comparability', 'pass'], ['sample_coverage', 'pass'], ['implementation_conditions', 'pass']
]);

const blocked = reviewMeasurement({
  plan, teachingEvent: { ...teachingEvent, actual_duration_sec: 0 }, observations,
  rubricMode: 'missing'
}, ids);
expect(blocked.disposition).toBe('needs_measurement_review');
expect(blocked.checks).toEqual(expect.arrayContaining([
  expect.objectContaining({ check_id: 'scoring_available', status: 'fail', return_module: 'M07' }),
  expect.objectContaining({ check_id: 'implementation_conditions', status: 'unknown', return_module: 'M11' })
]));
```

Add a same-item/full-model case proving the result cannot claim transfer or delayed retention.

- [ ] **Step 2: Run measurement tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-measurement.test.ts
```

Expected: FAIL because the measurement module is absent.

- [ ] **Step 3: Implement the pure measurement gate**

Define `MeasurementCheck` with `check_id`, `status:'pass'|'fail'|'unknown'`, `evidence`, `object_ids`, and `return_module`. `MeasurementReview` contains the exact five checks, `disposition`, and `is_effectiveness_proof:false`.

Rules are deterministic and closed: missing task/rubric returns M07; unknown material/support/delay blocks comparison; invalid sample scope blocks class inference; missing duration/conditions returns M11 or M08. Do not call a provider from this module.

- [ ] **Step 4: Run measurement tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Add strict attribution contract and failing privacy/output tests**

Create `TeachingAttribution.schema.json` with two strict definitions. `$defs.ModelOutput` contains only a `hypotheses` array and `is_effectiveness_proof:false`; each hypothesis uses the six fixed kinds, observation-ID arrays, evidence basis, limitations, disconfirming evidence, and return modules. `$defs.AttributionResult` wraps a validated model output with `attribution_run_id`, `plan_revision_id`, `teaching_event_id`, `measurement_review_id`, `model_job_id`, `content_origin`, `not_executed_checks`, and `is_effectiveness_proof:false`. Both definitions use `additionalProperties:false`; the file root references `AttributionResult` for persisted-contract verification.

Create `feedback-attribution.test.ts`:

```ts
const context = buildAttributionContext({ plan, teachingEvent, observations, outcomes, measurement });
expect(JSON.stringify(context)).not.toContain(observations[0].summary);
expect(context.observations[0]).toEqual({
  observationId: observations[0].observation_id,
  outcome: 'needed_prompt', supportLevel: 'partial_prompt',
  materialRelation: 'similar_new', delayDays: 2,
  sampleCount: 6, populationCount: 42, selection: 'typical_cases',
  coverageCaveatCode: 'non_representative_sample'
});

expect(validateTeachingAttributionModelOutput(validModelOutput, [observations[0].observation_id])).toEqual([]);
expect(validateTeachingAttributionModelOutput({ ...validModelOutput, class_error_rate: 0.6 }, allowedIds)).toContain('extra:class_error_rate');
expect(validateTeachingAttributionModelOutput(personalityAttribution, allowedIds)).toContain('prohibited_attribution');
expect(validateTeachingAttributionModelOutput(fabricatedObservationRef, allowedIds)).toContain('unknown_observation_id');
```

The context carries enumerated adjustment categories, never raw `adjustment_summary`.

- [ ] **Step 6: Run contract/privacy tests and verify RED**

Run:

```powershell
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-attribution.test.ts
```

Expected: domain test FAIL because attribution code is absent.

- [ ] **Step 7: Implement allowlisted context and strict result validation**

Construct `AttributionContext` field-by-field. Never spread Observation, TeachingEvent, plan, IPC payload, or renderer input. Convert free text to closed codes before context construction. Include only stable IDs, target/task/rubric structural summaries that the service itself derives, and bounded observation metadata.

Validation rejects extra fields, unsupported hypothesis kinds, missing limitations/反证, object IDs outside the allowed observation set, percentage/ranking/personality/intelligence/family terms, causal-proof language, and `is_effectiveness_proof !== false`.

Define the service result as a closed union so callers cannot treat a measurement stop as a successful attribution:

```ts
export type FeedbackAnalysisResult =
  | { status: 'needs_measurement_review'; streamRevision: number; measurement: MeasurementReview }
  | { status: 'attributed'; streamRevision: number; measurement: MeasurementReview; attribution: AttributionResult }
  | { status: 'blocked'; streamRevision: number; measurement: MeasurementReview; code: 'PRIVACY_BLOCKED' | 'MODEL_NOT_AVAILABLE' | 'BUDGET_EXCEEDED'; note: string }
  | { status: 'uncertain'; streamRevision: number; measurement: MeasurementReview; jobId: string; code: 'REQUEST_UNCERTAIN'; note: string };
```

- [ ] **Step 8: Extend the existing model prompt and provider contract**

Add `teaching_attribution` to the prompt registry with `PROMPT_VERSION` bumped to `yuwen-prompt-1.1.0`. Its system instruction explicitly limits output to hypotheses and forbids the rejected categories. Add `validateContract('teaching_attribution.v1', ...)` using the same strict validator as the feedback domain.

Add a deterministic test-double response selected by `req.outputContract === 'teaching_attribution.v1'`. It returns two labeled hypotheses, limitations, and disconfirming evidence, and remains `contentOrigin:'simulated'`. Existing tasks keep their previous responses and tests.

- [ ] **Step 9: Add a narrow structured-attribution entry to ModelService**

Implement:

```ts
runStructuredAttribution(input: {
  context: AttributionContext;
  dispatchConsent: boolean;
}): Promise<RunResult>
```

It computes a canonical context hash and reuses current provider lookup, real-network authorization, protected key, budget reservation, retries, timeout, cancellation, finish-reason checks, strict output validation, cache, usage settlement, and content-origin persistence. For a provider with `requiresKey=true`, reject before `provider.complete` unless `dispatchConsent === true`. Test-double and offline-injected execution still carry their non-real origin labels.

- [ ] **Step 10: Write failing end-to-end service tests**

Create `g08-attribution-flow.test.ts` with injected provider spies:

- measurement failure persists `needs_measurement_review` and provider call count remains zero;
- test-double path persists a valid `simulated` attribution and survives reopen;
- DeepSeek injected transport uses the strict request/response contract but persists `offline-injected`;
- a requires-key provider with `dispatchConsent:false` receives zero calls and returns `PRIVACY_BLOCKED`;
- invalid JSON, forbidden percentage, fabricated observation ID, and `finish_reason='length'` do not create a usable result;
- timeout/after-dispatch network uncertainty follows existing G04 cost behavior;
- same idempotency key replays one result, while a changed observation stream yields conflict and does not silently reuse stale hypotheses.

- [ ] **Step 11: Run flow tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g08-attribution-flow.test.ts
```

Expected: FAIL because the orchestrator and model entry are absent.

- [ ] **Step 12: Implement FeedbackService persistence and IPC/UI**

`FeedbackService.analyze` loads current validated records, runs and persists MeasurementReview, stops if not ready, constructs the allowlisted context, creates an attribution run, calls ModelService, validates returned JSON again, and commits a usable result only if input hash and feedback-stream revision remain current.

Expose `feedback.analyze` and `feedback.history` through strict schemas and named preload methods. The UI shows measurement checks before hypotheses, always shows `simulated`/`offline-injected`/`real`, lists unexecuted real API/professional checks, and never renders model output as effectiveness proof.

- [ ] **Step 13: Verify, document, and commit G08-T03**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-measurement.test.ts tests/feedback-attribution.test.ts tests/g08-attribution-flow.test.ts tests/model.test.ts tests/model-deepseek.test.ts tests/model-protect.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Record real API and professional interpretation as `BLOCKED_EXTERNAL`; do not turn the offline protocol test into real success. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests contracts PROGRESS.md HANDOFF.md
git commit -m "feat(G08-T03): add measurement-gated model attribution"
```

---

### Task 4: G08-T04 Minimal Correction, Dual-Track Evidence, Revert, and Final Boundaries

**Files:**
- Create: `apps/desktop/src/main/feedback/correction.ts`
- Create: `apps/desktop/tests/feedback-correction.test.ts`
- Create: `apps/desktop/tests/g08-correction-flow.test.ts`
- Create: `apps/desktop/tests/g08-evidence-boundary.test.ts`
- Create: `reports/G08_EVIDENCE.md`
- Modify: `apps/desktop/src/main/feedback/types.ts`
- Modify: `apps/desktop/src/main/feedback/validation.ts`
- Modify: `apps/desktop/src/main/feedback/service.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `apps/desktop/src/renderer/feedbackView.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 3 validated attribution, existing strict M12 ChangeProposal definition, Task 1 feedback stream, and G07 change preview/apply boundary.
- Produces: `buildCorrectionProposal(input, ids): CorrectionProposal`
- Produces: `applyCorrectionDecision` and `revertCorrectionDecision` append-only transitions.
- Produces: `PreferenceEvent` and `EffectEvidenceEvent` with no cross-track auto-promotion.
- Produces: IPC `corrections.decide` and `corrections.revert` plus complete `feedback.history`.

- [ ] **Step 1: Write failing pure correction and evidence-track tests**

Create `feedback-correction.test.ts`:

```ts
const proposal = buildCorrectionProposal({
  planRevisionId: plan.revision_id,
  observationIds: ['obs_1'],
  hypothesis: validHypothesis,
  replacementAction: '把教师连续讲解替换为一轮独立找证据后同伴核对',
  removedOrReduced: '减少三分钟重复讲解，不增加课后作业',
  predictedEvidence: '下一次相似新材料中能独立指出证据并说明联系',
  disconfirmingEvidence: '撤去提示后仍无法定位证据，或总负担增加',
  nextNormalTask: '下一篇正常阅读任务中的证据联系题',
  returnModules: ['M06', 'M07', 'M08']
}, ids);
expect(proposal.status).toBe('proposed');
expect(proposal.removed_or_reduced).toContain('减少');
expect(validateCorrectionProposal(proposal)).toEqual([]);

expect(applyPreferenceEvent(history, preferEvent).effectState).toBe('unknown');
expect(applyEffectEvidence(history, initialEvidence).preferenceState).toEqual(history.preferenceState);
expect(canPromoteEffect([initialEvidence])).toBe(false);
expect(canPromoteEffect([initialEvidence, comparableLaterEvidence])).toBe(true);
```

Add rejections for an empty removed/reduced field, “再加十道题” without a corresponding reduction, repeated-same-item evidence promoted as transfer, one observation promoted to `repeated_support`, class ranking, or effectiveness claims.

- [ ] **Step 2: Run pure correction tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-correction.test.ts
```

Expected: FAIL because the correction module is absent.

- [ ] **Step 3: Implement strict CorrectionProposal and dual-track transitions**

Reuse the exact M12 `ChangeProposal` fields embedded in `Observation.schema.json`; expose it in code as `CorrectionProposal` and validate closed keys. An accepted correction changes only its event state. If it implies a lesson change, return a typed G07 `LessonChange` suggestion for explicit preview; never call `LessonChangeService.apply` without the teacher's separate G07 confirmation.

Define:

```ts
export interface PreferenceEvent {
  event_id: string; proposal_id: string;
  action: 'set' | 'revert'; preference_key: string;
  value: string | null; reason: string; created_at: string;
}

export interface EffectEvidenceEvent {
  event_id: string; proposal_id: string;
  state: 'unknown' | 'initial_support' | 'repeated_support' | 'disconfirmed';
  observation_ids: string[]; conditions: string;
  is_effectiveness_proof: false; created_at: string;
}
```

`repeated_support` requires at least two non-deleted, comparable observations with at least one `similar_new` or `different_context` item and appropriate delay metadata. It remains conditional evidence, not causal proof.

- [ ] **Step 4: Run pure correction tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing transactional decision/revert tests**

Create `g08-correction-flow.test.ts` covering:

- proposed → accepted appends an event and keeps original proposal JSON;
- proposed → rejected cannot be accepted with a stale revision;
- accepted → reverted appends a reverse event and restores the prior current recommendation without deleting history;
- same key replays across restart; same key/different decision rejects;
- fault injection at proposal update, preference insert, effect insert, stream increment, and idempotency write rolls back the whole decision;
- a preference event leaves effect state unknown;
- initial effect evidence leaves delivery preference unchanged;
- a G07 suggestion is returned for preview only and does not create a lesson revision or artifact bundle.

- [ ] **Step 6: Run flow tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g08-correction-flow.test.ts
```

Expected: FAIL because persistence transitions and IPC are absent.

- [ ] **Step 7: Implement atomic decide/revert operations and history**

In one `IMMEDIATE` transaction, validate feedback-stream revision, proposal state revision, idempotency fingerprint, and referenced observations; append the decision plus any explicitly selected preference/effect event; increment revisions; persist the exact result. Revert targets an accepted decision, records a reason, and derives the current view by replaying append-only events. Never delete or rewrite the original proposal, attribution, observation, or prior event.

Expose `corrections.decide` and `corrections.revert` with strict payloads and named preload methods. Extend `feedback.history` to return validated teaching events, observations/tombstones, measurement reviews, attribution runs, proposals, preference events, effect events, and stream revision.

- [ ] **Step 8: Complete the correction/history UI and view-model tests**

Show one correction card containing “替换什么 / 减少什么 / 预计看到什么 / 什么情况说明没奏效 / 在哪次正常任务复核”. Provide “采用建议”“不采用”“撤回采用” actions with stable per-decision idempotency keys and in-flight locks.

History has separate headings “交付偏好” and “效果证据”. Add `feedbackView.test.ts` assertions that a repeated deletion preference never changes an effect label and that `initial_support` renders as “有限条件下的初步证据（非效果证明）”.

- [ ] **Step 9: Add cross-stage evidence-boundary regression tests**

Create `g08-evidence-boundary.test.ts` to exercise the complete local chain and violating counterexamples:

- adopted but not taught → no Observation;
- taught but skipped feedback → unknown and no reminder state;
- typical six-case sample → no class percentage;
- same-item/full-model success → no transfer/retention claim;
- provider hypothesis → no direct lesson mutation;
- repeated presentation deletion → preference only;
- increased homework cost prevents a success-only effect summary;
- deleted observation cannot remain in an active attribution/correction result;
- all renderer-visible simulated/offline outputs retain origin labels;
- frozen acceptance JSON remains unchanged.

- [ ] **Step 10: Run final targeted and full verification**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-correction.test.ts tests/g08-correction-flow.test.ts tests/g08-evidence-boundary.test.ts tests/feedbackView.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

Expected: every executed command exits 0. Record the actual test count and existing skips; do not copy G07 counts.

- [ ] **Step 11: Write evidence, update handoff, and commit G08-T04**

Create `reports/G08_EVIDENCE.md` with commit baseline, OS/Node/npm/Vitest/TypeScript versions, fixture identities, exact commands/exit codes, deterministic and model-origin observations, contract hashes if generated, and separate `BLOCKED_EXTERNAL` entries for real API, professional teaching review, Electron window walkthrough, clean Windows, Office/WPS, and signing.

Update `PROGRESS.md` and `HANDOFF.md` after actual verification. Keep frozen acceptance statuses unchanged and describe only machine-executable coverage. Commit:

```powershell
git add apps/desktop/src apps/desktop/tests contracts reports/G08_EVIDENCE.md PROGRESS.md HANDOFF.md
git commit -m "feat(G08-T04): add reversible evidence-bounded corrections"
```

## Final Branch Review

After Task 4, use `superpowers:verification-before-completion` and then `superpowers:requesting-code-review`. Confirm:

```powershell
git status --short --branch
git log --oneline --decorate -8
git diff --check
```

The expected branch contains the G08 design commit, this plan commit, and four G08 implementation commits after the six G07 commits. Do not merge or push to `main` without explicit user authorization.
