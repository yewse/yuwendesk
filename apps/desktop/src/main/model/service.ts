// G04 模型调用编排：配置/探测/密钥保护/预算(预留与结算)/结构化调用/上下文边界/在途去重/
// 取消(含取消后提交保护)/超时(执行与费用不确定)/重试/缓存/结果持久化。
// 数据、检索与业务本地；模型走授权云 API。无授权不发起真实调用；测试替身完成本地链路并遵守同一输出合同。
import { createHash, randomUUID } from 'node:crypto';
import type { ModelConfig, ModelJobRecord, ModelStore, SourceStore } from '../store';
import { assemblePrompt, isKnownTask, PROMPT_VERSION, validateContract } from './prompt';
import { defaultProviders } from './providers';
import { DEFAULT_PARAMS, type ApprovedFragment, type CancelSignalLike, type Citation, type ModelParams, type ModelProvider } from './types';

export interface CredentialLike {
  credentialEncryptionAvailable(): boolean;
  setCredential(name: string, plaintext: string): { ok: true; last4: string } | { ok: false; reason: string };
  readCredential(name: string): { ok: true; plaintext: string } | { ok: false; reason: string };
}
const KEY_NAME = 'model_api_key';
const MAX_RETRIES = 2;
const TRANSIENT = new Set(['NETWORK_UNAVAILABLE', 'RATE_LIMITED']);
const MAX_FRAGMENT_CHARS = 4000; // 单片段进入模型上下文的字符上限；超出需缩小/分批授权，不静默截断。

export type ConfigureResult =
  | { ok: true; config: ModelConfig; keyStored: boolean }
  | { ok: false; code: 'UNKNOWN_PROVIDER' | 'KEY_UNAVAILABLE' | 'INPUT_INVALID'; note: string };
export type RunResult =
  | { status: 'succeeded' | 'cached'; jobId: string; result: unknown; costCents: number; fromCache: boolean }
  | { status: 'failed'; jobId: string; code: string; note: string }
  | { status: 'uncertain'; jobId: string; code: 'REQUEST_UNCERTAIN'; note: string }
  | { status: 'cancelled'; jobId: string }
  | { status: 'blocked'; code: 'PRIVACY_BLOCKED' | 'SOURCE_MISSING' | 'SOURCE_CONFLICT' | 'BUDGET_EXCEEDED' | 'INPUT_INVALID' | 'MODEL_NOT_AVAILABLE'; note: string };

export class ModelService {
  private readonly cancels = new Map<string, CancelSignalLike>();
  private readonly inflight = new Map<string, Promise<RunResult>>();
  private readonly providers: Record<string, ModelProvider>;
  constructor(
    private readonly store: ModelStore & SourceStore & CredentialLike,
    opts: { timeoutMs?: number; now?: () => string; providers?: Record<string, ModelProvider> } = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.providers = opts.providers ?? defaultProviders();
  }
  private readonly timeoutMs: number;
  private readonly now: () => string;

  private getProvider(id: string): ModelProvider | undefined {
    return this.providers[id];
  }
  providerCatalog(): { id: string; defaultModel: string; requiresKey: boolean }[] {
    return Object.values(this.providers).map((p) => ({ id: p.id, defaultModel: p.defaultModel, requiresKey: p.requiresKey }));
  }

  configure(input: { provider: string; model?: string; params?: Partial<ModelParams>; budgetCapCents?: number; allowRealNetwork?: boolean; apiKey?: string }): ConfigureResult {
    const provider = this.getProvider(input.provider);
    if (!provider) return { ok: false, code: 'UNKNOWN_PROVIDER', note: `未知服务商：${input.provider}` };
    const model = input.model && input.model.trim() ? input.model.trim() : provider.defaultModel;
    const params: ModelParams = { temperature: input.params?.temperature ?? DEFAULT_PARAMS.temperature, maxTokens: input.params?.maxTokens ?? DEFAULT_PARAMS.maxTokens };
    const budgetCapCents = Math.max(0, Math.floor(input.budgetCapCents ?? 0));
    let keyStored = false;
    if (provider.requiresKey && input.apiKey) {
      if (!this.store.credentialEncryptionAvailable()) return { ok: false, code: 'KEY_UNAVAILABLE', note: '无安全加密后端，拒绝存储明文密钥；真实服务商保持 BLOCKED。' };
      const set = this.store.setCredential(KEY_NAME, input.apiKey);
      if (!set.ok) return { ok: false, code: 'KEY_UNAVAILABLE', note: '密钥保护失败。' };
      keyStored = true;
    }
    const config: ModelConfig = { provider: provider.id, model, temperature: params.temperature, maxTokens: params.maxTokens, budgetCapCents, allowRealNetwork: !!input.allowRealNetwork, updatedAt: this.now() };
    this.store.setModelConfig(config);
    return { ok: true, config, keyStored };
  }

