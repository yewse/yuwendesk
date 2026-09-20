# G07 Review and One-Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement G07-T01–T04 so one controlled teacher change creates an immutable reviewed lesson revision and atomically publishes a consistent five-file bundle while preserving the prior reliable version.

**Architecture:** Add pure review and change-domain modules around the existing `LessonPlan` and `buildMaterialSet` functions, then persist their strict contract outputs through one SQLite transaction. Publish generated files through a staging directory and disk hash verification before moving the lesson's current pointer; expose only named IPC methods and a minimal single-proposal UI.

**Tech Stack:** Electron 44.4.3, TypeScript 5.5.4, React 18.3.1, better-sqlite3 13.0.3, Vitest 2.1.1, Node.js filesystem/crypto, existing PptxGenJS/JSZip/pdfkit material pipeline.

**Spec:** `docs/superpowers/specs/2026-09-20-g07-review-change-design.md`

## Global Constraints

- Do not redo G00–G06 or alter frozen acceptance definitions.
- Keep `ReviewReport` and `ChangeProposal` compatible with the existing strict contracts; never add undeclared fields to their JSON.
- `ReviewReport.is_effectiveness_proof` is always `false`.
- Preserve stable objective/task/rubric/activity/anchor IDs across semantic revisions; only the lesson `revision_id` changes.
- Do not convert removed class content into homework.
- Do not mark model, Office/WPS, clean-Windows, signing, or professional teaching checks PASS without those environments.
- A failed five-file publication must leave the current revision and prior artifact bundle unchanged.
- Every task uses red-green-refactor, ends with targeted and full verification, and updates both `PROGRESS.md` and `HANDOFF.md` before its commit.

---

### Task 1: G07-T01 Deterministic and Model-Assisted Review Layers

**Files:**
- Create: `apps/desktop/src/main/review/types.ts`
- Create: `apps/desktop/src/main/review/review.ts`
- Create: `apps/desktop/tests/review.test.ts`
- Create: `apps/desktop/tests/g07-review-store.test.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces: `reviewLessonPlan(plan, options): ReviewReport`
- Produces: `validateReviewReport(value): string[]`
- Produces: `LessonStore.saveReviewReport(record)` and `LessonStore.getLatestReviewReport(planId, revisionId)`
- Produces: IPC operation `review.run` with payload `{ planId: string; revisionId?: string }`
- Consumes: existing `LessonPlan`, `validateLessonPlan`, `MaterialArtifactRecord`, and strict contract field names.

- [ ] **Step 1: Write failing review-domain tests**

Create `apps/desktop/tests/review.test.ts` with explicit authored fixtures and deterministic IDs:

```ts
import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { reviewLessonPlan, validateReviewReport } from '../src/main/review/review';

const ids = { reportId: () => 'report_test', issueId: (rule: string) => `issue_${rule}` };

