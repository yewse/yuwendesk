import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { SqliteStore, type SqliteStoreOptions } from '../src/main/db/sqliteStore';
import { createTeachingEvent } from '../src/main/feedback/teaching';
import { createObservationRecord } from '../src/main/feedback/observation';
import { FeedbackKeyReuseError, FeedbackSourceMissingError, FeedbackVersionConflictError } from '../src/main/feedback/types';
import { IpcService } from '../src/main/ipc';
import { StoreProtectedError } from '../src/main/store';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g08-observation-'));
}

async function openStore(dir: string, opts: SqliteStoreOptions = {}): Promise<SqliteStore> {
  const store = new SqliteStore(dir, opts);
  stores.add(store);
  await store.load();
  return store;
}

function seedPlan(store: SqliteStore) {
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

function seedTeaching(store: SqliteStore, plan: ReturnType<typeof buildLessonPlan>) {
  const event = createTeachingEvent(
    {
      workspaceId: 'workspace_default',
      planId: plan.plan_id,
      planRevisionId: plan.revision_id,
      taughtAt: '2026-09-20T07:30:00.000Z',
      actualDurationSec: 2400,
      implementationState: 'completed',
      adjustmentSummary: ''
    },
    { eventId: () => 'teaching_1', now: () => '2026-09-20T08:00:00.000Z' }
  );
  store.recordTeaching({
    workspaceId: 'workspace_default',
    planId: plan.plan_id,
    planRevisionId: plan.revision_id,
    expectedRevision: 0,
    idempotencyKey: 'teaching-key',
    fingerprint: 'teaching-fingerprint',
    event
  });
  return event;
}

function observationFor(plan: ReturnType<typeof buildLessonPlan>) {
  const taskId = plan.tasks[0]?.task_id;
  if (!taskId) throw new Error('fixture_missing_task');
  return createObservationRecord(
    {
      workspaceId: 'workspace_default',
      planRevisionId: plan.revision_id,
      teachingEventId: 'teaching_1',
      taskId,
      sourceKind: 'teacher_observation',
      observedAt: '2026-09-20T08:10:00.000Z',
      outcome: 'needed_prompt',
      supportLevel: 'partial_prompt',
      materialRelation: 'same_item',
      delayDays: 0,
      sampleCount: 6,
      populationCount: 42,
      selection: 'typical_cases',
      coverageCaveat: '六份为教师刻意选择的典型作答，不能推算全班比例',
      summary: '部分作答能指出关键词，但书面证据联系仍需提示'
    },
    { observationId: () => 'observation_1' }
  );
}

function addInput(plan: ReturnType<typeof buildLessonPlan>) {
  const record = observationFor(plan);
  return {
    workspaceId: 'workspace_default',
    planId: plan.plan_id,
    teachingEventId: 'teaching_1',
    expectedRevision: 1,
    idempotencyKey: 'observation-key',
    fingerprint: 'observation-fingerprint',
    observation: record.observation,
    outcome: record.outcome,
    createdAt: '2026-09-20T08:11:00.000Z'
  };
}

function service(
  store: SqliteStore,
  confirmObservationDelete: NonNullable<ConstructorParameters<typeof IpcService>[0]['confirmObservationDelete']> = async () => null
): IpcService {
  return new IpcService({
    store,
    lessonStore: store,
    feedbackStore: store,
    confirmObservationDelete,
    appVersion: '0.1.0',
    appNameZh: 'G08 observation test',
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

describe('G08-T02 real SQLite observation boundary', () => {
  it('rejects an observation without its TeachingEvent and writes no row', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);

    expect(() => store.addObservation({ ...addInput(plan), expectedRevision: 0 })).toThrow(FeedbackSourceMissingError);
    expect(store.listObservations(plan.plan_id)).toEqual([]);
  });

  it('atomically saves the strict observation and separate outcome and advances the stream', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    seedTeaching(store, plan);

    expect(store.addObservation(addInput(plan))).toEqual({
      streamRevision: 2,
      value: { teachingEventId: 'teaching_1', ...observationFor(plan) },
      replayed: false
    });
    expect(store.listObservations(plan.plan_id)).toEqual([{ teachingEventId: 'teaching_1', ...observationFor(plan) }]);
    expect(store.feedbackKnowledgeState(plan.plan_id)).toBe('observed');
  });

  it('keeps skipped feedback unknown because skipping writes no observation', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    seedTeaching(store, plan);

    expect(store.listObservations(plan.plan_id)).toEqual([]);
    expect(store.getFeedbackHistory(plan.plan_id).knowledgeState).toBe('unknown');
  });

  it('restarts with the exact validated record and persistent idempotency', async () => {
    const dir = tempDir();
    const first = await openStore(dir);
    const plan = seedPlan(first);
    seedTeaching(first, plan);
    const input = addInput(plan);
    first.addObservation(input);
    first.close();
    stores.delete(first);

    const reopened = await openStore(dir);
    expect(reopened.listObservations(plan.plan_id)).toEqual([{ teachingEventId: 'teaching_1', ...observationFor(plan) }]);
    expect(reopened.addObservation(input)).toMatchObject({ streamRevision: 2, replayed: true });
    expect(() => reopened.addObservation({ ...input, fingerprint: 'different' })).toThrow(FeedbackKeyReuseError);
    expect(() => reopened.addObservation({ ...input, idempotencyKey: 'stale-key' })).toThrow(FeedbackVersionConflictError);
  });

  it('rolls back when outcome persistence fails after the observation insert', async () => {
    const store = await openStore(tempDir(), {
      feedbackFaults: { afterObservationInsert: () => { throw new Error('outcome_fault'); } }
    });
    const plan = seedPlan(store);
    seedTeaching(store, plan);

    expect(() => store.addObservation(addInput(plan))).toThrow('outcome_fault');
    expect(store.listObservations(plan.plan_id)).toEqual([]);
    expect(store.getFeedbackHistory(plan.plan_id).streamRevision).toBe(1);
  });

  it('fails closed instead of hiding an observation whose companion outcome is missing', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    seedTeaching(store, plan);
    store.addObservation(addInput(plan));
    store.withTransaction((db) => db.prepare('DELETE FROM observation_outcome WHERE observation_id=?').run('observation_1'));

    expect(() => store.listObservations(plan.plan_id)).toThrow(StoreProtectedError);
  });
});

