// 服务商适配：先完成一个主力（可配置）与一个明确标注的测试替身。
// 真实联网调用在获得授权前保持 BLOCKED（不伪造通过）。产品运行模型不绑定某一厂商。
import type { ModelProvider, ModelRequest, ModelResult, ProbeResult } from './types';

// 测试替身：本机确定性生成结构化输出，用于打通本地链路（无网络）。结果明确标注为非真实模型。
export const testDoubleProvider: ModelProvider = {
  id: 'test-double',
  defaultModel: 'test-double-v0',
  requiresKey: false,
  async probe({ model }): Promise<ProbeResult> {
    return { ok: true, provider: 'test-double', model, isTestDouble: true, note: '测试替身可用（本机确定性输出，非真实模型）' };
  },
  async complete(req: ModelRequest, ctx): Promise<ModelResult> {
    if (ctx.signal?.cancelled) throw new Error('cancelled');
    // 依据输出合同产出确定性 JSON：包含分析/建议与引用计数，明确标注测试替身。
    const citationCount = (req.user.match(/【引用\d+】/g) ?? []).length;
    const body = {
      contract: req.outputContract,
      note: '本结果由测试替身生成（非真实模型，仅打通本地链路）。',
      analysis: '（测试替身）依据所提供的获准片段进行结构化分析占位：主旨、结构与修辞留待真实模型产出。',
      teaching_suggestions: ['朗读与重音停连', '比喻/拟人辨析', '分组活动设计'],
      used_citations: citationCount
    };
    const text = JSON.stringify(body, null, 2);
    const promptTokens = Math.ceil((req.system.length + req.user.length) / 4);
    const completionTokens = Math.ceil(text.length / 4);
    return {
      text,
      usage: { promptTokens, completionTokens },
      costCents: 0, // 测试替身零成本
      provider: 'test-double',
      model: ctx.model || 'test-double-v0',
      isTestDouble: true
    };
  }
};

// DeepSeek 主力候选（可配置实际模型 ID，默认 deepseek-flash）。真实调用需账户/授权与联网，
// 未授权前一律 BLOCKED（不伪造通过；真实能力、参数与费用以接入时验证为准）。
export const deepseekProvider: ModelProvider = {
  id: 'deepseek',
  defaultModel: 'deepseek-flash',
  requiresKey: true,
  async probe({ model, apiKey }): Promise<ProbeResult> {
    if (!apiKey) return { ok: false, code: 'KEY_UNAVAILABLE', note: '未配置受保护的 API 密钥；真实探测 BLOCKED。' };
    // 未获授权联网：明确 BLOCKED，不伪造。真实探测将在接入授权账户后启用。
    return { ok: false, code: 'MODEL_NOT_AVAILABLE', note: `deepseek(${model}) 真实联网未授权：保持 BLOCKED/未验证。` };
  },
  async complete(_req: ModelRequest, ctx): Promise<ModelResult> {
    // 真实调用未授权：不发起网络请求，直接 BLOCKED。
    void ctx;
    throw new Error('MODEL_NOT_AVAILABLE');
  }
};

export const PROVIDERS: Record<string, ModelProvider> = {
  'test-double': testDoubleProvider,
  deepseek: deepseekProvider
};

export function getProvider(id: string): ModelProvider | undefined {
  return PROVIDERS[id];
}
