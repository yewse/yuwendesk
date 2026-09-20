import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, type SourcePrivacyFaultHooks } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import {
  decryptSensitiveSourcePayload,
  encryptSensitiveSourcePayload,
  type SensitiveSourcePayloadV1
} from '../src/main/protection/sourcePrivacy';

const stores = new Set<SqliteStore>();
const studentName = '测试学生甲乙丙';
const studentBody = `${studentName}：我认为春天的脚步是一种拟人表达。`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-source-privacy-'));
}

function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}

async function openStore(dir: string, sourcePrivacyFaults?: SourcePrivacyFaultHooks): Promise<SqliteStore> {
  const store = new SqliteStore(dir, { safeStorage: fakeSafe(), sourcePrivacyFaults });
  stores.add(store);
  await store.load();
  return store;
}

afterEach(() => {
  for (const store of stores) {
    try { store.close(); } catch { /* keep original failure */ }
  }
  stores.clear();
});

function payload(): SensitiveSourcePayloadV1 {
  return {
    version: 1,
    originalBase64: Buffer.from(studentBody).toString('base64'),
    mime: 'text/plain',
    fullText: studentBody,
    segments: [{
      ordinal: 0,
      locatorKind: 'text_line',
      locator: JSON.stringify({ line: 1 }),
      text: studentBody,
      charStart: 0,
      charEnd: studentBody.length,
      reliable: true
    }]
  };
}

describe('G09 sensitive source authenticated payload', () => {
  it('uses random nonces and authenticates ciphertext, nonce, and internal-ID-only AAD', () => {
    const key = Buffer.alloc(32, 9);
    const context = { workspaceId: 'workspace_local', documentId: 'document_1', versionId: 'version_1' };
    const first = encryptSensitiveSourcePayload(key, payload(), context);
    const second = encryptSensitiveSourcePayload(key, payload(), context);

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(JSON.parse(first.aad)).toEqual({
      document_id: 'document_1',
      object: 'source_sensitive_payload',
      payload_version: 1,
      version_id: 'version_1',
      workspace_id: 'workspace_local'
    });
    expect(first.aad).not.toContain(studentName);
    expect(decryptSensitiveSourcePayload(key, first, context)).toEqual(payload());

    for (const field of ['ciphertext', 'nonce'] as const) {
      const changed = { ...first, [field]: Buffer.from(first[field]) };
      changed[field][0] ^= 1;
      expect(() => decryptSensitiveSourcePayload(key, changed, context)).toThrow('sensitive_source_authentication_failed');
    }
    expect(() => decryptSensitiveSourcePayload(key, first, { ...context, versionId: 'version_2' }))
      .toThrow('sensitive_source_authentication_failed');
  });
});

