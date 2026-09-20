import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../src/main/db/sqliteStore';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { FeedbackKeyReuseError, FeedbackVersionConflictError } from '../src/main/feedback/types';
import { IpcService } from '../src/main/ipc';
import { StoreProtectedError } from '../src/main/store';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g08-feedback-'));
}

async function openStore(dir: string): Promise<SqliteStore> {
  const store = new SqliteStore(dir);
  stores.add(store);
  await store.load();
  return store;
}

function saveLesson(store: SqliteStore) {
  const plan = buildLessonPlan(demoLessonSpec());
  store.saveLessonRevision(
    {
      revisionId: plan.revision_id,
      planId: plan.plan_id,
      previousRevisionId: plan.previous_revision_id,
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

function eventFor(plan: ReturnType<typeof buildLessonPlan>) {
  return createTeachingEvent(
    {
      workspaceId: 'workspace_default',
      planId: plan.plan_id,
      planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z',
      actualDurationSec: 2400,
      implementationState: 'completed',
      adjustmentSummary: '按计划完成核心学生任务'
    },
    {
      eventId: () => 'teach_1',
      now: () => '2026-09-20T08:20:00.000Z'
    }
  );
}

function recordInput(plan: ReturnType<typeof buildLessonPlan>) {
  return {
    workspaceId: 'workspace_default',
    planId: plan.plan_id,
    planRevisionId: plan.revision_id,
    expectedRevision: 0,
    idempotencyKey: 'teach-key',
    fingerprint: 'fingerprint-a',
    event: eventFor(plan)
  };
}

function ipcService(store: SqliteStore): IpcService {
  return new IpcService({
    store,
    lessonStore: store,
    feedbackStore: store,
    appVersion: '0.1.0',
    appNameZh: 'G08 feedback test',
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

describe('G08-T01 real SQLite teaching event boundary', () => {
  it('preserves G08 tables while migrating to the current schema target', async () => {
    const store = await openStore(tempDir());
    expect(SQLITE_SCHEMA_TARGET).toBe(11);
    expect(store.schemaVersion()).toBe(11);
  });

  it('persists one teaching event without moving the lesson revision', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    const result = store.recordTeaching(recordInput(plan));

    expect(result).toEqual({ streamRevision: 1, value: eventFor(plan), replayed: false });
    expect(store.getLessonRevision(plan.plan_id)?.revisionId).toBe(plan.revision_id);
    expect(store.getFeedbackHistory(plan.plan_id)).toEqual({
      streamRevision: 1,
      teachingEvents: [eventFor(plan)],
      knowledgeState: 'unknown'
    });
  });

  it('replays across restart and rejects the same key with another fingerprint', async () => {
    const dir = tempDir();
    const first = await openStore(dir);
    const plan = saveLesson(first);
    const input = recordInput(plan);
    first.recordTeaching(input);
    first.close();
    stores.delete(first);

    const reopened = await openStore(dir);
    expect(reopened.recordTeaching(input)).toEqual({ streamRevision: 1, value: eventFor(plan), replayed: true });
    expect(() => reopened.recordTeaching({ ...input, fingerprint: 'fingerprint-b' })).toThrow(FeedbackKeyReuseError);
    expect(reopened.getFeedbackHistory(plan.plan_id).teachingEvents).toHaveLength(1);
  });

  it('allows only one distinct key at the same expected feedback revision', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    const first = recordInput(plan);
    const second = {
      ...recordInput(plan),
      idempotencyKey: 'teach-key-2',
      fingerprint: 'fingerprint-2',
      event: { ...eventFor(plan), event_id: 'teach_2' }
    };

    expect(store.recordTeaching(first).streamRevision).toBe(1);
    expect(() => store.recordTeaching(second)).toThrow(FeedbackVersionConflictError);
    expect(store.getFeedbackHistory(plan.plan_id).teachingEvents).toHaveLength(1);
  });

  it('fails closed when a stored teaching event no longer satisfies the strict contract', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    store.recordTeaching(recordInput(plan));
    store.withTransaction((db) => db.prepare("UPDATE teaching_event SET event_json='{}'").run());

    expect(() => store.getFeedbackHistory(plan.plan_id)).toThrow(StoreProtectedError);
  });
});

describe('G08-T01 plans.recordTeaching IPC', () => {
  function request(plan: ReturnType<typeof buildLessonPlan>, overrides: Record<string, unknown> = {}) {
    return {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'req-teach',
      operation: 'plans.recordTeaching',
      workspace_id: 'workspace_default',
      expected_revision: 0,
      idempotency_key: 'ipc-teach-key',
      payload: {
        planId: plan.plan_id,
        planRevisionId: plan.revision_id,
        taughtAt: '2026-09-20T07:30:00.000Z',
        actualDurationSec: 2400,
        implementationState: 'completed',
        adjustmentSummary: ''
      },
      ...overrides
    };
  }

  it('requires expected revision and idempotency key', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    const service = ipcService(store);

    const missingRevision = request(plan);
    delete missingRevision.expected_revision;
    const missingKey = request(plan);
    delete missingKey.idempotency_key;

    await expect(service.handle('plans.recordTeaching', missingRevision)).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } });
    await expect(service.handle('plans.recordTeaching', missingKey)).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } });
  });

  it('rejects extra fields and a missing lesson revision', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    const service = ipcService(store);

    const extra = request(plan);
    extra.payload = { ...extra.payload, effectiveness: 'proved' };
    await expect(service.handle('plans.recordTeaching', extra)).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } });
    await expect(
      service.handle('plans.recordTeaching', request({ ...plan, revision_id: 'missing_revision' }))
    ).resolves.toMatchObject({ ok: false, error: { code: 'SOURCE_MISSING' } });
  });

  it('records and replays one event through the named operation', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    const service = ipcService(store);
    const req = request(plan);

    const first = await service.handle('plans.recordTeaching', req);
    const replay = await service.handle('plans.recordTeaching', req);

    expect(first).toMatchObject({ ok: true, data: { streamRevision: 1, replayed: false } });
    expect(replay).toEqual({ ...(first as { ok: true; data: Record<string, unknown> }), data: { ...(first as { ok: true; data: Record<string, unknown> }).data, replayed: true } });
    expect(store.getFeedbackHistory(plan.plan_id).teachingEvents).toHaveLength(1);
  });

  it('reads the persisted teaching history through the named operation', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    store.recordTeaching(recordInput(plan));
    const service = ipcService(store);

    await expect(
      service.handle('feedback.history', {
        schema_version: IPC_SCHEMA_VERSION,
        request_id: 'req-feedback-history',
        operation: 'feedback.history',
        workspace_id: 'workspace_default',
        payload: { planId: plan.plan_id }
      })
    ).resolves.toEqual({
      ok: true,
      data: {
        streamRevision: 1,
        teachingEvents: [eventFor(plan)],
        knowledgeState: 'unknown'
      }
    });
  });

  it('returns DATABASE_LOCKED rather than hiding corrupted persisted teaching data', async () => {
    const store = await openStore(tempDir());
    const plan = saveLesson(store);
    store.recordTeaching(recordInput(plan));
    store.withTransaction((db) => db.prepare("UPDATE teaching_event SET event_json='not-json'").run());
    const service = ipcService(store);

    await expect(
      service.handle('feedback.history', {
        schema_version: IPC_SCHEMA_VERSION,
        request_id: 'req-feedback-history-corrupt',
        operation: 'feedback.history',
        workspace_id: 'workspace_default',
        payload: { planId: plan.plan_id }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'DATABASE_LOCKED' } });
  });
});
