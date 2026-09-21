import type { PreparationSession, TeachingContext } from '../../main/preparation/types';
import type { ReviewReport } from '../../main/review/types';
import type { PreparationContextPayload, PreparationSourcePayload } from '../../shared/ipc';

export interface AiFlowGateway {
  saveContext: (
    payload: PreparationContextPayload,
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<TeachingContext>;
  createSession: (
    contextId: string,
    mode: 'model_assisted',
    idempotencyKey: string
  ) => Promise<PreparationSession>;
  setSources: (
    sessionId: string,
    sources: PreparationSourcePayload[],
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<PreparationSession>;
  build: (
    sessionId: string,
    guidance: string,
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<PreparationSession>;
  review: (
    sessionId: string,
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<{ session: PreparationSession; report: ReviewReport }>;
  confirm: (
    sessionId: string,
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<PreparationSession>;
  exportFiles: (
    sessionId: string,
    expectedRevision: number,
    idempotencyKey: string
  ) => Promise<PreparationSession>;
}

export interface AiPlanningInput {
  context: PreparationContextPayload;
  contextRevision: number;
  source: PreparationSourcePayload;
  guidance: string;
  idempotencyPrefix: string;
  onSession?: (session: PreparationSession) => void;
}

const AI_REFERENCE_BOUNDARY = [
  '未提供课程标准或考试说明原文时，可结合通用教学知识补充，但必须在 teacher_summary 或 unknowns 中明确标注“AI 补充参考，需教师核实”。',
  '不得虚构文件名称、版本、条款编号或考试范围，也不得把 AI 补充内容作为教材原文引用。',
  '教学设计优先形成学生可观察的学习任务、由文本证据支持的回答、逐步提升的认知要求和课内可完成的形成性评价。'
].join('');

export function composeAiGuidance(userGuidance: string): string {
  const extra = userGuidance.trim();
  return extra ? `${AI_REFERENCE_BOUNDARY}\n教师补充要求：${extra}` : AI_REFERENCE_BOUNDARY;
}

export async function runAiPlanning(
  gateway: AiFlowGateway,
  input: AiPlanningInput
): Promise<{ session: PreparationSession; report: ReviewReport }> {
  const savedContext = await gateway.saveContext(
    input.context,
    input.contextRevision,
    `${input.idempotencyPrefix}:context`
  );
  const created = await gateway.createSession(
    savedContext.contextId,
    'model_assisted',
    `${input.idempotencyPrefix}:session`
  );
  input.onSession?.(created);
  const selected = await gateway.setSources(
    created.sessionId,
    [input.source],
    created.revision,
    `${input.idempotencyPrefix}:sources`
  );
  input.onSession?.(selected);
  const built = await gateway.build(
    selected.sessionId,
    composeAiGuidance(input.guidance),
    selected.revision,
    `${input.idempotencyPrefix}:build`
  );
  input.onSession?.(built);
  return gateway.review(
    built.sessionId,
    built.revision,
    `${input.idempotencyPrefix}:review`
  );
}

export async function confirmAndExport(
  gateway: AiFlowGateway,
  session: PreparationSession,
  idempotencyPrefix: string
): Promise<PreparationSession> {
  const confirmed = await gateway.confirm(
    session.sessionId,
    session.revision,
    `${idempotencyPrefix}:confirm`
  );
  return gateway.exportFiles(
    confirmed.sessionId,
    confirmed.revision,
    `${idempotencyPrefix}:export`
  );
}