describe('G09 sensitive import and atomic reclassification', () => {
  it('prevents mixed-classification versions and uses a mutable document revision', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const ordinary = store.importSource({ title: '同一资料', format: 'txt', content: '普通第一版' });
    if (ordinary.status !== 'imported') throw new Error('seed failed');
    expect(store.listSources()[0].revision).toBe(2);

    const blockedPromotion = store.importSource({
      title: '同一资料', format: 'txt', content: '敏感第二版', classification: 'student_sensitive',
      relation: 'new_version', targetDocumentId: ordinary.documentId
    });
    expect(blockedPromotion).toEqual({ status: 'blocked_sensitive', reason: 'classification_transition_blocked' });
    expect(store.getSourceVersions(ordinary.documentId)).toHaveLength(1);

    const promoted = store.reclassifySource({
      workspaceId: 'workspace_local', documentId: ordinary.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive', idempotencyKey: 'promote_consistent',
      fingerprint: 'promote_consistent_fp', updatedAt: '2026-09-20T00:30:00.000Z'
    });
    expect(promoted).toMatchObject({ status: 'succeeded', revision: 3 });
    expect(store.listSources()[0]).toMatchObject({ classification: 'student_sensitive', revision: 3 });

    const blockedDowngradeVersion = store.importSource({
      title: '同一资料', format: 'txt', content: '普通第二版', classification: 'teacher_private',
      relation: 'new_version', targetDocumentId: ordinary.documentId
    });
    expect(blockedDowngradeVersion).toEqual({ status: 'blocked_sensitive', reason: 'classification_transition_blocked' });

    const sensitiveSecond = store.importSource({
      title: '不会保留的学生姓名', format: 'txt', content: '敏感第二版', classification: 'student_sensitive',
      relation: 'new_version', targetDocumentId: ordinary.documentId
    });
    expect(sensitiveSecond.status).toBe('new_version');
    expect(store.listSources()[0]).toMatchObject({ classification: 'student_sensitive', revision: 4 });
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM source_sensitive_payload WHERE document_id=?').pluck().get(ordinary.documentId)).toBe(2);
      expect(db.prepare('SELECT COUNT(*) FROM source_text st JOIN source_version sv ON sv.id=st.version_id WHERE sv.document_id=?').pluck().get(ordinary.documentId)).toBe(0);
    } finally { db.close(); }
  });

  it('enables FTS5 secure-delete for both source indexes', async () => {
    const dir = tempDir();
    await openStore(dir);
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare("SELECT v FROM source_fts_config WHERE k='secure-delete'").pluck().get()).toBe(1);
      expect(db.prepare("SELECT v FROM source_seg_fts_config WHERE k='secure-delete'").pluck().get()).toBe(1);
    } finally { db.close(); }
  });

  it('does not leave a unique indexed trigram recoverable in the database after promotion', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const trigramCanary = 'qzxvbnmprivacycanary';
    const imported = store.importSource({ title: 'FTS 安全删除', format: 'txt', content: trigramCanary });
    if (imported.status !== 'imported') throw new Error('seed failed');
    expect(store.searchSources('qzx')).not.toEqual([]);
    expect(store.reclassifySource({
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive', idempotencyKey: 'fts_secure_delete', fingerprint: 'fts_secure_delete_fp',
      updatedAt: '2026-09-20T00:45:00.000Z'
    }).status).toBe('succeeded');
    store.close();
    stores.delete(store);
    expect(readFileSync(join(dir, 'yuwendesk.db')).includes(Buffer.from('qzx'))).toBe(false);
  });

  it('imports student-sensitive content only as encrypted payload with a generic title', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const result = store.importSource({
      title: `${studentName}课堂作答.txt`,
      format: 'txt',
      content: studentBody,
      classification: 'student_sensitive'
    });

    expect(result.status).toBe('imported');
    if (result.status !== 'imported') return;
    expect(store.listSources()[0]).toMatchObject({ classification: 'student_sensitive' });
    expect(store.listSources()[0].title).toMatch(/^学生作品（[a-f0-9]{8}）$/u);
    expect(store.listSources()[0].title).not.toContain(studentName);
    expect(store.searchSources(studentName)).toEqual([]);
    expect(store.readSource(result.versionId)).toBeNull();
    expect(store.readOriginal(result.versionId)).toBeNull();

    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM source_sensitive_payload WHERE version_id=?').pluck().get(result.versionId)).toBe(1);
      expect(db.prepare('SELECT COUNT(*) FROM source_text WHERE version_id=?').pluck().get(result.versionId)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM source_segment WHERE version_id=?').pluck().get(result.versionId)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM source_seg_fts WHERE version_id=?').pluck().get(result.versionId)).toBe(0);
      expect(db.prepare('SELECT original_blob FROM source_file WHERE version_id=?').pluck().get(result.versionId)).toBeNull();
    } finally {
      db.close();
    }

    store.close();
    stores.delete(store);
    expect(readFileSync(join(dir, 'yuwendesk.db')).includes(Buffer.from(studentName))).toBe(false);
    expect(readFileSync(join(dir, 'yuwendesk.db')).includes(Buffer.from(studentBody))).toBe(false);
  });

  it('atomically upgrades an ordinary source, invalidates references, and persists idempotent replay', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const imported = store.importSource({ title: `${studentName}作答`, format: 'txt', content: studentBody });
    if (imported.status !== 'imported') throw new Error('seed failed');
    store.saveLessonRevision({
      revisionId: 'lesson_revision_1', planId: 'lesson_plan_1', previousRevisionId: null,
      title: '引用学生作答的课时', contentJson: JSON.stringify({ source_version_ids: [imported.versionId] }),
      contentOrigin: 'authored', valid: true, createdAt: '2026-09-20T00:00:00.000Z'
    }, true);
    store.insertModelJob({
      id: 'model_job_1', task: 'analyze_text', cacheKey: 'cache_1', provider: 'test-double', model: 'test-double-v0',
      paramsJson: '{}', promptVersion: 'v1', materialVersionsJson: JSON.stringify([imported.versionId]), status: 'succeeded',
      resultJson: JSON.stringify({ leaked: studentName }), costCents: 0, errorCode: null,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z'
    });

    const input = {
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive' as const, idempotencyKey: 'reclassify_1',
      fingerprint: 'reclassify_fingerprint_1', updatedAt: '2026-09-20T01:00:00.000Z'
    };
    const applied = store.reclassifySource(input);
    const replayed = store.reclassifySource(input);

    expect(applied).toMatchObject({ status: 'succeeded', documentId: imported.documentId, classification: 'student_sensitive' });
    expect(replayed).toEqual({ ...applied, replayed: true });
    expect(store.getLessonRevision('lesson_plan_1')?.valid).toBe(false);
    expect(store.listModelJobs(10)).toEqual([]);
    expect(store.searchSources(studentName)).toEqual([]);
    expect(store.readSource(imported.versionId)).toBeNull();
    expect(store.readOriginal(imported.versionId)).toBeNull();

    const beforeRepeat = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    const ciphertextBefore = Buffer.from(beforeRepeat.prepare('SELECT ciphertext FROM source_sensitive_payload WHERE version_id=?').pluck().get(imported.versionId) as Buffer);
    beforeRepeat.close();
    const repeatedWithNewKey = store.reclassifySource({
      ...input,
      expectedRevision: 3,
      idempotencyKey: 'reclassify_2',
      fingerprint: 'reclassify_fingerprint_2'
    });
    expect(repeatedWithNewKey.status).toBe('succeeded');
    const afterRepeat = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    const ciphertextAfter = Buffer.from(afterRepeat.prepare('SELECT ciphertext FROM source_sensitive_payload WHERE version_id=?').pluck().get(imported.versionId) as Buffer);
    afterRepeat.close();
    expect(ciphertextAfter).toEqual(ciphertextBefore);

    const downgrade = store.reclassifySource({ ...input, targetClassification: 'teacher_private', idempotencyKey: 'downgrade_1' });
    expect(downgrade).toEqual({ status: 'blocked', reason: 'PRIVACY_BLOCKED' });

    store.close();
    stores.delete(store);
    const reopened = await openStore(dir);
    expect(reopened.reclassifySource(input)).toEqual({ ...applied, replayed: true });
    expect(readFileSync(join(dir, 'yuwendesk.db')).includes(Buffer.from(studentName))).toBe(false);
    expect(readFileSync(join(dir, 'yuwendesk.db')).includes(Buffer.from(studentBody))).toBe(false);
  });

  it('redacts derived lesson data and removes generated files, proposals, feedback, and attribution records', async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const canary = '派生敏感明文_测试学生甲乙丙_987654';
    const imported = store.importSource({ title: canary, format: 'txt', content: `${canary}的原始作答` });
    if (imported.status !== 'imported') throw new Error('seed failed');
    const planId = 'privacy_plan_1';
    const revisionId = 'privacy_revision_1';
    store.saveLessonRevision({
      revisionId, planId, previousRevisionId: null, title: canary,
      contentJson: JSON.stringify({ source_version_ids: [imported.versionId], copied_answer: canary }),
      contentOrigin: 'authored', valid: true, createdAt: '2026-09-20T00:00:00.000Z'
    }, true);
    const bundleDir = join(dir, 'materials', 'privacy_bundle');
    const artifactPath = join(bundleDir, 'student-answer.txt');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(artifactPath, canary);
    store.withTransaction((db) => {
      db.prepare("INSERT INTO material_bundle VALUES(?,?,?,?,?,?,?)").run('privacy_bundle', planId, revisionId, canary, bundleDir, 'published', '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO material_artifact(id,plan_id,revision_id,role,format,filename,path,sha256,byte_size,content_origin,created_at,bundle_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run('privacy_artifact', planId, revisionId, 'student', 'txt', 'student-answer.txt', artifactPath, 'hash', Buffer.byteLength(canary), 'generated', '2026-09-20T00:00:00.000Z', 'privacy_bundle');
      db.prepare("INSERT INTO review_report VALUES(?,?,?,?,?)").run('privacy_review', planId, revisionId, JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO change_proposal VALUES(?,?,?,?,?,?,?,?,?)").run('privacy_change', planId, revisionId, null, 'local', JSON.stringify({ canary }), 'proposed', '2026-09-20T00:00:00.000Z', null);
      db.prepare("INSERT INTO feedback_stream VALUES(?,?,?,?)").run(planId, 'workspace_local', 1, '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO teaching_event VALUES(?,?,?,?,?,?)").run('privacy_teaching', 'workspace_local', planId, revisionId, JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO learning_observation VALUES(?,?,?,?,?,?)").run('privacy_observation', 'workspace_local', planId, 'privacy_teaching', JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO observation_outcome VALUES(?,?)").run('privacy_observation', JSON.stringify({ canary }));
      db.prepare("INSERT INTO measurement_review VALUES(?,?,?,?,?,?)").run('privacy_measurement', 'workspace_local', planId, 'privacy_teaching', JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO attribution_run VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('privacy_run', 'workspace_local', planId, 'privacy_teaching', 'hash', 'succeeded', JSON.stringify({ canary }), null, 'model', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO correction_proposal VALUES(?,?,?,?,?,?,?)").run('privacy_correction', 'workspace_local', planId, JSON.stringify({ canary }), 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO preference_event VALUES(?,?,?,?,?,?)").run('privacy_preference', 'workspace_local', planId, 'privacy_correction', JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO effect_evidence_event VALUES(?,?,?,?,?,?)").run('privacy_effect', 'workspace_local', planId, 'privacy_correction', JSON.stringify({ canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO feedback_idempotency VALUES(?,?,?,?,?,?)").run('privacy_feedback_key', 'fp', 'feedback.analyze', 'succeeded', JSON.stringify({ plan_id: planId, canary }), '2026-09-20T00:00:00.000Z');
      db.prepare("INSERT INTO lesson_change_idempotency VALUES(?,?,?,?,?,?,?)").run('privacy_change_key', 'fp', 'succeeded', JSON.stringify({ planId, canary }), 0, null, '2026-09-20T00:00:00.000Z');
    });

    const result = store.reclassifySource({
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive', idempotencyKey: 'derived_purge', fingerprint: 'derived_purge_fp',
      updatedAt: '2026-09-20T01:00:00.000Z'
    });
    expect(result).toMatchObject({ status: 'succeeded', invalidatedLessonRevisionIds: [revisionId] });
    expect(existsSync(bundleDir)).toBe(false);
    expect(store.getLessonRevision(planId)).toMatchObject({
      title: '需重新生成的课时（敏感资料）', contentJson: '{"redacted_due_to_sensitive_source":true}', valid: false
    });
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      for (const table of [
        'material_artifact', 'material_bundle', 'review_report', 'change_proposal', 'feedback_stream', 'teaching_event',
        'learning_observation', 'observation_outcome', 'measurement_review', 'attribution_run', 'correction_proposal',
        'preference_event', 'effect_evidence_event', 'feedback_idempotency', 'lesson_change_idempotency', 'privacy_file_quarantine'
      ]) expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
      expect(JSON.stringify(db.prepare('SELECT * FROM lesson_revision WHERE revision_id=?').get(revisionId))).not.toContain(canary);
    } finally { db.close(); }
  });

  it('rolls back ciphertext and every plaintext cleanup when a transaction hook fails', async () => {
    const dir = tempDir();
    const store = await openStore(dir, { afterPlaintextCleanup: () => { throw new Error('fault_after_plaintext_cleanup'); } });
    const imported = store.importSource({ title: `${studentName}原始作答`, format: 'txt', content: studentBody });
    if (imported.status !== 'imported') throw new Error('seed failed');

    expect(() => store.reclassifySource({
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive', idempotencyKey: 'fault_1', fingerprint: 'fault_fingerprint_1',
      updatedAt: '2026-09-20T02:00:00.000Z'
    })).toThrow('fault_after_plaintext_cleanup');

    expect(store.readSource(imported.versionId)?.text).toContain(studentName);
    expect(store.readOriginal(imported.versionId)).not.toBeNull();
    expect(store.listSources()[0]).toMatchObject({ classification: 'teacher_private', title: `${studentName}原始作答` });
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM source_sensitive_payload').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM maintenance_idempotency').pluck().get()).toBe(0);
    } finally { db.close(); }
  });

  it('restores quarantined generated files when dependency invalidation rolls back', async () => {
    const dir = tempDir();
    const store = await openStore(dir, { afterDependencyInvalidation: () => { throw new Error('fault_dependency_rollback'); } });
    const imported = store.importSource({ title: '文件回滚资料', format: 'txt', content: '文件回滚正文' });
    if (imported.status !== 'imported') throw new Error('seed failed');
    const planId = 'rollback_plan';
    const revisionId = 'rollback_revision';
    store.saveLessonRevision({
      revisionId, planId, previousRevisionId: null, title: '文件回滚课时',
      contentJson: JSON.stringify({ source_version_ids: [imported.versionId] }), contentOrigin: 'authored', valid: true,
      createdAt: '2026-09-20T02:10:00.000Z'
    }, true);
    const bundleDir = join(dir, 'materials', 'rollback_bundle');
    const artifactPath = join(bundleDir, 'artifact.txt');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(artifactPath, 'must survive rollback');
    store.withTransaction((db) => {
      db.prepare('INSERT INTO material_bundle VALUES(?,?,?,?,?,?,?)')
        .run('rollback_bundle', planId, revisionId, 'hash', bundleDir, 'published', '2026-09-20T02:10:00.000Z');
      db.prepare('INSERT INTO material_artifact(id,plan_id,revision_id,role,format,filename,path,sha256,byte_size,content_origin,created_at,bundle_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('rollback_artifact', planId, revisionId, 'student', 'txt', 'artifact.txt', artifactPath, 'hash', 21, 'generated', '2026-09-20T02:10:00.000Z', 'rollback_bundle');
    });

    expect(() => store.reclassifySource({
      workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
      targetClassification: 'student_sensitive', idempotencyKey: 'rollback_files', fingerprint: 'rollback_files_fp',
      updatedAt: '2026-09-20T02:20:00.000Z'
    })).toThrow('fault_dependency_rollback');
    expect(readFileSync(artifactPath, 'utf8')).toBe('must survive rollback');
    expect(store.getLessonRevision(planId)?.valid).toBe(true);
    expect(store.listMaterialArtifacts(planId)).toHaveLength(1);
    const db = new Database(join(dir, 'yuwendesk.db'), { readonly: true });
    try { expect(db.prepare('SELECT COUNT(*) FROM privacy_file_quarantine').pluck().get()).toBe(0); } finally { db.close(); }
  });

  it.each([
    'afterCiphertextInsert', 'afterFtsCleanup', 'afterSegmentCleanup', 'afterTextCleanup',
    'afterOriginalCleanup', 'afterDependencyInvalidation', 'beforeIdempotency'
  ] as const)(
    'rolls back the distinct %s boundary',
    async (faultName) => {
      const dir = tempDir();
      const faults = { [faultName]: () => { throw new Error(`fault_${faultName}`); } } as SourcePrivacyFaultHooks;
      const store = await openStore(dir, faults);
      const imported = store.importSource({ title: '边界资料', format: 'txt', content: '边界测试正文' });
      if (imported.status !== 'imported') throw new Error('seed failed');
      expect(() => store.reclassifySource({
        workspaceId: 'workspace_local', documentId: imported.documentId, expectedRevision: 2,
        targetClassification: 'student_sensitive', idempotencyKey: `key_${faultName}`, fingerprint: `fp_${faultName}`,
        updatedAt: '2026-09-20T02:30:00.000Z'
      })).toThrow(`fault_${faultName}`);
      expect(store.readSource(imported.versionId)?.text).toBe('边界测试正文');
      expect(store.readOriginal(imported.versionId)).not.toBeNull();
      expect(store.searchSources('边界测试')).not.toEqual([]);
    }
  );
});
