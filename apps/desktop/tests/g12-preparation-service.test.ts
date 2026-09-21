import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { IpcService } from '../src/main/ipc';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';
import {
  PreparationService,
  PreparationServiceError,
  exportPreparedMaterials,
  type PreparationModelRunner
} from '../src/main/preparation/service';

const open = new Set<SqliteStore>();
afterEach(() => {
  for (const store of open) {
    try { store.close(); } catch { /* closed */ }
  }
  open.clear();
});

const modelObject = {
  title: '消息二则',
  objectives: [{ description: '把握消息结构', cognitive_demand: 'understand' }],
  tasks: [{
    prompt: '依据材料梳理消息要素。', cognitive_demand: 'explain', support_level: 'independent',
    teacher_notes: '核对材料依据。', acceptable_variants: ['要素完整且有依据。'],
    insufficient_examples: ['没有材料依据。'], anchor_ids: ['source-1']
  }],
  activities: [{
    title: '独立研读', start_sec: 0, end_sec: 2700, actor: 'student',
    student_action: '阅读并作答。', teacher_action: '巡视。', priority: 'essential', task_indexes: [0]
  }],
  teacher_summary: '围绕材料依据组织学习。',
  unknowns: ['本班学情需教师核实。']
};

async function fixture(mode: 'local_authored' | 'model_assisted' = 'local_authored') {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-g12-service-'));
  const store = new SqliteStore(dir);
  open.add(store);
  await store.load();
  const sourceText = '新华社长江前线二十二日二十二时电。';
  const imported = store.importSource({
    title: '教材节选', format: 'txt', content: sourceText, classification: 'licensed_reference'
  });
  if (imported.status !== 'imported') throw new Error('fixture import failed');
  const context = store.saveTeachingContext({
    classDisplayName: '八年级一班', grade: 'grade8', textbookTitle: '语文八年级上册',
    textbookEdition: '统编版', unitTitle: '第一单元', lessonTitle: '消息二则', durationSec: 2700, notes: ''
  }, 0, `ctx-${mode}`);
  const created = store.createPreparationSession(context.contextId, mode, `session-${mode}`);
  const session = store.replacePreparationSources(created.sessionId, [{
    sourceVersionId: imported.versionId,
    charStart: 0,
    charEnd: sourceText.length,
    purpose: 'textbook',
    approvedForModel: mode === 'model_assisted',
    textSha256: createHash('sha256').update(sourceText).digest('hex')
  }], created.revision, `sources-${mode}`);
  return { dir, store, sourceText, imported, context, session };
}

const buildInput = (sessionId: string, expectedRevision: number, idempotencyKey: string) => ({
  sessionId,
  expectedRevision,
  idempotencyKey,
  focus: '把握消息结构',
  coreTask: '依据片段梳理消息六要素。',
  answerScope: '答案限于所选材料支持的内容。'
});

