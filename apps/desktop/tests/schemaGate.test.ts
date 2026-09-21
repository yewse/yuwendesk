import { describe, expect, it } from 'vitest';
import { checkPayload, getPayloadSchema } from '../src/main/schemaGate';

describe('IPC 载荷 Schema 门（G02-T01 / SEC 边界）', () => {
  it('读操作无载荷 schema；写操作 ui.saveDraft 有对象 schema', () => {
    expect(getPayloadSchema('app.bootstrap')).toBeNull();
    expect(getPayloadSchema('ui.loadDraft')).toBeNull();
    expect(getPayloadSchema('ui.saveDraft')).not.toBeNull();
  });

  it('合法 ui.saveDraft 载荷通过', () => {
    expect(checkPayload('ui.saveDraft', { content: '本课《春》' }).ok).toBe(true);
  });

  it('content 非字符串 → 失败', () => {
    const r = checkPayload('ui.saveDraft', { content: 123 });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('应为字符串');
  });

  it('缺少必填 content → 失败', () => {
    const r = checkPayload('ui.saveDraft', {});
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('缺少必填字段 content');
  });

  it('多余字段被拒绝（additionalProperties:false）→ 失败', () => {
    const r = checkPayload('ui.saveDraft', { content: 'x', teacher_only: '答案' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('不允许的字段 teacher_only');
  });

  it('继承属性名不得被误判为已声明字段：constructor / toString 额外字段被拒绝', () => {
    const withConstructor = checkPayload('ui.saveDraft', { content: 'x', constructor: 1 });
    expect(withConstructor.ok).toBe(false);
    expect(withConstructor.errors.join()).toContain('不允许的字段 constructor');

    const withToString = checkPayload('ui.saveDraft', { content: 'x', toString: 'evil' });
    expect(withToString.ok).toBe(false);
    expect(withToString.errors.join()).toContain('不允许的字段 toString');
  });

  it('__proto__ 作为真实自有字段（JSON 解析）被拒绝', () => {
    const parsed = JSON.parse('{"content":"x","__proto__":{"polluted":true}}');
    const r = checkPayload('ui.saveDraft', parsed);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('不允许的字段 __proto__');
  });

  it('正常请求回归：仅 content 仍通过', () => {
    expect(checkPayload('ui.saveDraft', { content: '仅内容' }).ok).toBe(true);
  });

  it('教材量级 Base64 不因整串正则耗尽调用栈，非法尾部仍被拒绝', () => {
    const textbookSizedBase64 = 'QUJD'.repeat(8_000_000);
    expect(checkPayload('sources.importFile', {
      title: '语文教材.pdf', format: 'pdf', base64: textbookSizedBase64
    })).toEqual({ ok: true, errors: [] });
    expect(checkPayload('sources.importFile', {
      title: '语文教材.pdf', format: 'pdf', base64: `${textbookSizedBase64.slice(0, -4)}***=`
    }).errors).toContain('字段 base64 编码无效');
  });

  it('模型主导备课允许三个教师约束为空，但仍限制字段类型和长度', () => {
    expect(checkPayload('preparation.build', {
      sessionId: 'session-1', focus: '', coreTask: '', answerScope: ''
    })).toEqual({ ok: true, errors: [] });
    expect(checkPayload('preparation.build', {
      sessionId: 'session-1', focus: 1, coreTask: '', answerScope: ''
    }).ok).toBe(false);
    expect(checkPayload('preparation.build', {
      sessionId: 'session-1', focus: '重'.repeat(2001), coreTask: '', answerScope: ''
    }).errors).toContain('字段 focus 过长');
  });

  it('content 过长 → 失败', () => {
    const r = checkPayload('ui.saveDraft', { content: 'a'.repeat(200_001) });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('过长');
  });

  it('对象载荷缺失（非对象）→ 失败', () => {
    expect(checkPayload('ui.saveDraft', 'not-an-object').ok).toBe(false);
    expect(checkPayload('ui.saveDraft', null).ok).toBe(false);
    expect(checkPayload('ui.saveDraft', ['x']).ok).toBe(false);
  });

  it('无载荷操作夹带非空载荷 → 失败；缺省/undefined 通过', () => {
    expect(checkPayload('app.health', { sneaky: 1 }).ok).toBe(false);
    expect(checkPayload('app.health', undefined).ok).toBe(true);
    expect(checkPayload('app.bootstrap', {}).ok).toBe(true);
  });
});

describe('G09 protection payload schemas', () => {
  it('accepts only path-free backup and restore intents', () => {
    expect(checkPayload('backup.create', { mode: 'local' }).ok).toBe(true);
    expect(checkPayload('backup.create', { mode: 'portable', passphrase: '12345678901234' }).ok).toBe(true);
    expect(checkPayload('backup.create', { mode: 'portable', path: 'C:\\x' }).ok).toBe(false);
    expect(checkPayload('backup.restore', {
      action: 'confirm', restoreJobId: 'r1', previewHash: 'a'.repeat(64), confirmationToken: 'token'
    }).ok).toBe(true);
    expect(checkPayload('backup.restore', { action: 'local-preview', backupId: 'b1' }).ok).toBe(true);
    expect(checkPayload('backup.restore', { action: 'local-preview', backupId: 'b1', path: 'C:\\private\\backup.ready' }).ok).toBe(false);
    expect(checkPayload('backups.delete', { action: 'prepare', backupId: 'b1' }).ok).toBe(true);
  });

  it('accepts only path-free source privacy intents', () => {
    expect(checkPayload('sources.reclassify', { documentId: 'd1', targetClassification: 'student_sensitive' }).ok).toBe(true);
    expect(checkPayload('sources.reclassify', { documentId: 'd1', targetClassification: 'student_sensitive', path: 'C:\\x' }).ok).toBe(false);
    expect(checkPayload('sources.prepareDelete', { documentId: 'd1' }).ok).toBe(true);
    expect(checkPayload('sources.delete', {
      documentId: 'd1', confirmationToken: 't1', managedBackupIds: ['b1'], policy: 'keep_managed'
    }).ok).toBe(true);
    expect(checkPayload('sources.delete', {
      documentId: 'd1', confirmationToken: 't1', managedBackupIds: ['b1'], policy: 'keep_managed', ciphertext: 'x'
    }).ok).toBe(false);
  });
});

describe('G12 preparation payload schemas', () => {
  it('accepts closed context and source-selection payloads', () => {
    expect(checkPayload('preparation.context.save', {
      contextId: 'context_1',
      classDisplayName: '八年级一班',
      grade: 'grade8',
      textbookTitle: '语文八年级上册',
      textbookEdition: '统编版',
      unitTitle: '第一单元',
      lessonTitle: '消息二则',
      durationSec: 2700,
      notes: ''
    })).toEqual({ ok: true, errors: [] });
    expect(checkPayload('preparation.sources.set', {
      sessionId: 'session_1',
      sources: [{ ordinal: 0, sourceVersionId: 'v1', charStart: 0, charEnd: 8, purpose: 'textbook', approvedForModel: false, textSha256: 'a'.repeat(64) }]
    }).ok).toBe(true);
  });

  it('rejects unknown context fields and malformed nested source entries', () => {
    expect(checkPayload('preparation.context.save', {
      classDisplayName: '八年级一班', grade: 'grade8', textbookTitle: '语文', textbookEdition: '', unitTitle: '',
      lessonTitle: '消息二则', durationSec: 2700, notes: '', apiKey: 'must-not-cross'
    }).errors.join()).toContain('不允许的字段 apiKey');
    expect(checkPayload('preparation.sources.set', {
      sessionId: 'session_1',
      sources: [{ ordinal: 0, sourceVersionId: 'v1', charStart: -1, charEnd: 8, purpose: 'textbook', approvedForModel: false, textSha256: 'bad' }]
    }).ok).toBe(false);
  });

  it('exposes named read operations without arbitrary payloads', () => {
    expect(getPayloadSchema('preparation.context.get')).not.toBeNull();
    expect(getPayloadSchema('preparation.session.list')).toBeNull();
  });
});
