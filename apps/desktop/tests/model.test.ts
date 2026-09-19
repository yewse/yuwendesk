import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { ModelService } from '../src/main/model/service';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-model-'));
}
function fakeSafe(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => Buffer.from(b.toString('utf8').slice(5), 'base64').toString('utf8')
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

// 导入一段非敏感文本并返回可引用的片段。
function seedFragment(s: SqliteStore, title = '春课文', content = '盼望着，东风来了，春天的脚步近了。'): { versionId: string; documentId: string; charStart: number; charEnd: number } {
  const r = s.importSource({ title, format: 'txt', content });
  if (r.status !== 'imported') throw new Error('seed failed');
  const versionId = s.getSourceVersions(r.documentId)[0].versionId;
  return { versionId, documentId: r.documentId, charStart: 0, charEnd: 8 };
}

describe('G04 配置/探测/密钥保护', () => {
  it('配置测试替身 → ok；探测可用且标注测试替身', async () => {
    const svc = new ModelService(await makeStore(tmp()));
    const cfg = svc.configure({ provider: 'test-double' });
    expect(cfg.ok).toBe(true);
    if (cfg.ok) expect(cfg.config.model).toBe('test-double-v0');
    const p = await svc.probe();
    expect(p.ok).toBe(true);
    expect(p.isTestDouble).toBe(true);
  });

  it('未知服务商 → 拒绝', async () => {
    const svc = new ModelService(await makeStore(tmp()));
    expect(svc.configure({ provider: 'nope' }).ok).toBe(false);
  });

  it('DeepSeek 主力：默认模型 deepseek-flash；无安全后端存密钥 → KEY_UNAVAILABLE', async () => {
    const svc = new ModelService(await makeStore(tmp())); // 无 safeStorage
    const r = svc.configure({ provider: 'deepseek', apiKey: 'sk-secret' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('KEY_UNAVAILABLE');
  });

  it('DeepSeek 配置(安全后端存密钥)但真实探测 BLOCKED，不伪造通过', async () => {
    const svc = new ModelService(await makeStore(tmp(), fakeSafe()));
    const r = svc.configure({ provider: 'deepseek', apiKey: 'sk-secret' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.model).toBe('deepseek-flash');
      expect(r.keyStored).toBe(true);
    }
    const p = await svc.probe();
    expect(p.ok).toBe(false); // 真实联网未授权 → BLOCKED
  });
});

describe('G04 结构化调用 + 上下文边界', () => {
  it('测试替身：获准非敏感片段 → 成功，结果含引用且标注测试替身，作业持久化', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const frag = seedFragment(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') {
      const res = r.result as { isTestDouble: boolean; citations: unknown[] };
      expect(res.isTestDouble).toBe(true);
      expect(res.citations.length).toBe(1);
    }
    expect(s.listModelJobs(10)[0].status).toBe('succeeded');
  });

  it('未获准片段 → INPUT_INVALID（私有默认不外发）', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const frag = seedFragment(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: false }] });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('INPUT_INVALID');
  });

  it('敏感分类片段 → PRIVACY_BLOCKED（不进入模型上下文）', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const frag = seedFragment(s);
    // 直接把该资料改为敏感分类，模拟敏感材料
    s.withTransaction((db) => db.prepare("UPDATE source_document SET classification='student_sensitive' WHERE id=?").run(frag.documentId));
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('PRIVACY_BLOCKED');
  });

  it('停用资料片段 → SOURCE_MISSING（版本边界）', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const frag = seedFragment(s);
    s.retireSource(frag.documentId);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('SOURCE_MISSING');
  });

  it('缓存：相同任务/材料版本重复运行 → cached，不新增作业', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const frag = seedFragment(s);
    const a = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(a.status).toBe('succeeded');
    const before = s.listModelJobs(50).length;
    const b = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(b.status).toBe('cached');
    if (b.status === 'cached') expect(b.fromCache).toBe(true);
    expect(s.listModelJobs(50).length).toBe(before); // 不重复生成
  });

  it('预算上限：已达上限 → BUDGET_EXCEEDED', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double', budgetCapCents: 50 });
    // 人为记录一笔已花费 100 分的成功作业
    const now = new Date().toISOString();
    s.insertModelJob({ id: 'seed', task: 'analyze_text', cacheKey: 'x', provider: 'test-double', model: 'test-double-v0', paramsJson: '{}', promptVersion: 'p', materialVersionsJson: '[]', status: 'succeeded', resultJson: '{}', costCents: 100, errorCode: null, createdAt: now, updatedAt: now });
    const frag = seedFragment(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('BUDGET_EXCEEDED');
  });

  it('DeepSeek 真实调用 → failed(MODEL_NOT_AVAILABLE)，作业记 failed，不伪造成功', async () => {
    const s = await makeStore(tmp(), fakeSafe());
    const svc = new ModelService(s);
    svc.configure({ provider: 'deepseek', apiKey: 'sk-x' });
    const frag = seedFragment(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ ...frag, approved: true }] });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.code).toBe('MODEL_NOT_AVAILABLE');
    expect(s.listModelJobs(10)[0].status).toBe('failed');
  });
});

describe('G04 重启不确定态', () => {
  it('上次 running 作业 → 重启后标记 uncertain', async () => {
    const dir = tmp();
    const s = await makeStore(dir);
    const now = new Date().toISOString();
    s.insertModelJob({ id: 'j-run', task: 'analyze_text', cacheKey: 'k', provider: 'test-double', model: 'm', paramsJson: '{}', promptVersion: 'p', materialVersionsJson: '[]', status: 'running', resultJson: null, costCents: 0, errorCode: null, createdAt: now, updatedAt: now });
    s.close();
    open.delete(s);
    const s2 = await makeStore(dir);
    expect(s2.getModelJob('j-run')?.status).toBe('uncertain');
  });
});
