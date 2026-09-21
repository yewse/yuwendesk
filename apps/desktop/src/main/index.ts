import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import Database from 'better-sqlite3';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMPLEMENTED_OPERATIONS } from '../shared/ipc';
import { IpcService } from './ipc';
import { CloseController } from './lifecycle';
import { evaluatePlatform } from './platform';
import { createWorkerParser } from './sources/parseHost';
import { ModelService } from './model/service';
import { FeedbackService } from './feedback/service';
import {
  attachCsp,
  isAllowedExternalUrl,
  isAllowedInWindowNavigation,
  isTrustedIpcSender,
  lockdownSession
} from './security';
import {
  migrateSqliteDatabaseToTarget,
  SqliteStore,
  SQLITE_DATA_GENERATION,
  SQLITE_SCHEMA_TARGET
} from './db/sqliteStore';
import { BackupCoordinator, BackupService } from './protection/backup';
import { ProtectionService } from './protection/service';
import { applyPendingRestoreBeforeOpen } from './protection/restore';
import { SourcePrivacyService } from './protection/sourcePrivacy';
import { DiagnosticsService } from './protection/diagnostics';
import { UpdateService } from './update/service';
import { trustedUpdateKeys } from './update/trust';
import { DatabaseMigrationCoordinator } from './update/migration';
import { exportPreparedMaterials, PreparationService } from './preparation/service';
import { isBoundPresentationRequest, PresentationService, PresentationWindowRegistry } from './presentation/service';

const APP_NAME_ZH = '语文备课工作台';

// 固定 userData 目录名，保证升级中标识一致（appId 在 electron-builder.yml 固定为 org.yuwendesk.app）。
app.setName('YuwenDesk');

let mainWindow: BrowserWindow | null = null;
let store: SqliteStore;
let ipcService: IpcService;
let closeController: CloseController | null = null;
const presentationWindows = new PresentationWindowRegistry<BrowserWindow>();
const presentationWindowIds = new Set<number>();
const presentationSessions = new Map<number, string>();
let mainWindowOwnerId: string | null = null;

// 仅在未打包（开发）且显式提供开发服务器地址时才进入开发模式；打包后一律走本地静态资源。
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !app.isPackaged && !!DEV_SERVER_URL;
// OS 级沙箱是否启用（容器内开发验证会以 --no-sandbox 启动，此时如实标记为未沙箱）。
const sandboxDisabled =
  process.argv.includes('--no-sandbox') || app.commandLine.hasSwitch('no-sandbox');

function rendererIndexPath(): string {
  // 生产环境从本地打包静态资源加载，不使用任何开发服务器或本地监听端口。
  return join(__dirname, '..', 'renderer', 'index.html');
}

// 受控读取 Windows 系统身份（Win32_OperatingSystem.ProductType：1=工作站/2=域控/3=服务器）。
// 仅应用内部执行，不要求教师打开命令行；非 Windows 或探测失败返回 undefined（判为 unknown，不冒称 Win11）。
function detectWindowsProductType(): number | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).ProductType'],
      { timeout: 4000, windowsHide: true, encoding: 'utf-8' }
    );
    const n = Number(String(out).trim());
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, operation?: string): boolean {
  if (!mainWindow) return false;
  const fromMain = event.sender.id === mainWindow.webContents.id;
  const fromPresentation = presentationWindowIds.has(event.sender.id);
  if (!fromMain && !(fromPresentation && ['presentation.get', 'presentation.close'].includes(operation ?? ''))) return false;
  const expected = pathToFileURL(rendererIndexPath()).toString();
  return isTrustedIpcSender({
    senderId: event.sender.id,
    mainWindowId: event.sender.id,
    senderFrame: event.senderFrame,
    mainFrame: event.sender.mainFrame,
    expectedFileUrl: expected,
    devServerUrl: DEV_SERVER_URL,
    allowDev: isDev
  });
}

function openPresentationWindow(sessionId: string): { opened: true; reused: boolean } {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('main_window_unavailable');
  const ownerId = String(mainWindow.webContents.id);
  const result = presentationWindows.open(ownerId, sessionId, () => {
    const window = new BrowserWindow({
      parent: mainWindow ?? undefined,
      width: 1180,
      height: 760,
      minWidth: 800,
      minHeight: 560,
      show: false,
      backgroundColor: '#171512',
      title: `${APP_NAME_ZH} · 课堂展示`,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webviewTag: false,
        devTools: isDev
      }
    });
    presentationWindowIds.add(window.webContents.id);
    presentationSessions.set(window.webContents.id, sessionId);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedInWindowNavigation(url, window.webContents.getURL())) event.preventDefault();
    });
    window.once('ready-to-show', () => window.show());
    window.once('closed', () => {
      presentationWindowIds.delete(window.webContents.id);
      presentationSessions.delete(window.webContents.id);
    });
    if (isDev && DEV_SERVER_URL) {
      const url = new URL(DEV_SERVER_URL);
      url.searchParams.set('presentationSession', sessionId);
      void window.loadURL(url.toString());
    } else {
      void window.loadFile(rendererIndexPath(), { query: { presentationSession: sessionId } });
    }
    return window;
  });
  return { opened: true, reused: result.reused };
}

