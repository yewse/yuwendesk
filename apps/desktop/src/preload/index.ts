import { contextBridge, ipcRenderer } from 'electron';
import type {
  BootstrapData,
  BackupRecordDTO,
  DraftData,
  HealthData,
  IpcRequest,
  IpcResponse,
  OperationName,
  PreparationContextPayload,
  PreparationSessionSummaryDTO,
  PreparationSourcePayload,
  SaveDraftPayload,
  RestorePreviewDTO,
  SourceHitDTO,
  SourceImportPayload,
  SourceListItemDTO,
  SourceReadDTO,
  SourceVersionDTO,
  StatusData
} from '../shared/ipc';
import type { ReviewReport } from '../main/review/types';
import type { PresentationDTO } from '../main/presentation/service';
import type { PreparationResumeDTO } from '../renderer/preparation/types';
import type { ChangePreview, LessonChange } from '../main/change/types';
import type { LessonChangeApplyOutcome } from '../main/store';
import type { DiagnosticSaveResult, DiagnosticsPreview } from '../main/protection/diagnostics';
import type { UpdateInspectionResult, UpdateStageResult } from '../main/update/service';
import type {
  FeedbackHistory,
  FeedbackAnalysisHistory,
  FeedbackAnalysisResult,
  FeedbackCorrectionHistory,
  CorrectionDecisionResult,
  EffectEvidenceState,
  FeedbackKnowledgeState,
  FeedbackWriteResult,
  ImplementationState,
  ObservationDeleteResult,
  ObservationMaterialRelation,
  ObservationOutcomeValue,
  ObservationRecord,
  ObservationSelection,
  ObservationSourceKind,
  ObservationSupportLevel,
  TeachingEvent
} from '../main/feedback/types';

// 预加载在 sandbox=true 下不能 require 本地模块，因此保持完全自包含：
// 仅使用类型导入（编译期擦除）与本地常量，运行时只依赖 electron。
const IPC_SCHEMA_VERSION = '1.0.0';

// 预加载只暴露固定的命名方法，绝不暴露通用 invoke(channel, ...args)、fs、shell 或原始 ipcRenderer。
function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

async function call<TData>(
  operation: OperationName,
  extra: Partial<IpcRequest> = {}
): Promise<IpcResponse<TData>> {
  const request: IpcRequest = {
    schema_version: IPC_SCHEMA_VERSION,
    request_id: newRequestId(),
    operation,
    workspace_id: null,
    ...extra
  };
  return ipcRenderer.invoke(`yuwen:${operation}`, request) as Promise<IpcResponse<TData>>;
}

