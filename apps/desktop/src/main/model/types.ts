// G04 模型调用类型。产品运行模型不绑定某一厂商：服务商与实际模型 ID 均可配置。
export interface ModelParams {
  temperature: number;
  maxTokens: number;
}
export const DEFAULT_PARAMS: ModelParams = { temperature: 0.4, maxTokens: 1200 };

// 已获准可进入模型上下文的资料片段（须显式获准、通过版本/权限/引用边界）。
export interface ApprovedFragment {
  versionId: string;
  charStart: number;
  charEnd: number;
  approved: boolean;
}
export interface Citation {
  versionId: string;
  title: string;
  version: number;
  charStart: number;
  charEnd: number;
  locatorLabel: string;
  excerpt: string;
}

export interface ModelRequest {
  system: string;
  user: string;
  params: ModelParams;
  outputContract: string; // 输出合同名（约束返回结构）
}
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
}
export interface ModelResult {
  text: string;
  usage: ModelUsage;
  usageKnown: boolean; // 用量是否已知（未知用量不得自动按零费用结算）
  costCents: number;
  provider: string;
  model: string;
  isTestDouble: boolean; // 是否测试替身（非真实模型），需在结果中明确标注
  contentOrigin: ContentOrigin; // 内容来源身份（随缓存/课程/成品传递）
  finishReason: string; // 协议终止原因：'stop' 正常；'length' 截断；'' 未终止
  pricing: PricingConfig; // 费率身份
}
export type ProbeResult =
  | { ok: true; provider: string; model: string; isTestDouble: boolean; note: string }
  | { ok: false; code: 'MODEL_NOT_AVAILABLE' | 'AUTH_FAILED' | 'NETWORK_UNAVAILABLE' | 'KEY_UNAVAILABLE'; note: string };

export interface CancelSignalLike {
  cancelled: boolean;
}

// 费率配置：模拟费率与真实价格分离；保留币种、来源、生效时间与“是否估算”身份。
export interface PricingConfig {
  currency: string; // 'SIM'（模拟）| 'CNY' | 'USD' …
  per1kInputCents: number;
  per1kOutputCents: number;
  source: string; // 'simulated' | 'config' | 'official-doc'
  effectiveDate: string; // ISO 或 'N/A'
  isEstimate: boolean; // 真实价格核实前均为估算
}
// 内容来源身份：真实模型输出 / 经适配器的离线注入(仍为模拟) / 纯测试替身。随缓存、课程、成品传递。
export type ContentOrigin = 'real' | 'offline-injected' | 'simulated';

// 可注入/可拦截的 HTTP 传输：生产用真实 fetch；测试注入离线替身，禁止测试意外联网。
// 取消/超时通过 AbortSignal 传播到传输层。
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  stream: boolean;
  signal?: AbortSignal;
}
export interface TransportResponse {
  status: number;
  // 非流式：JSON 文本；流式：提供增量分片异步序列（provider 增量消费并核对 finish_reason）。
  text?: string;
  stream?: AsyncIterable<string>;
}
export type HttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

export interface ModelProvider {
  id: string;
  defaultModel: string;
  requiresKey: boolean;
  pricing: PricingConfig; // 该服务商的费率身份（模拟/真实分离）
  contentOrigin: ContentOrigin; // 该 provider 产出内容的来源身份
  probe(opts: { model: string; apiKey?: string; stream?: boolean; signal?: AbortSignal }): Promise<ProbeResult>;
  complete(req: ModelRequest, ctx: { model: string; apiKey?: string; signal?: CancelSignalLike; abort?: AbortSignal; timeoutMs: number; stream?: boolean }): Promise<ModelResult>;
}
