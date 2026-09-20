// 服务商适配：产品运行模型不绑定某一厂商。测试替身完成本地链路（内容=模拟）；DeepSeek 实现真实协议
// （请求构造/传输/非流式与真正增量流式解析/finish_reason 核对/错误映射/用量与费用）。
// 传输可注入以离线测试（禁止测试实网），取消/超时经 AbortSignal 传播到传输层。
// 内容来源身份（real/offline-injected/simulated）随结果传递：经 DeepSeek 适配器的离线注入仍为“模拟内容”。
import type { ContentOrigin, HttpTransport, ModelProvider, ModelRequest, ModelResult, PricingConfig, ProbeResult, TransportResponse } from './types';

const SIM_PRICING: PricingConfig = { currency: 'SIM', per1kInputCents: 0, per1kOutputCents: 0, source: 'simulated', effectiveDate: 'N/A', isEstimate: true };

// 测试替身：本机确定性生成，严格遵守输出合同；内容来源=simulated。
export const testDoubleProvider: ModelProvider = {
  id: 'test-double',
  defaultModel: 'test-double-v0',
  requiresKey: false,
  pricing: SIM_PRICING,
  contentOrigin: 'simulated',
  async probe({ model }): Promise<ProbeResult> {
    return { ok: true, provider: 'test-double', model, isTestDouble: true, note: '测试替身可用（本机确定性输出，内容为模拟）' };
  },
  async complete(req: ModelRequest, ctx): Promise<ModelResult> {
    if (ctx.signal?.cancelled) throw new Error('cancelled');
    const n = (req.user.match(/【引用\d+】/g) ?? []).length;
    const cites = Array.from({ length: n }, (_v, i) => i + 1);
    let body: unknown;
    if (req.outputContract === 'teaching_attribution.v1') {
      let observationIds: string[] = [];
      try {
        const marker = '补充要求：';
        const start = req.user.indexOf(marker);
        const end = req.user.indexOf('\n\n', start);
        const raw = start >= 0 ? req.user.slice(start + marker.length, end >= 0 ? end : undefined) : '';
        const parsed = JSON.parse(raw) as { observations?: Array<{ observationId?: unknown }> };
        observationIds = (parsed.observations ?? []).flatMap((item) => typeof item.observationId === 'string' ? [item.observationId] : []);
      } catch {
        observationIds = [];
      }
      const observationId = observationIds[0] ?? 'observation_missing';
      body = {
        hypotheses: [
          {
            kind: 'support_mismatch',
            summary: '待验证：当前提示程度可能遮蔽独立作答表现。',
            observation_ids: [observationId],
            evidence_basis: ['结构化记录显示作答发生在有提示条件下。'],
            limitations: ['该观察不能外推为全班结论。'],
            disconfirming_evidence: ['若相似新题在无提示下稳定完成，应撤回该假设。'],
            return_modules: ['M11']
          },
          {
            kind: 'time_constraint',
            summary: '待验证：实际课堂时间可能限制了独立表达机会。',
            observation_ids: [observationId],
            evidence_basis: ['结构化上下文包含实际授课时长。'],
            limitations: ['未进行教学专业复核，不能据此认定因果。'],
            disconfirming_evidence: ['若等时条件下表现无变化，应撤回该假设。'],
            return_modules: ['M08', 'M11']
          }
        ],
        is_effectiveness_proof: false
      };
    } else if (req.outputContract === 'lesson_outline.v1') {
      body = {
        objectives: ['朗读课文，把握重音与停连', '体会比喻与拟人的表达效果'],
        steps: [
          { stage: '导入', minutes: 5, activity: '情境导入与齐读', citations: cites.slice(0, 1) },
          { stage: '研读', minutes: 20, activity: '分组研读并交流修辞', citations: cites },
          { stage: '活动', minutes: 15, activity: '仿写“春天像……”', citations: cites.slice(0, 1) }
        ],
        notes: ['具体版本/引文需教师核实（测试替身生成，内容为模拟）']
      };
    } else {
      body = {
        summary: '（测试替身）课文主旨占位：描绘春天生机，表达喜悦与希望。',
        structure: ['盼春', '绘春', '赞春'],
        rhetoric: ['比喻', '拟人'],
        teaching_suggestions: ['朗读与重音停连', '比喻/拟人辨析', '分组活动设计'],
        citations: cites
      };
    }
    const text = JSON.stringify(body, null, 2);
    return {
      text,
      usage: { promptTokens: Math.ceil((req.system.length + req.user.length) / 4), completionTokens: Math.ceil(text.length / 4) },
      usageKnown: true,
      costCents: 0,
      provider: 'test-double',
      model: ctx.model || 'test-double-v0',
      isTestDouble: true,
      contentOrigin: 'simulated',
      finishReason: 'stop',
      pricing: SIM_PRICING
    };
  }
};

// 默认真实传输：使用全局 fetch，支持 AbortSignal 与流式 body 增量读取。
const realFetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
  if (req.stream && res.body) {
    const reader = (res.body as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }).getReader();
    const dec = new TextDecoder();
    const iter = async function* (): AsyncIterable<string> {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield dec.decode(value, { stream: true });
      }
    };
    return { status: res.status, stream: iter() };
  }
  return { status: res.status, text: await res.text() };
};

