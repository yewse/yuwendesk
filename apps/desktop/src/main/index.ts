import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMPLEMENTED_OPERATIONS } from '../shared/ipc';
import { IpcService } from './ipc';
import { evaluatePlatform } from './platform';
import { LocalStore } from './store';

const APP_NAME_ZH = '语文备课工作台';

// 固定 userData 目录名，保证升级中标识一致（appId 在 electron-builder.yml 固定为 org.yuwendesk.app）。
app.setName('YuwenDesk');

let mainWindow: BrowserWindow | null = null;
let store: LocalStore;
let ipcService: IpcService;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_SERVER_URL;

function rendererIndexPath(): string {
  // 生产环境从本地打包静态资源加载，不使用任何开发服务器或本地监听端口。
  return join(__dirname, '..', 'renderer', 'index.html');
}

function isTrustedSender(contents: WebContents): boolean {
  if (!mainWindow || contents.id !== mainWindow.webContents.id) return false;
  const url = contents.getURL();
  if (isDev && DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return true;
  const expected = pathToFileURL(rendererIndexPath()).toString();
  // file:// 加载时允许带 hash/query。
  return url.split('#')[0].split('?')[0] === expected.split('#')[0];
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
      webviewTag: false
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  for (const op of IMPLEMENTED_OPERATIONS) {
    ipcMain.handle(`yuwen:${op}`, async (event: IpcMainInvokeEvent, request: unknown) => {
      // 逐调用校验发送者身份：仅接受本应用主窗口的受信任 frame。
      if (!isTrustedSender(event.sender)) {
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

  store = new LocalStore(app.getPath('userData'));
  await store.load();

  ipcService = new IpcService({
    store,
    appVersion: app.getVersion(),
    appNameZh: APP_NAME_ZH,
    platformSupported: platform.supported,
    httpListeners: 0,
    online: false
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