  getConfig(): ModelConfig | null {
    return this.store.getModelConfig();
  }
  cancel(jobId: string): boolean {
    const sig = this.cancels.get(jobId);
    if (!sig) return false;
    sig.cancelled = true;
    return true;
  }
  listJobs(limit = 50): ModelJobRecord[] {
    return this.store.listModelJobs(limit);
  }
  private readKey(): string | undefined {
    const r = this.store.readCredential(KEY_NAME);
    return r.ok ? r.plaintext : undefined;
  }

  // 派发前联网授权：真实服务商需 allowRealNetwork 且持有受保护密钥；否则 BLOCKED（不发起网络）。
  private authorize(cfg: ModelConfig, provider: ModelProvider): { ok: true; apiKey?: string } | { ok: false; note: string } {
    if (!provider.requiresKey) return { ok: true };
    if (!cfg.allowRealNetwork) return { ok: false, note: '真实联网未授权（allowRealNetwork=false），保持 BLOCKED。' };
    const apiKey = this.readKey();
    if (!apiKey) return { ok: false, note: '未配置受保护的 API 密钥。' };
    return { ok: true, apiKey };
  }

  async probe(): Promise<{ ok: boolean; note: string; code?: string; provider?: string; model?: string; isTestDouble?: boolean }> {
    const cfg = this.store.getModelConfig();
    if (!cfg) return { ok: false, note: '未配置服务商。', code: 'INPUT_INVALID' };
    const provider = this.getProvider(cfg.provider);
    if (!provider) return { ok: false, note: '未知服务商。', code: 'UNKNOWN_PROVIDER' };
    // 探测同样遵守预算与授权。
    if (cfg.budgetCapCents > 0 && this.store.budgetSpentCents() >= cfg.budgetCapCents) return { ok: false, note: '已达预算上限，暂停探测。', code: 'BUDGET_EXCEEDED' };
    let apiKey: string | undefined;
    if (provider.requiresKey) {
      const auth = this.authorize(cfg, provider);
      if (!auth.ok) return { ok: false, note: auth.note, code: 'MODEL_NOT_AVAILABLE' };
      apiKey = auth.apiKey;
    }
    const r = await provider.probe({ model: cfg.model, apiKey });
    return r.ok ? { ok: true, note: r.note, provider: r.provider, model: r.model, isTestDouble: r.isTestDouble } : { ok: false, note: r.note, code: r.code };
  }

