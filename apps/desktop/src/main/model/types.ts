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
  costCents: number;
  provider: string;
  model: string;
  isTestDouble: boolean; // 是否测试替身（非真实模型），需在结果中明确标注
}
export type ProbeResult =
  | { ok: true; provider: string; model: string; isTestDouble: boolean; note: string }
  | { ok: false; code: 'MODEL_NOT_AVAILABLE' | 'AUTH_FAILED' | 'NETWORK_UNAVAILABLE' | 'KEY_UNAVAILABLE'; note: string };

export interface CancelSignalLike {
  cancelled: boolean;
}

// 可注入/可拦截的 HTTP 传输：生产用真实 fetch；测试注入离线替身，禁止测试意外联网。
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  stream: boolean;
}
export interface TransportResponse {
  status: number;
  // 非流式：JSON 文本；流式：原始 SSE 文本（provider 负责解析）。
  text: string;
}
export type HttpTransport = (req: TransportRequest) => Promise<TransportResponse>;

export interface ModelProvider {
  id: string;
  defaultModel: string;
  requiresKey: boolean;
  // 每千 token 成本（分），用于预算预留与结算估算；测试替身为 0。
  costPer1kCents: number;
  probe(opts: { model: string; apiKey?: string; stream?: boolean }): Promise<ProbeResult>;
  complete(req: ModelRequest, ctx: { model: string; apiKey?: string; signal?: CancelSignalLike; timeoutMs: number; stream?: boolean }): Promise<ModelResult>;
}