describe('G08-T02 observation IPC and confirmed deletion', () => {
  function envelope(operation: string, payload: Record<string, unknown>, expectedRevision?: number, idempotencyKey?: string) {
    return {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: `req-${operation}`,
      operation,
      workspace_id: 'workspace_default',
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      payload
    };
  }

  it('maps a missing TeachingEvent to SOURCE_MISSING', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    const record = observationFor(plan);
    const observation = record.observation;
    const response = await service(store).handle(
      'observations.add',
      envelope(
        'observations.add',
        {
          planId: plan.plan_id,
          planRevisionId: observation.plan_revision_id,
          teachingEventId: 'teaching_1',
          taskId: observation.task_id,
          sourceKind: observation.source_kind,
          observedAt: observation.observed_at,
          outcome: record.outcome.outcome,
          supportLevel: observation.support_level,
          materialRelation: observation.material_relation,
          delayDays: observation.delay_days,
          sampleCount: observation.sample_count,
          populationCount: observation.population_count,
          selection: observation.selection,
          coverageCaveat: observation.coverage_caveat,
          summary: observation.summary
        },
        0,
        'ipc-observation-key'
      )
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'SOURCE_MISSING' } });
    expect(store.listObservations(plan.plan_id)).toEqual([]);
  });

  it('rejects deletion without a prepared one-time confirmation token', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    seedTeaching(store, plan);
    store.addObservation(addInput(plan));

    await expect(
      service(store).handle(
        'observations.delete',
        envelope(
          'observations.delete',
          { planId: plan.plan_id, observationId: 'observation_1', confirmationToken: 'invented-token' },
          2,
          'delete-key'
        )
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'INPUT_INVALID' } });
    expect(store.listObservations(plan.plan_id)).toHaveLength(1);
  });

  it('deletes after native confirmation, leaves a content-free tombstone, and consumes the token', async () => {
    const store = await openStore(tempDir());
    const plan = seedPlan(store);
    seedTeaching(store, plan);
    store.addObservation(addInput(plan));
    const api = service(store, async ({ observationId }) => ({
      token: `confirmed-${observationId}`,
      expiresAt: Date.now() + 60_000
    }));
    const prepared = await api.handle(
      'observations.prepareDelete',
      envelope('observations.prepareDelete', { planId: plan.plan_id, observationId: 'observation_1' })
    );
    expect(prepared).toMatchObject({ ok: true, data: { confirmationToken: 'confirmed-observation_1' } });
    if (!prepared.ok) throw new Error('confirmation_not_prepared');

    const deletion = envelope(
      'observations.delete',
      { planId: plan.plan_id, observationId: 'observation_1', confirmationToken: prepared.data.confirmationToken },
      2,
      'delete-key'
    );
    await expect(api.handle('observations.delete', deletion)).resolves.toMatchObject({
      ok: true,
      data: { streamRevision: 3, replayed: false, value: { observationId: 'observation_1' } }
    });
    await expect(api.handle('observations.delete', deletion)).resolves.toMatchObject({
      ok: true,
      data: { streamRevision: 3, replayed: true, value: { observationId: 'observation_1' } }
    });
    expect(store.listObservations(plan.plan_id)).toEqual([]);
    expect(store.feedbackKnowledgeState(plan.plan_id)).toBe('deleted');
    const tombstone = store.withTransaction((db) =>
      db.prepare('SELECT backup_scope_json backupScopeJson FROM observation_tombstone WHERE observation_id=?').get('observation_1') as { backupScopeJson: string }
    );
    expect(JSON.parse(tombstone.backupScopeJson)).toEqual({
      observationId: 'observation_1',
      planId: plan.plan_id,
      deletedAt: expect.any(String),
      backupScopesNotCovered: ['external_or_offline_backups']
    });
    expect(tombstone.backupScopeJson).not.toContain('部分作答');
    await expect(api.handle('observations.delete', { ...deletion, idempotency_key: 'another-delete-key' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INPUT_INVALID' }
    });
  });

  it('rolls back a failed deletion and does not write a success tombstone', async () => {
    const store = await openStore(tempDir(), {
      feedbackFaults: { afterObservationDelete: () => { throw new Error('delete_fault'); } }
    });
    const plan = seedPlan(store);
    seedTeaching(store, plan);
    store.addObservation(addInput(plan));

    expect(() =>
      store.deleteObservation({
        workspaceId: 'workspace_default',
        planId: plan.plan_id,
        observationId: 'observation_1',
        expectedRevision: 2,
        idempotencyKey: 'delete-key',
        fingerprint: 'delete-fingerprint',
        confirmationToken: 'confirmed-test-token',
        deletedAt: '2026-09-20T09:00:00.000Z',
        backupScopesNotCovered: ['external_or_offline_backups']
      })
    ).toThrow('delete_fault');
    expect(store.listObservations(plan.plan_id)).toHaveLength(1);
    expect(
      store.withTransaction((db) => db.prepare('SELECT COUNT(*) count FROM observation_tombstone').get() as { count: number }).count
    ).toBe(0);
  });
});
