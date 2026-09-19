// 服务商适配：产品运行模型不绑定某一厂商。测试替身完成本地链路；DeepSeek 为主力候选，
// 实现真实协议（请求构造/传输/响应与流式解析/错误映射）。传输可注入以离线测试，禁止测试意外联网；
// 真实账户联网烟测在获授权前保持 BLOCKED。
import type { HttpTransport, ModelProvider, ModelRequest, ModelResult, ProbeResult, TransportResponse } from './types';

// 测试替身：本机确定性生成，且严格遵守输出合同（与真实模型受同一 Schema/引用校验）。
export const testDoubleProvider: ModelProvider = {
  id: 'test-double',
  defaultModel: 'test-double-v0',
  requiresKey: false,
  costPer1kCents: 0,
  async probe({ model }): Promise<ProbeResult> {
    return { ok: true, provider: 'test-double', model, isTestDouble: true, note: '测试替身可用（本机确定性输出，非真实模型）' };
  },
  async complete(req: ModelRequest, ctx): Promise<ModelResult> {
    if (ctx.signal?.cancelled) throw new Error('cancelled');
    const n = (req.user.match(/【引用\d+】/g) ?? []).length;
    const cites = Array.from({ length: n }, (_v, i) => i + 1); // 引用 1..N（在授权片段范围内）
    let body: unknown;
    if (req.outputContract === 'lesson_outline.v1') {
      body = {
        objectives: ['朗读课文，把握重音与停连', '体会比喻与拟人的表达效果'],
        steps: [
          { stage: '导入', minutes: 5, activity: '情境导入与齐读', citations: cites.slice(0, 1) },
          { stage: '研读', minutes: 20, activity: '分组研读并交流修辞', citations: cites },
          { stage: '活动', minutes: 15, activity: '仿写“春天像……”', citations: cites.slice(0, 1) }
        ],
        notes: ['具体版本/引文需教师核实（测试替身生成，非真实模型）']
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
      costCents: 0,
      provider: 'test-double',
      model: ctx.model || 'test-double-v0',
      isTestDouble: true
    };
  }
};

// 默认真实传输：仅在生产授权后实际发起；使用全局 fetch。
const realFetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, text: await res.text() };
};

interface DeepseekChoiceMsg {
  choices?: { message?: { content?: string }; delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

// 解析流式 SSE：拼接 delta.content，遇 [DONE] 结束。
function parseStream(text: string): { content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } {
  let content = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      const j = JSON.parse(payload) as DeepseekChoiceMsg;
      const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
      content += delta;
      if (j.usage) usage = j.usage;
    } catch {
      // 忽略不可解析的分片行（不当作正文）
    }
  }
  return { content, usage };
}

function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'NETWORK_UNAVAILABLE';
  return 'MODEL_NOT_AVAILABLE';
}

// DeepSeek（OpenAI 兼容 /chat/completions）。默认模型 deepseek-flash（实际以接入时验证为准）。
export function createDeepseekProvider(transport: HttpTransport = realFetchTransport, baseUrl = 'https://api.deepseek.com'): ModelProvider {
  const costPer1kCents = 1; // 估算占位：每千 token 1 分；真实费率以账户/文档为准。
  async function call(model: string, apiKey: string, messages: { role: string; content: string }[], temperature: number, maxTokens: number, stream: boolean): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream });
    let res: TransportResponse;
    try {
      res = await transport({ url: `${baseUrl}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body, stream });
    } catch {
      throw new Error('NETWORK_UNAVAILABLE'); // 传输层异常（含超时/断网）
    }
    if (res.status < 200 || res.status >= 300) throw new Error(mapHttpError(res.status));
    if (stream) {
      const s = parseStream(res.text);
      return { content: s.content, promptTokens: s.usage?.prompt_tokens ?? 0, completionTokens: s.usage?.completion_tokens ?? 0 };
    }
    let j: DeepseekChoiceMsg;
    try {
      j = JSON.parse(res.text) as DeepseekChoiceMsg;
    } catch {
      throw new Error('MODEL_NOT_AVAILABLE'); // 响应非 JSON
    }
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('MODEL_NOT_AVAILABLE');
    return { content, promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 };
  }
  return {
    id: 'deepseek',
    defaultModel: 'deepseek-flash',
    requiresKey: true,
    costPer1kCents,
    async probe({ model, apiKey, stream }): Promise<ProbeResult> {
      if (!apiKey) return { ok: false, code: 'KEY_UNAVAILABLE', note: '未配置受保护的 API 密钥。' };
      try {
        // 轻量探测：一次极小的真实请求（离线测试走注入传输）。
        await call(model, apiKey, [{ role: 'user', content: 'ping' }], 0, 1, !!stream);
        return { ok: true, provider: 'deepseek', model, isTestDouble: false, note: `deepseek(${model}) 探测成功。` };
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
        !!ctx.stream
      );
      const totalTokens = r.promptTokens + r.completionTokens;
      return {
        text: r.content,
        usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens },
        costCents: Math.ceil((totalTokens / 1000) * costPer1kCents),
        provider: 'deepseek',
        model: ctx.model,
        isTestDouble: false
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
