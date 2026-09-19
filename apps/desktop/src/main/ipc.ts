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

// 有界的幂等结果缓存：记录已处理的 idempotency_key → {载荷指纹, 确定性响应}。
// 用于安全地忽略网络重试/重放导致的重复写入（不重复递增版本、不误报冲突）。
// 只缓存"确定性结果"（成功 / 版本冲突 / 载荷非法）；瞬时写盘失败不缓存，允许重试。
const IDEMPOTENCY_CACHE_LIMIT = 256;

interface IdempotentEntry {
  fingerprint: string;
  response: IpcResponse;
}

export class IpcService {
  private readonly idempotency = new Map<string, IdempotentEntry>();
  // 同键并发在途请求去重：并发重放共享同一 promise，避免二者都写入或互相误报冲突。
  private readonly inflight = new Map<string, { fingerprint: string; promise: Promise<IpcResponse> }>();

  constructor(private readonly ctx: IpcServiceContext) {}

  private rememberIdempotent(key: string, fingerprint: string, res: IpcResponse): void {
    if (this.idempotency.has(key)) this.idempotency.delete(key);
    this.idempotency.set(key, { fingerprint, response: res });
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
        recovered_from_corruption: this.ctx.store.recoveredFromCorruption()
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

    // 幂等缓存命中：同键同请求→返回原确定性结果；同键异请求→拒绝键复用（T06，不冒充旧成功）。
    const cached = this.idempotency.get(key);
    if (cached) {
      if (cached.fingerprint === fp) return cached.response as IpcResponse<DraftData>;
      return errorResponse('INPUT_INVALID', '同一幂等键被用于不同的请求。', '请为新的修改使用新的请求标识。');
    }
    // 在途去重：同键同请求并发→共享同一 Promise（T07，避免二者都写或误报冲突）；同键异请求→拒绝。
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.fingerprint === fp) return (await pending.promise) as IpcResponse<DraftData>;
      return errorResponse('INPUT_INVALID', '同一幂等键正在被另一请求使用。', '请为新的修改使用新的请求标识。');
    }

    const promise = this.commitSaveDraft(payload.content, rev);
    this.inflight.set(key, { fingerprint: fp, promise });
    let res: IpcResponse;
    try {
      res = await promise;
    } finally {
      this.inflight.delete(key);
    }
    // 仅缓存确定性结果（成功 / 版本冲突）；瞬时写盘失败不缓存，允许重试后成功。
    if (res.ok || res.error.code === 'VERSION_CONFLICT') {
      this.rememberIdempotent(key, fp, res);
    }
    return res as IpcResponse<DraftData>;
  }

  // 版本检查 + 写盘 + 内存提交处于同一有序边界（写盘成功后才由 store 公布提交）。
  private async commitSaveDraft(content: string, expectedRevision: number): Promise<IpcResponse<DraftData>> {
    const current = this.ctx.store.getDraft();
    if (expectedRevision !== current.revision) {
      return errorResponse(
        'VERSION_CONFLICT',
        '本地草稿已在别处更新，为避免覆盖已停止保存。',
        '请刷新查看最新草稿后重试。'
      );
    }
    try {
      const saved = await this.ctx.store.saveDraft(content);
      return { ok: true, data: { content: saved.content, revision: saved.revision, updated_at: saved.updated_at } };
    } catch {
      // 写盘失败：返回可重试错误，且不缓存（store 保证内存版本未被提前改动，T08）。
      return errorResponse('DISK_FULL', '保存到本地失败，磁盘可能空间不足或暂不可写。', '请检查磁盘空间后重试。', true);
    }
  }
}
