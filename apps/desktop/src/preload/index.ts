import { contextBridge, ipcRenderer } from 'electron';
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
import { IPC_SCHEMA_VERSION } from '../shared/ipc';

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
    })
};

export type YuwenApi = typeof api;

contextBridge.exposeInMainWorld('yuwen', api);
