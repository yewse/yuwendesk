import type {
  BootstrapData,
  DraftData,
  HealthData,
  IpcRequest,
  IpcResponse,
  OperationName,
  SaveDraftPayload,
  StatusData
} from '../shared/ipc';
import { IMPLEMENTED_OPERATIONS, IPC_SCHEMA_VERSION } from '../shared/ipc';
import type { ErrorCode } from '../shared/ipc';
import type {
  DraftStore,
  FeedbackStore,
  LessonStore,
  MaterialArtifactRecord,
  MaterialBundleRecord,
  ReviewReportRecord,
  SourceStore
} from './store';
import { StoreProtectedError } from './store';
import { checkPayload } from './schemaGate';
import { buildLessonPlan, demoLessonSpec, validateLessonPlan } from './lesson/build';
import { buildMaterialSet } from './materials/generate';
import { reviewLessonPlan } from './review/review';
import { reviewMaterialSet } from './review/bundleReview';
import {
  LessonChangeConflictError,
  LessonChangeDiskError,
  LessonChangeKeyReuseError,
  LessonChangeReviewError,
  LessonChangeService,
  LessonChangeSourceMissingError
} from './change/service';
import { ChangeBlockedError, ChangeValidationError } from './change/change';
import type { LessonChange } from './change/types';
import type { LessonPlan } from './lesson/types';
import { FontMissingError } from './materials/generate';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nodeBundleIo, promoteStagedBundle, stageMaterialSet, type PublishedBundle } from './materials/publish';
import { createTeachingEvent } from './feedback/teaching';
import {
  FeedbackKeyReuseError,
  FeedbackSourceMissingError,
  FeedbackVersionConflictError,
  CorrectionVersionConflictError,
  type CorrectionDecisionResult,
  type ImplementationState,
  type FeedbackAnalysisResult,
  type ObservationMaterialRelation,
  type ObservationOutcomeValue,
  type ObservationSelection,
  type ObservationSourceKind,
  type ObservationSupportLevel
} from './feedback/types';
import { createObservationRecord, ObservationPrivacyError } from './feedback/observation';
import type { CorrectionDecisionInput, CorrectionRevertInput, FeedbackAnalyzeInput } from './feedback/service';

function errorResponse(
  code: ErrorCode,
  message_zh: string,
  next_action: string,
  retryable = false
): IpcResponse<never> {
  return { ok: false, error: { code, message_zh, retryable, next_action } };
}

export interface IpcServiceContext {
  store: DraftStore;
  appVersion: string;
  appNameZh: string;
  platformSupported: boolean;
  // 生产环境本地监听端口数，必须为 0（对应 INS-008：无 HTTP/WebSocket 监听）。
  httpListeners: number;
  online: boolean;
  // 真实运行标志（状态证据）。
  buildMode: 'development' | 'production';
  sandboxEnabled: boolean;
  platformDevOverride: boolean;
  platformTargetSupported: boolean;
  platformIdentity: string;
  // G03 资料能力（由 SqliteStore 提供）；缺省时资料操作返回未实现。
  sourceStore?: SourceStore;
  // G04 模型服务；缺省时模型操作返回未实现。
  modelService?: ModelServiceLike;
  // G05/G06 课时计划与成品存储（由 SqliteStore 提供）。
  lessonStore?: LessonStore;
  // G08 采用/授课/观察反馈流（由 SqliteStore 提供）。
  feedbackStore?: FeedbackStore;
  // G08 测量门与模型辅助归因；仅接受稳定 ID 和逐次许可，不接受自由提示词或 Observation JSON。
  feedbackService?: {
    analyze(input: FeedbackAnalyzeInput): Promise<FeedbackAnalysisResult>;
    decideCorrection(input: CorrectionDecisionInput): CorrectionDecisionResult;
    revertCorrection(input: CorrectionRevertInput): CorrectionDecisionResult;
  };
  // G08 删除观察前的原生确认；仅主进程注入，渲染层不能签发 token。
  confirmObservationDelete?: (input: {
    workspaceId: string;
    planId: string;
    observationId: string;
  }) => Promise<{ token: string; expiresAt: number } | null>;
  // 成品文件输出根目录（userData）。
  userDataDir?: string;
  // G07 一处修改服务；生产缺省时由 lessonStore + userDataDir 构造，测试可注入。
  lessonChangeService?: LessonChangeService;
  // G09 备份/恢复服务；路径只由主进程原生对话框选择。
  protectionService?: ProtectionServiceLike;
  sourcePrivacyService?: SourcePrivacyServiceLike;
  noteSuccessfulWrite?: (operation: OperationName) => void;
}

export interface ProtectionServiceLike {
  create(payload: { mode: string; passphrase?: string }, idempotencyKey?: string): Promise<unknown>;
  list(): Promise<unknown[]>;
  restore(payload: {
    action: string;
    passphrase?: string;
    restoreJobId?: string;
    previewHash?: string;
    confirmationToken?: string;
  }, idempotencyKey?: string): Promise<unknown>;
  delete(payload: { action: string; backupId: string; confirmationToken?: string }, idempotencyKey?: string): Promise<unknown>;
}