  // 上下文边界：仅使用显式获准、非敏感、版本未停用片段；按授权区间“精确读取”（不复用带未授权前后文的预览）；
  // 超出单片段上限需缩小/分批授权，不静默截断后冒称完整。记录引用。
  private buildCitations(
    fragments: ApprovedFragment[]
  ): { ok: true; citations: Citation[]; materialVersions: { versionId: string; textHash: string }[] } | { ok: false; code: 'PRIVACY_BLOCKED' | 'SOURCE_MISSING' | 'INPUT_INVALID'; note: string } {
    const citations: Citation[] = [];
    const materialVersions: { versionId: string; textHash: string }[] = [];
    for (const f of fragments) {
      if (!f.approved) return { ok: false, code: 'INPUT_INVALID', note: '存在未获准片段：默认私有资料不得自动外发。' };
      if (!Number.isInteger(f.charStart) || !Number.isInteger(f.charEnd) || f.charStart < 0 || f.charEnd < f.charStart)
        return { ok: false, code: 'INPUT_INVALID', note: '片段区间非法。' };
      const meta = this.store.getVersionMeta(f.versionId);
      if (!meta) return { ok: false, code: 'SOURCE_MISSING', note: '片段所属版本不存在。' };
      if (meta.status === 'retired') return { ok: false, code: 'SOURCE_MISSING', note: '片段所属资料已停用，不进入模型上下文。' };
      if (meta.classification === 'student_sensitive') return { ok: false, code: 'PRIVACY_BLOCKED', note: '敏感学生材料不得进入模型上下文/外发。' };
      const exact = this.store.readExactRange(f.versionId, f.charStart, f.charEnd);
      if (!exact) return { ok: false, code: 'SOURCE_MISSING', note: '片段原文不可读。' };
      if (f.charEnd > exact.fullLength) return { ok: false, code: 'INPUT_INVALID', note: '授权区间超出原文长度。' };
      if (exact.text.length > MAX_FRAGMENT_CHARS) return { ok: false, code: 'INPUT_INVALID', note: '片段超出单次上下文上限，请缩小或分批授权（不静默截断）。' };
      citations.push({ versionId: f.versionId, title: meta.title, version: meta.version, charStart: f.charStart, charEnd: f.charEnd, locatorLabel: `字符${f.charStart}–${f.charEnd}`, excerpt: exact.text });
      materialVersions.push({ versionId: f.versionId, textHash: meta.textHash });
    }
    return { ok: true, citations, materialVersions };
  }