interface DeepseekMsg {
  choices?: { message?: { content?: string }; delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK_UNAVAILABLE';
  return 'MODEL_NOT_AVAILABLE';
}

// 真正增量流式解析：逐分片缓冲、按行解析 SSE，累计 delta、核对 finish_reason 与 [DONE]；中途可中止。
async function consumeStream(stream: AsyncIterable<string>, signal?: { cancelled: boolean }): Promise<{ content: string; finishReason: string; done: boolean; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  let buffer = '';
  let content = '';
  let finishReason = '';
  let done = false;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const handleLine = (line: string): void => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    try {
      const j = JSON.parse(payload) as DeepseekMsg;
      const ch = j.choices?.[0];
      content += ch?.delta?.content ?? ch?.message?.content ?? '';
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      if (j.usage) usage = j.usage;
    } catch {
      /* 忽略不可解析分片 */
    }
  };
  for await (const chunk of stream) {
    if (signal?.cancelled) throw new Error('cancelled'); // 取消传播到流处理
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (done) break;
    }
    if (done) break;
  }
  if (buffer.length) handleLine(buffer);
  return { content, finishReason, done, usage };
}

export interface DeepseekOpts {
  contentOrigin?: ContentOrigin; // 真实 fetch→'real'；离线注入→'offline-injected'
  pricing?: PricingConfig;
  baseUrl?: string;
}

export function createDeepseekProvider(transport: HttpTransport = realFetchTransport, opts: DeepseekOpts = {}): ModelProvider {
  const contentOrigin: ContentOrigin = opts.contentOrigin ?? 'real';
  // 真实价格：核实前为估算（isEstimate=true），保留币种/来源/生效时间。
  const pricing: PricingConfig = opts.pricing ?? { currency: 'CNY', per1kInputCents: 1, per1kOutputCents: 2, source: 'config-estimate', effectiveDate: 'N/A', isEstimate: true };
  const baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';

  async function call(
    model: string,
    apiKey: string,
    messages: { role: string; content: string }[],
    temperature: number,
    maxTokens: number,
    stream: boolean,
    abort?: AbortSignal,
    cancel?: { cancelled: boolean }
  ): Promise<{ content: string; finishReason: string; promptTokens: number; completionTokens: number; usageKnown: boolean }> {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream });
    let res: TransportResponse;
    try {
      res = await transport({ url: `${baseUrl}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body, stream, signal: abort });
    } catch (e) {
      if ((e as Error).message === 'cancelled') throw e;
      throw new Error('NETWORK_UNAVAILABLE');
    }
    if (res.status < 200 || res.status >= 300) throw new Error(mapHttpError(res.status));
    if (stream) {
      if (!res.stream) throw new Error('MODEL_NOT_AVAILABLE');
      const s = await consumeStream(res.stream, cancel);
      if (!s.done) throw new Error('INCOMPLETE'); // 协议未正常终止（无 [DONE]）
      return { content: s.content, finishReason: s.finishReason || 'stop', promptTokens: s.usage?.prompt_tokens ?? 0, completionTokens: s.usage?.completion_tokens ?? 0, usageKnown: s.usage !== undefined };
    }
    let j: DeepseekMsg;
    try {
      j = JSON.parse(res.text ?? '') as DeepseekMsg;
    } catch {
      throw new Error('MODEL_NOT_AVAILABLE');
    }
    const ch = j.choices?.[0];
    const content = ch?.message?.content;
    if (typeof content !== 'string') throw new Error('MODEL_NOT_AVAILABLE');
    return { content, finishReason: ch?.finish_reason ?? '', promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0, usageKnown: j.usage !== undefined };
  }

  return {
    id: 'deepseek',
    defaultModel: 'deepseek-flash',
    requiresKey: true,
    pricing,
    contentOrigin,
    async probe({ model, apiKey, stream, signal }): Promise<ProbeResult> {
      if (!apiKey) return { ok: false, code: 'KEY_UNAVAILABLE', note: '未配置受保护的 API 密钥。' };
      try {
        await call(model, apiKey, [{ role: 'user', content: 'ping' }], 0, 1, !!stream, signal);
        const note = contentOrigin === 'real' ? `deepseek(${model}) 探测成功。` : `deepseek(${model}) 探测成功（离线注入传输，内容为模拟）。`;
        return { ok: true, provider: 'deepseek', model, isTestDouble: false, note };
      } catch (e) {
        const c = (e as Error).message;
        const known: 'MODEL_NOT_AVAILABLE' | 'AUTH_FAILED' | 'NETWORK_UNAVAILABLE' | 'KEY_UNAVAILABLE' =
          c === 'AUTH_FAILED' || c === 'NETWORK_UNAVAILABLE' || c === 'KEY_UNAVAILABLE' ? c : 'MODEL_NOT_AVAILABLE';
        return { ok: false, code: known, note: `deepseek 探测失败：${c}` };
      }
    },
    async complete(req: ModelRequest, ctx): Promise<ModelResult> {
      if (!ctx.apiKey) throw new Error('KEY_UNAVAILABLE');
      if (ctx.signal?.cancelled) throw new Error('cancelled');
      const r = await call(
        ctx.model,
        ctx.apiKey,
        [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ],
        req.params.temperature,
        req.params.maxTokens,
        !!ctx.stream,
        ctx.abort,
        ctx.signal
      );
      const costCents = Math.ceil((r.promptTokens / 1000) * pricing.per1kInputCents + (r.completionTokens / 1000) * pricing.per1kOutputCents);
      return {
        text: r.content,
        usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens },
        usageKnown: r.usageKnown,
        costCents,
        provider: 'deepseek',
        model: ctx.model,
        isTestDouble: false,
        contentOrigin, // 经适配器的离线注入仍标 offline-injected（模拟内容）
        finishReason: r.finishReason,
        pricing
      };
    }
  };
}

export const deepseekProvider = createDeepseekProvider();

export function defaultProviders(): Record<string, ModelProvider> {
  return { 'test-double': testDoubleProvider, deepseek: deepseekProvider };
}
export const PROVIDERS = defaultProviders();
export function getProvider(id: string): ModelProvider | undefined {
  return PROVIDERS[id];
}
