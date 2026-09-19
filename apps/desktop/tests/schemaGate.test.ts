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