describe('G12 PreparationService', () => {
  it('builds locally without a model and replays the same successful plan', async () => {
    const f = await fixture();
    const service = new PreparationService({ store: f.store });
    const built = await service.build(buildInput(f.session.sessionId, f.session.revision, 'build-local'));
    expect(built).toMatchObject({ status: 'PLAN_REVIEW', contentOrigin: 'teacher_authored' });
    expect(f.store.getLessonRevision(built.planId!, built.revisionId!)).toMatchObject({
      contentOrigin: 'teacher_authored', valid: true
    });
    const replay = await service.build(buildInput(f.session.sessionId, f.session.revision, 'build-local'));
    expect(replay).toEqual(built);
  });

  it.each([
    ['real', false, 'model_assisted_real'],
    ['simulated', true, 'model_assisted_simulated']
  ] as const)('preserves %s model identity', async (contentOrigin, isTestDouble, expectedOrigin) => {
    const f = await fixture('model_assisted');
    const model: PreparationModelRunner = {
      run: async () => ({
        status: 'succeeded', jobId: `job-${contentOrigin}`, result: {
          parsed: modelObject,
          contentOrigin,
          isTestDouble
        }
      })
    };
    const service = new PreparationService({ store: f.store, model });
    const built = await service.build(buildInput(f.session.sessionId, f.session.revision, `build-${contentOrigin}`));
    expect(built.contentOrigin).toBe(expectedOrigin);
    expect(built.modelJobId).toBe(`job-${contentOrigin}`);
  });

  it('returns to sources when the model is unavailable without retrying automatically', async () => {
    const f = await fixture('model_assisted');
    let calls = 0;
    const model: PreparationModelRunner = {
      run: async () => {
        calls += 1;
        return { status: 'blocked', code: 'MODEL_NOT_AVAILABLE' };
      }
    };
    const service = new PreparationService({ store: f.store, model });
    await expect(service.build(buildInput(f.session.sessionId, f.session.revision, 'build-blocked')))
      .rejects.toMatchObject({ code: 'PREPARATION_MODEL_UNAVAILABLE' });
    expect(calls).toBe(1);
    expect(f.store.getPreparationSession(f.session.sessionId)).toMatchObject({
      status: 'SOURCES_SELECTED', lastErrorCode: 'PREPARATION_MODEL_UNAVAILABLE'
    });
  });

  it('fails closed when selected source text drifts', async () => {
    const f = await fixture();
    f.store.withTransaction((db) => {
      db.prepare('UPDATE source_text SET full_text=? WHERE version_id=?').run('已变化的片段', f.imported.versionId);
    });
    const service = new PreparationService({ store: f.store });
    await expect(service.build(buildInput(f.session.sessionId, f.session.revision, 'build-drift')))
      .rejects.toMatchObject({ code: 'PREPARATION_SOURCE_CHANGED' });
    expect(f.store.getPreparationSession(f.session.sessionId)).toMatchObject({ status: 'SOURCES_SELECTED' });
  });

  it('reviews, confirms, exports, and rolls export failure back to READY_TO_EXPORT', async () => {
    const f = await fixture();
    let failExport = true;
    const service = new PreparationService({
      store: f.store,
      exportPlan: async () => {
        if (failExport) throw new Error('disk boundary');
        return { bundleId: 'bundle_1' };
      }
    });
    const built = await service.build(buildInput(f.session.sessionId, f.session.revision, 'build-review'));
    const reviewed = service.review(built.sessionId, built.revision, 'review-1');
    expect(reviewed.report.disposition).toBe('ready_for_teacher');
    const ready = service.confirm(built.sessionId, built.revision, 'confirm-1');
    expect(ready.status).toBe('READY_TO_EXPORT');
    await expect(service.export(ready.sessionId, ready.revision, 'export-fail')).rejects.toBeInstanceOf(PreparationServiceError);
    expect(f.store.getPreparationSession(ready.sessionId)).toMatchObject({
      status: 'READY_TO_EXPORT', lastErrorCode: 'PREPARATION_EXPORT_FAILED'
    });
    failExport = false;
    const current = f.store.getPreparationSession(ready.sessionId)!;
    const exported = await service.export(current.sessionId, current.revision, 'export-ok');
    expect(exported).toMatchObject({ status: 'EXPORTED', bundleId: 'bundle_1' });
  });

  it('invalidates confirmation after the teaching context changes', async () => {
    const f = await fixture();
    const service = new PreparationService({ store: f.store });
    const built = await service.build(buildInput(f.session.sessionId, f.session.revision, 'build-stale'));
    service.review(built.sessionId, built.revision, 'review-stale');
    f.store.saveTeachingContext({
      contextId: f.context.contextId,
      classDisplayName: f.context.classDisplayName,
      grade: f.context.grade,
      textbookTitle: f.context.textbookTitle,
      textbookEdition: f.context.textbookEdition,
      unitTitle: f.context.unitTitle,
      lessonTitle: '修改后的课题',
      durationSec: f.context.durationSec,
      notes: f.context.notes
    }, f.context.revision, 'context-update-stale');
    expect(() => service.confirm(built.sessionId, built.revision, 'confirm-stale'))
      .toThrowError(PreparationServiceError);
    expect(f.store.getPreparationSession(built.sessionId)).toMatchObject({
      status: 'PLAN_REVIEW', lastErrorCode: 'PREPARATION_STALE'
    });
  });

  it('publishes and registers a reviewed five-file bundle through the real exporter', async () => {
    const f = await fixture();
    const service = new PreparationService({
      store: f.store,
      exportPlan: (planId) => exportPreparedMaterials(f.store, join(f.dir, 'materials'), planId)
    });
    const built = await service.build(buildInput(f.session.sessionId, f.session.revision, 'build-real-export'));
    service.review(built.sessionId, built.revision, 'review-real-export');
    const ready = service.confirm(built.sessionId, built.revision, 'confirm-real-export');
    const exported = await service.export(ready.sessionId, ready.revision, 'export-real');
    expect(exported.status).toBe('EXPORTED');
    expect(f.store.listMaterialArtifacts(exported.planId!, exported.revisionId!)).toHaveLength(5);
  });

  it('routes the named preparation IPC operations without a generic invoke surface', async () => {
    const f = await fixture();
    const preparation = new PreparationService({ store: f.store });
    const ipc = new IpcService({
      store: f.store,
      sourceStore: f.store,
      lessonStore: f.store,
      preparationStore: f.store,
      preparationService: preparation,
      appVersion: '0.1.0', appNameZh: '语文备课工作台', platformSupported: true,
      httpListeners: 0, online: false, buildMode: 'production', sandboxEnabled: true,
      platformDevOverride: false, platformTargetSupported: true, platformIdentity: 'win11'
    });
    const request = (operation: string, payload?: unknown, expectedRevision?: number, idempotencyKey?: string) => ({
      schema_version: IPC_SCHEMA_VERSION,
      request_id: `request-${operation}`,
      operation,
      workspace_id: 'workspace_local',
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      ...(payload === undefined ? {} : { payload })
    });
    const built = await ipc.handle('preparation.build', request(
      'preparation.build',
      { sessionId: f.session.sessionId, focus: '把握消息结构', coreTask: '梳理六要素', answerScope: '限于材料范围' },
      f.session.revision,
      'ipc-build'
    ));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.data as { session: { status: string } }).session.status).toBe('PLAN_REVIEW');
  });
});