describe('G07-T01 ReviewReport', () => {
  it('separates software readiness from teaching effectiveness', () => {
    const report = reviewLessonPlan(buildLessonPlan(demoLessonSpec()), { ids });
    expect(report.disposition).toBe('ready_for_teacher');
    expect(report.is_effectiveness_proof).toBe(false);
    expect(report.not_executed_checks).toEqual(
      expect.arrayContaining(['model_semantic_review', 'teacher_professional_review', 'office_wps_fidelity'])
    );
    expect(validateReviewReport(report)).toEqual([]);
  });

  it('routes a conflicting source anchor to M03 and blocks publication', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.source_anchors[0].verification = 'conflict';
    const report = reviewLessonPlan(plan, { ids });
    expect(report.disposition).toBe('blocked');
    expect(report.issues).toContainEqual(expect.objectContaining({ severity: 'blocking', return_module: 'M03' }));
  });

  it('routes schedule overflow to M08 without claiming a measured duration', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.activities[0].end_sec = plan.declared_duration_sec + 1;
    const report = reviewLessonPlan(plan, { ids });
    expect(report.disposition).toBe('needs_fix');
    expect(report.issues).toContainEqual(expect.objectContaining({ return_module: 'M08', verification_type: 'deterministic' }));
  });

  it('keeps supported alternative interpretations for teacher review instead of keyword rejection', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    plan.rubrics[0].criteria[0].acceptable_variants = ['从反复和语气说明急切期盼'];
    const report = reviewLessonPlan(plan, { ids });
    expect(report.issues.some((x) => x.rule_id === 'preset_personality_keyword')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the review test and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/review.test.ts
```

Expected: FAIL because `src/main/review/review.ts` does not exist.

- [ ] **Step 3: Add strict review types and the minimal deterministic reviewer**

In `review/types.ts`, define only contract fields:

```ts
export type ReviewSeverity = 'blocking' | 'fix' | 'teacher_review' | 'info';
export type ReturnModule = 'M01'|'M02'|'M03'|'M04'|'M05'|'M06'|'M07'|'M08'|'M09'|'M10'|'M11'|'M12';

export interface ReviewIssue {
  issue_id: string;
  severity: ReviewSeverity;
  rule_id: string;
  object_ids: string[];
  message: string;
  evidence: string;
  return_module: ReturnModule;
  verification_type: 'deterministic' | 'model_assisted' | 'human_observation';
  status: 'open' | 'fixed' | 'accepted_with_limit';
}

export interface ReviewReport {
  report_id: string;
  plan_revision_id: string;
  issues: ReviewIssue[];
  disposition: 'ready_for_teacher' | 'needs_fix' | 'blocked';
  executed_checks: string[];
  not_executed_checks: string[];
  is_effectiveness_proof: false;
}
```

In `review/review.ts`, map existing validation errors by prefix and add anchor checks:

```ts
const validationRoutes: Record<string, { severity: ReviewSeverity; module: ReturnModule }> = {
  task_anchor_missing: { severity: 'blocking', module: 'M03' },
  rubric_anchor_missing: { severity: 'blocking', module: 'M03' },
  task_rubric_missing: { severity: 'fix', module: 'M07' },
  rubric_no_variants: { severity: 'teacher_review', module: 'M07' },
  activity_time: { severity: 'fix', module: 'M08' },
  activity_overtime: { severity: 'fix', module: 'M08' },
  activity_task_missing: { severity: 'fix', module: 'M08' }
};

function issue(
  ruleId: string,
  severity: ReviewSeverity,
  returnModule: ReturnModule,
  objectIds: string[],
  ids: ReviewIds
): ReviewIssue {
  return {
    issue_id: ids.issueId(ruleId),
    severity,
    rule_id: ruleId,
    object_ids: objectIds,
    message: ruleMessage(ruleId),
    evidence: `deterministic:${ruleId}:${objectIds.join(',')}`,
    return_module: returnModule,
    verification_type: 'deterministic',
    status: 'open'
  };
}

export function reviewLessonPlan(plan: LessonPlan, options: ReviewOptions): ReviewReport {
  const issues = validationIssues(plan, options.ids);
  for (const anchor of plan.source_anchors) {
    if (anchor.verification === 'conflict') issues.push(issue('source_anchor_conflict', 'blocking', 'M03', [anchor.anchor_id], options.ids));
    if (anchor.verification === 'needs_review') issues.push(issue('source_anchor_needs_review', 'teacher_review', 'M03', [anchor.anchor_id], options.ids));
  }
  if (options.modelIssues) issues.push(...options.modelIssues.map(assertModelAssisted));
  return {
    report_id: options.ids.reportId(),
    plan_revision_id: plan.revision_id,
    issues,
    disposition: issues.some((x) => x.severity === 'blocking') ? 'blocked' : issues.some((x) => x.severity === 'fix') ? 'needs_fix' : 'ready_for_teacher',
    executed_checks: ['lesson_schema', 'reference_integrity', 'schedule_bounds', 'source_verification'],
    not_executed_checks: options.modelIssues
      ? ['teacher_professional_review', 'office_wps_fidelity']
      : ['model_semantic_review', 'teacher_professional_review', 'office_wps_fidelity'],
    is_effectiveness_proof: false
  };
}
```

Implement `validateReviewReport` as a closed-key runtime validator that rejects missing, extra, wrong-enum, wrong-type, and `is_effectiveness_proof !== false` values.

- [ ] **Step 4: Run the review test and verify GREEN**

Run the Step 2 command.

Expected: PASS for all `review.test.ts` cases with no warnings.

- [ ] **Step 5: Write failing SQLite persistence and IPC tests**

Create `g07-review-store.test.ts` that opens a real temporary `SqliteStore`, saves a lesson revision, calls `review.run`, closes/reopens the store, and asserts the exact report persists. Add a schema-gate assertion that `{ planId, extra: true }` returns `INPUT_INVALID`.

Use this request helper:

```ts
function reviewReq(planId: string, revisionId?: string) {
  return {
    schema_version: IPC_SCHEMA_VERSION,
    request_id: 'review-1',
    operation: 'review.run' as const,
    workspace_id: null,
    payload: revisionId ? { planId, revisionId } : { planId }
  };
}
```

- [ ] **Step 6: Run the store/IPC test and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g07-review-store.test.ts
```

Expected: FAIL because migration/table/store methods and `review.run` are absent.

- [ ] **Step 7: Add the G07 migration and review persistence**

Add one migration after version 8. It creates all G07 tables once so later packages do not alter schema piecemeal:

```sql
CREATE TABLE review_report (
  report_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_revision ON review_report(plan_id, revision_id, created_at);

CREATE TABLE change_proposal (
  change_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  candidate_revision_id TEXT,
  change_kind TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE material_bundle (
  bundle_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  presentation_spec_hash TEXT NOT NULL,
  directory TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE material_artifact ADD COLUMN bundle_id TEXT;

CREATE TABLE lesson_change_idempotency (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  updated_at TEXT NOT NULL
);
```

Add `ReviewReportRecord` and `LessonStore` methods to `store.ts`, then implement inserts/reads in `sqliteStore.ts`. Parse persisted JSON through `validateReviewReport` before returning; invalid stored JSON must throw rather than be shown as reviewed.

- [ ] **Step 8: Expose the narrow review IPC route**

Add `'review.run'` to `IMPLEMENTED_OPERATIONS`, a strict payload schema, the switch branch, and preload method:

```ts
reviewRun: (planId: string, revisionId?: string) =>
  call<{ report: ReviewReport }>('review.run', {
    payload: revisionId ? { planId, revisionId } : { planId }
  })
```

`IpcService.reviewRun` loads the requested revision, runs deterministic review, saves it, and returns `{ report }`. It does not call a provider. Missing lesson returns `SOURCE_MISSING`; protected storage returns `DATABASE_LOCKED`.

- [ ] **Step 9: Run targeted and full Task 1 verification**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/review.test.ts tests/g07-review-store.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Expected: every command exits 0; record the actual total test count rather than copying the previous 220 count.

- [ ] **Step 10: Update progress files and commit G07-T01**

In both `PROGRESS.md` and `HANDOFF.md`, record G07-T01 as completed only for deterministic/local evidence, list the exact commands and counts, and keep model/Office/Windows checks `BLOCKED_EXTERNAL` or NOT_RUN.

Commit:

```powershell
git add apps/desktop/src apps/desktop/tests PROGRESS.md HANDOFF.md
git commit -m "feat(G07-T01): add layered lesson review reports"
```

---

### Task 2: G07-T02 Dependency Invalidation, ChangeProposal, and Atomic Business Commit

**Files:**
- Create: `apps/desktop/src/main/change/types.ts`
- Create: `apps/desktop/src/main/change/change.ts`
- Create: `apps/desktop/src/main/change/service.ts`
- Create: `apps/desktop/src/main/materials/publish.ts`
- Create: `apps/desktop/tests/change.test.ts`
- Create: `apps/desktop/tests/g07-change-sqlite.test.ts`
- Modify: `apps/desktop/src/main/lesson/types.ts`
- Modify: `apps/desktop/src/main/store.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/schemaGate.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 1 `reviewLessonPlan`, `ReviewReport`, and G07 tables.
- Produces: `previewLessonChange(base, change, ids): ChangePreview`
- Produces: `LessonChangeService.preview`, `.apply`, and `.history`
- Produces: `LessonStore.commitLessonChange(input): ChangeCommitResult`
- Produces: IPC `change.preview`, `change.apply`, and `change.history`.

**Acceptance mapping:** JOB-002, JOB-003, JOB-006, CLS-021, CLS-022, CLS-023, and CLS-038 receive direct automated coverage. Their frozen/addendum definitions remain unchanged; execution status is recorded only from actual evidence.

- [ ] **Step 1: Write failing pure change tests**

Create `change.test.ts` with fixed IDs and these cases:

```ts
const ids = { changeId: 'chg_1', revisionId: 'rev_2' };

function linkedPlanFixture() {
  const plan = buildLessonPlan(demoLessonSpec());
  plan.tasks[1].task_id = 'task_link';
  plan.activities[2].activity_id = 'act_link';
  plan.activities[2].task_ids = ['task_link'];
  plan.links = [{
    link_id: 'link_1',
    current_anchor_ids: ['anc_1'],
    related_anchor_ids: ['anc_1'],
    relation_type: 'same_topic_difference',
    similarities: ['均写春日景象（自拟测试）'],
    differences: ['观察角度不同（自拟测试）'],
    purpose: '比较观察角度后返回本篇语言',
    author_timeline: [],
    text_timeline: ['先比较，再返回当前文本'],
    student_learning_status: 'current',
    prerequisite_support: '提供当前段落',
    student_action: '比较两处景物描写',
    return_to_text_task_id: 'task_link',
    estimated_sec: 300,
    replaces_activity_ids: ['act_link'],
    next_recurrence: null,
    disconfirming_observation: '比较未帮助解释当前文本时删除',
    decision: 'include'
  }];
  return plan;
}

it('shortens a lesson by removing optional work before compressible work and never adds homework', () => {
  const base = linkedPlanFixture();
  const beforeHomework = structuredClone(base.homework);
  const out = previewLessonChange(base, { kind: 'change_duration', durationSec: 2100 }, ids);
  expect(out.invalidatedModules).toEqual(['M08', 'M09', 'M10']);
  expect(out.candidatePlan.revision_id).toBe('rev_2');
  expect(out.candidatePlan.previous_revision_id).toBe(base.revision_id);
  expect(out.candidatePlan.activities.every((a) => a.end_sec <= 2100)).toBe(true);
  expect(out.candidatePlan.homework).toEqual(beforeHomework);
});

it('adds independent time once by taking time from optional/compressible activity, not homework', () => {
  const base = linkedPlanFixture();
  const target = base.activities.find((x) => x.actor === 'student')!;
  const originalDuration = target.end_sec - target.start_sec;
  const out = previewLessonChange(base, { kind: 'increase_independent_time', activityId: target.activity_id, addedSec: 300 }, ids);
  const changed = out.candidatePlan.activities.find((x) => x.activity_id === target.activity_id)!;
  expect(changed.end_sec - changed.start_sec).toBe(originalDuration + 300);
  expect(out.candidatePlan.declared_duration_sec).toBe(base.declared_duration_sec);
  expect(out.candidatePlan.homework).toEqual(base.homework);
  expect(out.invalidatedModules).toEqual(['M08', 'M09', 'M10']);
});

it('removes one link, its return task, rubric, and replacement activities without renumbering unaffected IDs', () => {
  const base = linkedPlanFixture();
  const keepTaskId = base.tasks[0].task_id;
  const out = previewLessonChange(base, { kind: 'remove_link', linkId: 'link_1' }, ids);
  expect(out.candidatePlan.links.some((x) => x.link_id === 'link_1')).toBe(false);
  expect(out.candidatePlan.tasks.some((x) => x.task_id === 'task_link')).toBe(false);
  expect(out.candidatePlan.tasks.some((x) => x.task_id === keepTaskId)).toBe(true);
  expect(out.invalidatedModules).toEqual(['M05', 'M06', 'M07', 'M08', 'M09', 'M10']);
});

it('updates a task and its answer range while preserving unrelated semantics', () => {
  const base = linkedPlanFixture();
  const out = previewLessonChange(base, {
    kind: 'edit_task', taskId: base.tasks[0].task_id, prompt: '新的题意', acceptableVariants: ['有文本依据的答案']
  }, ids);
  expect(out.candidatePlan.tasks[0].prompt).toBe('新的题意');
  expect(out.candidatePlan.rubrics[0].criteria[0].acceptable_variants).toEqual(['有文本依据的答案']);
  expect(out.proposal.plan_revision_id).toBe(base.revision_id);
  expect(out.proposal.observation_ids).toEqual([]);
  expect(out.proposal.hypothesis).toContain('教师主动修改');
});

it('presentation-only change keeps semantic revision and creates a new presentation spec hash', () => {
  const base = linkedPlanFixture();
  const out = previewLessonChange(base, { kind: 'presentation_only', fontScale: 1.25, paperSize: 'A4', theme: 'light' }, ids);
  expect(out.semanticRevisionChanged).toBe(false);
  expect(out.candidatePlan.revision_id).toBe(base.revision_id);
  expect(out.invalidatedModules).toEqual(['M09', 'M10']);
  expect(out.presentationSpecHash).toMatch(/^[a-f0-9]{64}$/);
});
```

The `linkedPlanFixture` must be explicitly authored in the test and mark all text fictional. It contains a typed `LinkCard` whose `return_to_text_task_id` is `task_link` and whose `replaces_activity_ids` identifies the link-only activity.

- [ ] **Step 2: Run pure change tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/change.test.ts
```

Expected: FAIL because the change module is absent.

- [ ] **Step 3: Type LinkCard and implement controlled change validation**

Replace `LessonPlan.links: unknown[]` with a `LinkCard[]` matching the existing contract. Define the closed union:

```ts
export type LessonChange =
  | { kind: 'change_duration'; durationSec: number }
  | { kind: 'increase_independent_time'; activityId: string; addedSec: number }
  | { kind: 'remove_link'; linkId: string }
  | { kind: 'edit_task'; taskId: string; prompt: string; acceptableVariants: string[] }
  | { kind: 'edit_rubric'; rubricId: string; acceptableVariants: string[] }
  | { kind: 'presentation_only'; fontScale: number; paperSize: 'A4' | 'Letter'; theme: 'light' | 'high_contrast' };
```

Implement `validateLessonChange` to reject unknown keys, unknown kinds, empty IDs/text, answer lists over 20 entries, text over 4,000 characters, duration outside 300–14,400 seconds, `addedSec` outside 60–1,800 seconds, and font scale outside 0.8–1.5.

- [ ] **Step 4: Implement immutable change application and invalidation**

Use `structuredClone(base)`; never call `buildLessonPlan`, because it would reassign stable child IDs. For semantic changes set:

```ts
candidate.revision_id = ids.revisionId;
candidate.previous_revision_id = base.revision_id;
candidate.software_review_state = 'not_reviewed';
```

Implement schedule fitting from activity durations, not their old absolute gaps:

```ts
const essential = activities.filter((a) => a.priority === 'essential');
const compressible = activities.filter((a) => a.priority === 'compressible');
const optional = activities.filter((a) => a.priority === 'optional');
const minimum = sumDurations(essential) + compressible.length * 60;
if (minimum > durationSec) throw new ChangeBlockedError('CORE_ACTIONS_DO_NOT_FIT');
const selected = allocateInOrder([...essential, ...compressible, ...optional], durationSec);
return repackFromZero(selected);
```

`allocateInOrder` preserves essential durations, gives each compressible activity at least 60 seconds, drops optional activities before shrinking compressible activities, and never modifies homework. `remove_link` removes the identified link, its `return_to_text_task_id`, the now-unused rubric, and `replaces_activity_ids`; it also removes dangling task references and repacks remaining activities.

Build `ChangeProposal` with strict fields only and `status: 'proposed'`. Put candidate revision, diff entries, invalidated modules, and presentation hash in `ChangePreview`, not inside the contract object.

- [ ] **Step 5: Run pure change tests and verify GREEN**

Run the Step 2 command.

Expected: PASS for duration, link removal, task/rubric synchronization, and presentation-only identity.

- [ ] **Step 6: Write failing real-SQLite apply tests**

Create `g07-change-sqlite.test.ts` covering:

- same key + same fingerprint returns the original success after store reopen;
- same key + different payload returns `key_reuse`;
- two different keys against the same base revision yield exactly one commit and one `VERSION_CONFLICT`;
- successful apply creates one new lesson revision, one accepted proposal, one review report, one bundle, exactly five artifacts, and updates `current_revision_id` together;
- presentation-only apply keeps the semantic revision but adds a second bundle.

Use actual temporary directories and `SqliteStore`; do not mock its transaction.

- [ ] **Step 7: Run SQLite apply tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g07-change-sqlite.test.ts
```

Expected: FAIL because atomic commit and the change service are absent.

- [ ] **Step 8: Implement staged bundle writing for the happy path**

In `materials/publish.ts`, add an injectable filesystem boundary:

```ts
export interface BundleIo {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export async function stageMaterialSet(root: string, bundleId: string, set: MaterialSet, io: BundleIo): Promise<StagedBundle>;
export async function promoteStagedBundle(root: string, staged: StagedBundle, io: BundleIo): Promise<PublishedBundle>;
```

`stageMaterialSet` verifies the exact five role/format pairs, writes to `.staging/<bundleId>`, rereads every file, and compares SHA-256 before returning. `promoteStagedBundle` renames to `<revisionId>/<bundleId>` and never overwrites a non-identical existing directory.

- [ ] **Step 9: Implement the atomic SQLite business commit**

Add records for `MaterialBundleRecord`, `StoredChangeProposal`, `LessonChangeCommitInput`, and `LessonChangeCommitResult`. `commitLessonChange` must run one `IMMEDIATE` transaction that:

1. checks idempotency key/fingerprint;
2. checks `lesson_plan.current_revision_id === baseRevisionId`;
3. inserts the semantic revision only when it changed;
4. inserts `material_bundle` and five `material_artifact` rows;
5. inserts the strict review and accepted proposal JSON;
6. updates current revision only for semantic changes;
7. writes the complete success result to `lesson_change_idempotency`.

Throw typed `LessonChangeConflictError` and `LessonChangeKeyReuseError`; do not catch them inside the transaction.

Add these exact query methods for service preflight and history:

```ts
findLessonChangeIdempotency(key: string): LessonChangeIdempotencyRecord | null;
listLessonChangeHistory(planId: string): {
  revisions: LessonRevisionRecord[];
  proposals: StoredChangeProposal[];
  bundles: MaterialBundleRecord[];
};
```

- [ ] **Step 10: Implement LessonChangeService and backend IPC**

`LessonChangeService.apply` performs: precheck idempotency → preview → review candidate → generate five files → stage/promote → atomic commit → cleanup on failure. It changes proposal status to `accepted` only in the JSON passed to the successful transaction.

Add these operations and strict payload gates:

```ts
'change.preview'
'change.apply'
'change.history'
```

`change.apply` requires both `baseRevisionId` in payload and envelope `idempotency_key`. Map typed conflicts to `VERSION_CONFLICT`, key reuse/invalid nested changes to `INPUT_INVALID`, disk failures to `DISK_FULL`, and review blockers to `EXPORT_INVALID`.

- [ ] **Step 11: Run targeted and full Task 2 verification**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/change.test.ts tests/g07-change-sqlite.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Expected: all exit 0. Inspect the real temp output in the test: one current revision, old revision still readable, and five verified files under the new bundle directory.

- [ ] **Step 12: Update progress files and commit G07-T02**

Record only the executed local/SQLite/structural evidence. Mark real Office/WPS opening and real provider review as external/not run.

Commit:

```powershell
git add apps/desktop/src apps/desktop/tests PROGRESS.md HANDOFF.md
git commit -m "feat(G07-T02): apply dependency-aware lesson changes atomically"
```

---

### Task 3: G07-T03 Single-Proposal and Minimum-Choice UI

**Files:**
- Create: `apps/desktop/src/renderer/lessonChangeView.ts`
- Create: `apps/desktop/tests/lessonChangeView.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/global.d.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 2 preload methods and `ChangePreview`/apply response DTOs.
- Produces: pure `buildChangeSummary(preview)` and `needsPrintedCopyWarning(diff)` helpers.
- Produces: one course change panel with one preview, one confirmation, one result, and version history.

**Acceptance mapping:** JOB-004, CLS-027, CLS-031, and CLS-039 receive UI/state coverage without claiming teaching-effect evidence or external-editor synchronization.

- [ ] **Step 1: Write failing view-model tests**

Create `lessonChangeView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChangeSummary, needsPrintedCopyWarning } from '../src/renderer/lessonChangeView';

it('summarizes one proposal without asking for per-file choices', () => {
  const summary = buildChangeSummary({
    changeKind: 'increase_independent_time',
    invalidatedModules: ['M08', 'M09', 'M10'],
    diff: [{ objectId: 'act_2', field: 'duration', before: '600', after: '900' }],
    affectedOutputs: ['课堂PPT', '学生讲义DOCX/PDF', '教师讲解版DOCX/PDF']
  });
  expect(summary).toContain('增加独立学习时间');
  expect(summary).toContain('三类五文件将同步更新');
  expect(summary).not.toContain('选择字体');
});

it('warns when task numbering or prompt changes can invalidate printed handouts', () => {
  expect(needsPrintedCopyWarning([{ objectId: 'task_1', field: 'prompt', before: '旧题', after: '新题' }])).toBe(true);
  expect(needsPrintedCopyWarning([{ objectId: 'bundle', field: 'fontScale', before: '1', after: '1.25' }])).toBe(false);
});
```

- [ ] **Step 2: Run view-model tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/lessonChangeView.test.ts
```

Expected: FAIL because `lessonChangeView.ts` is absent.

- [ ] **Step 3: Implement the pure Chinese summary helpers**

Map each controlled kind to one teacher-facing label and produce a compact summary:

```ts
const kindLabels = {
  change_duration: '改变实际课时',
  increase_independent_time: '增加独立学习时间',
  remove_link: '减少联结',
  edit_task: '修改题目与合理答案范围',
  edit_rubric: '修改合理答案范围',
  presentation_only: '只调整版式'
} as const;
```

`needsPrintedCopyWarning` returns true for task prompt, task order, task removal, rubric answer, material anchor, or link removal differences. The warning text is exactly: `旧纸本不会自动更新：请重印新讲义，或课堂上统一使用旧版。`

- [ ] **Step 4: Run view-model tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Add named preload methods and typed DTOs**

Expose only:

```ts
reviewRun(planId, revisionId?)
changePreview(planId, baseRevisionId, change)
changeApply(planId, baseRevisionId, change, idempotencyKey)
changeHistory(planId)
```

The preload continues to expose no filesystem path input, raw `ipcRenderer`, or generic operation string.

- [ ] **Step 6: Implement the one-change course panel**

In `CoursesPage`, load the selected plan through `lessonGet`. Render one compact panel with these controls:

- actual duration in minutes, minimum 5 and maximum 240;
- “独立学习增加 5 分钟” for an available student activity;
- one selectable included link, only when links exist;
- one task prompt and semicolon-separated acceptable answer variants;
- presentation controls for font scale, paper size, and theme.

Only one choice can be active. “预览改动” calls `change.preview`; it shows one proposal, affected modules, affected outputs, and field-level diff. “确认并同步更新” calls `change.apply` once with `crypto.randomUUID()` as the stable click idempotency key; disable the button while in flight so a double click cannot create another key.

After success, show:

- new semantic revision or unchanged semantic revision for presentation-only work;
- five filenames and hashes;
- `ReviewReport.disposition` and unexecuted checks;
- prior revision remains available;
- printed-copy warning when `needsPrintedCopyWarning` is true.

On failure, keep the current UI manifest and show `旧版未受影响` plus the server-provided next action. Do not display “已授课” or effectiveness claims.

- [ ] **Step 7: Run renderer and full verification**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/lessonChangeView.test.ts tests/g07-change-sqlite.test.ts
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run -w @yuwendesk/desktop build
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
```

Expected: every command exits 0 and the renderer build contains no remote URL or local server dependency.

- [ ] **Step 8: Perform a development-Electron UI walkthrough without overstating it**

Launch the built app in the available Windows development environment, create the explicit fictional demo lesson, preview “独立学习增加 5 分钟”, confirm once, and observe the new five-file manifest and diff. Record environment and screenshots/logs as development evidence only. Do not label this a clean-Windows installer or Office/WPS fidelity test.

- [ ] **Step 9: Update progress files and commit G07-T03**

Record the UI walkthrough separately from automated tests. Keep CLS-027/031/039 at NOT_RUN if the exact full acceptance environment was not exercised.

Commit:

```powershell
git add apps/desktop/src apps/desktop/tests PROGRESS.md HANDOFF.md
git commit -m "feat(G07-T03): add one-change lesson regeneration UI"
```

---

### Task 4: G07-T04 Failure Downgrade, Retry Cutoff, and Consistency Regression

**Files:**
- Create: `apps/desktop/src/main/review/bundleReview.ts`
- Create: `apps/desktop/tests/g07-bundle-failure.test.ts`
- Create: `reports/G07_EVIDENCE.md`
- Modify: `apps/desktop/src/main/materials/publish.ts`
- Modify: `apps/desktop/src/main/change/service.ts`
- Modify: `apps/desktop/src/main/db/sqliteStore.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/tests/materials.test.ts`
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: Task 2 `BundleIo`, `LessonChangeService`, review/store contracts.
- Produces: `reviewMaterialSet(plan, set): Promise<ReviewIssue[]>`.
- Produces: persistent three-attempt cutoff in `lesson_change_idempotency`.
- Replaces: unsafe swallowing of file and manifest errors in `IpcService.materialsGenerate`.

**Acceptance mapping:** JOB-007 and the failure/old-version portions of CLS-021–023 and CLS-039 receive fault-injection regression coverage. Office/WPS, clean-Windows, real-provider, and signing evidence remain separate external gates.

- [ ] **Step 1: Write failing material consistency tests**

Extend `materials.test.ts` or create focused tests for:

```ts
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function docxWithText(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')!.file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

it('rejects a bundle missing any one of the exact five outputs', async () => {
  const plan = buildLessonPlan(demoLessonSpec());
  const set = await buildMaterialSet(plan, 'authored');
  set.files.pop();
  const issues = await reviewMaterialSet(plan, set);
  expect(issues).toContainEqual(expect.objectContaining({ severity: 'blocking', rule_id: 'bundle_exact_five', return_module: 'M09' }));
});

it('rejects teacher-only content in student files', async () => {
  const plan = buildLessonPlan(demoLessonSpec());
  const set = await buildMaterialSet(plan, 'authored');
  const student = set.files.find((x) => x.role === 'student' && x.format === 'docx')!;
  student.bytes = await docxWithText('教师动作：范读并纠音');
  student.sha256 = sha256(student.bytes);
  const issues = await reviewMaterialSet(plan, set);
  expect(issues).toContainEqual(expect.objectContaining({ rule_id: 'student_role_leak', return_module: 'M09' }));
});
```

Also cover revision mismatch, SHA mismatch, teacher-private unknowns leaking into presentation, and task/answer synchronization after edit.

- [ ] **Step 2: Run material consistency tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/materials.test.ts
```

Expected: FAIL because `reviewMaterialSet` is absent.

- [ ] **Step 3: Implement full bundle review**

`reviewMaterialSet` must:

- require the exact five role/format pairs;
- recalculate every byte hash;
- parse DOCX/PPTX/PDF through the existing extraction code;
- require the same plan and revision identity in every parseable output;
- assert student files exclude `teacher_notes`, acceptable variants, insufficient examples, teacher actions, teacher summary, and unknowns;
- assert presentation excludes teacher-private unknowns, teacher summary, and teacher-only actions;
- assert task prompts and teacher answer ranges reflect the candidate plan.

Return only deterministic M09 issues; do not claim Office layout fidelity.

- [ ] **Step 4: Run material consistency tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Write failing filesystem/transaction fault tests**

Create `g07-bundle-failure.test.ts` with a `FaultingBundleIo` wrapper around real temporary files. Parameterize failures at:

1. each of the five writes;
2. each reread/hash check;
3. directory rename;
4. SQLite before revision insert;
5. after revision insert;
6. after bundle insert;
7. after artifact insert;
8. before current-pointer update;
9. before idempotency success insert.

For every case assert:

```ts
expect(store.getLessonRevision(planId)?.revisionId).toBe(baseRevisionId);
expect(store.listMaterialArtifacts(planId, baseRevisionId)).toEqual(oldArtifacts);
expect(store.getLessonRevision(planId, candidateRevisionId)).toBeNull();
```

Add a retry test: the same key/fingerprint fails three times with `DISK_FULL`; the fourth attempt returns `failed_final` without invoking `buildMaterialSet` or filesystem writes.

- [ ] **Step 6: Run fault tests and verify RED**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g07-bundle-failure.test.ts
```

Expected: FAIL because commit fault hooks, failure persistence, and cutoff are absent.

- [ ] **Step 7: Add transaction hooks and persistent failure cutoff**

Extend `SqliteStoreOptions` with G07-only test hooks named after transaction boundaries. Invoke them inside `commitLessonChange`; thrown errors roll back the entire transaction.

Add:

```ts
recordLessonChangeFailure(key: string, fingerprint: string, errorCode: string): number;
getLessonChangeAttempt(key: string, fingerprint: string): { failureCount: number; status: string } | null;
```

`recordLessonChangeFailure` uses its own short transaction after cleanup. At count 3 set status `failed_final`. A fingerprint mismatch remains key reuse and does not increment the count. On the fourth call, service returns the reliable base revision and does not generate or write files.

- [ ] **Step 8: Make both generation routes fail closed**

Update `LessonChangeService.apply` to call `reviewMaterialSet` before staging and to record typed failures after cleanup. Replace `IpcService.materialsGenerate` direct `mkdirSync`/`writeFileSync`/ignored errors with the same staging, bundle review, disk verification, and bundle commit service for an existing revision.

Add a dedicated atomic store method for the non-change G06 route so it does not invent a `ChangeProposal`:

```ts
commitMaterialBundle(input: {
  bundle: MaterialBundleRecord;
  artifacts: MaterialArtifactRecord[];
  review: ReviewReportRecord;
}): void;
```

It inserts the bundle, exactly five artifacts, and review in one `IMMEDIATE` transaction without changing `lesson_plan.current_revision_id`.

Remove every empty catch that currently permits a success manifest after a write or DB failure. Map failures to an honest IPC error and include `旧版未受影响` in the Chinese message.

- [ ] **Step 9: Run fault and regression tests and verify GREEN**

Run:

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/g07-bundle-failure.test.ts tests/materials.test.ts tests/g07-change-sqlite.test.ts
```

Expected: PASS across all injected boundaries; no candidate revision remains current after a failure.

- [ ] **Step 10: Run final local verification**

Run:

```powershell
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop build
git diff --check
```

Expected: every command exits 0. Capture actual versions, test count, command output, Git commit, and generated bundle SHA-256 values in `reports/G07_EVIDENCE.md`.

- [ ] **Step 11: Record external gates without fabricating evidence**

In `reports/G07_EVIDENCE.md`, `PROGRESS.md`, and `HANDOFF.md`, record these separately:

- deterministic review/change/SQLite/filesystem structural evidence: actual PASS or FAIL;
- development Electron UI walkthrough: actual status and environment;
- clean Windows 11 installer acceptance: `BLOCKED_EXTERNAL` unless actually run in the required clean VM;
- real provider semantic review: `BLOCKED_EXTERNAL` without account/network authorization;
- PowerPoint/WPS/Word fidelity: `BLOCKED_EXTERNAL` unless the actual applications were used;
- release signing: `BLOCKED_EXTERNAL` without signing identity.

Do not edit acceptance case definitions or change NOT_RUN cases to PASS solely because unit tests passed.

- [ ] **Step 12: Commit G07-T04**

```powershell
git add apps/desktop/src apps/desktop/tests reports/G07_EVIDENCE.md PROGRESS.md HANDOFF.md
git commit -m "fix(G07-T04): publish lesson bundles fail-closed with recovery"
```

- [ ] **Step 13: Inspect the four-package history and branch state**

Run:

```powershell
git log --oneline --decorate -6
git status --short --branch
```

Expected: design/plan commits followed by four G07 package commits; working tree clean; no merge to `main`.
