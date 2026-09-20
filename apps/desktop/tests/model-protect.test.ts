import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { ModelService } from '../src/main/model/service';
import { testDoubleProvider } from '../src/main/model/providers';
import type { ModelProvider } from '../src/main/model/types';

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-mp-'));
}
async function makeStore(dir: string): Promise<SqliteStore> {
  const s = new SqliteStore(dir);
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

const VALID = JSON.stringify({ summary: 's', structure: ['a'], rhetoric: ['b'], teaching_suggestions: ['c'], citations: [1] });

// 可控 provider：gate 释放前 complete 挂起；不检查取消（用于验证 service 层取消后提交保护）。
function controllable(costPer1kCents = 0, delayMs?: number): { provider: ModelProvider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pricing = { currency: 'SIM', per1kInputCents: 0, per1kOutputCents: costPer1kCents, source: 'simulated', effectiveDate: 'N/A', isEstimate: true };
  const provider: ModelProvider = {
    id: 'ctrl',
    defaultModel: 'ctrl',
    requiresKey: false,
    pricing,
    contentOrigin: 'simulated',
    async probe() {
      return { ok: true, provider: 'ctrl', model: 'ctrl', isTestDouble: true, note: 'ok' };
    },
    async complete() {
      if (delayMs !== undefined) await new Promise((r) => setTimeout(r, delayMs));
      else await gate;
      return { text: VALID, usage: { promptTokens: 100, completionTokens: 50 }, usageKnown: true, costCents: Math.ceil((150 / 1000) * costPer1kCents), provider: 'ctrl', model: 'ctrl', isTestDouble: true, contentOrigin: 'simulated', finishReason: 'stop', pricing };
    }
  };
  return { provider, release };
}
function seed(s: SqliteStore, content = '盼望着，东风来了，春天的脚步近了。') {
  const r = s.importSource({ title: '春' + Math.random(), format: 'txt', content });
  if (r.status !== 'imported') throw new Error('seed');
  return { versionId: s.getSourceVersions(r.documentId)[0].versionId };
}

describe('G04 上下文边界：精确区间读取（不带未授权前后文）', () => {
  it('引用 excerpt 仅为授权区间，不含相邻文本', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    // 内容：HEADER|CORE|TAIL；仅授权 CORE 区间
    const content = 'HEADER-秘密前文XXXX核心内容YYYY秘密后文-TAIL';
    const coreStart = content.indexOf('核心内容');
    const coreEnd = coreStart + '核心内容'.length;
    const r = s.importSource({ title: '边界样例', format: 'txt', content });
    if (r.status !== 'imported') throw new Error('seed');
    const versionId = s.getSourceVersions(r.documentId)[0].versionId;
    const run = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: coreStart, charEnd: coreEnd, approved: true }] });
    expect(run.status).toBe('succeeded');
    if (run.status === 'succeeded') {
      const cites = (run.result as { citations: { excerpt: string }[] }).citations;
      expect(cites[0].excerpt).toBe('核心内容'); // 精确区间，无 ±padding、无相邻“秘密前/后文”
    }
  });

  it('超单片段上限 → INPUT_INVALID（不静默截断冒称完整）', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const big = 'x'.repeat(5000);
    const r = s.importSource({ title: '超长', format: 'txt', content: big });
    if (r.status !== 'imported') throw new Error('seed');
    const versionId = s.getSourceVersions(r.documentId)[0].versionId;
    const run = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 5000, approved: true }] });
    expect(run.status).toBe('blocked');
    if (run.status === 'blocked') expect(run.code).toBe('INPUT_INVALID');
  });

  it('授权区间超出原文长度 → INPUT_INVALID', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double' });
    const { versionId } = seed(s, '短文');
    const run = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 9999, approved: true }] });
    expect(run.status).toBe('blocked');
    if (run.status === 'blocked') expect(run.code).toBe('INPUT_INVALID');
  });
});