export interface SourcePrivacyServiceLike {
  prepareDelete(input: {
    workspaceId: string;
    documentId: string;
    expectedRevision: number;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<unknown>;
  delete(input: {
    workspaceId: string;
    documentId: string;
    expectedRevision: number;
    managedBackupIds: string[];
    policy: 'delete_managed_and_create_post_delete' | 'keep_managed';
    confirmationToken: string;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<unknown>;
}

// 仅声明 IPC 需要的模型服务形状（避免主进程强耦合）。
export interface ModelServiceLike {
  providerCatalog(): { id: string; defaultModel: string; requiresKey: boolean }[];
  getConfig(): unknown;
  configure(input: { provider: string; model?: string; params?: { temperature?: number; maxTokens?: number }; budgetCapCents?: number; allowRealNetwork?: boolean; apiKey?: string }): { ok: boolean; code?: string; note?: string; config?: unknown; keyStored?: boolean };
  probe(): Promise<{ ok: boolean; note: string; code?: string; provider?: string; model?: string; isTestDouble?: boolean }>;
  run(input: { task: string; instructionExtra?: string; fragments?: { versionId: string; charStart: number; charEnd: number; approved: boolean }[] }): Promise<{ status: string; jobId?: string; result?: unknown; costCents?: number; fromCache?: boolean; code?: string; note?: string }>;
  cancel(jobId: string): boolean;
  listJobs(limit?: number): unknown[];
}

export function isImplementedOperation(op: string): op is OperationName {
  return (IMPLEMENTED_OPERATIONS as readonly string[]).includes(op);
}

const BUSINESS_WRITE_OPERATIONS = new Set<OperationName>([
  'ui.saveDraft', 'sources.import', 'sources.importFile', 'sources.retire', 'sources.reclassify', 'sources.delete',
  'model.configure', 'model.run', 'lesson.buildDemo', 'plans.recordTeaching',
  'feedback.analyze', 'corrections.decide', 'corrections.revert',
  'observations.add', 'observations.delete', 'change.apply', 'materials.generate'
]);

// 统一请求外壳校验（对应规范 9.1）。结构校验通过不代表语义正确，语义在各处理函数继续检查。
export function validateEnvelope(op: string, req: unknown): IpcResponse<never> | null {
  if (!isImplementedOperation(op)) {
    return errorResponse(
      'INPUT_INVALID',
      '请求的操作未开放或尚未实现。',
      '请更新到实现该功能的版本，或联系支持。'
    );
  }
  if (typeof req !== 'object' || req === null) {
    return errorResponse('INPUT_INVALID', '请求格式无效。', '请重试当前操作。');
  }
  const r = req as Partial<IpcRequest>;
  if (r.schema_version !== IPC_SCHEMA_VERSION) {
    return errorResponse(
      'INPUT_INVALID',
      '请求的接口版本与当前应用不一致。',
      '请重启应用后重试。'
    );
  }
  if (typeof r.request_id !== 'string' || r.request_id.length === 0) {
    return errorResponse('INPUT_INVALID', '请求缺少有效的请求标识。', '请重试当前操作。');
  }
  if (r.operation !== op) {
    return errorResponse('INPUT_INVALID', '请求内容与调用通道不一致。', '请重试当前操作。');
  }
  return null;
}

export class IpcService {
  private readonly lessonChangeService?: LessonChangeService;
  private readonly observationDeleteTokens = new Map<
    string,
    { workspaceId: string; planId: string; observationId: string; expiresAt: number; consumedBy?: string; deletedAt?: string }
  >();

  constructor(private readonly ctx: IpcServiceContext) {
    this.lessonChangeService =
      ctx.lessonChangeService ??
      (ctx.lessonStore && ctx.userDataDir
        ? new LessonChangeService(ctx.lessonStore, { rootDir: join(ctx.userDataDir, 'materials') })
        : undefined);
  }

  async handle(op: string, req: unknown): Promise<IpcResponse> {
    const response = await this.handleRequest(op, req);
    if (response.ok && isImplementedOperation(op) && BUSINESS_WRITE_OPERATIONS.has(op)) {
      this.ctx.noteSuccessfulWrite?.(op);
    }
    return response;
  }

  private async handleRequest(op: string, req: unknown): Promise<IpcResponse> {
    const invalid = validateEnvelope(op, req);
    if (invalid) return invalid;
    const request = req as IpcRequest;

    // G02-T01 Schema 门：分发前统一校验载荷结构（类型/必填/多余字段），结构不合直接拒绝。
    const gate = checkPayload(request.operation, request.payload);
    if (!gate.ok) {
      return errorResponse('INPUT_INVALID', `请求载荷结构无效：${gate.errors.join('；')}`, '请检查后重试。');
    }

    switch (request.operation) {
      case 'app.bootstrap':
        return this.bootstrap();
      case 'app.health':
        return this.health();
      case 'app.getStatus':
        return this.getStatus();
      case 'ui.loadDraft':
        return this.loadDraft();
      case 'ui.saveDraft':
        return this.saveDraft(request as IpcRequest<SaveDraftPayload>);
      case 'sources.import':
        return this.sourcesImport(request);
      case 'sources.importFile':
        return this.sourcesImportFile(request);
      case 'sources.cancelImport':
        return this.sourcesCancelImport(request);
      case 'sources.list':
        return this.sourcesList();
      case 'sources.search':
        return this.sourcesSearch(request);
      case 'sources.read':
        return this.sourcesRead(request);
      case 'sources.retire':
        return this.sourcesRetire(request);
      case 'sources.versions':
        return this.sourcesVersions(request);
      case 'sources.readOriginal':
        return this.sourcesReadOriginal(request);
      case 'sources.reclassify':
        return this.sourcesReclassify(request);
      case 'sources.prepareDelete':
        return this.sourcesPrepareDelete(request);
      case 'sources.delete':
        return this.sourcesDelete(request);
      case 'model.providers':
        return this.ctx.modelService ? { ok: true, data: { providers: this.ctx.modelService.providerCatalog() } } : { ok: true, data: { providers: [] } };
      case 'model.getConfig':
        return this.ctx.modelService ? { ok: true, data: { config: this.ctx.modelService.getConfig() } } : { ok: true, data: { config: null } };
      case 'model.configure':
        return this.modelConfigure(request);
      case 'model.probe':
        return this.modelProbe();
      case 'model.run':
        return this.modelRun(request);
      case 'model.cancel':
        return this.ctx.modelService
          ? { ok: true, data: { cancelled: this.ctx.modelService.cancel((request.payload as { jobId: string }).jobId) } }
          : { ok: true, data: { cancelled: false } };
      case 'model.listJobs':
        return this.ctx.modelService
          ? { ok: true, data: { jobs: this.ctx.modelService.listJobs((request.payload as { limit?: number } | undefined)?.limit ?? 50) } }
          : { ok: true, data: { jobs: [] } };
      case 'lesson.buildDemo':
        return this.lessonBuildDemo();
      case 'lesson.list':
        return this.ctx.lessonStore ? { ok: true, data: { plans: this.ctx.lessonStore.listLessonPlans() } } : { ok: true, data: { plans: [] } };
      case 'lesson.get':
        return this.lessonGet(request);
      case 'plans.recordTeaching':
        return this.plansRecordTeaching(request);
      case 'feedback.history':
        return this.feedbackHistory(request);
      case 'feedback.analyze':
        return this.feedbackAnalyze(request);
      case 'corrections.decide':
        return this.correctionsDecide(request);
      case 'corrections.revert':
        return this.correctionsRevert(request);
      case 'observations.add':
        return this.observationsAdd(request);
      case 'observations.list':
        return this.observationsList(request);
      case 'observations.prepareDelete':
        return this.observationsPrepareDelete(request);
      case 'observations.delete':
        return this.observationsDelete(request);
      case 'review.run':
        return this.reviewRun(request);
      case 'change.preview':
        return this.changePreview(request);
      case 'change.apply':
        return this.changeApply(request);
      case 'change.history':
        return this.changeHistory(request);
      case 'materials.generate':
        return this.materialsGenerate(request);
      case 'materials.list':
        return this.ctx.lessonStore
          ? { ok: true, data: { artifacts: this.ctx.lessonStore.listMaterialArtifacts((request.payload as { planId: string }).planId) } }
          : { ok: true, data: { artifacts: [] } };
      case 'backup.create':
        return this.backupCreate(request);
      case 'backup.restore':
        return this.backupRestore(request);
      case 'backups.list':
        return this.backupsList();
      case 'backups.delete':
        return this.backupsDelete(request);
      default:
        return errorResponse('INPUT_INVALID', '未知操作。', '请重试当前操作。');
    }
  }

  private async backupCreate(req: IpcRequest): Promise<IpcResponse> {
    if (!this.ctx.protectionService) return errorResponse('BACKUP_INVALID', '备份功能当前不可用。', '请重启应用后重试。');
    if (!req.idempotency_key?.trim()) return errorResponse('INPUT_INVALID', '备份请求缺少幂等标识。', '请重试当前操作。');
    const payload = req.payload as { mode: string; passphrase?: string };
    if (!['local', 'portable'].includes(payload.mode) || (payload.mode === 'portable' && typeof payload.passphrase !== 'string')) {
      return errorResponse('INPUT_INVALID', '备份模式或口令无效。', '请选择备份类型并检查口令。');
    }
    try {
      return { ok: true, data: await this.ctx.protectionService.create(payload, req.idempotency_key) };
    } catch {
      return errorResponse('BACKUP_INVALID', '备份未能完成，旧备份未被修改。', '请检查空间后重试。', true);
    }
  }

  private async backupRestore(req: IpcRequest): Promise<IpcResponse> {
    if (!this.ctx.protectionService) return errorResponse('BACKUP_INVALID', '恢复功能当前不可用。', '请重启应用后重试。');
    if (!req.idempotency_key?.trim()) return errorResponse('INPUT_INVALID', '恢复请求缺少幂等标识。', '请重试当前操作。');
    const payload = req.payload as { action: string; passphrase?: string; restoreJobId?: string; previewHash?: string; confirmationToken?: string };
    if (!['preview', 'request-confirmation', 'confirm'].includes(payload.action)) {
      return errorResponse('INPUT_INVALID', '恢复步骤无效。', '请重新选择备份。');
    }
    try {
      return { ok: true, data: await this.ctx.protectionService.restore(payload, req.idempotency_key) };
    } catch {
      return errorResponse('BACKUP_INVALID', '备份无法验证或恢复。现有数据未更改。', '请检查口令和备份文件。');
    }
  }

  private async backupsList(): Promise<IpcResponse> {
    if (!this.ctx.protectionService) return { ok: true, data: { backups: [] } };
    return { ok: true, data: { backups: await this.ctx.protectionService.list() } };
  }

  private async backupsDelete(req: IpcRequest): Promise<IpcResponse> {
    if (!this.ctx.protectionService) return errorResponse('BACKUP_INVALID', '备份管理当前不可用。', '请重启应用后重试。');
    if (!req.idempotency_key?.trim()) return errorResponse('INPUT_INVALID', '删除请求缺少幂等标识。', '请重试当前操作。');
    const payload = req.payload as { action: string; backupId: string; confirmationToken?: string };
    if (!['prepare', 'confirm'].includes(payload.action)) return errorResponse('INPUT_INVALID', '删除步骤无效。', '请重试当前操作。');
    try {
      return { ok: true, data: await this.ctx.protectionService.delete(payload, req.idempotency_key) };
    } catch {
      return errorResponse('BACKUP_INVALID', '备份未删除。', '请刷新备份列表后重试。');
    }
  }

  private sourcesImport(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('INPUT_INVALID', '资料功能不可用。', '请重启应用。');
    const p = req.payload as {
      title: string;
      format: string;
      content: string;
      classification?: string;
      relation?: 'new_version' | 'separate';
      targetDocumentId?: string;
    };
    try {
      const r = src.importSource({
        title: p.title,
        format: p.format,
        content: p.content,
        classification: p.classification,
        relation: p.relation,
        targetDocumentId: p.targetDocumentId
      });
      return this.mapImportResult(r);
    } catch (e) {
      return this.mapImportError(e);
    }
  }

  private async sourcesImportFile(req: IpcRequest): Promise<IpcResponse> {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('INPUT_INVALID', '资料功能不可用。', '请重启应用。');
    const p = req.payload as {
      title: string;
      format: string;
      base64: string;
      classification?: string;
      relation?: 'new_version' | 'separate';
      targetDocumentId?: string;
      jobId?: string;
    };
    try {
      const r = await src.importFile({
        title: p.title,
        format: p.format,
        base64: p.base64,
        classification: p.classification,
        relation: p.relation,
        targetDocumentId: p.targetDocumentId,
        jobId: p.jobId
      });
      return this.mapImportResult(r);
    } catch (e) {
      return this.mapImportError(e);
    }
  }

  private sourcesCancelImport(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return { ok: true, data: { cancelled: false } };
    const p = req.payload as { jobId: string };
    return { ok: true, data: { cancelled: src.cancelImport(p.jobId) } };
  }

  private mapImportResult(r: import('./store').SourceImportResult): IpcResponse {
    if (r.status === 'blocked_sensitive') {
      if (r.reason === 'classification_transition_blocked') {
        return errorResponse(
          'PRIVACY_BLOCKED',
          '未新增版本：同一资料不能混用普通明文与学生敏感分类。',
          '请先把整份资料升级为学生敏感资料，再导入敏感新版本。'
        );
      }
      return errorResponse(
        'PRIVACY_BLOCKED',
        '敏感资料未导入：当前设备的安全密钥后端不可用，正文不会写入普通存储。',
        '请在受支持的 Windows 安全存储可用后重试，或继续处理非敏感资料。'
      );
    }
    if (r.status === 'rejected') {
      const msg =
        r.reason === 'too_large'
          ? '文件过大。'
          : r.reason === 'bad_classification'
            ? '资料分类取值非法。'
            : '内容为空或无法解析。';
      return errorResponse('INPUT_INVALID', msg, '请检查文件与分类后重试。');
    }
    // needs_confirmation / imported / new_version / duplicate 均为正常数据返回。
    return { ok: true, data: r };
  }

  private mapImportError(e: unknown): IpcResponse {
    if (e instanceof StoreProtectedError) {
      return errorResponse('DATABASE_LOCKED', '本地数据暂停写入以防覆盖。', '请先完成数据恢复。');
    }
    return errorResponse('DISK_FULL', '导入失败，本地写入异常。', '请检查磁盘后重试。', true);
  }

  private sourcesVersions(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return { ok: true, data: { versions: [] } };
    const p = req.payload as { documentId: string };
    return { ok: true, data: { versions: src.getSourceVersions(p.documentId) } };
  }

  private sourcesReclassify(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('SOURCE_MISSING', '资料不存在。', '请刷新资料列表。');
    const expectedRevision = req.expected_revision;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !req.idempotency_key?.trim()) {
      return errorResponse('INPUT_INVALID', '重分类请求缺少有效版本或幂等标识。', '请刷新资料后重试。');
    }
    const payload = req.payload as { documentId: string; targetClassification: string };
    if (payload.targetClassification !== 'student_sensitive') {
      return errorResponse('PRIVACY_BLOCKED', '学生敏感资料不可降级为普通明文资料。', '如需移除，请使用永久删除。');
    }
    const workspaceId = req.workspace_id ?? 'workspace_local';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      operation: 'sources.reclassify', workspaceId, documentId: payload.documentId,
      expectedRevision, targetClassification: payload.targetClassification
    })).digest('hex');
    try {
      const result = src.reclassifySource({
        workspaceId,
        documentId: payload.documentId,
        expectedRevision,
        targetClassification: 'student_sensitive',
        idempotencyKey: req.idempotency_key,
        fingerprint,
        updatedAt: new Date().toISOString()
      });
      if (result.status === 'missing') return errorResponse('SOURCE_MISSING', '资料不存在。', '请刷新资料列表。');
      if (result.status === 'conflict') return errorResponse('VERSION_CONFLICT', '资料版本已经变化。', '请刷新后重新确认。');
      if (result.status === 'blocked') {
        return errorResponse(result.reason === 'KEY_UNAVAILABLE' ? 'KEY_UNAVAILABLE' : 'PRIVACY_BLOCKED', '敏感资料保护未执行。', '请检查设备安全存储。');
      }
      return { ok: true, data: result };
    } catch (error) {
      if (error instanceof StoreProtectedError) return errorResponse('DATABASE_LOCKED', '本地数据暂停写入。', '请先完成数据恢复。');
      if ((error as Error).message.includes('idempotency')) return errorResponse('INPUT_INVALID', '幂等标识已用于不同请求。', '请刷新后重试。');
      return errorResponse('DISK_FULL', '敏感升级未完成，原资料保持不变。', '请检查存储后重试。', true);
    }
  }