  async run(input: { task: string; instructionExtra?: string; fragments?: ApprovedFragment[] }): Promise<RunResult> {
    const cfg = this.store.getModelConfig();
    if (!cfg) return { status: 'blocked', code: 'INPUT_INVALID', note: '未配置服务商。' };
    if (!isKnownTask(input.task)) return { status: 'blocked', code: 'INPUT_INVALID', note: `未知任务：${input.task}` };
    const provider = this.getProvider(cfg.provider);
    if (!provider) return { status: 'blocked', code: 'INPUT_INVALID', note: '未知服务商。' };
    const boundary = this.buildCitations(input.fragments ?? []);
    if (!boundary.ok) return { status: 'blocked', code: boundary.code, note: boundary.note };

    const params: ModelParams = { temperature: cfg.temperature, maxTokens: cfg.maxTokens };
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ task: input.task, provider: cfg.provider, model: cfg.model, params, promptVersion: PROMPT_VERSION, instructionExtra: input.instructionExtra ?? '', materialVersions: boundary.materialVersions, fragments: input.fragments ?? [] }))
      .digest('hex');

    // 缓存：相同任务/模型/提示/参数/材料版本 → 复用已确认结果（仅合格成功才会入缓存）。
    const cached = this.store.findCachedJob(cacheKey);
    if (cached) return { status: 'cached', jobId: cached.id, result: cached.resultJson ? JSON.parse(cached.resultJson) : null, costCents: cached.costCents, fromCache: true };

    // 在途去重：相同任务正在执行 → 复用同一在途结果，不重复派发。
    const running = this.inflight.get(cacheKey);
    if (running) return running;

    const exec = this.execute(cfg, provider, input.task, input.instructionExtra ?? '', params, cacheKey, boundary.citations, boundary.materialVersions);
    this.inflight.set(cacheKey, exec);
    try {
      return await exec;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async execute(
    cfg: ModelConfig,
    provider: ModelProvider,
    task: string,
    instructionExtra: string,
    params: ModelParams,
    cacheKey: string,
    citations: Citation[],
    materialVersions: { versionId: string; textHash: string }[]
  ): Promise<RunResult> {
    // 派发前联网授权。
    const auth = this.authorize(cfg, provider);
    if (!auth.ok) return { status: 'blocked', code: 'MODEL_NOT_AVAILABLE', note: auth.note };

    // 预算预留：估算成本，预留后若超上限则拒绝。
    const estCost = Math.ceil((params.maxTokens / 1000) * provider.costPer1kCents);
    if (cfg.budgetCapCents > 0 && this.store.budgetSpentCents() + estCost > cfg.budgetCapCents) return { status: 'blocked', code: 'BUDGET_EXCEEDED', note: '预算不足以预留本次调用。' };

    const prompt = assemblePrompt(task, instructionExtra, citations);
    const jobId = randomUUID();
    const signal: CancelSignalLike = { cancelled: false };
    this.cancels.set(jobId, signal);
    const nowTs = this.now();
    // 插入 running 并预留成本（budgetSpentCents 计入 running，保证在途预留）。
    this.store.insertModelJob({ id: jobId, task, cacheKey, provider: cfg.provider, model: cfg.model, paramsJson: JSON.stringify(params), promptVersion: PROMPT_VERSION, materialVersionsJson: JSON.stringify(materialVersions), status: 'running', resultJson: null, costCents: estCost, errorCode: null, createdAt: nowTs, updatedAt: nowTs });

    try {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal.cancelled) throw new Error('cancelled');
        try {
          const result = await this.withTimeout(
            provider.complete({ system: prompt.system, user: prompt.user, params, outputContract: prompt.outputContract }, { model: cfg.model, apiKey: auth.apiKey, signal, timeoutMs: this.timeoutMs }),
            this.timeoutMs
          );
          // 取消后提交保护：迟到结果不得作为成功/缓存提交。
          if (signal.cancelled) {
            this.store.updateModelJob(jobId, { status: 'cancelled', costCents: 0, errorCode: 'JOB_CANCELLED' });
            this.cancels.delete(jobId);
            return { status: 'cancelled', jobId };
          }
          // 真实 Schema + 引用区间校验（真实模型与测试替身同一合同）。响应已发生 → 结算实际成本。
          const check = validateContract(prompt.outputContract, result.text, citations.length);
          if (!check.ok) {
            this.store.updateModelJob(jobId, { status: 'failed', costCents: result.costCents, errorCode: 'EXPORT_INVALID' });
            this.cancels.delete(jobId);
            return { status: 'failed', jobId, code: 'EXPORT_INVALID', note: `模型输出不合格(${check.reason})，未纳入可用缓存。` };
          }
          const resultJson = JSON.stringify({ text: result.text, parsed: check.parsed, provider: result.provider, model: result.model, isTestDouble: result.isTestDouble, promptVersion: PROMPT_VERSION, params, usage: result.usage, citations, materialVersions });
          this.store.updateModelJob(jobId, { status: 'succeeded', resultJson, costCents: result.costCents });
          this.cancels.delete(jobId);
          return { status: 'succeeded', jobId, result: JSON.parse(resultJson), costCents: result.costCents, fromCache: false };
        } catch (e) {
          lastErr = e as Error;
          const code = (e as Error).message;
          if (code === 'cancelled' || code === 'timeout') throw e;
          if (!TRANSIENT.has(code) || attempt === MAX_RETRIES) throw e;
          await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
        }
      }
      throw lastErr ?? new Error('unknown');
    } catch (e) {
      this.cancels.delete(jobId);
      const msg = (e as Error).message;
      if (msg === 'cancelled') {
        this.store.updateModelJob(jobId, { status: 'cancelled', costCents: 0, errorCode: 'JOB_CANCELLED' });
        return { status: 'cancelled', jobId };
      }
      if (msg === 'timeout') {
        // 超时：执行与费用不确定；保留预留成本（不以“调用失败”直接认定未计费）。
        this.store.updateModelJob(jobId, { status: 'uncertain', errorCode: 'REQUEST_UNCERTAIN' });
        return { status: 'uncertain', jobId, code: 'REQUEST_UNCERTAIN', note: '调用超时：执行与费用不确定，已保留预留额待核实。' };
      }
      // 明确未发生调用/未计费的失败（鉴权/密钥/网络前置）：成本置 0。
      const noCharge = msg === 'AUTH_FAILED' || msg === 'KEY_UNAVAILABLE' || msg === 'MODEL_NOT_AVAILABLE' || msg === 'NETWORK_UNAVAILABLE';
      this.store.updateModelJob(jobId, { status: 'failed', costCents: noCharge ? 0 : this.store.getModelJob(jobId)?.costCents ?? 0, errorCode: msg });
      const code = msg === 'AUTH_FAILED' ? 'AUTH_FAILED' : msg === 'RATE_LIMITED' ? 'RATE_LIMITED' : msg === 'NETWORK_UNAVAILABLE' ? 'NETWORK_UNAVAILABLE' : 'MODEL_NOT_AVAILABLE';
      return { status: 'failed', jobId, code, note: `调用未成功：${msg}` };
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), t]);
  }
}
