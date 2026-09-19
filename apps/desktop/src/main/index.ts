import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMPLEMENTED_OPERATIONS } from '../shared/ipc';
import { IpcService } from './ipc';
import { evaluatePlatform } from './platform';
import { attachCsp, isTrustedRendererUrl, lockdownSession } from './security';
import { LocalStore } from './store';

const APP_NAME_ZH = '语文备课工作台';

// 固定 userData 目录名，保证升级中标识一致（appId 在 electron-builder.yml 固定为 org.yuwendesk.app）。
app.setName('YuwenDesk');

let mainWindow: BrowserWindow | null = null;
let store: LocalStore;
let ipcService: IpcService;

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

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return false;
  // 仅接受主窗口的顶层 frame，拒绝任何子 frame（若被注入 iframe）。
  const frame = event.senderFrame;
  if (frame && frame !== event.sender.mainFrame) return false;
  const expected = pathToFileURL(rendererIndexPath()).toString();
  return isTrustedRendererUrl(event.sender.getURL(), expected, DEV_SERVER_URL, isDev);
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

  // 禁止渲染进程打开任意窗口/导航到外部页面；外链交由系统浏览器（受控 HTTPS）。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
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
    void store.saveWindow({ width: b.width, height: b.height, x: b.x, y: b.y });
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);

  // 关闭前刷新保存（规范 3.3「窗口关闭前自动保存」）：先请求渲染层落盘未保存草稿，
  // 收到完成回执或超时后再真正关闭，避免防抖丢失最后一次编辑。
  let allowClose = false;
  mainWindow.on('close', (event) => {
    if (allowClose || !mainWindow) return;
    event.preventDefault();
    const finish = (): void => {
      allowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    };
    const timer = setTimeout(finish, 1500);
    ipcMain.once('yuwen:flush-done', (e: IpcMainEvent) => {
      if (!isTrustedSender(e)) return;
      clearTimeout(timer);
      finish();
    });
    mainWindow.webContents.send('yuwen:before-close');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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
}

async function bootstrap(): Promise<void> {
  const platform = evaluatePlatform(process.platform, process.arch);
  if (!platform.supported) {
    // 不支持的系统：给中文说明并安全退出，不做任何安装/更改（INS-006）。
    dialog.showErrorBox(APP_NAME_ZH, platform.reason_zh);
    app.exit(0);
    return;
  }

  // 生产安全边界：拒绝一切渲染进程权限请求、拦截非本地网络请求、注入 CSP 响应头。
  const { session } = await import('electron');
  lockdownSession(session.defaultSession);
  attachCsp(session.defaultSession);

  if (!app.isPackaged && sandboxDisabled) {
    console.warn('[YuwenDesk] 开发验证模式：OS 沙箱已禁用（--no-sandbox）。正式发布包不得以该方式运行。');
  }

  store = new LocalStore(app.getPath('userData'));
  await store.load();

  ipcService = new IpcService({
    store,
    appVersion: app.getVersion(),
    appNameZh: APP_NAME_ZH,
    platformSupported: platform.supported,
    httpListeners: 0,
    online: false,
    buildMode: app.isPackaged ? 'production' : 'development',
    sandboxEnabled: !sandboxDisabled,
    platformDevOverride: platform.isDevOverride
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
