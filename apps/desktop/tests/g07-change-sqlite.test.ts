import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import {
  LessonChangeConflictError,
  LessonChangeKeyReuseError,
  LessonChangeService,
  type LessonChangeIds
} from '../src/main/change/service';
import { IpcService } from '../src/main/ipc';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g07-change-'));
}

async function openStore(dir: string): Promise<SqliteStore> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  return store;
}

function deterministicIds(prefix = 'test'): LessonChangeIds {
  let sequence = 0;
  const next = (kind: string): string => `${kind}_${prefix}_${++sequence}`;
  return {
    changeId: () => next('change'),
    revisionId: () => next('revision'),
    bundleId: () => next('bundle'),
    reportId: () => next('report'),
    issueId: () => next('issue'),
    artifactId: () => next('artifact'),
    now: () => `2026-09-20T00:00:${String(sequence).padStart(2, '0')}.000Z`
  };
}

function saveBase(store: SqliteStore) {
  const plan = buildLessonPlan(demoLessonSpec());
  store.saveLessonRevision(
    {
      revisionId: plan.revision_id,
      planId: plan.plan_id,
      previousRevisionId: null,
      title: plan.title,
      contentJson: JSON.stringify(plan),
      contentOrigin: 'authored',
      valid: true,
      createdAt: '2026-09-20T00:00:00.000Z'
    },
    true
  );
  return plan;
}

function ipcService(store: SqliteStore, dir: string): IpcService {
  return new IpcService({
    store,
    lessonStore: store,
    userDataDir: dir,
    appVersion: '0.1.0',
    appNameZh: 'G07 change test',
    platformSupported: true,
    httpListeners: 0,
    online: false,
    buildMode: 'production',
    sandboxEnabled: true,
    platformDevOverride: false,
    platformTargetSupported: true,
    platformIdentity: 'win11'
  });
}

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // Preserve the original assertion failure.
    }
  }
  stores.clear();
});