describe('G04 在途去重 / 取消后提交保护', () => {
  it('相同任务并发 → 在途去重，仅一个作业，二者同一 jobId', async () => {
    const s = await makeStore(tmp());
    const { provider, release } = controllable();
    const svc = new ModelService(s, { providers: { ctrl: provider } });
    svc.configure({ provider: 'ctrl' });
    const { versionId } = seed(s);
    const frag = [{ versionId, charStart: 0, charEnd: 8, approved: true }];
    const p1 = svc.run({ task: 'analyze_text', fragments: frag });
    const p2 = svc.run({ task: 'analyze_text', fragments: frag });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe('succeeded');
    expect(b.status).toBe('succeeded');
    if (a.status === 'succeeded' && b.status === 'succeeded') expect(a.jobId).toBe(b.jobId);
    expect(s.listModelJobs(50).filter((j) => j.status === 'succeeded').length).toBe(1);
  });

  it('取消后迟到结果不得提交为成功（cancelled，不缓存）', async () => {
    const s = await makeStore(tmp());
    const { provider, release } = controllable();
    const svc = new ModelService(s, { providers: { ctrl: provider } });
    svc.configure({ provider: 'ctrl' });
    const { versionId } = seed(s);
    const p = svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] });
    // 找到在途作业并取消
    await new Promise((r) => setTimeout(r, 10));
    const running = s.listModelJobs(10).find((j) => j.status === 'running');
    expect(running).toBeTruthy();
    svc.cancel(running!.id);
    release(); // 迟到成功
    const r = await p;
    expect(r.status).toBe('cancelled');
    expect(s.getModelJob(running!.id)?.status).toBe('cancelled');
    expect(s.listModelJobs(50).some((j) => j.status === 'succeeded')).toBe(false); // 未缓存成功
  });
});

describe('G04 超时不确定 / 预算预留与结算 / 探测遵守授权与预算', () => {
  it('超时 → uncertain，保留预留成本（不认定未计费）', async () => {
    const s = await makeStore(tmp());
    const { provider } = controllable(1, 200); // 成本>0，且 complete 延迟 200ms
    const svc = new ModelService(s, { providers: { ctrl: provider }, timeoutMs: 20 });
    svc.configure({ provider: 'ctrl' });
    const { versionId } = seed(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] });
    expect(r.status).toBe('uncertain');
    if (r.status === 'uncertain') expect(r.code).toBe('REQUEST_UNCERTAIN');
    const job = s.listModelJobs(10)[0];
    expect(job.status).toBe('uncertain');
    expect(job.costCents).toBeGreaterThan(0); // 保留预留额
    expect(s.budgetSpentCents()).toBeGreaterThan(0); // 计入预算（不确定不清零）
  });

  it('预算预留：预留额超上限 → 派发前 BUDGET_EXCEEDED', async () => {
    const s = await makeStore(tmp());
    const { provider } = controllable(1, 0);
    const svc = new ModelService(s, { providers: { ctrl: provider } });
    // maxTokens 默认 1200 → 预留 ceil(1.2)=2；上限 1 → 不足预留
    svc.configure({ provider: 'ctrl', budgetCapCents: 1 });
    const { versionId } = seed(s);
    const r = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] });
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') expect(r.code).toBe('BUDGET_EXCEEDED');
  });

  it('探测遵守预算：已达上限 → 探测 BUDGET_EXCEEDED', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s);
    svc.configure({ provider: 'test-double', budgetCapCents: 10 });
    const now = new Date().toISOString();
    s.insertModelJob({ id: 'x', task: 'analyze_text', cacheKey: 'k', provider: 'test-double', model: 'm', paramsJson: '{}', promptVersion: 'p', materialVersionsJson: '[]', status: 'succeeded', resultJson: '{}', costCents: 20, errorCode: null, createdAt: now, updatedAt: now });
    const p = await svc.probe();
    expect(p.ok).toBe(false);
    expect(p.code).toBe('BUDGET_EXCEEDED');
  });
});

// 保证 testDoubleProvider 输出遵守同一合同（否则 succeeded 校验会失败）。
describe('测试替身遵守同一输出合同', () => {
  it('analyze_text 与 lesson_outline 输出均通过合同校验', async () => {
    const s = await makeStore(tmp());
    const svc = new ModelService(s, { providers: { 'test-double': testDoubleProvider } });
    svc.configure({ provider: 'test-double' });
    const { versionId } = seed(s);
    const a = await svc.run({ task: 'analyze_text', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] });
    expect(a.status).toBe('succeeded');
    const b = await svc.run({ task: 'lesson_outline', fragments: [{ versionId, charStart: 0, charEnd: 8, approved: true }] });
    expect(b.status).toBe('succeeded');
  });
});