const api = {
  schemaVersion: IPC_SCHEMA_VERSION,
  bootstrap: () => call<BootstrapData>('app.bootstrap'),
  health: () => call<HealthData>('app.health'),
  getStatus: () => call<StatusData>('app.getStatus'),
  loadDraft: () => call<DraftData>('ui.loadDraft'),
  saveDraft: (content: string, expectedRevision: number, idempotencyKey: string) =>
    call<DraftData>('ui.saveDraft', {
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload: { content } satisfies SaveDraftPayload
    }),
  // G03 资料：导入/列表/搜索/查看/停用（内容在渲染层通过原生文件选择或拖拽读取后传入）。
  importSource: (payload: SourceImportPayload) =>
    call<{
      status: string;
      documentId?: string;
      versionId?: string;
      version?: number;
      contentHash?: string;
      versionConflict?: boolean;
      existing?: { documentId: string; title: string; currentVersion: number; currentHash: string };
    }>('sources.import', { payload }),
  importFile: (payload: {
    title: string;
    format: string;
    base64: string;
    classification?: string;
    relation?: 'new_version' | 'separate';
    targetDocumentId?: string;
    jobId?: string;
  }) =>
    call<{
      status: string;
      documentId?: string;
      versionId?: string;
      version?: number;
      contentHash?: string;
      versionConflict?: boolean;
      existing?: { documentId: string; title: string; currentVersion: number; currentHash: string };
    }>('sources.importFile', { payload }),
  cancelImport: (jobId: string) => call<{ cancelled: boolean }>('sources.cancelImport', { payload: { jobId } }),
  listSources: () => call<{ sources: SourceListItemDTO[] }>('sources.list'),
  searchSources: (query: string) => call<{ hits: SourceHitDTO[] }>('sources.search', { payload: { query } }),
  readSource: (versionId: string, charStart?: number, charEnd?: number) =>
    call<SourceReadDTO>('sources.read', {
      payload:
        typeof charStart === 'number' && typeof charEnd === 'number' ? { versionId, charStart, charEnd } : { versionId }
    }),
  retireSource: (documentId: string) => call<{ documentId: string; status: string }>('sources.retire', { payload: { documentId } }),
  sourceVersions: (documentId: string) => call<{ versions: SourceVersionDTO[] }>('sources.versions', { payload: { documentId } }),
  readOriginal: (versionId: string) =>
    call<{ base64: string; originalHash: string; byteSize: number; mime: string }>('sources.readOriginal', { payload: { versionId } }),
  reclassifySourceSensitive: (documentId: string, expectedRevision: number, idempotencyKey: string) =>
    call<{
      status: 'succeeded'; documentId: string; classification: 'student_sensitive'; revision: number;
      protectedVersionIds: string[]; invalidatedLessonRevisionIds: string[]; deletedModelJobIds: string[]; replayed: boolean;
    }>('sources.reclassify', {
      workspace_id: 'workspace_local',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload: { documentId, targetClassification: 'student_sensitive' }
    }),
  prepareSourceDelete: (documentId: string, expectedRevision: number, idempotencyKey: string) =>
    call<{
      cancelled?: boolean; confirmationToken?: string; expiresAt?: number; managedBackupIds?: string[];
      policy?: 'delete_managed_and_create_post_delete' | 'keep_managed';
      externalOrOfflineBackups?: 'cannot_be_recalled'; ssdPhysicalErasure?: 'not_guaranteed';
    }>('sources.prepareDelete', {
      workspace_id: 'workspace_local',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload: { documentId }
    }),
  deleteSourcePermanently: (
    documentId: string,
    expectedRevision: number,
    confirmationToken: string,
    managedBackupIds: string[],
    policy: 'delete_managed_and_create_post_delete' | 'keep_managed',
    idempotencyKey: string
  ) => call<{
    status: 'succeeded'; documentId: string; databaseDeleted: true; deletedVersionCount: number;
    managedBackupDeletedIds: string[]; managedBackupRemainingIds: string[]; postDeleteBackupId: string | null;
    externalOrOfflineBackups: 'not_recalled'; ssdPhysicalErasure: 'not_guaranteed'; replayed: boolean;
  }>('sources.delete', {
    workspace_id: 'workspace_local',
    expected_revision: expectedRevision,
    idempotency_key: idempotencyKey,
    payload: { documentId, confirmationToken, managedBackupIds, policy }
  }),
  // G04 模型（教师不写提示词；此处仅配置/探测/运行/查看）。
  modelProviders: () => call<{ providers: { id: string; defaultModel: string; requiresKey: boolean }[] }>('model.providers'),
  modelGetConfig: () => call<{ config: unknown }>('model.getConfig'),
  modelConfigure: (payload: { provider: string; model?: string; temperature?: number; maxTokens?: number; budgetCapCents?: number; allowRealNetwork?: boolean; apiKey?: string }) =>
    call<{ config: unknown; keyStored: boolean }>('model.configure', { payload }),
  modelProbe: () => call<{ ok: boolean; note: string; provider?: string; model?: string; isTestDouble?: boolean }>('model.probe'),
  modelRun: (payload: { task: string; instructionExtra?: string; fragments?: { versionId: string; charStart: number; charEnd: number; approved: boolean }[] }) =>
    call<{ status: string; jobId?: string; result?: unknown; costCents?: number; fromCache?: boolean }>('model.run', { payload }),
  modelCancel: (jobId: string) => call<{ cancelled: boolean }>('model.cancel', { payload: { jobId } }),
  modelListJobs: (limit?: number) => call<{ jobs: unknown[] }>('model.listJobs', { payload: limit ? { limit } : {} }),
  preparationContextSave: (payload: PreparationContextPayload, expectedRevision: number, idempotencyKey: string) =>
    call<unknown>('preparation.context.save', {
      workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey, payload
    }),
  preparationContextGet: (contextId: string) =>
    call<unknown>('preparation.context.get', { workspace_id: 'workspace_local', payload: { contextId } }),
  preparationSessionCreate: (
    contextId: string,
    mode: 'local_authored' | 'model_assisted',
    idempotencyKey: string
  ) => call<unknown>('preparation.session.create', {
    workspace_id: 'workspace_local', expected_revision: 0, idempotency_key: idempotencyKey, payload: { contextId, mode }
  }),
  preparationSessionGet: (sessionId: string) =>
    call<unknown>('preparation.session.get', { workspace_id: 'workspace_local', payload: { sessionId } }),
  preparationSessionList: () =>
    call<{ sessions: PreparationSessionSummaryDTO[] }>('preparation.session.list', { workspace_id: 'workspace_local' }),
  preparationResume: (sessionId: string) =>
    call<PreparationResumeDTO>('preparation.resume', { workspace_id: 'workspace_local', payload: { sessionId } }),
  preparationSourcesSet: (
    sessionId: string,
    sources: PreparationSourcePayload[],
    expectedRevision: number,
    idempotencyKey: string
  ) => call<unknown>('preparation.sources.set', {
    workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey,
    payload: { sessionId, sources }
  }),
  preparationBuild: (
    payload: { sessionId: string; focus: string; coreTask: string; answerScope: string },
    expectedRevision: number,
    idempotencyKey: string
  ) => call<unknown>('preparation.build', {
    workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey, payload
  }),
  preparationReview: (sessionId: string, expectedRevision: number, idempotencyKey: string) =>
    call<unknown>('preparation.review', {
      workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      payload: { sessionId }
    }),
  preparationConfirm: (sessionId: string, expectedRevision: number, idempotencyKey: string) =>
    call<unknown>('preparation.confirm', {
      workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      payload: { sessionId }
    }),
  preparationExport: (sessionId: string, expectedRevision: number, idempotencyKey: string) =>
    call<unknown>('preparation.export', {
      workspace_id: 'workspace_local', expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      payload: { sessionId }
    }),
  presentationOpen: (sessionId: string) =>
    call<{ opened: true; reused: boolean }>('presentation.open', {
      workspace_id: 'workspace_local', payload: { sessionId }
    }),
  presentationGet: (sessionId: string) =>
    call<PresentationDTO>('presentation.get', { workspace_id: 'workspace_local', payload: { sessionId } }),
  presentationClose: () =>
    call<{ closed: boolean }>('presentation.close', { workspace_id: 'workspace_local' }),
  // G05/G06 课时计划与三类五文件（自拟/测试内容明确标注）。
  lessonList: () => call<{ plans: { planId: string; title: string; currentRevisionId: string | null; updatedAt: string }[] }>('lesson.list'),
  lessonGet: (planId: string) => call<{ plan: unknown; contentOrigin: string; valid: boolean; revisionId: string }>('lesson.get', { payload: { planId } }),
  recordTeaching: (
    payload: {
      planId: string;
      planRevisionId: string;
      taughtAt: string;
      actualDurationSec: number;
      implementationState: ImplementationState;
      adjustmentSummary: string;
    },
    expectedRevision: number,
    idempotencyKey: string
  ) =>
    call<FeedbackWriteResult<TeachingEvent>>('plans.recordTeaching', {
      workspace_id: 'workspace_default',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload
    }),
  feedbackHistory: (planId: string) =>
    call<FeedbackHistory & Partial<FeedbackAnalysisHistory & FeedbackCorrectionHistory>>('feedback.history', {
      workspace_id: 'workspace_default',
      payload: { planId }
    }),
  analyzeFeedback: (
    planId: string,
    teachingEventId: string,
    observationIds: string[],
    dispatchConsent: boolean,
    expectedRevision: number,
    idempotencyKey: string
  ) =>
    call<FeedbackAnalysisResult>('feedback.analyze', {
      workspace_id: 'workspace_default',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload: { planId, teachingEventId, observationIds, dispatchConsent }
    }),
  decideCorrection: (
    payload: {
      planId: string;
      proposalId: string;
      decision: 'accept' | 'reject';
      reason: string;
      expectedProposalRevision: number;
      preference?: { preferenceKey: string; value: string; reason: string };
      effect?: { state: EffectEvidenceState; observationIds: string[] };
    },
    expectedRevision: number,
    idempotencyKey: string
  ) => call<CorrectionDecisionResult>('corrections.decide', {
    workspace_id: 'workspace_default', expected_revision: expectedRevision, idempotency_key: idempotencyKey, payload
  }),
  revertCorrection: (
    payload: { planId: string; proposalId: string; reason: string; expectedProposalRevision: number },
    expectedRevision: number,
    idempotencyKey: string
  ) => call<CorrectionDecisionResult>('corrections.revert', {
    workspace_id: 'workspace_default', expected_revision: expectedRevision, idempotency_key: idempotencyKey, payload
  }),
  addObservation: (
    payload: {
      planId: string;
      planRevisionId: string;
      teachingEventId: string;
      taskId: string;
      sourceKind: ObservationSourceKind;
      observedAt: string;
      outcome: ObservationOutcomeValue;
      supportLevel: ObservationSupportLevel;
      materialRelation: ObservationMaterialRelation;
      delayDays: number;
      sampleCount: number;
      populationCount: number;
      selection: ObservationSelection;
      coverageCaveat: string;
      summary: string;
    },
    expectedRevision: number,
    idempotencyKey: string
  ) =>
    call<FeedbackWriteResult<ObservationRecord>>('observations.add', {
      workspace_id: 'workspace_default',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload
    }),
  listObservations: (planId: string) =>
    call<{ observations: ObservationRecord[]; knowledgeState: FeedbackKnowledgeState }>('observations.list', {
      workspace_id: 'workspace_default',
      payload: { planId }
    }),
  prepareObservationDelete: (planId: string, observationId: string) =>
    call<{ confirmationToken: string; expiresAt: number }>('observations.prepareDelete', {
      workspace_id: 'workspace_default',
      payload: { planId, observationId }
    }),
  deleteObservation: (
    planId: string,
    observationId: string,
    confirmationToken: string,
    expectedRevision: number,
    idempotencyKey: string
  ) =>
    call<FeedbackWriteResult<ObservationDeleteResult>>('observations.delete', {
      workspace_id: 'workspace_default',
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      payload: { planId, observationId, confirmationToken }
    }),
  reviewRun: (planId: string, revisionId?: string) =>
    call<{ report: ReviewReport }>('review.run', {
      payload: revisionId ? { planId, revisionId } : { planId }
    }),
  changePreview: (planId: string, baseRevisionId: string, change: LessonChange) =>
    call<{ preview: ChangePreview }>('change.preview', { payload: { planId, baseRevisionId, change } }),
  changeApply: (planId: string, baseRevisionId: string, change: LessonChange, idempotencyKey: string) =>
    call<{ result: LessonChangeApplyOutcome }>('change.apply', {
      idempotency_key: idempotencyKey,
      payload: { planId, baseRevisionId, change }
    }),
  changeHistory: (planId: string) =>
    call<{ revisions: unknown[]; proposals: unknown[]; bundles: unknown[] }>('change.history', { payload: { planId } }),
  materialsGenerate: (planId: string) =>
    call<{ planId: string; revisionId: string; contentOrigin: string; versionStamp: string; files: { role: string; format: string; filename: string; path: string; sha256: string; byteSize: number }[] }>('materials.generate', { payload: { planId } }),
  materialsList: (planId: string) => call<{ artifacts: { role: string; format: string; filename: string; path: string; sha256: string; byteSize: number; revisionId: string; contentOrigin: string }[] }>('materials.list', { payload: { planId } }),
  backupCreateLocal: (idempotencyKey: string) =>
    call<{ backupId: string; valid: boolean }>('backup.create', {
      idempotency_key: idempotencyKey,
      payload: { mode: 'local' }
    }),
  backupExportPortable: (passphrase: string, idempotencyKey: string) =>
    call<{ backupId?: string; saved?: boolean; cancelled?: boolean; sha256?: string; byteSize?: number }>('backup.create', {
      idempotency_key: idempotencyKey,
      payload: { mode: 'portable', passphrase }
    }),
  backupsList: () => call<{ backups: BackupRecordDTO[] }>('backups.list'),
  backupRestorePreview: (passphrase: string, idempotencyKey: string) =>
    call<{ cancelled?: boolean; restoreJobId?: string; previewHash?: string; preview?: RestorePreviewDTO }>('backup.restore', {
      idempotency_key: idempotencyKey,
      payload: { action: 'preview', passphrase }
    }),
  backupRestoreRequestConfirmation: (restoreJobId: string, previewHash: string, idempotencyKey: string) =>
    call<{ cancelled?: boolean; confirmationToken?: string; expiresAt?: number }>('backup.restore', {
      idempotency_key: idempotencyKey,
      payload: { action: 'request-confirmation', restoreJobId, previewHash }
    }),
  backupRestoreConfirm: (restoreJobId: string, previewHash: string, confirmationToken: string, idempotencyKey: string) =>
    call<{ restoreJobId: string; restartRequired: true }>('backup.restore', {
      idempotency_key: idempotencyKey,
      payload: { action: 'confirm', restoreJobId, previewHash, confirmationToken }
    }),
  backupDeletePrepare: (backupId: string, idempotencyKey: string) =>
    call<{ cancelled?: boolean; confirmationToken?: string; expiresAt?: number }>('backups.delete', {
      idempotency_key: idempotencyKey,
      payload: { action: 'prepare', backupId }
    }),
  backupDeleteConfirm: (backupId: string, confirmationToken: string, idempotencyKey: string) =>
    call<{ backupId: string; deleted: boolean }>('backups.delete', {
      idempotency_key: idempotencyKey,
      payload: { action: 'confirm', backupId, confirmationToken }
    }),
  diagnosticsPreview: () =>
    call<{ preview: DiagnosticsPreview; previewHash: string }>('diagnostics.export', {
      payload: { action: 'preview' }
    }),
  diagnosticsSave: (previewHash: string, idempotencyKey: string) =>
    call<DiagnosticSaveResult>('diagnostics.export', {
      idempotency_key: idempotencyKey,
      payload: { action: 'save', previewHash }
    }),
  updateStatus: () => call<{
    state: 'trust_not_configured' | 'idle' | 'verified_ready';
    trustConfigured: boolean;
    currentVersion: string;
    ready: Array<{ state: 'verified_ready' | 'superseded'; releaseId: string; targetVersion: string; manifestSha256: string; packageSha256: string }>;
    noticeZh: string;
  }>('updates.status'),
  inspectOfflineUpdate: () => call<{ cancelled: true } | UpdateInspectionResult>('updates.inspectOffline'),
  stageOfflineUpdate: (
    payload: {
      confirmationToken: string;
      manifestSha256: string;
      currentVersion: string;
      targetVersion: string;
    },
    idempotencyKey: string
  ) => call<UpdateStageResult>('updates.stageOffline', { idempotency_key: idempotencyKey, payload }),
  // 关闭前刷新握手：主进程在窗口关闭前通知渲染层落盘（带唯一 requestId）；渲染层完成后回执。
  // 仅暴露固定通道，不暴露任意 send/on。返回取消订阅函数，供组件卸载时释放监听。
  onBeforeClose: (handler: (requestId: string) => void | Promise<void>): (() => void) => {
    const listener = (_e: unknown, requestId: string): void => {
      void Promise.resolve(handler(requestId));
    };
    ipcRenderer.on('yuwen:before-close', listener);
    return () => {
      ipcRenderer.removeListener('yuwen:before-close', listener);
    };
  },
  notifyFlushDone: (requestId: string, saved: boolean): void => {
    ipcRenderer.send('yuwen:flush-done', requestId, saved);
  }
};

export type YuwenApi = typeof api;

contextBridge.exposeInMainWorld('yuwen', api);
