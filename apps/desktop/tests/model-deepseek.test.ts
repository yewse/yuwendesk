import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { ModelService } from '../src/main/model/service';
import { createDeepseekProvider, testDoubleProvider } from '../src/main/model/providers';
import type { HttpTransport } from '../src/main/model/types';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-ds-'));
}
function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('E:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => Buffer.from(b.toString('utf8').slice(2), 'base64').toString('utf8')
  };
}
async function makeStore(dir: string, safe?: SafeStorageLike): Promise<SqliteStore> {
  const s = new SqliteStore(dir, { safeStorage: safe });
  open.add(s);
  await s.load();
  return s;
}
afterEach(() => {
  for (const s of open)
    try {
      s.close();
    } catch {
      /* ignore */
    }
  open.clear();
});

const okBody = JSON.stringify({
  summary: '春天生机勃勃，表达喜悦与希望。',
  structure: ['盼春', '绘春', '赞春'],
  rhetoric: ['比喻', '拟人'],
  teaching_suggestions: ['朗读', '修辞辨析'],
  citations: [1]
});

function jsonTransport(content: string, status = 200): HttpTransport {
  return async () => ({ status, text: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) });
}
function statusTransport(status: number): HttpTransport {
  return async () => ({ status, text: '{"error":{"message":"x"}}' });
}
function streamTransport(chunks: string[]): HttpTransport {
  return async () => ({
    status: 200,
    text: chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`).join('\n') + '\ndata: [DONE]\n'
  });
}

describe('DeepSeek 真实协议（离线注入传输，禁止实网）', () => {
  it('成功：构造请求并解析响应内容与用量', async () => {
    const seen: { url: string; auth: string; body: unknown } = { url: '', auth: '', body: null };
    const transport: HttpTransport = async (req) => {
      seen.url = req.url;
      seen.auth = req.headers.Authorization;
      seen.body = JSON.parse(req.body);
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: okBody } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) };
    };
    const ds = createDeepseekProvider(transport);
    const r = await ds.complete(
      { system: 'sys', user: '【引用1】x', params: { temperature: 0.4, maxTokens: 100 }, outputContract: 'analyze_text.v1' },
      { model: 'deepseek-flash', apiKey: 'sk-1', timeoutMs: 1000 }
    );
    expect(r.text).toBe(okBody);
    expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(r.isTestDouble).toBe(false);
    expect(seen.url).toContain('/chat/completions');
    expect(seen.auth).toBe('Bearer sk-1');
    expect((seen.body as { model: string }).model).toBe('deepseek-flash');
  });

  it('流式：解析 SSE delta 拼接内容', async () => {
    const ds = createDeepseekProvider(streamTransport(['第一', '段', '内容']));
    const r = await ds.complete(
      { system: 's', user: 'u', params: { temperature: 0, maxTokens: 10 }, outputContract: 'analyze_text.v1' },
      { model: 'deepseek-flash', apiKey: 'k', timeoutMs: 1000, stream: true }
    );
    expect(r.text).toBe('第一段内容');
  });

  it('错误映射：401→AUTH_FAILED, 429→RATE_LIMITED, 500→NETWORK_UNAVAILABLE', async () => {
    const auth = createDeepseekProvider(statusTransport(401));
    await expect(auth.complete({ system: '', user: '', params: { temperature: 0, maxTokens: 1 }, outputContract: 'analyze_text.v1' }, { model: 'm', apiKey: 'k', timeoutMs: 100 })).rejects.toThrow('AUTH_FAILED');
    const rate = createDeepseekProvider(statusTransport(429));
    await expect(rate.complete({ system: '', user: '', params: { temperature: 0, maxTokens: 1 }, outputContract: 'analyze_text.v1' }, { model: 'm', apiKey: 'k', timeoutMs: 100 })).rejects.toThrow('RATE_LIMITED');
    const net = createDeepseekProvider(statusTransport(500));
    await expect(net.complete({ system: '', user: '', params: { temperature: 0, maxTokens: 1 }, outputContract: 'analyze_text.v1' }, { model: 'm', apiKey: 'k', timeoutMs: 100 })).rejects.toThrow('NETWORK_UNAVAILABLE');
  });

  it('传输异常 → NETWORK_UNAVAILABLE', async () => {
    const ds = createDeepseekProvider(async () => {
      throw new Error('socket');
    });
    await expect(ds.complete({ system: '', user: '', params: { temperature: 0, maxTokens: 1 }, outputContract: 'analyze_text.v1' }, { model: 'm', apiKey: 'k', timeoutMs: 100 })).rejects.toThrow('NETWORK_UNAVAILABLE');
  });
});

function seedFragment(s: SqliteStore) {
  const r = s.importSource({ title: '春', format: 'txt', content: '盼望着，东风来了，春天的脚步近了。' });
  if (r.status !== 'imported') throw new Error('seed');
  return { versionId: s.getSourceVersions(r.documentId)[0].versionId, charStart: 0, charEnd: 8, approved: true };
}
function svcWith(s: SqliteStore, transport: HttpTransport): ModelService {
  return new ModelService(s, { providers: { 'test-double': testDoubleProvider, deepseek: createDeepseekProvider(transport) } });
}

describe('DeepSeek 经 ModelService 授权后离线跑通（真实实网仍 BLOCKED）', () => {
  it('授权+密钥+合格输出 → succeeded 并结算成本，可缓存', async () => {
    const s = await makeStore(tmp(), fakeSafe());
    const svc = svcWith(s, jsonTransport(okBody));
    svc.configure({ provider: 'deepseek', apiKey: 'sk', allowRealNetwork: true, budgetCapCents: 0 });
    const r = await svc.run({ task: 'analyze_text', fragments: [seedFragment(s)] });
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') expect(r.costCents).toBeGreaterThan(0); // 结算实际成本
  });

  it('非法输出(缺字段) → failed(EXPORT_INVALID)，不进入可用缓存', async () => {
    const s = await makeStore(tmp(), fakeSafe());
    const svc = svcWith(s, jsonTransport(JSON.stringify({ summary: 'x' }))); // 缺 structure/rhetoric/...
    svc.configure({ provider: 'deepseek', apiKey: 'sk', allowRealNetwork: true });
    const frag = seedFragment(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [frag] });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.code).toBe('EXPORT_INVALID');
    // 不入可用缓存：再次运行仍会重新派发（非 cached）
    const r2 = await svc.run({ task: 'analyze_text', fragments: [frag] });
    expect(r2.status).toBe('failed');
  });

  it('越界引用 → failed(EXPORT_INVALID)', async () => {
    const s = await makeStore(tmp(), fakeSafe());
    const bad = JSON.stringify({ summary: 's', structure: ['a'], rhetoric: ['b'], teaching_suggestions: ['c'], citations: [2] }); // 仅 1 个引用却引用 2
    const svc = svcWith(s, jsonTransport(bad));
    svc.configure({ provider: 'deepseek', apiKey: 'sk', allowRealNetwork: true });
    const r = await svc.run({ task: 'analyze_text', fragments: [seedFragment(s)] });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.code).toBe('EXPORT_INVALID');
  });

  it('截断 JSON → failed(EXPORT_INVALID)', async () => {
    const s = await makeStore(tmp(), fakeSafe());
    const svc = svcWith(s, jsonTransport('{"summary":"s","structure":['));
    svc.configure({ provider: 'deepseek', apiKey: 'sk', allowRealNetwork: true });
    const r = await svc.run({ task: 'analyze_text', fragments: [seedFragment(s)] });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.code).toBe('EXPORT_INVALID');
  });
});