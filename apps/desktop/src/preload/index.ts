import { contextBridge, ipcRenderer } from 'electron';
import type {
  BootstrapData,
  DraftData,
  HealthData,
  IpcRequest,
  IpcResponse,
  OperationName,
  SaveDraftPayload,
  SourceHitDTO,
  SourceImportPayload,
  SourceListItemDTO,
  SourceReadDTO,
  SourceVersionDTO,
  StatusData
} from '../shared/ipc';

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
