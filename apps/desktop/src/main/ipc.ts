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
import type { LocalStore } from './store';

function errorResponse(
  code: ErrorCode,
  message_zh: string,
  next_action: string,
  retryable = false
): IpcResponse<never> {
  return { ok: false, error: { code, message_zh, retryable, next_action } };
}

export interface IpcServiceContext {
  store: LocalStore;
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

// 有界的幂等结果缓存：记录已处理的 idempotency_key → 响应，
// 用于安全地忽略网络重试/重放导致的重复写入（不重复递增版本，也不误报冲突）。
const IDEMPOTENCY_CACHE_LIMIT = 256;

export class IpcService {
  private readonly idempotency = new Map<string, IpcResponse>();

  constructor(private readonly ctx: IpcServiceContext) {}

  private rememberIdempotent(key: string, res: IpcResponse): void {
    if (this.idempotency.has(key)) this.idempotency.delete(key);
    this.idempotency.set(key, res);
    while (this.idempotency.size > IDEMPOTENCY_CACHE_LIMIT) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest === undefined) break;
      this.idempotency.delete(oldest);
    }
  }

  async handle(op: string, req: unknown): Promise<IpcResponse> {
    const invalid = validateEnvelope(op, req);
    if (invalid) return invalid;
    const request = req as IpcRequest;

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
      default:
        return errorResponse('INPUT_INVALID', '未知操作。', '请重试当前操作。');
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

  private health(): IpcResponse<HealthData> {
    return {
      ok: true,
      data: {
        main_process: 'ok',
        renderer_channel: 'ok',
        storage_writable: this.ctx.store.storageWritable(),
        http_listeners: this.ctx.httpListeners,
        offline_ready: true,
        build_mode: this.ctx.buildMode,
        sandbox_enabled: this.ctx.sandboxEnabled,
        platform_dev_override: this.ctx.platformDevOverride
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

  private async saveDraft(req: IpcRequest<SaveDraftPayload>): Promise<IpcResponse<DraftData>> {
    const payload = req.payload;
    if (!payload || typeof payload.content !== 'string') {
      return errorResponse('INPUT_INVALID', '草稿内容无效。', '请检查后重试。');
    }
    if (payload.content.length > 200_000) {
      return errorResponse('INPUT_INVALID', '草稿内容过长。', '请缩减内容后重试。');
    }
    // 幂等：写操作要求 idempotency_key；同一 key 的重放直接返回首次结果，
    // 避免网络重试/重复派发导致重复写入或误报版本冲突（规范 9.1、10.4 REQUEST_UNCERTAIN）。
    const key = req.idempotency_key;
    if (typeof key !== 'string' || key.length === 0) {
      return errorResponse('INPUT_INVALID', '写操作缺少幂等标识。', '请重试当前操作。');
    }
    const prior = this.idempotency.get(key);
    if (prior) return prior as IpcResponse<DraftData>;

    // 乐观并发：expected_revision 与当前版本不一致时返回版本冲突，展示差异而非覆盖（规范 7.3）。
    const current = this.ctx.store.getDraft();
    if (typeof req.expected_revision === 'number' && req.expected_revision !== current.revision) {
      const conflict = errorResponse(
        'VERSION_CONFLICT',
        '本地草稿已在别处更新，为避免覆盖已停止保存。',
        '请刷新查看最新草稿后重试。'
      ) as IpcResponse<DraftData>;
      // 冲突结果也按 key 记忆：同一请求重放得到一致的确定性结果，不重复触发写入尝试。
      this.rememberIdempotent(key, conflict);
      return conflict;
    }
    const saved = await this.ctx.store.saveDraft(payload.content);
    const res: IpcResponse<DraftData> = {
      ok: true,
      data: { content: saved.content, revision: saved.revision, updated_at: saved.updated_at }
    };
    this.rememberIdempotent(key, res);
    return res;
  }
}