function createWindow(): void {
  const win = store.getWindow();
  mainWindow = new BrowserWindow({
    width: win.width,
    height: win.height,
    x: win.x,
    y: win.y,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f3ee',
    title: APP_NAME_ZH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      // 生产环境禁用开发者工具，降低被注入内容打开调试面板的面。
      devTools: isDev
    }
  });
  mainWindowOwnerId = String(mainWindow.webContents.id);

  // 禁止渲染进程打开任意窗口/导航到外部页面；外链仅在通过规范化 https 策略时交由系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (!isAllowedInWindowNavigation(url, current)) event.preventDefault();
  });

  if (isDev && DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(rendererIndexPath());
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    // 保护态或写盘失败时，窗口几何保存不得覆盖源文件、也不得因未捕获异常导致退出（R3-02/03）。
    void store.saveWindow({ width: b.width, height: b.height, x: b.x, y: b.y }).catch(() => undefined);
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);

  // 关闭前刷新保存（规范 3.3「窗口关闭前自动保存」）：由 CloseController 协调——
  // 请求渲染层落盘、只接受本次握手的成功回执、失败或超时询问用户而非静默丢弃。
  closeController = new CloseController({
    requestFlush: (requestId) => {
      mainWindow?.webContents.send('yuwen:before-close', requestId);
    },
    closeWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    },
    confirmForceQuit: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return true;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['继续编辑', '仍要退出'],
        defaultId: 0,
        cancelId: 0,
        title: APP_NAME_ZH,
        message: '有未保存的修改尚未成功保存。',
        detail: '选择“继续编辑”可返回修改并重试保存；“仍要退出”将放弃尚未保存的修改。'
      });
      return response === 1;
    },
    timeoutMs: 10000
  });

  mainWindow.on('close', (event) => {
    if (closeController && !closeController.onClose()) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    if (mainWindowOwnerId) presentationWindows.close(mainWindowOwnerId);
    mainWindow = null;
    mainWindowOwnerId = null;
    closeController = null;
  });
}

function registerIpc(): void {
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.handle(`yuwen:${op}`, async (event: IpcMainInvokeEvent, request: unknown) => {
      // 逐调用校验发送者身份：仅接受本应用主窗口的受信任顶层 frame。
      if (!isTrustedSender(event, op)) {
        return {
          ok: false,
          error: {
            code: 'INPUT_INVALID',
            message_zh: '拒绝了来自未授权来源的请求。',
            retryable: false,
            next_action: '请通过应用界面重新操作。'
          }
        };
      }
      if (op === 'presentation.get' && presentationWindowIds.has(event.sender.id)) {
        const requested = (request as { payload?: { sessionId?: unknown } } | null)?.payload?.sessionId;
        if (!isBoundPresentationRequest(presentationSessions, event.sender.id, op, requested)) {
          return {
            ok: false,
            error: {
              code: 'INPUT_INVALID',
              message_zh: '课堂展示请求与当前受限窗口不一致。',
              retryable: false,
              next_action: '请关闭展示并从当前备课会话重新打开。'
            }
          };
        }
      }
      return ipcService.handle(op, request);
    });
  }

  // 关闭握手回执（带 requestId 与保存结果）；校验发送者，路由到关闭协调器。
  ipcMain.on('yuwen:flush-done', (event: IpcMainEvent, requestId: unknown, saved: unknown) => {
    if (!isTrustedSender(event)) return;
    if (typeof requestId !== 'string') return;
    void closeController?.onFlushResult(requestId, saved === true);
  });
}