describe('G07-T02 real SQLite lesson change commit', () => {
  it('replays the original success after reopen and rejects same-key different payload', async () => {
    const dir = tempDir();
    const firstStore = await openStore(dir);
    const base = saveBase(firstStore);
    const firstService = new LessonChangeService(firstStore, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('first')
    });
    const request = {
      planId: base.plan_id,
      baseRevisionId: base.revision_id,
      idempotencyKey: 'same-key',
      change: { kind: 'edit_task' as const, taskId: base.tasks[0].task_id, prompt: '修改后的题意', acceptableVariants: ['依据原文作答'] }
    };
    const applied = await firstService.apply(request);
    firstStore.close();
    stores.delete(firstStore);

    const reopened = await openStore(dir);
    const secondService = new LessonChangeService(reopened, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('second')
    });
    await expect(secondService.apply(request)).resolves.toEqual(applied);
    await expect(
      secondService.apply({
        ...request,
        change: { ...request.change, prompt: '同键的另一份载荷' }
      })
    ).rejects.toBeInstanceOf(LessonChangeKeyReuseError);
  });

  it('allows exactly one of two keys against the same base revision to commit', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const base = saveBase(store);
    const service = new LessonChangeService(store, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('race')
    });

    const results = await Promise.allSettled([
      service.apply({
        planId: base.plan_id,
        baseRevisionId: base.revision_id,
        idempotencyKey: 'race-a',
        change: { kind: 'edit_task', taskId: base.tasks[0].task_id, prompt: '方案 A', acceptableVariants: ['答案 A'] }
      }),
      service.apply({
        planId: base.plan_id,
        baseRevisionId: base.revision_id,
        idempotencyKey: 'race-b',
        change: { kind: 'edit_task', taskId: base.tasks[0].task_id, prompt: '方案 B', acceptableVariants: ['答案 B'] }
      })
    ]);

    const diagnostics = results.map((result) =>
      result.status === 'fulfilled'
        ? 'fulfilled'
        : `${result.reason instanceof Error ? result.reason.name : typeof result.reason}:${result.reason instanceof Error ? result.reason.message : String(result.reason)}:${JSON.stringify((result.reason as { issues?: unknown }).issues ?? [])}`
    );
    expect(results.filter((result) => result.status === 'fulfilled'), diagnostics.join(' | ')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(LessonChangeConflictError);
    expect(store.listLessonChangeHistory(base.plan_id).revisions).toHaveLength(2);
  });

  it('commits revision, accepted proposal, review, bundle, five verified artifacts, and current pointer together', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const base = saveBase(store);
    const service = new LessonChangeService(store, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('atomic')
    });

    const result = await service.apply({
      planId: base.plan_id,
      baseRevisionId: base.revision_id,
      idempotencyKey: 'atomic-key',
      change: { kind: 'edit_rubric', rubricId: base.rubrics[0].rubric_id, acceptableVariants: ['新的合理答案'] }
    });

    const history = store.listLessonChangeHistory(base.plan_id);
    expect(history.revisions).toHaveLength(2);
    expect(store.getLessonRevision(base.plan_id, base.revision_id)).not.toBeNull();
    expect(store.getLessonRevision(base.plan_id)?.revisionId).toBe(result.revisionId);
    expect(history.proposals).toHaveLength(1);
    expect(history.proposals[0].proposal.status).toBe('accepted');
    expect(history.bundles).toHaveLength(1);
    expect(store.getLatestReviewReport(base.plan_id, result.revisionId)).not.toBeNull();
    const artifacts = store.listMaterialArtifacts(base.plan_id, result.revisionId);
    expect(artifacts).toHaveLength(5);
    expect(new Set(artifacts.map((artifact) => artifact.bundleId))).toEqual(new Set([result.bundleId]));
    for (const artifact of artifacts) {
      expect(existsSync(artifact.path)).toBe(true);
      expect(createHash('sha256').update(readFileSync(artifact.path)).digest('hex')).toBe(artifact.sha256);
    }
  });

  it('presentation-only apply keeps the semantic revision and adds a second bundle', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const base = saveBase(store);
    const service = new LessonChangeService(store, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('presentation')
    });

    const first = await service.apply({
      planId: base.plan_id,
      baseRevisionId: base.revision_id,
      idempotencyKey: 'presentation-a',
      change: { kind: 'presentation_only', fontScale: 1, paperSize: 'A4', theme: 'light' }
    });
    const second = await service.apply({
      planId: base.plan_id,
      baseRevisionId: base.revision_id,
      idempotencyKey: 'presentation-b',
      change: { kind: 'presentation_only', fontScale: 1.25, paperSize: 'Letter', theme: 'high_contrast' }
    });

    expect(first.revisionId).toBe(base.revision_id);
    expect(second.revisionId).toBe(base.revision_id);
    const history = store.listLessonChangeHistory(base.plan_id);
    expect(history.revisions).toHaveLength(1);
    expect(history.bundles).toHaveLength(2);
    expect(new Set(history.bundles.map((bundle) => bundle.presentationSpecHash)).size).toBe(2);
    const artifacts = store.listMaterialArtifacts(base.plan_id, base.revision_id);
    const firstPresentation = artifacts.find(
      (artifact) => artifact.bundleId === first.bundleId && artifact.role === 'presentation'
    );
    const secondPresentation = artifacts.find(
      (artifact) => artifact.bundleId === second.bundleId && artifact.role === 'presentation'
    );
    expect(firstPresentation?.sha256).not.toBe(secondPresentation?.sha256);
    expect(store.getLessonRevision(base.plan_id)?.revisionId).toBe(base.revision_id);
  });

  it('exposes narrow IPC gates and rejects nested extra fields or a missing apply idempotency key', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const base = saveBase(store);
    const service = ipcService(store, dir);
    const payload = {
      planId: base.plan_id,
      baseRevisionId: base.revision_id,
      change: {
        kind: 'edit_task',
        taskId: base.tasks[0].task_id,
        prompt: 'IPC 修改',
        acceptableVariants: ['有依据'],
        hidden: true
      }
    };
    const preview = await service.handle('change.preview', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'preview-invalid',
      operation: 'change.preview',
      workspace_id: null,
      payload
    });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.code).toBe('INPUT_INVALID');

    delete (payload.change as { hidden?: boolean }).hidden;
    const apply = await service.handle('change.apply', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'apply-no-key',
      operation: 'change.apply',
      workspace_id: null,
      payload
    });
    expect(apply.ok).toBe(false);
    if (!apply.ok) expect(apply.error.code).toBe('INPUT_INVALID');
  });
});
