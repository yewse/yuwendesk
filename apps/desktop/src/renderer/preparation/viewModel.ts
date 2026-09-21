import type { PreparationSession } from '../../main/preparation/types';
import type {
  PreparationPrimaryAction,
  PreparationStep,
  PreparationView,
  PreparationViewInput
} from './types';

const ORIGIN_LABELS: Record<PreparationSession['contentOrigin'], string> = {
  teacher_authored: '教师自拟',
  model_assisted_real: '模型辅助（真实服务）',
  model_assisted_simulated: '模型辅助（模拟）'
};

function route(input: PreparationViewInput): {
  step: PreparationStep;
  action: PreparationPrimaryAction;
  progressIndex: number;
} {
  const session = input.session;
  if (!session) return { step: 'context', action: 'save_context', progressIndex: 0 };
  switch (session.status) {
    case 'CONTEXT_DRAFT':
      return { step: 'sources', action: 'select_sources', progressIndex: 1 };
    case 'SOURCES_SELECTED':
      return { step: 'build', action: 'build_plan', progressIndex: 2 };
    case 'BUILDING':
      return { step: 'build', action: 'wait', progressIndex: 2 };
    case 'PLAN_REVIEW':
      return input.report?.disposition === 'ready_for_teacher'
        ? { step: 'review', action: 'confirm_plan', progressIndex: 3 }
        : { step: 'review', action: 'run_review', progressIndex: 3 };
    case 'READY_TO_EXPORT':
      return { step: 'export', action: 'export_files', progressIndex: 4 };
    case 'EXPORTING':
      return { step: 'export', action: 'wait', progressIndex: 4 };
    case 'EXPORTED':
      return { step: 'complete', action: 'open_presentation', progressIndex: 5 };
  }
}

export function buildPreparationView(input: PreparationViewInput): PreparationView {
  const routed = route(input);
  const session = input.session;
  return {
    step: routed.step,
    primaryActions: [routed.action],
    progressIndex: routed.progressIndex,
    originLabel: session ? ORIGIN_LABELS[session.contentOrigin] : '尚未生成',
    unknowns: input.plan ? [...input.plan.unknowns] : [],
    canExport: session?.status === 'READY_TO_EXPORT' && input.report?.disposition === 'ready_for_teacher',
    localFallbackAvailable: session?.mode === 'model_assisted' &&
      ['PREPARATION_MODEL_UNAVAILABLE', 'PREPARATION_MODEL_INVALID'].includes(session.lastErrorCode ?? ''),
    sessionId: session?.sessionId ?? null,
    planId: session?.planId ?? null,
    revisionId: session?.revisionId ?? null,
    bundleId: session?.bundleId ?? null,
    title: input.plan?.title ?? '',
    reviewDisposition: input.report?.disposition ?? null,
    notExecutedChecks: input.report ? [...input.report.not_executed_checks] : [],
    artifacts: input.artifacts.map((artifact) => ({
      role: artifact.role,
      format: artifact.format,
      filename: artifact.filename,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize
    }))
  };
}