async function bootstrap(): Promise<void> {
  // 平台判定：打包版本禁用开发放行（allowDevOverride=false）；用 os.release() 判定 Win11。
  const platform = evaluatePlatform(process.platform, process.arch, process.env, {
    allowDevOverride: !app.isPackaged,
    osRelease: release(),
    productType: detectWindowsProductType()
  });
  if (!platform.supported) {
    // 不支持的系统：给中文说明并安全退出，不做任何安装/更改（INS-006）。
    dialog.showErrorBox(APP_NAME_ZH, platform.reason_zh);
    app.exit(0);
    return;
  }

  // 生产安全边界：拒绝一切渲染进程权限请求、按模式拦截网络请求、注入 CSP 响应头。
  const { session, safeStorage } = await import('electron');
  lockdownSession(session.defaultSession, isDev ? { devOrigin: DEV_SERVER_URL } : {});
  attachCsp(session.defaultSession);

  if (!app.isPackaged && sandboxDisabled) {
    console.warn('[YuwenDesk] 开发验证模式：OS 沙箱已禁用（--no-sandbox）。正式发布包不得以该方式运行。');
  }

  const userDataDir = app.getPath('userData');
  const startupRestore = await applyPendingRestoreBeforeOpen(userDataDir, async (directory) => {
    let candidate: Database.Database | null = null;
    try {
      candidate = new Database(join(directory, 'yuwendesk.db'), { readonly: true });
      return candidate.pragma('integrity_check', { simple: true }) === 'ok' &&
        Number(candidate.pragma('user_version', { simple: true })) <= SQLITE_SCHEMA_TARGET;
    } catch {
      return false;
    } finally {
      candidate?.close();
    }
  });

  const migration = await new DatabaseMigrationCoordinator({
    userDataDir,
    // 旧数据没有可信的历史应用版本字段时明确记录 unknown，不据此虚构来源版本。
    sourceAppVersion: 'unknown',
    targetAppVersion: app.getVersion(),
    targetSchema: SQLITE_SCHEMA_TARGET,
    targetGeneration: SQLITE_DATA_GENERATION,
    migrateCandidate: (candidate) => {
      const current = Number(candidate.pragma('user_version', { simple: true }));
      migrateSqliteDatabaseToTarget(candidate, current, SQLITE_SCHEMA_TARGET);
    }
  }).run();
  if (migration.state === 'blocked') {
    console.warn(`[YuwenDesk] migration protected state: ${migration.code}`);
  }

  // 注入 Electron safeStorage 用于凭据/敏感 payload 保护（不可用时拒绝落明文，见 T03）。
  store = new SqliteStore(userDataDir, {
    safeStorage,
    supportedDataGeneration: SQLITE_DATA_GENERATION,
    startupProtectionReason: migration.state === 'blocked' ? 'migration_recovery_required' : undefined,
    // 既有数据库只能由上面的旁路协调器升级；全新数据库仍需创建当前 schema。
    allowInPlaceMigrations: migration.state === 'not_required' && migration.schema === 0,
    // 耗时原始文件解析放到 worker 线程，避免阻塞主进程。
    parseFile: createWorkerParser(join(__dirname, 'sources', 'parseWorker.js'))
  });
  await store.load();
  if (startupRestore.status === 'applied') {
    try {
      store.recordMaintenanceSuccess({ scope: 'restore', code: 'RESTORE_OK', at: new Date().toISOString() });
    } catch { /* restored data remains authoritative if maintenance metadata cannot be updated */ }
  } else if (startupRestore.status === 'rolled_back') {
    try {
      store.recordMaintenanceFailure({ scope: 'restore', code: 'RESTORE_ROLLED_BACK', at: new Date().toISOString() });
    } catch { /* rollback remains authoritative if maintenance metadata cannot be updated */ }
  }

  const modelService = new ModelService(store);
  const preparationService = new PreparationService({
    store,
    model: modelService,
    exportPlan: (planId) => exportPreparedMaterials(store, join(userDataDir, 'materials'), planId)
  });
  const presentationService = new PresentationService(store);
  const feedbackService = new FeedbackService(store, store, modelService);
  const backupService = new BackupService({ userDataDir, appVersion: app.getVersion(), store });
  const backupCoordinator = new BackupCoordinator(backupService, () => new Date(), store);
  const sourcePrivacyService = new SourcePrivacyService({
    store,
    backup: backupService,
    confirmDelete: async ({ documentId, expectedRevision, managedBackupIds }) => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const first = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '继续核对删除范围'], defaultId: 0, cancelId: 0,
        title: APP_NAME_ZH,
        message: '永久删除这份资料及其本机派生内容？',
        detail: `资料内部 ID：${documentId}\n当前状态修订号：${expectedRevision}\n此操作不可撤销；相关全文索引、模型缓存会清理，引用它的课时需重新核对来源。`
      });
      if (first.response !== 1) return null;
      const second = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['取消', '保留受管备份', '删除受管备份并建立删除后恢复点'],
        defaultId: 0,
        cancelId: 0,
        title: APP_NAME_ZH,
        message: '再次确认删除范围',
        detail: `含该资料或当前无法安全检查的应用受管备份：${managedBackupIds.length ? managedBackupIds.join('、') : '无'}\n无法检查的受管备份会保守纳入本次范围；已导出的文件和离线副本无法召回；应用级删除不保证 SSD 物理擦除。`
      });
      if (second.response === 1) return { policy: 'keep_managed' };
      if (second.response === 2) return { policy: 'delete_managed_and_create_post_delete' };
      return null;
    }
  });
  await sourcePrivacyService.reconcilePending();
  const protectionService = new ProtectionService({
    userDataDir,
    backup: backupService,
    idempotencyStore: store,
    safeStorage,
    choosePortableSavePath: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const selected = await dialog.showSaveDialog(mainWindow, {
        title: '导出跨机加密备份',
        defaultPath: `YuwenDesk-${new Date().toISOString().slice(0, 10)}.yuwenbackup`,
        filters: [{ name: '语文备课工作台加密备份', extensions: ['yuwenbackup'] }]
      });
      return selected.canceled ? null : selected.filePath;
    },
    choosePortableOpenPath: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: '选择跨机加密备份', properties: ['openFile'],
        filters: [{ name: '语文备课工作台加密备份', extensions: ['yuwenbackup'] }]
      });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
    confirmRestore: async (preview) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const selected = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '重启并恢复'], defaultId: 0, cancelId: 0,
        title: APP_NAME_ZH,
        message: '确认用已验证备份替换当前本机数据？',
        detail: `备份时间：${preview.createdAt}\n恢复成功后应用将重启。API 密钥不会迁移，需要重新连接 AI。当前数据会保留回滚副本。`
      });
      return selected.response === 1;
    },
    confirmDelete: async (backupId) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const selected = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['取消', '删除此备份'], defaultId: 0, cancelId: 0,
        title: APP_NAME_ZH,
        message: '确认删除这个本机恢复点？',
        detail: `备份 ID：${backupId}\n删除不会影响当前课程数据。`
      });
      return selected.response === 1;
    },
    relaunch: () => {
      setTimeout(() => { app.relaunch(); app.exit(0); }, 100);
    }
  });
  const diagnosticsService = new DiagnosticsService({
    appVersion: app.getVersion(),
    buildMode: app.isPackaged ? 'production' : 'development',
    platform: {
      targetSupported: platform.targetSupported,
      identity: platform.identity,
      sandboxEnabled: !sandboxDisabled
    },
    store,
    backups: backupService,
    chooseSavePath: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const selected = await dialog.showSaveDialog(mainWindow, {
        title: '保存最小诊断包',
        defaultPath: `YuwenDesk-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }]
      });
      return selected.canceled ? null : selected.filePath;
    }
  });
  const updateTrust = trustedUpdateKeys();
  const updateService = new UpdateService({
    userDataDir,
    currentVersion: app.getVersion(),
    appId: 'org.yuwendesk.app',
    platform: process.platform,
    arch: process.arch,
    trustedKeys: updateTrust.trustedKeys,
    chooseOfflinePath: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: '选择可信离线更新包',
        properties: ['openFile'],
        filters: [{ name: '语文备课工作台离线更新', extensions: ['yuwenupdate'] }]
      });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    }
  });
  ipcService = new IpcService({
    store,
    sourceStore: store,
    modelService,
    lessonStore: store,
    preparationStore: store,
    preparationService,
    presentationService,
    openPresentation: openPresentationWindow,
    closePresentation: () => mainWindow ? presentationWindows.close(String(mainWindow.webContents.id)) : false,
    feedbackStore: store,
    feedbackService,
    confirmObservationDelete: async ({ observationId }) => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['取消', '删除本机观察'],
        defaultId: 0,
        cancelId: 0,
        title: APP_NAME_ZH,
        message: '确认删除这条课堂观察？',
        detail: '本机观察正文和结果会删除，并保留不含正文的删除记录。外部或离线备份不在本次删除范围内。'
      });
      if (response !== 1) return null;
      return {
        token: `observation-delete_${observationId}_${randomUUID()}`,
        expiresAt: Date.now() + 2 * 60_000
      };
    },
    userDataDir,
    protectionService,
    sourcePrivacyService,
    diagnosticsService,
    updateService,
    noteSuccessfulWrite: (operation) => backupCoordinator.noteSuccessfulWrite(operation),
    appVersion: app.getVersion(),
    appNameZh: APP_NAME_ZH,
    platformSupported: platform.supported,
    httpListeners: 0,
    online: false,
    buildMode: app.isPackaged ? 'production' : 'development',
    sandboxEnabled: !sandboxDisabled,
    platformDevOverride: platform.isDevOverride,
    platformTargetSupported: platform.targetSupported,
    platformIdentity: platform.identity
  });

  registerIpc();
  createWindow();
}

// 单实例锁：第二次启动唤醒原窗口，不开启第二个写入进程（INS-003）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch(() => {
    dialog.showErrorBox(
      APP_NAME_ZH,
      '启动前的数据检查或恢复未能安全完成。应用已停止写入；请保留当前数据目录并使用已验证备份或受支持的恢复流程。'
    );
    app.exit(1);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && store) createWindow();
  });
}

app.on('window-all-closed', () => {
  // 退出后结束所有自有进程，不驻留后台。
  app.quit();
});
