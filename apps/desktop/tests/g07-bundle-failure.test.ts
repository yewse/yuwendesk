import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LessonChangeDiskError,
  LessonChangeKeyReuseError,
  LessonChangeService,
  type LessonChangeIds
} from '../src/main/change/service';
import {
  SqliteStore,
  type LessonChangeCommitFaultHooks,
  type SqliteStoreOptions
} from '../src/main/db/sqliteStore';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import { buildMaterialSet } from '../src/main/materials/generate';
import { nodeBundleIo, type BundleIo } from '../src/main/materials/publish';
import { IpcService } from '../src/main/ipc';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

const stores = new Set<SqliteStore>();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g07-failure-'));
}

async function openStore(dir: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
  const store = new SqliteStore(dir, options);
  stores.add(store);
  await store.load();
  return store;
}

function deterministicIds(prefix: string): LessonChangeIds {
  let sequence = 0;
  const next = (kind: string): string => `${kind}_${prefix}_${++sequence}`;
  return {
    changeId: () => next('change'),
    revisionId: () => next('revision'),
    bundleId: () => next('bundle'),
    reportId: () => next('report'),
    issueId: () => next('issue'),
    artifactId: () => next('artifact'),
    now: () => `2026-09-20T01:00:${String(sequence).padStart(2, '0')}.000Z`
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

function requestFor(plan: ReturnType<typeof saveBase>, key: string) {
  return {
    planId: plan.plan_id,
    baseRevisionId: plan.revision_id,
    idempotencyKey: key,
    change: {
      kind: 'edit_task' as const,
      taskId: plan.tasks[0].task_id,
      prompt: '故障测试后的新任务',
      acceptableVariants: ['故障测试后的新答案']
    }
  };
}

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
}

function faultingIo(method: 'writeFile' | 'readFile' | 'rename', occurrence: number): BundleIo {
  let seen = 0;
  return {
    ...nodeBundleIo,
    [method]: async (...args: [string, Buffer] | [string, string] | [string]) => {
      seen += 1;
      if (seen === occurrence) throw enospc();
      return (nodeBundleIo[method] as (...actual: unknown[]) => Promise<unknown>)(...args);
    }
  } as BundleIo;
}

function expectUnchanged(store: SqliteStore, planId: string, revisionId: string): void {
  const history = store.listLessonChangeHistory(planId);
  expect(history.revisions).toHaveLength(1);
  expect(history.proposals).toHaveLength(0);
  expect(history.bundles).toHaveLength(0);
  expect(store.getLessonRevision(planId)?.revisionId).toBe(revisionId);
  expect(store.listMaterialArtifacts(planId)).toHaveLength(0);
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe('G07-T04 filesystem fail-closed boundaries', () => {
  const boundaries = [
    ...Array.from({ length: 5 }, (_, index) => ({ method: 'writeFile' as const, occurrence: index + 1 })),
    ...Array.from({ length: 5 }, (_, index) => ({ method: 'readFile' as const, occurrence: index + 1 })),
    { method: 'rename' as const, occurrence: 1 }
  ];

  for (const boundary of boundaries) {
    it(`${boundary.method} #${boundary.occurrence} 失败时不推进修订、清单或当前指针`, async () => {
      const dir = tempDir();
      const store = await openStore(dir);
      const plan = saveBase(store);
      const service = new LessonChangeService(store, {
        rootDir: join(dir, 'materials'),
        io: faultingIo(boundary.method, boundary.occurrence),
        ids: deterministicIds(`${boundary.method}-${boundary.occurrence}`)
      });
      const request = requestFor(plan, `${boundary.method}-${boundary.occurrence}`);

      await expect(service.apply(request)).rejects.toBeInstanceOf(LessonChangeDiskError);

      expectUnchanged(store, plan.plan_id, plan.revision_id);
      expect(store.findLessonChangeIdempotency(request.idempotencyKey)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        errorCode: 'DISK_FULL'
      });
      const staging = join(dir, 'materials', '.staging');
      expect(!existsSync(staging) || readdirSync(staging).length === 0).toBe(true);
    });
  }
});

describe('G07-T04 SQLite transaction fail-closed boundaries', () => {
  const boundaries: Array<keyof LessonChangeCommitFaultHooks> = [
    'beforeRevisionInsert',
    'afterRevisionInsert',
    'afterBundleInsert',
    'afterArtifactInsert',
    'beforeCurrentPointerUpdate',
    'beforeIdempotencySuccess'
  ];

  for (const boundary of boundaries) {
    it(`${boundary} 抛错时整个业务事务回滚且已发布目录被清理`, async () => {
      const dir = tempDir();
      const lessonChangeFaults = {
        [boundary]: () => {
          throw new Error(`injected:${boundary}`);
        }
      } satisfies LessonChangeCommitFaultHooks;
      const store = await openStore(dir, { lessonChangeFaults });
      const plan = saveBase(store);
      const service = new LessonChangeService(store, {
        rootDir: join(dir, 'materials'),
        ids: deterministicIds(boundary)
      });
      const request = requestFor(plan, boundary);

      await expect(service.apply(request)).rejects.toThrow(`injected:${boundary}`);

      expectUnchanged(store, plan.plan_id, plan.revision_id);
      expect(store.findLessonChangeIdempotency(request.idempotencyKey)).toMatchObject({ status: 'failed', failureCount: 1 });
      const revisionRoot = join(dir, 'materials');
      const publishedFiles = existsSync(revisionRoot)
        ? readdirSync(revisionRoot, { recursive: true }).filter((name) => /\.(docx|pdf|pptx)$/.test(String(name)))
        : [];
      expect(publishedFiles).toHaveLength(0);
    });
  }
});

describe('G07-T04 persistent retry cutoff and legacy generation path', () => {
  it('同一请求前三次失败被持久计数，第四次直接返回 failed_final 且不再生成或写文件', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const plan = saveBase(store);
    let builds = 0;
    let writes = 0;
    const service = new LessonChangeService(store, {
      rootDir: join(dir, 'materials'),
      ids: deterministicIds('cutoff'),
      buildSet: async (...args) => {
        builds += 1;
        return buildMaterialSet(...args);
      },
      io: {
        ...nodeBundleIo,
        writeFile: async () => {
          writes += 1;
          throw enospc();
        }
      }
    });
    const request = requestFor(plan, 'cutoff-key');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(service.apply(request)).rejects.toBeInstanceOf(LessonChangeDiskError);
    }
    await expect(
      service.apply({ ...request, change: { ...request.change, prompt: '同键但不同载荷' } })
    ).rejects.toBeInstanceOf(LessonChangeKeyReuseError);
    const fourth = await service.apply(request);

    expect(fourth).toEqual({
      status: 'failed_final',
      planId: plan.plan_id,
      revisionId: plan.revision_id,
      failureCount: 3,
      errorCode: 'DISK_FULL'
    });
    expect(builds).toBe(3);
    expect(writes).toBe(3);
    expect(store.findLessonChangeIdempotency(request.idempotencyKey)).toMatchObject({
      status: 'failed_final',
      failureCount: 3,
      errorCode: 'DISK_FULL'
    });
    const fingerprint = store.findLessonChangeIdempotency(request.idempotencyKey)!.fingerprint;
    expect(store.getLessonChangeAttempt(request.idempotencyKey, fingerprint)).toEqual({
      status: 'failed_final',
      failureCount: 3
    });
    expectUnchanged(store, plan.plan_id, plan.revision_id);
  });

  it('materials.generate 成功时以一个事务登记包、五文件与复核报告', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const plan = saveBase(store);
    const ipc = new IpcService({
      store,
      lessonStore: store,
      userDataDir: dir,
      appVersion: '0.1.0',
      appNameZh: 'G07 bundle test',
      platformSupported: true,
      httpListeners: 0,
      online: false,
      buildMode: 'production',
      sandboxEnabled: true,
      platformDevOverride: false,
      platformTargetSupported: true,
      platformIdentity: 'win11'
    });

    const response = await ipc.handle('materials.generate', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'materials-success',
      operation: 'materials.generate',
      workspace_id: null,
      payload: { planId: plan.plan_id }
    });

    expect(response.ok).toBe(true);
    expect(store.listMaterialArtifacts(plan.plan_id, plan.revision_id)).toHaveLength(5);
    expect(store.listLessonChangeHistory(plan.plan_id).bundles).toHaveLength(1);
    expect(store.getLatestReviewReport(plan.plan_id, plan.revision_id)?.report.executed_checks).toContain(
      'material_bundle_consistency'
    );
  });

  it('materials.generate 写入目录不可用时返回失败且不登记不存在的文件', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const plan = saveBase(store);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'materials'), 'not a directory');
    const ipc = new IpcService({
      store,
      lessonStore: store,
      userDataDir: dir,
      appVersion: '0.1.0',
      appNameZh: 'G07 failure test',
      platformSupported: true,
      httpListeners: 0,
      online: false,
      buildMode: 'production',
      sandboxEnabled: true,
      platformDevOverride: false,
      platformTargetSupported: true,
      platformIdentity: 'win11'
    });

    const response = await ipc.handle('materials.generate', {
      schema_version: IPC_SCHEMA_VERSION,
      request_id: 'materials-failure',
      operation: 'materials.generate',
      workspace_id: null,
      payload: { planId: plan.plan_id }
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('DISK_FULL');
    expect(store.listMaterialArtifacts(plan.plan_id)).toHaveLength(0);
    expect(store.listLessonChangeHistory(plan.plan_id).bundles).toHaveLength(0);
  });
});
