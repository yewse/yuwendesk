import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMPLEMENTED_OPERATIONS } from '../shared/ipc';
import { IpcService } from './ipc';
import { CloseController } from './lifecycle';
import { evaluatePlatform } from './platform';
import { createWorkerParser } from './sources/parseHost';
import { ModelService } from './model/service';
import { attachCsp, isAllowedExternalUrl, isTrustedRendererUrl, lockdownSession } from './security';
import { SqliteStore } from './db/sqliteStore';

const APP_NAME_ZH = '语文备课工作台';

// 固定 userData 目录名，保证升级中标识一致（appId 在 electron-builder.yml 固定为 org.yuwendesk.app）。
app.setName('YuwenDesk');

let mainWindow: BrowserWindow | null = null;
let store: SqliteStore;
let ipcService: IpcService;
let closeController: CloseController | null = null;

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

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false;
  // 缺少 frame 身份依据时拒绝；仅接受主窗口顶层 frame（拒绝任何子 frame/注入 iframe）。
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  const expected = pathToFileURL(rendererIndexPath()).toString();
  // 以实际发送 frame 的 URL 为准做精确来源校验。
  return isTrustedRendererUrl(frame.url, expected, DEV_SERVER_URL, isDev);
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

  // 禁止渲染进程打开任意窗口/导航到外部页面；外链仅在通过规范化 https 策略时交由系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (url !== current) event.preventDefault();
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
    mainWindow = null;
    closeController = null;
  });
}

function registerIpc(): void {
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.handle(`yuwen:${op}`, async (event: IpcMainInvokeEvent, request: unknown) => {
      // 逐调用校验发送者身份：仅接受本应用主窗口的受信任顶层 frame。
      if (!isTrustedSender(event)) {
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

  // 注入 Electron safeStorage 用于凭据/敏感 payload 保护（不可用时拒绝落明文，见 T03）。
  store = new SqliteStore(app.getPath('userData'), {
    safeStorage,
    // 耗时原始文件解析放到 worker 线程，避免阻塞主进程。
    parseFile: createWorkerParser(join(__dirname, 'sources', 'parseWorker.js'))
  });
  await store.load();

  const modelService = new ModelService(store);
  ipcService = new IpcService({
    store,
    sourceStore: store,
    modelService,
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

  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox(APP_NAME_ZH, `启动失败：${String(err)}`);
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
