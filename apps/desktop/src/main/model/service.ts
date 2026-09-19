// G04 模型调用编排：配置/探测/密钥保护/预算/结构化调用/上下文边界/取消/超时/重试/缓存/结果持久化。
// 数据、检索与业务本地；模型走授权云 API。无真实账户时用明标测试替身完成本地链路，真实调用保持 BLOCKED。
import { createHash, randomUUID } from 'node:crypto';
import type { ModelConfig, ModelJobRecord, ModelStore, SourceStore } from '../store';
import { assemblePrompt, isKnownTask, PROMPT_VERSION } from './prompt';
import { getProvider, PROVIDERS } from './providers';
import { DEFAULT_PARAMS, type ApprovedFragment, type CancelSignalLike, type Citation, type ModelParams } from './types';

export interface CredentialLike {
  credentialEncryptionAvailable(): boolean;
  setCredential(name: string, plaintext: string): { ok: true; last4: string } | { ok: false; reason: string };
  readCredential(name: string): { ok: true; plaintext: string } | { ok: false; reason: string };
}
const KEY_NAME = 'model_api_key';
const MAX_RETRIES = 2;
const TRANSIENT = new Set(['NETWORK_UNAVAILABLE', 'RATE_LIMITED']);

export type ConfigureResult =
  | { ok: true; config: ModelConfig; keyStored: boolean }
  | { ok: false; code: 'UNKNOWN_PROVIDER' | 'KEY_UNAVAILABLE' | 'INPUT_INVALID'; note: string };
export type RunResult =
  | { status: 'succeeded' | 'cached'; jobId: string; result: unknown; costCents: number; fromCache: boolean }
  | { status: 'failed'; jobId: string; code: string; note: string }
  | { status: 'cancelled'; jobId: string }
  | { status: 'blocked'; code: 'PRIVACY_BLOCKED' | 'SOURCE_MISSING' | 'SOURCE_CONFLICT' | 'BUDGET_EXCEEDED' | 'INPUT_INVALID' | 'MODEL_NOT_AVAILABLE'; note: string };

