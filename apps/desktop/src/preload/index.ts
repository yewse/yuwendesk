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
import type { ReviewReport } from '../main/review/types';
import type { ChangePreview, LessonChange } from '../main/change/types';
import type { LessonChangeApplyResult } from '../main/store';

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
  // G05/G06 课时计划与三类五文件（自拟/测试内容明确标注）。
  lessonBuildDemo: () => call<{ planId: string; revisionId: string; title: string; valid: boolean; contentOrigin: string }>('lesson.buildDemo'),
  lessonList: () => call<{ plans: { planId: string; title: string; currentRevisionId: string | null; updatedAt: string }[] }>('lesson.list'),
  lessonGet: (planId: string) => call<{ plan: unknown; contentOrigin: string; valid: boolean; revisionId: string }>('lesson.get', { payload: { planId } }),
  reviewRun: (planId: string, revisionId?: string) =>
    call<{ report: ReviewReport }>('review.run', {
      payload: revisionId ? { planId, revisionId } : { planId }
    }),
  changePreview: (planId: string, baseRevisionId: string, change: LessonChange) =>
    call<{ preview: ChangePreview }>('change.preview', { payload: { planId, baseRevisionId, change } }),
  changeApply: (planId: string, baseRevisionId: string, change: LessonChange, idempotencyKey: string) =>
    call<{ result: LessonChangeApplyResult }>('change.apply', {
      idempotency_key: idempotencyKey,
      payload: { planId, baseRevisionId, change }
    }),
  changeHistory: (planId: string) =>
    call<{ revisions: unknown[]; proposals: unknown[]; bundles: unknown[] }>('change.history', { payload: { planId } }),
  materialsGenerate: (planId: string) =>
    call<{ planId: string; revisionId: string; contentOrigin: string; versionStamp: string; files: { role: string; format: string; filename: string; path: string; sha256: string; byteSize: number }[] }>('materials.generate', { payload: { planId } }),
  materialsList: (planId: string) => call<{ artifacts: { role: string; format: string; filename: string; path: string; sha256: string; byteSize: number; revisionId: string; contentOrigin: string }[] }>('materials.list', { payload: { planId } }),
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
