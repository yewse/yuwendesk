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
  'ui.saveDraft',
  'sources.import',
  'sources.importFile',
  'sources.cancelImport',
  'sources.list',
  'sources.search',
  'sources.read',
  'sources.retire',
  'sources.versions',
  'sources.readOriginal',
  'model.providers',
  'model.getConfig',
  'model.configure',
  'model.probe',
  'model.run',
  'model.cancel',
  'model.listJobs',
  'lesson.buildDemo',
  'lesson.list',
  'lesson.get',
  'plans.recordTeaching',
  'feedback.history',
  'feedback.analyze',
  'corrections.decide',
  'corrections.revert',
  'observations.add',
  'observations.list',
  'observations.prepareDelete',
  'observations.delete',
  'review.run',
  'change.preview',
  'change.apply',
  'change.history',
  'materials.generate',
  'materials.list'
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
  // 运行时探针：实际写入并清理一个临时文件后的真实结果（非"尝试建目录"的常量）。
  storage_probe: 'ok' | 'failed';
  // 设计保证（非运行时端口扫描）：应用不启动任何本地 HTTP/WebSocket 服务。
  // INS-008 的验收以系统级外部证据（进程/监听套接字）为准，不以本字段替代。
  local_http_service: 'not_started_by_design';
  // 设计能力：离线可查阅/编辑/导出现有内容；非"当前是否联网"的实时检测。
  offline_capable_by_design: boolean;
  // 真实运行标志（状态证据，不写死）。
  build_mode: 'development' | 'production';
  sandbox_enabled: boolean; // 仅启动参数层面的指示，非全进程 OS 隔离实测
  platform_dev_override: boolean;
  recovered_from_corruption: boolean;
  // 平台身份（F07）：可运行 ≠ 正式目标 ≠ 已验收；identity 信息不足时为 unknown。
  platform_target_supported: boolean;
  platform_identity: string;
  // 本地数据保护态：源文件未可靠读取或隔离失败时为 true，此时暂停写入以防覆盖。
  storage_protected: boolean;
  // 凭据加密（safeStorage/DPAPI）可用性：不可用时拒绝持久化明文密钥（G02-T03）。
  credential_encryption: 'available' | 'unavailable';
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

// ---- G03 资料/来源（渲染层类型） ----
export interface SourceAnchorDTO {
  char_start: number;
  char_end: number;
  line: number;
}
export interface SourceHitDTO {
  documentId: string;
  title: string;
  version: number;
  versionId: string;
  classification: string;
  anchor: SourceAnchorDTO | null;
  context: string;
  locator: ({ kind: string } & Record<string, number | string>) | null;
  reliable: boolean;
  locatorLabel: string;
  matchKind: 'title' | 'body';
}
export interface SourceVersionDTO {
  versionId: string;
  version: number;
  contentHash: string;
  originalHash: string;
  textHash: string;
  format: string;
  scanned: boolean;
  reliableText: boolean;
  createdAt: string;
  isCurrent: boolean;
}
export interface SourceListItemDTO {
  documentId: string;
  title: string;
  classification: string;
  status: string;
  version: number;
  contentHash: string;
}
export interface SourceReadDTO {
  title: string;
  version: number;
  text: string;
  char_start: number | null;
  char_end: number | null;
  truncated: boolean;
}
export interface SourceImportPayload {
  title: string;
  format: string;
  content: string;
  classification?: string;
  relation?: 'new_version' | 'separate';
  targetDocumentId?: string;
}
