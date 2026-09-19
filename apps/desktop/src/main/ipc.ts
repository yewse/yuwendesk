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
import type { DraftStore, SourceStore } from './store';
import { StoreProtectedError } from './store';
import { checkPayload } from './schemaGate';

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
}

export function isImplementedOperation(op: string): op is OperationName {
  return (IMPLEMENTED_OPERATIONS as readonly string[]).includes(op);
}

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
  constructor(private readonly ctx: IpcServiceContext) {}

  async handle(op: string, req: unknown): Promise<IpcResponse> {
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
      case 'sources.list':
        return this.sourcesList();
      case 'sources.search':
        return this.sourcesSearch(request);
      case 'sources.read':
        return this.sourcesRead(request);
      case 'sources.retire':
        return this.sourcesRetire(request);
      default:
        return errorResponse('INPUT_INVALID', '未知操作。', '请重试当前操作。');
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
      if (r.status === 'blocked_sensitive') {
        return errorResponse(
          'PRIVACY_BLOCKED',
          '敏感资料（学生材料）导入已被阻止：完整加密资料路径尚未实现，不会将正文写入普通存储。',
          '普通非敏感资料可正常导入；敏感材料待加密业务落点实现后再启用。'
        );
      }
      if (r.status === 'rejected') {
        const msg =
          r.reason === 'too_large' ? '文件过大。' : r.reason === 'bad_classification' ? '资料分类取值非法。' : '内容为空。';
        return errorResponse('INPUT_INVALID', msg, '请检查文件与分类后重试。');
      }
      // needs_confirmation / imported / new_version / duplicate 均为正常数据返回。
      return { ok: true, data: r };
    } catch (e) {
      if (e instanceof StoreProtectedError) {
        return errorResponse('DATABASE_LOCKED', '本地数据暂停写入以防覆盖。', '请先完成数据恢复。');
      }
      return errorResponse('DISK_FULL', '导入失败，本地写入异常。', '请检查磁盘后重试。', true);
    }
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