export class ModelService {
  private readonly cancels = new Map<string, CancelSignalLike>();
  constructor(
    private readonly store: ModelStore & SourceStore & CredentialLike,
    private readonly timeoutMs = 20_000,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  configure(input: { provider: string; model?: string; params?: Partial<ModelParams>; budgetCapCents?: number; allowRealNetwork?: boolean; apiKey?: string }): ConfigureResult {
    const provider = getProvider(input.provider);
    if (!provider) return { ok: false, code: 'UNKNOWN_PROVIDER', note: `未知服务商：${input.provider}` };
    const model = input.model && input.model.trim() ? input.model.trim() : provider.defaultModel;
    const params: ModelParams = {
      temperature: input.params?.temperature ?? DEFAULT_PARAMS.temperature,
      maxTokens: input.params?.maxTokens ?? DEFAULT_PARAMS.maxTokens
    };
    const budgetCapCents = Math.max(0, Math.floor(input.budgetCapCents ?? 0));
    let keyStored = false;
    if (provider.requiresKey && input.apiKey) {
      // 密钥保护：只经 safeStorage 落密文；无安全后端则拒绝（真实服务商保持不可用）。
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

  async probe(): Promise<{ ok: boolean; note: string; code?: string; provider?: string; model?: string; isTestDouble?: boolean }> {
    const cfg = this.store.getModelConfig();
    if (!cfg) return { ok: false, note: '未配置服务商。', code: 'INPUT_INVALID' };
    const provider = getProvider(cfg.provider);
    if (!provider) return { ok: false, note: '未知服务商。', code: 'UNKNOWN_PROVIDER' };
    const apiKey = provider.requiresKey ? this.readKey() : undefined;
    const r = await provider.probe({ model: cfg.model, apiKey });
    return r.ok ? { ok: true, note: r.note, provider: r.provider, model: r.model, isTestDouble: r.isTestDouble } : { ok: false, note: r.note, code: r.code };
  }

  cancel(jobId: string): boolean {
    const sig = this.cancels.get(jobId);
    if (!sig) return false;
    sig.cancelled = true;
    return true;
  }

  private readKey(): string | undefined {
    const r = this.store.readCredential(KEY_NAME);
    return r.ok ? r.plaintext : undefined;
  }

  // 上下文边界：仅使用显式获准、非敏感、版本存在（未停用）的片段；记录引用。私有资料非获准不外发。
  private buildCitations(fragments: ApprovedFragment[]): { ok: true; citations: Citation[]; materialVersions: { versionId: string; textHash: string }[] } | { ok: false; code: 'PRIVACY_BLOCKED' | 'SOURCE_MISSING' | 'INPUT_INVALID'; note: string } {
    const citations: Citation[] = [];
    const materialVersions: { versionId: string; textHash: string }[] = [];
    for (const f of fragments) {
      if (!f.approved) return { ok: false, code: 'INPUT_INVALID', note: '存在未获准片段：默认私有资料不得自动外发。' };
      const meta = this.store.getVersionMeta(f.versionId);
      if (!meta) return { ok: false, code: 'SOURCE_MISSING', note: '片段所属版本不存在。' };
      if (meta.status === 'retired') return { ok: false, code: 'SOURCE_MISSING', note: '片段所属资料已停用，不进入模型上下文。' };
      if (meta.classification === 'student_sensitive') return { ok: false, code: 'PRIVACY_BLOCKED', note: '敏感学生材料不得进入模型上下文/外发。' };
      const read = this.store.readSource(f.versionId, f.charStart, f.charEnd);
      if (!read) return { ok: false, code: 'SOURCE_MISSING', note: '片段原文不可读。' };
      citations.push({
        versionId: f.versionId,
        title: meta.title,
        version: meta.version,
        charStart: f.charStart,
        charEnd: f.charEnd,
        locatorLabel: `字符${f.charStart}–${f.charEnd}`,
        excerpt: read.text.slice(0, 300)
      });
      materialVersions.push({ versionId: f.versionId, textHash: meta.textHash });
    }
    return { ok: true, citations, materialVersions };
  }

  async run(input: { task: string; instructionExtra?: string; fragments?: ApprovedFragment[] }): Promise<RunResult> {
    const cfg = this.store.getModelConfig();
    if (!cfg) return { status: 'blocked', code: 'INPUT_INVALID', note: '未配置服务商。' };
    if (!isKnownTask(input.task)) return { status: 'blocked', code: 'INPUT_INVALID', note: `未知任务：${input.task}` };
    const provider = getProvider(cfg.provider);
    if (!provider) return { status: 'blocked', code: 'INPUT_INVALID', note: '未知服务商。' };

    const boundary = this.buildCitations(input.fragments ?? []);
    if (!boundary.ok) return { status: 'blocked', code: boundary.code, note: boundary.note };

    const params: ModelParams = { temperature: cfg.temperature, maxTokens: cfg.maxTokens };
    const materialVersionsJson = JSON.stringify(boundary.materialVersions);
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ task: input.task, provider: cfg.provider, model: cfg.model, params, promptVersion: PROMPT_VERSION, instructionExtra: input.instructionExtra ?? '', materialVersions: boundary.materialVersions, fragments: input.fragments ?? [] }))
      .digest('hex');

    // 缓存：相同任务/模型/提示/参数/材料版本 → 复用已确认结果，不重复生成。
    const cached = this.store.findCachedJob(cacheKey);
    if (cached) return { status: 'cached', jobId: cached.id, result: cached.resultJson ? JSON.parse(cached.resultJson) : null, costCents: cached.costCents, fromCache: true };

    // 预算：先检查是否已达上限。
    if (cfg.budgetCapCents > 0 && this.store.budgetSpentCents() >= cfg.budgetCapCents) {
      return { status: 'blocked', code: 'BUDGET_EXCEEDED', note: '已达预算上限。' };
    }

    const prompt = assemblePrompt(input.task, input.instructionExtra ?? '', boundary.citations);
    const jobId = randomUUID();
    const signal: CancelSignalLike = { cancelled: false };
    this.cancels.set(jobId, signal);
    const nowTs = this.now();
    this.store.insertModelJob({
      id: jobId,
      task: input.task,
      cacheKey,
      provider: cfg.provider,
      model: cfg.model,
      paramsJson: JSON.stringify(params),
      promptVersion: PROMPT_VERSION,
      materialVersionsJson,
      status: 'running',
      resultJson: null,
      costCents: 0,
      errorCode: null,
      createdAt: nowTs,
      updatedAt: nowTs
    });

    try {
      const apiKey = provider.requiresKey ? this.readKey() : undefined;
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal.cancelled) throw new Error('cancelled');
        try {
          const result = await this.withTimeout(
            provider.complete({ system: prompt.system, user: prompt.user, params, outputContract: prompt.outputContract }, { model: cfg.model, apiKey, signal, timeoutMs: this.timeoutMs }),
            this.timeoutMs
          );
          const resultJson = JSON.stringify({
            text: result.text,
            provider: result.provider,
            model: result.model,
            isTestDouble: result.isTestDouble,
            promptVersion: PROMPT_VERSION,
            params,
            usage: result.usage,
            citations: boundary.citations,
            materialVersions: boundary.materialVersions
          });
          this.store.updateModelJob(jobId, { status: 'succeeded', resultJson, costCents: result.costCents });
          this.cancels.delete(jobId);
          return { status: 'succeeded', jobId, result: JSON.parse(resultJson), costCents: result.costCents, fromCache: false };
        } catch (e) {
          lastErr = e as Error;
          const code = (e as Error).message;
          if (code === 'cancelled') throw e;
          if (!TRANSIENT.has(code) || attempt === MAX_RETRIES) throw e;
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); // 退避重试
        }
      }
      throw lastErr ?? new Error('unknown');
    } catch (e) {
      this.cancels.delete(jobId);
      const msg = (e as Error).message;
      if (msg === 'cancelled') {
        this.store.updateModelJob(jobId, { status: 'cancelled', errorCode: 'JOB_CANCELLED' });
        return { status: 'cancelled', jobId };
      }
      const code = msg === 'MODEL_NOT_AVAILABLE' ? 'MODEL_NOT_AVAILABLE' : msg === 'timeout' ? 'REQUEST_UNCERTAIN' : 'MODEL_NOT_AVAILABLE';
      this.store.updateModelJob(jobId, { status: 'failed', errorCode: code });
      return { status: 'failed', jobId, code, note: msg === 'timeout' ? '调用超时，结果不确定。' : '真实调用不可用（未授权/未验证）。' };
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), t]);
  }

  listJobs(limit = 50): ModelJobRecord[] {
    return this.store.listModelJobs(limit);
  }

  providerCatalog(): { id: string; defaultModel: string; requiresKey: boolean }[] {
    return Object.values(PROVIDERS).map((p) => ({ id: p.id, defaultModel: p.defaultModel, requiresKey: p.requiresKey }));
  }
}