  private async sourcesPrepareDelete(req: IpcRequest): Promise<IpcResponse> {
    const service = this.ctx.sourcePrivacyService;
    if (!service) return errorResponse('PRIVACY_BLOCKED', '永久删除功能当前不可用。', '请重启应用后重试。');
    const expectedRevision = req.expected_revision;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !req.idempotency_key?.trim()) {
      return errorResponse('INPUT_INVALID', '删除确认缺少有效版本或幂等标识。', '请刷新资料后重试。');
    }
    const payload = req.payload as { documentId: string };
    const workspaceId = req.workspace_id ?? 'workspace_local';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      operation: 'sources.prepareDelete', workspaceId, documentId: payload.documentId, expectedRevision
    })).digest('hex');
    try {
      const prepared = await service.prepareDelete({
        workspaceId,
        documentId: payload.documentId,
        expectedRevision,
        idempotencyKey: req.idempotency_key,
        fingerprint
      });
      return { ok: true, data: prepared ?? { cancelled: true } };
    } catch {
      return errorResponse('PRIVACY_BLOCKED', '未能完成删除范围确认。', '请刷新资料与备份列表后重试。');
    }
  }

  private async sourcesDelete(req: IpcRequest): Promise<IpcResponse> {
    const service = this.ctx.sourcePrivacyService;
    if (!service) return errorResponse('PRIVACY_BLOCKED', '永久删除功能当前不可用。', '请重启应用后重试。');
    const expectedRevision = req.expected_revision;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !req.idempotency_key?.trim()) {
      return errorResponse('INPUT_INVALID', '删除请求缺少有效版本或幂等标识。', '请重新确认删除。');
    }
    const payload = req.payload as {
      documentId: string;
      confirmationToken: string;
      managedBackupIds: unknown[];
      policy: string;
    };
    if (
      payload.managedBackupIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128) ||
      !['delete_managed_and_create_post_delete', 'keep_managed'].includes(payload.policy)
    ) return errorResponse('INPUT_INVALID', '删除范围无效。', '请重新确认删除。');
    const workspaceId = req.workspace_id ?? 'workspace_local';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      operation: 'sources.delete', workspaceId, documentId: payload.documentId,
      expectedRevision, managedBackupIds: [...payload.managedBackupIds].sort(), policy: payload.policy
    })).digest('hex');
    try {
      const result = await service.delete({
        workspaceId,
        documentId: payload.documentId,
        expectedRevision,
        managedBackupIds: payload.managedBackupIds as string[],
        policy: payload.policy as 'delete_managed_and_create_post_delete' | 'keep_managed',
        confirmationToken: payload.confirmationToken,
        idempotencyKey: req.idempotency_key,
        fingerprint
      });
      const status = (result as { status?: string }).status;
      if (status === 'missing') return errorResponse('SOURCE_MISSING', '资料不存在或已经删除。', '请刷新资料列表。');
      if (status === 'conflict') return errorResponse('VERSION_CONFLICT', '资料版本已经变化。', '请刷新后重新确认。');
      return { ok: true, data: result };
    } catch (error) {
      if ((error as Error).message === 'source_delete_confirmation_invalid') {
        return errorResponse('PRIVACY_BLOCKED', '删除确认已失效或与当前资料/备份范围不匹配。', '请重新执行两步确认。');
      }
      if ((error as Error).message === 'source_delete_scope_changed') {
        return errorResponse('VERSION_CONFLICT', '应用受管备份范围已经变化，本次未删除。', '请重新执行两步确认并核对最新备份范围。');
      }
      if ((error as Error).message.includes('idempotency')) return errorResponse('INPUT_INVALID', '幂等标识已用于不同请求。', '请刷新后重试。');
      return errorResponse('DISK_FULL', '永久删除未能安全完成。', '请检查存储并重新确认。', true);
    }
  }

  private modelConfigure(req: IpcRequest): IpcResponse {
    const m = this.ctx.modelService;
    if (!m) return errorResponse('INPUT_INVALID', '模型功能不可用。', '请重启应用。');
    const p = req.payload as { provider: string; model?: string; temperature?: number; maxTokens?: number; budgetCapCents?: number; allowRealNetwork?: boolean; apiKey?: string };
    const r = m.configure({
      provider: p.provider,
      model: p.model,
      params: { temperature: p.temperature, maxTokens: p.maxTokens },
      budgetCapCents: p.budgetCapCents,
      allowRealNetwork: p.allowRealNetwork,
      apiKey: p.apiKey
    });
    if (!r.ok) {
      const code = r.code === 'KEY_UNAVAILABLE' ? 'KEY_UNAVAILABLE' : 'INPUT_INVALID';
      return errorResponse(code, r.note ?? '配置失败。', '请检查服务商与密钥后重试。');
    }
    return { ok: true, data: { config: r.config, keyStored: r.keyStored } };
  }

  private async modelProbe(): Promise<IpcResponse> {
    const m = this.ctx.modelService;
    if (!m) return errorResponse('INPUT_INVALID', '模型功能不可用。', '请重启应用。');
    const r = await m.probe();
    if (!r.ok) {
      const code = (r.code as ErrorCode) ?? 'MODEL_NOT_AVAILABLE';
      const known = ['MODEL_NOT_AVAILABLE', 'AUTH_FAILED', 'NETWORK_UNAVAILABLE', 'KEY_UNAVAILABLE'].includes(code) ? code : 'MODEL_NOT_AVAILABLE';
      return errorResponse(known as ErrorCode, r.note, '真实调用需授权账户与联网；当前保持未验证。');
    }
    return { ok: true, data: r };
  }

  private async modelRun(req: IpcRequest): Promise<IpcResponse> {
    const m = this.ctx.modelService;
    if (!m) return errorResponse('INPUT_INVALID', '模型功能不可用。', '请重启应用。');
    const p = req.payload as { task: string; instructionExtra?: string; fragments?: { versionId: string; charStart: number; charEnd: number; approved: boolean }[] };
    const r = await m.run({ task: p.task, instructionExtra: p.instructionExtra, fragments: p.fragments });
    if (r.status === 'succeeded' || r.status === 'cached') {
      return { ok: true, data: { status: r.status, jobId: r.jobId, result: r.result, costCents: r.costCents, fromCache: r.fromCache } };
    }
    if (r.status === 'cancelled') return { ok: true, data: { status: 'cancelled', jobId: r.jobId } };
    // blocked / failed → 明确错误码
    const code = (r.code as ErrorCode) ?? 'MODEL_NOT_AVAILABLE';
    const known: ErrorCode = (['PRIVACY_BLOCKED', 'SOURCE_MISSING', 'SOURCE_CONFLICT', 'BUDGET_EXCEEDED', 'INPUT_INVALID', 'MODEL_NOT_AVAILABLE', 'REQUEST_UNCERTAIN'] as string[]).includes(
      code
    )
      ? (code as ErrorCode)
      : 'MODEL_NOT_AVAILABLE';
    return errorResponse(known, r.note ?? '调用未成功。', '请检查片段授权、预算与服务商状态。');
  }

  // G05：组建自拟示例完整课时计划并持久化（内容来源 authored，明确标注自拟）。
  private lessonBuildDemo(): IpcResponse {
    const ls = this.ctx.lessonStore;
    if (!ls) return errorResponse('INPUT_INVALID', '课时计划功能不可用。', '请重启应用。');
    const plan = buildLessonPlan(demoLessonSpec());
    const v = validateLessonPlan(plan);
    if (!v.ok) return errorResponse('EXPORT_INVALID', `计划不合格：${v.errors.join(',')}`, '请检查计划结构。');
    ls.saveLessonRevision(
      { revisionId: plan.revision_id, planId: plan.plan_id, previousRevisionId: plan.previous_revision_id, title: plan.title, contentJson: JSON.stringify(plan), contentOrigin: 'authored', valid: true, createdAt: new Date().toISOString() },
      true
    );
    return { ok: true, data: { planId: plan.plan_id, revisionId: plan.revision_id, title: plan.title, valid: true, contentOrigin: 'authored' } };
  }

  private lessonGet(req: IpcRequest): IpcResponse {
    const ls = this.ctx.lessonStore;
    if (!ls) return errorResponse('SOURCE_MISSING', '不可用。', '请重启应用。');
    const rec = ls.getLessonRevision((req.payload as { planId: string }).planId);
    if (!rec) return errorResponse('SOURCE_MISSING', '课时计划不存在。', '请先组建计划。');
    return { ok: true, data: { plan: JSON.parse(rec.contentJson), contentOrigin: rec.contentOrigin, valid: rec.valid, revisionId: rec.revisionId } };
  }

  private plansRecordTeaching(req: IpcRequest): IpcResponse {
    const feedback = this.ctx.feedbackStore;
    if (!feedback) return errorResponse('SOURCE_MISSING', '授课记录功能不可用。', '请重启应用。');
    if (!Number.isSafeInteger(req.expected_revision) || (req.expected_revision as number) < 0) {
      return errorResponse('INPUT_INVALID', '授课记录缺少有效的反馈版本。', '请刷新课程后重试。');
    }
    if (typeof req.idempotency_key !== 'string' || req.idempotency_key.trim().length === 0) {
      return errorResponse('INPUT_INVALID', '授课记录缺少幂等键。', '请重试当前操作。');
    }
    const payload = req.payload as {
      planId: string;
      planRevisionId: string;
      taughtAt: string;
      actualDurationSec: number;
      implementationState: ImplementationState;
      adjustmentSummary: string;
    };
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    try {
      const event = createTeachingEvent(
        {
          workspaceId,
          planId: payload.planId,
          planRevisionId: payload.planRevisionId,
          taughtAt: payload.taughtAt,
          actualDurationSec: payload.actualDurationSec,
          implementationState: payload.implementationState,
          adjustmentSummary: payload.adjustmentSummary
        },
        { eventId: () => `teach_${randomUUID()}`, now: () => new Date().toISOString() }
      );
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            req.expected_revision,
            workspaceId,
            payload.planId,
            payload.planRevisionId,
            payload.taughtAt,
            payload.actualDurationSec,
            payload.implementationState,
            payload.adjustmentSummary.trim()
          ])
        )
        .digest('hex');
      return {
        ok: true,
        data: feedback.recordTeaching({
          workspaceId,
          planId: payload.planId,
          planRevisionId: payload.planRevisionId,
          expectedRevision: req.expected_revision as number,
          idempotencyKey: req.idempotency_key,
          fingerprint,
          event
        })
      };
    } catch (error) {
      if (error instanceof FeedbackVersionConflictError) {
        return errorResponse('VERSION_CONFLICT', '授课记录已被其他操作更新，本次未覆盖。', '请刷新课程后重试。');
      }
      if (error instanceof FeedbackKeyReuseError) {
        return errorResponse('INPUT_INVALID', '授课记录幂等键已用于不同内容。', '请重试当前操作。');
      }
      if (error instanceof FeedbackSourceMissingError) {
        return errorResponse('SOURCE_MISSING', '课时计划或指定修订不存在。', '请刷新课程后重试。');
      }
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态，授课记录未写入。', '请先恢复或备份数据库。');
      }
      return errorResponse('INPUT_INVALID', '授课记录内容无效。', '请核对时间和实施状态后重试。');
    }
  }

  private feedbackHistory(req: IpcRequest): IpcResponse {
    const feedback = this.ctx.feedbackStore;
    if (!feedback) return errorResponse('SOURCE_MISSING', '授课记录功能不可用。', '请重启应用。');
    try {
      const planId = (req.payload as { planId: string }).planId;
      const base = feedback.getFeedbackHistory(planId);
      const analysis = feedback.getFeedbackAnalysisHistory(planId);
      const corrections = feedback.getFeedbackCorrectionHistory(planId);
      const observations = feedback.listObservations(planId);
      const hasExtendedHistory = analysis.measurementReviews.length || analysis.attributionRuns.length || observations.length ||
        corrections.corrections.length || corrections.preferenceEvents.length || corrections.effectEvents.length || corrections.observationTombstones.length;
      return {
        ok: true,
        data: hasExtendedHistory
          ? { ...base, observations, ...analysis, ...corrections }
          : base
      };
    } catch (error) {
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '授课历史校验失败，已拒绝隐藏或覆盖损坏数据。', '请先备份并恢复本地数据库。');
      }
      throw error;
    }
  }

  private async feedbackAnalyze(req: IpcRequest): Promise<IpcResponse> {
    const service = this.ctx.feedbackService;
    if (!service) return errorResponse('MODEL_NOT_AVAILABLE', '反馈分析功能不可用。', '请重启应用。');
    if (!Number.isSafeInteger(req.expected_revision) || (req.expected_revision as number) < 0) {
      return errorResponse('INPUT_INVALID', '反馈分析缺少有效的反馈版本。', '请刷新课程后重试。');
    }
    if (typeof req.idempotency_key !== 'string' || !req.idempotency_key.trim()) {
      return errorResponse('INPUT_INVALID', '反馈分析缺少幂等键。', '请重试当前操作。');
    }
    const payload = req.payload as { planId: string; teachingEventId: string; observationIds: unknown[]; dispatchConsent: boolean };
    if (payload.observationIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128)) {
      return errorResponse('INPUT_INVALID', '课堂观察 ID 列表无效。', '请刷新课程后重试。');
    }
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    try {
      return {
        ok: true,
        data: await service.analyze({
          workspaceId,
          planId: payload.planId,
          teachingEventId: payload.teachingEventId,
          observationIds: payload.observationIds as string[],
          dispatchConsent: payload.dispatchConsent,
          expectedRevision: req.expected_revision as number,
          idempotencyKey: req.idempotency_key
        })
      };
    } catch (error) {
      return this.feedbackMutationError(error, '反馈分析');
    }
  }

  private correctionsDecide(req: IpcRequest): IpcResponse {
    const service = this.ctx.feedbackService;
    if (!service) return errorResponse('SOURCE_MISSING', '纠偏决策功能不可用。', '请重启应用。');
    const basic = this.correctionRequestBase(req);
    if (!basic.ok) return basic.response;
    const payload = req.payload as {
      planId: string; proposalId: string; decision: unknown; reason: string; expectedProposalRevision: number;
      preference?: unknown; effect?: unknown;
    };
    if (payload.decision !== 'accept' && payload.decision !== 'reject') {
      return errorResponse('INPUT_INVALID', '纠偏决策无效。', '请选择接受或拒绝。');
    }
    const preference = this.parseCorrectionPreference(payload.preference);
    if (preference === false) return errorResponse('INPUT_INVALID', '表达偏好结构无效。', '请刷新后重试。');
    const effect = this.parseCorrectionEffect(payload.effect);
    if (effect === false) return errorResponse('INPUT_INVALID', '效果证据结构无效。', '请核对观察条件后重试。');
    try {
      return { ok: true, data: service.decideCorrection({
        ...basic.input,
        decision: payload.decision,
        ...(preference ? { preference } : {}),
        ...(effect ? { effect } : {})
      }) };
    } catch (error) {
      return this.feedbackMutationError(error, '纠偏决策');
    }
  }

  private correctionsRevert(req: IpcRequest): IpcResponse {
    const service = this.ctx.feedbackService;
    if (!service) return errorResponse('SOURCE_MISSING', '纠偏撤回功能不可用。', '请重启应用。');
    const basic = this.correctionRequestBase(req);
    if (!basic.ok) return basic.response;
    try {
      return { ok: true, data: service.revertCorrection(basic.input) };
    } catch (error) {
      return this.feedbackMutationError(error, '纠偏撤回');
    }
  }

  private correctionRequestBase(req: IpcRequest):
    | { ok: true; input: CorrectionRevertInput }
    | { ok: false; response: IpcResponse<never> } {
    if (!Number.isSafeInteger(req.expected_revision) || (req.expected_revision as number) < 0 ||
        typeof req.idempotency_key !== 'string' || !req.idempotency_key.trim()) {
      return { ok: false, response: errorResponse('INPUT_INVALID', '纠偏请求缺少有效版本或幂等键。', '请刷新后重试。') };
    }
    const payload = req.payload as { planId: string; proposalId: string; reason: string; expectedProposalRevision: number };
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    return { ok: true, input: {
      workspaceId, planId: payload.planId, proposalId: payload.proposalId, reason: payload.reason,
      expectedRevision: req.expected_revision as number,
      expectedProposalRevision: payload.expectedProposalRevision,
      idempotencyKey: req.idempotency_key
    } };
  }

  private parseCorrectionPreference(value: unknown): CorrectionDecisionInput['preference'] | null | false {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['preferenceKey', 'value', 'reason'].includes(key)) ||
        typeof input.preferenceKey !== 'string' || typeof input.value !== 'string' || typeof input.reason !== 'string') return false;
    return { preferenceKey: input.preferenceKey, value: input.value, reason: input.reason };
  }

  private parseCorrectionEffect(value: unknown): CorrectionDecisionInput['effect'] | null | false {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !['state', 'observationIds'].includes(key)) ||
        !['unknown', 'initial_support', 'repeated_support', 'disconfirmed'].includes(String(input.state)) ||
        !Array.isArray(input.observationIds) || input.observationIds.length < 1 || input.observationIds.length > 100 ||
        input.observationIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128)) return false;
    return { state: input.state as NonNullable<CorrectionDecisionInput['effect']>['state'], observationIds: input.observationIds as string[] };
  }

  private observationsAdd(req: IpcRequest): IpcResponse {
    const feedback = this.ctx.feedbackStore;
    if (!feedback) return errorResponse('SOURCE_MISSING', '课堂观察功能不可用。', '请重启应用。');
    if (!Number.isSafeInteger(req.expected_revision) || (req.expected_revision as number) < 0) {
      return errorResponse('INPUT_INVALID', '课堂观察缺少有效的反馈版本。', '请刷新课程后重试。');
    }
    if (typeof req.idempotency_key !== 'string' || !req.idempotency_key.trim()) {
      return errorResponse('INPUT_INVALID', '课堂观察缺少幂等键。', '请重试当前操作。');
    }
    const payload = req.payload as {
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
    };
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    try {
      const record = createObservationRecord(
        {
          workspaceId,
          planRevisionId: payload.planRevisionId,
          teachingEventId: payload.teachingEventId,
          taskId: payload.taskId,
          sourceKind: payload.sourceKind,
          observedAt: payload.observedAt,
          outcome: payload.outcome,
          supportLevel: payload.supportLevel,
          materialRelation: payload.materialRelation,
          delayDays: payload.delayDays,
          sampleCount: payload.sampleCount,
          populationCount: payload.populationCount,
          selection: payload.selection,
          coverageCaveat: payload.coverageCaveat,
          summary: payload.summary
        },
        { observationId: () => `observation_${randomUUID()}` }
      );
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([req.expected_revision, workspaceId, payload]))
        .digest('hex');
      return {
        ok: true,
        data: feedback.addObservation({
          workspaceId,
          planId: payload.planId,
          teachingEventId: payload.teachingEventId,
          expectedRevision: req.expected_revision as number,
          idempotencyKey: req.idempotency_key,
          fingerprint,
          observation: record.observation,
          outcome: record.outcome,
          createdAt: new Date().toISOString()
        })
      };
    } catch (error) {
      return this.feedbackMutationError(error, '课堂观察');
    }
  }

  private observationsList(req: IpcRequest): IpcResponse {
    const feedback = this.ctx.feedbackStore;
    if (!feedback) return errorResponse('SOURCE_MISSING', '课堂观察功能不可用。', '请重启应用。');
    const planId = (req.payload as { planId: string }).planId;
    try {
      return {
        ok: true,
        data: {
          observations: feedback.listObservations(planId),
          knowledgeState: feedback.feedbackKnowledgeState(planId)
        }
      };
    } catch (error) {
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '课堂观察校验失败，未隐藏损坏数据。', '请先备份并恢复本地数据库。');
      }
      throw error;
    }
  }

  private async observationsPrepareDelete(req: IpcRequest): Promise<IpcResponse> {
    const feedback = this.ctx.feedbackStore;
    const confirm = this.ctx.confirmObservationDelete;
    if (!feedback || !confirm) return errorResponse('INPUT_INVALID', '删除确认功能不可用。', '请重启应用。');
    const payload = req.payload as { planId: string; observationId: string };
    let exists = false;
    try {
      exists = feedback
        .listObservations(payload.planId)
        .some((record) => record.observation.observation_id === payload.observationId);
    } catch (error) {
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '课堂观察校验失败，不能准备删除。', '请先备份并恢复本地数据库。');
      }
      throw error;
    }
    if (!exists) return errorResponse('SOURCE_MISSING', '要删除的课堂观察不存在。', '请刷新课程后重试。');
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    const issued = await confirm({ workspaceId, planId: payload.planId, observationId: payload.observationId });
    if (!issued || !issued.token.trim() || !Number.isFinite(issued.expiresAt) || issued.expiresAt <= Date.now()) {
      return errorResponse('INPUT_INVALID', '未确认删除，课堂观察保持不变。', '如需删除，请重新确认。');
    }
    this.observationDeleteTokens.set(issued.token, {
      workspaceId,
      planId: payload.planId,
      observationId: payload.observationId,
      expiresAt: issued.expiresAt
    });
    return { ok: true, data: { confirmationToken: issued.token, expiresAt: issued.expiresAt } };
  }

  private observationsDelete(req: IpcRequest): IpcResponse {
    const feedback = this.ctx.feedbackStore;
    if (!feedback) return errorResponse('SOURCE_MISSING', '课堂观察功能不可用。', '请重启应用。');
    if (!Number.isSafeInteger(req.expected_revision) || (req.expected_revision as number) < 0) {
      return errorResponse('INPUT_INVALID', '删除请求缺少有效的反馈版本。', '请刷新课程后重试。');
    }
    if (typeof req.idempotency_key !== 'string' || !req.idempotency_key.trim()) {
      return errorResponse('INPUT_INVALID', '删除请求缺少幂等键。', '请重试当前操作。');
    }
    const payload = req.payload as { planId: string; observationId: string; confirmationToken: string };
    const workspaceId = typeof req.workspace_id === 'string' && req.workspace_id.trim() ? req.workspace_id.trim() : 'workspace_default';
    const token = this.observationDeleteTokens.get(payload.confirmationToken);
    if (
      !token ||
      token.expiresAt <= Date.now() ||
      token.workspaceId !== workspaceId ||
      token.planId !== payload.planId ||
      token.observationId !== payload.observationId ||
      (token.consumedBy !== undefined && token.consumedBy !== req.idempotency_key)
    ) {
      return errorResponse('INPUT_INVALID', '删除确认已失效、已被使用或与观察不匹配。', '请重新确认删除。');
    }
    token.consumedBy = req.idempotency_key;
    token.deletedAt ??= new Date().toISOString();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([req.expected_revision, workspaceId, payload.planId, payload.observationId]))
      .digest('hex');
    try {
      return {
        ok: true,
        data: feedback.deleteObservation({
          workspaceId,
          planId: payload.planId,
          observationId: payload.observationId,
          expectedRevision: req.expected_revision as number,
          idempotencyKey: req.idempotency_key,
          fingerprint,
          confirmationToken: payload.confirmationToken,
          deletedAt: token.deletedAt,
          backupScopesNotCovered: ['external_or_offline_backups']
        })
      };
    } catch (error) {
      return this.feedbackMutationError(error, '课堂观察删除');
    }
  }

  private feedbackMutationError(error: unknown, label: string): IpcResponse<never> {
    if (error instanceof CorrectionVersionConflictError) {
      return errorResponse('VERSION_CONFLICT', `${label}状态已变化，本次未覆盖。`, '请刷新纠偏卡后重试。');
    }
    if (error instanceof FeedbackVersionConflictError) {
      return errorResponse('VERSION_CONFLICT', `${label}流已被其他操作更新，本次未覆盖。`, '请刷新课程后重试。');
    }
    if (error instanceof FeedbackKeyReuseError) {
      return errorResponse('INPUT_INVALID', `${label}幂等键已用于不同内容。`, '请重试当前操作。');
    }
    if (error instanceof FeedbackSourceMissingError) {
      return errorResponse('SOURCE_MISSING', `${label}引用的授课、课时或任务不存在。`, '请刷新课程后重试。');
    }
    if (error instanceof ObservationPrivacyError) {
      return errorResponse('PRIVACY_BLOCKED', '课堂观察包含不必要的身份、联系方式、原始作品或路径字段，未保存。', '请只保留去身份化的表现事实。');
    }
    if (error instanceof StoreProtectedError) {
      return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态，本次反馈未写入。', '请先恢复或备份数据库。');
    }
    return errorResponse('INPUT_INVALID', `${label}内容无效。`, '请核对样本范围、时间和观察内容后重试。');
  }

  private reviewRun(req: IpcRequest): IpcResponse {
    const ls = this.ctx.lessonStore;
    if (!ls) return errorResponse('SOURCE_MISSING', '课时审查功能不可用。', '请重启应用。');
    if (this.ctx.store.isProtected()) {
      return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态，未写入审查结果。', '请先恢复或备份数据库。');
    }
    const payload = req.payload as { planId: string; revisionId?: string };
    const rec = ls.getLessonRevision(payload.planId, payload.revisionId);
    if (!rec) return errorResponse('SOURCE_MISSING', '课时计划或指定修订不存在。', '请刷新计划后重试。');

    let plan: ReturnType<typeof buildLessonPlan>;
    try {
      plan = JSON.parse(rec.contentJson) as ReturnType<typeof buildLessonPlan>;
    } catch {
      return errorResponse('EXPORT_INVALID', '课时计划数据损坏，无法审查。', '请恢复该修订或重新组建计划。');
    }
    const report = reviewLessonPlan(plan, {
      ids: {
        reportId: () => `report_${randomUUID()}`,
        issueId: () => `issue_${randomUUID()}`
      }
    });
    try {
      ls.saveReviewReport({
        reportId: report.report_id,
        planId: rec.planId,
        revisionId: rec.revisionId,
        report,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态，未写入审查结果。', '请先恢复或备份数据库。');
      }
      throw error;
    }
    return { ok: true, data: { report } };
  }

  private changePreview(req: IpcRequest): IpcResponse {
    if (!this.lessonChangeService) return errorResponse('SOURCE_MISSING', '一处修改功能不可用。', '请重启应用。');
    const payload = req.payload as { planId: string; baseRevisionId: string; change: LessonChange };
    try {
      return {
        ok: true,
        data: {
          preview: this.lessonChangeService.preview(payload.planId, payload.baseRevisionId, payload.change)
        }
      };
    } catch (error) {
      return this.lessonChangeError(error);
    }
  }

  private async changeApply(req: IpcRequest): Promise<IpcResponse> {
    if (!this.lessonChangeService) return errorResponse('SOURCE_MISSING', '一处修改功能不可用。', '请重启应用。');
    if (typeof req.idempotency_key !== 'string' || req.idempotency_key.trim().length === 0) {
      return errorResponse('INPUT_INVALID', '接纳修改缺少幂等键。', '请重试当前操作。');
    }
    const payload = req.payload as { planId: string; baseRevisionId: string; change: LessonChange };
    try {
      const result = await this.lessonChangeService.apply({
        ...payload,
        idempotencyKey: req.idempotency_key
      });
      return { ok: true, data: { result } };
    } catch (error) {
      return this.lessonChangeError(error);
    }
  }

  private changeHistory(req: IpcRequest): IpcResponse {
    if (!this.lessonChangeService) return errorResponse('SOURCE_MISSING', '修改历史功能不可用。', '请重启应用。');
    try {
      return {
        ok: true,
        data: this.lessonChangeService.history((req.payload as { planId: string }).planId)
      };
    } catch (error) {
      return this.lessonChangeError(error);
    }
  }

  private lessonChangeError(error: unknown): IpcResponse<never> {
    if (error instanceof LessonChangeConflictError) {
      return errorResponse('VERSION_CONFLICT', '计划已被其他修改更新，本次接纳未提交。', '请刷新最新版本后重试。');
    }
    if (error instanceof LessonChangeKeyReuseError || error instanceof ChangeValidationError) {
      return errorResponse('INPUT_INVALID', '修改请求或幂等键无效。', '请检查修改内容后重试。');
    }
    if (error instanceof LessonChangeSourceMissingError) {
      return errorResponse('SOURCE_MISSING', '课时计划或指定基线修订不存在。', '请刷新计划后重试。');
    }
    if (error instanceof LessonChangeReviewError || error instanceof ChangeBlockedError || error instanceof FontMissingError) {
      return errorResponse('EXPORT_INVALID', '修改后的计划未通过发布前审查。', '请返回建议模块修正后重试。');
    }
    if (error instanceof StoreProtectedError) {
      return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态，本次修改未提交。', '请先恢复或备份数据库。');
    }
    if (error instanceof LessonChangeDiskError) {
      return errorResponse('DISK_FULL', '成品写入失败，本次修改未提交。', '请检查磁盘空间与目录权限后重试。');
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS') {
      return errorResponse('DISK_FULL', '成品写入失败，本次修改未提交。', '请检查磁盘空间与目录权限后重试。');
    }
    return errorResponse('EXPORT_INVALID', '修改未能安全提交。', '请保留旧版本并重试；持续失败请联系支持。');
  }

  // G06/G07：生成后先复核内存字节，再以暂存→回读哈希→原子改名发布；文件、报告与清单同事务登记。
  private async materialsGenerate(req: IpcRequest): Promise<IpcResponse> {
    const ls = this.ctx.lessonStore;
    if (!ls) return errorResponse('INPUT_INVALID', '成品生成不可用。', '请重启应用。');
    const rec = ls.getLessonRevision((req.payload as { planId: string }).planId);
    if (!rec) return errorResponse('SOURCE_MISSING', '课时计划不存在。', '请先组建计划。');
    const bundleId = `bundle_${randomUUID()}`;
    const root = join(this.ctx.userDataDir ?? '.', 'materials');
    const stagingDirectory = join(root, '.staging', bundleId);
    let published: PublishedBundle | null = null;
    try {
      const plan = JSON.parse(rec.contentJson) as LessonPlan;
      const set = await buildMaterialSet(plan, rec.contentOrigin);
      const baseReport = reviewLessonPlan(plan, {
        ids: {
          reportId: () => `report_${randomUUID()}`,
          issueId: () => `issue_${randomUUID()}`
        }
      });
      const bundleIssues = await reviewMaterialSet(plan, set);
      const report = {
        ...baseReport,
        issues: [...baseReport.issues, ...bundleIssues],
        executed_checks: [...new Set([...baseReport.executed_checks, 'material_bundle_consistency'])]
      };
      if (report.issues.some((issue) => issue.severity === 'blocking')) report.disposition = 'blocked';
      else if (report.issues.some((issue) => issue.severity === 'fix')) report.disposition = 'needs_fix';
      if (report.disposition !== 'ready_for_teacher') {
        return errorResponse('EXPORT_INVALID', '生成的材料包未通过发布前一致性审查；旧版未受影响。', '请返回建议模块修正后重试。');
      }

      const staged = await stageMaterialSet(root, bundleId, set, nodeBundleIo);
      published = await promoteStagedBundle(root, staged, nodeBundleIo);
      const now = new Date().toISOString();
      const artifacts: MaterialArtifactRecord[] = published.files.map((file) => ({
        id: randomUUID(),
        planId: set.planId,
        revisionId: set.revisionId,
        role: file.role,
        format: file.format,
        filename: file.filename,
        path: join(published!.directory, file.filename),
        sha256: file.sha256,
        byteSize: file.byteSize,
        contentOrigin: set.contentOrigin,
        createdAt: now,
        bundleId
      }));
      const bundle: MaterialBundleRecord = {
        bundleId,
        planId: set.planId,
        revisionId: set.revisionId,
        presentationSpecHash: createHash('sha256')
          .update(JSON.stringify({ fontScale: 1, paperSize: 'A4', theme: 'light' }))
          .digest('hex'),
        directory: published.directory,
        status: 'published',
        createdAt: now
      };
      const reportRecord: ReviewReportRecord = {
        reportId: report.report_id,
        planId: set.planId,
        revisionId: set.revisionId,
        report,
        createdAt: now
      };
      ls.commitMaterialBundle({ bundle, artifacts, review: reportRecord });
      return {
        ok: true,
        data: {
          planId: set.planId,
          revisionId: set.revisionId,
          contentOrigin: set.contentOrigin,
          versionStamp: set.versionStamp,
          files: artifacts.map((artifact) => ({
            role: artifact.role,
            format: artifact.format,
            filename: artifact.filename,
            path: artifact.path,
            sha256: artifact.sha256,
            byteSize: artifact.byteSize
          }))
        }
      };
    } catch (error) {
      await nodeBundleIo.rm(published?.directory ?? stagingDirectory).catch(() => undefined);
      if (error instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '本地数据库处于保护状态；旧版未受影响，成品未登记。', '请先恢复或备份数据库。');
      }
      if (error instanceof LessonChangeConflictError) {
        return errorResponse('VERSION_CONFLICT', '计划已更新；旧版未受影响，生成的成品未登记。', '请刷新最新版本后重试。');
      }
      if (error instanceof FontMissingError) {
        return errorResponse('EXPORT_INVALID', '缺少可用的内置中文字体；旧版未受影响，未发布成品。', '请修复应用资源后重试。');
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS' || code === 'ENOTDIR') {
        return errorResponse('DISK_FULL', '成品写入失败；旧版未受影响，未登记不存在的文件。', '请检查磁盘空间与目录权限后重试。');
      }
      return errorResponse('EXPORT_INVALID', '成品未能安全发布；旧版未受影响。', '请保留旧版本并重试；持续失败请联系支持。');
    }
  }

  private sourcesReadOriginal(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('SOURCE_MISSING', '原件不存在。', '请刷新资料列表。');
    const p = req.payload as { versionId: string };
    const r = src.readOriginal(p.versionId);
    if (!r) return errorResponse('SOURCE_MISSING', '原件不存在或未保存。', '请刷新资料列表。');
    return { ok: true, data: r };
  }

  private sourcesList(): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return { ok: true, data: { sources: [] } };
    return { ok: true, data: { sources: src.listSources() } };
  }

  private sourcesSearch(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return { ok: true, data: { hits: [] } };
    const q = (req.payload as { query: string }).query;
    return { ok: true, data: { hits: src.searchSources(q) } };
  }

  private sourcesRead(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('SOURCE_MISSING', '资料不存在。', '请刷新资料列表。');
    const p = req.payload as { versionId: string; charStart?: number; charEnd?: number };
    const r = src.readSource(p.versionId, p.charStart, p.charEnd);
    if (!r) return errorResponse('SOURCE_MISSING', '资料不存在或已移除。', '请刷新资料列表。');
    return { ok: true, data: r };
  }

  private sourcesRetire(req: IpcRequest): IpcResponse {
    const src = this.ctx.sourceStore;
    if (!src) return errorResponse('SOURCE_MISSING', '资料不存在。', '请刷新资料列表。');
    const p = req.payload as { documentId: string };
    try {
      const ok = src.retireSource(p.documentId);
      if (!ok) return errorResponse('SOURCE_MISSING', '资料不存在。', '请刷新资料列表。');
      return { ok: true, data: { documentId: p.documentId, status: 'retired' } };
    } catch (e) {
      if (e instanceof StoreProtectedError) return errorResponse('DATABASE_LOCKED', '本地数据暂停写入。', '请先完成数据恢复。');
      return errorResponse('DISK_FULL', '操作失败。', '请重试。', true);
    }
  }

  private bootstrap(): IpcResponse<BootstrapData> {
    const draft = this.ctx.store.getDraft();
    return {
      ok: true,
      data: {
        schema_version: IPC_SCHEMA_VERSION,
        app_version: this.ctx.appVersion,
        app_name_zh: this.ctx.appNameZh,
        workspace: null,
        connection: this.ctx.online ? 'connected' : 'offline',
        recovery: {
          has_draft: draft.content.trim().length > 0,
          draft_updated_at: draft.updated_at
        },
        platform_supported: this.ctx.platformSupported
      }
    };
  }

  private async health(): Promise<IpcResponse<HealthData>> {
    const probe = await this.ctx.store.probeWritable();
    return {
      ok: true,
      data: {
        main_process: 'ok',
        renderer_channel: 'ok',
        storage_probe: probe ? 'ok' : 'failed',
        local_http_service: 'not_started_by_design',
        offline_capable_by_design: true,
        build_mode: this.ctx.buildMode,
        sandbox_enabled: this.ctx.sandboxEnabled,
        platform_dev_override: this.ctx.platformDevOverride,
        recovered_from_corruption: this.ctx.store.recoveredFromCorruption(),
        platform_target_supported: this.ctx.platformTargetSupported,
        platform_identity: this.ctx.platformIdentity,
        storage_protected: this.ctx.store.isProtected(),
        credential_encryption: this.ctx.store.credentialEncryptionAvailable() ? 'available' : 'unavailable'
      }
    };
  }

  private getStatus(): IpcResponse<StatusData> {
    // 尚未创建工作区：如实返回「无工作区」，不把未知显示为成功（语义守卫）。
    return {
      ok: true,
      data: {
        has_workspace: false,
        active_jobs: 0,
        note_zh: '尚未创建工作区。可在后续版本中导入教材并新建班级后开始备课。'
      }
    };
  }

  private loadDraft(): IpcResponse<DraftData> {
    const d = this.ctx.store.getDraft();
    return { ok: true, data: { content: d.content, revision: d.revision, updated_at: d.updated_at } };
  }

  // 稳定的请求指纹：把幂等键绑定到（基线版本 + 载荷）。同键异指纹视为键复用错误。
  private fingerprint(content: string, expectedRevision: number): string {
    return `${expectedRevision}\u0000${content}`;
  }

  private async saveDraft(req: IpcRequest<SaveDraftPayload>): Promise<IpcResponse<DraftData>> {
    const payload = req.payload;
    if (!payload || typeof payload.content !== 'string') {
      return errorResponse('INPUT_INVALID', '草稿内容无效。', '请检查后重试。');
    }
    if (payload.content.length > 200_000) {
      return errorResponse('INPUT_INVALID', '草稿内容过长。', '请缩减内容后重试。');
    }
    const key = req.idempotency_key;
    if (typeof key !== 'string' || key.length === 0) {
      return errorResponse('INPUT_INVALID', '写操作缺少幂等标识。', '请重试当前操作。');
    }
    // F03/T04/T05：expected_revision 在处理边界为必填、非负、安全整数；缺失或错误类型一律拒绝。
    const rev = req.expected_revision;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
      return errorResponse(
        'INPUT_INVALID',
        '写操作缺少有效的版本号（需非负整数）。',
        '请刷新查看最新草稿后重试。'
      );
    }
    const fp = this.fingerprint(payload.content, rev);

    // T04：幂等业务提交由存储层在同一事务完成（业务修改 + 持久幂等结果 + outbox 事件）。
    // 幂等/冲突/键复用语义与并发/跨重启去重由存储层保证（SqliteStore 持久；LocalStore 会话内）。
    try {
      const r = await this.ctx.store.commitDraftSave({
        idempotencyKey: key,
        fingerprint: fp,
        content: payload.content,
        expectedRevision: rev
      });
      switch (r.status) {
        case 'applied':
        case 'replayed':
          return { ok: true, data: { content: r.draft.content, revision: r.draft.revision, updated_at: r.draft.updated_at } };
        case 'conflict':
          return errorResponse(
            'VERSION_CONFLICT',
            '本地草稿已在别处更新，为避免覆盖已停止保存。',
            '请刷新查看最新草稿后重试。'
          );
        case 'key_reuse':
          return errorResponse('INPUT_INVALID', '同一幂等键被用于不同的请求。', '请为新的修改使用新的请求标识。');
      }
    } catch (e) {
      if (e instanceof StoreProtectedError) {
        return errorResponse(
          'DATABASE_LOCKED',
          '本地数据文件未能可靠读取或隔离，已暂停保存以防覆盖。',
          '请在设置中查看数据恢复；恢复完成前不会写入。'
        );
      }
      // 写盘/必需记录等失败：可重试错误，不落幂等（store 事务已回滚，未提交）。
      return errorResponse('DISK_FULL', '保存到本地失败，磁盘可能空间不足或暂不可写。', '请检查磁盘空间后重试。', true);
    }
  }
}
