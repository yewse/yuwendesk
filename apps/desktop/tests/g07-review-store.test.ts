import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../src/main/db/sqliteStore';
import { IpcService } from '../src/main/ipc';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';
import type { ReviewReport } from '../src/main/review/types';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g07-review-'));
}

async function openStore(dir: string): Promise<SqliteStore> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  return store;
}

function service(store: SqliteStore): IpcService {
  return new IpcService({
    store,
    lessonStore: store,
    appVersion: '0.1.0',
    appNameZh: 'G07 review test',
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

function reviewReq(planId: string, revisionId?: string) {
  return {
    schema_version: IPC_SCHEMA_VERSION,
    request_id: 'review-1',
    operation: 'review.run' as const,
    workspace_id: null,
    payload: revisionId ? { planId, revisionId } : { planId }
  };
}

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // Test cleanup must not hide the original assertion failure.
    }
  }
  stores.clear();
});

describe('G07-T01 review persistence and IPC', () => {
  it('persists an exact deterministic report across reopening the database', async () => {
    const dir = tempDir();
    const first = await openStore(dir);
    const plan = buildLessonPlan(demoLessonSpec());
    first.saveLessonRevision(
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

    const response = await service(first).handle('review.run', reviewReq(plan.plan_id, plan.revision_id));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const report = (response.data as { report: ReviewReport }).report;
    expect(report.plan_revision_id).toBe(plan.revision_id);
    expect(report.is_effectiveness_proof).toBe(false);

    first.close();
    stores.delete(first);
    const reopened = await openStore(dir);
    expect(reopened.getLatestReviewReport(plan.plan_id, plan.revision_id)?.report).toEqual(report);
  });

  it('rejects extra review.run payload properties at the schema gate', async () => {
    const store = await openStore(tempDir());
    const response = await service(store).handle('review.run', {
      ...reviewReq('plan_missing'),
      payload: { planId: 'plan_missing', extra: true }
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('INPUT_INVALID');
  });

  it('returns SOURCE_MISSING when the requested revision does not exist', async () => {
    const store = await openStore(tempDir());
    const response = await service(store).handle('review.run', reviewReq('plan_missing'));

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('SOURCE_MISSING');
  });

  it('refuses to return a stored report that no longer satisfies the strict contract', async () => {
    const store = await openStore(tempDir());
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
    const response = await service(store).handle('review.run', reviewReq(plan.plan_id));
    expect(response.ok).toBe(true);
    store.withTransaction((db) => db.prepare("UPDATE review_report SET report_json='{}'").run());

    expect(() => store.getLatestReviewReport(plan.plan_id, plan.revision_id)).toThrow('invalid_stored_review_report');
  });

  it('returns DATABASE_LOCKED before reading or writing through a protected store', async () => {
    const dir = tempDir();
    const seed = await openStore(dir);
    seed.withTransaction((db) => db.pragma(`user_version = ${SQLITE_SCHEMA_TARGET + 1}`));
    seed.close();
    stores.delete(seed);
    const protectedStore = await openStore(dir);

    const response = await service(protectedStore).handle('review.run', reviewReq('plan_any'));

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('DATABASE_LOCKED');
  });
});
