// 统一 IPC 契约（对应 contracts/ipc-catalog.json）。
// 该文件同时被主进程、预加载与渲染进程引用，只放纯类型与常量，不含任何密钥或业务正文。

export const IPC_SCHEMA_VERSION = '1.0.0' as const;

// 21 项错误码，与 contracts/ipc-catalog.json 保持一致。
export const ERROR_CODES = [
  'INPUT_INVALID',
  'SOURCE_MISSING',
  'SOURCE_CONFLICT',
  'NEEDS_SOURCE_CONFIRMATION',
  'PRIVACY_BLOCKED',
  'KEY_UNAVAILABLE',
  'AUTH_FAILED',
  'MODEL_NOT_AVAILABLE',
  'CAPABILITY_UNSUPPORTED',
  'NETWORK_UNAVAILABLE',
  'RATE_LIMITED',
  'REQUEST_UNCERTAIN',
  'BUDGET_EXCEEDED',
  'JOB_CANCELLED',
  'VERSION_CONFLICT',
  'EXPORT_INVALID',
  'DISK_FULL',
  'DATABASE_LOCKED',
  'BACKUP_INVALID',
  'UPDATE_UNTRUSTED',
  'OS_UNSUPPORTED'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// G01 已实现的受限操作白名单。完整目录见 contracts/ipc-catalog.json，
// 其余操作将在后续阶段（G02+）逐个实现，未实现前不暴露给渲染进程。
export const IMPLEMENTED_OPERATIONS = [
  'app.bootstrap',
  'app.health',
  'app.getStatus',
  'ui.loadDraft',
  'ui.saveDraft'
] as const;

export type OperationName = (typeof IMPLEMENTED_OPERATIONS)[number];

// 统一请求外壳。写操作在后续阶段将强制 expected_revision 与 idempotency_key；
// G01 的 ui.saveDraft 使用本地乐观版本号演示版本并发外壳。
export interface IpcRequest<TPayload = unknown> {
  schema_version: string;
  request_id: string;
  operation: OperationName;
  workspace_id: string | null;
  expected_revision?: number;
  idempotency_key?: string;
  payload?: TPayload;
}

export interface IpcErrorBody {
  code: ErrorCode;
  message_zh: string;
  retryable: boolean;
  next_action: string;
}

export type IpcResponse<TData = unknown> =
  | { ok: true; data: TData }
  | { ok: false; error: IpcErrorBody };

// ---- 各操作的输出契约（G01 子集） ----

export interface BootstrapData {
  schema_version: string;
  app_version: string;
  app_name_zh: string;
  workspace: null | { id: string; name: string };
  connection: 'offline' | 'connected';
  recovery: { has_draft: boolean; draft_updated_at: string | null };
  platform_supported: boolean;
}

export interface HealthData {
  main_process: 'ok';
  renderer_channel: 'ok';
  storage_writable: boolean;
  http_listeners: number; // 生产环境必须为 0
  offline_ready: boolean;
  // 真实运行标志（状态证据，不写死）：便于界面如实提示是否处于开发/非沙箱模式。
  build_mode: 'development' | 'production';
  sandbox_enabled: boolean;
  platform_dev_override: boolean;
}

export interface StatusData {
  has_workspace: boolean;
  active_jobs: number;
  note_zh: string;
}

export interface DraftData {
  content: string;
  revision: number;
  updated_at: string | null;
}

export interface SaveDraftPayload {
  content: string;
}
