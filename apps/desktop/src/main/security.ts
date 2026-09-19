import type { Session } from 'electron';

// 生产安全边界工具（F05）。纯函数便于单元测试；副作用函数集中在此，主进程统一调用。

function stripFragmentAndQuery(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// 判定渲染进程当前 URL 是否为受信任来源：
// - 生产：必须严格等于本地打包 index.html 的 file:// URL；
// - 开发：仅当 allowDev=true 且 origin 与开发服务器 **完全一致**（用 URL 解析，杜绝前缀伪造）。
export function isTrustedRendererUrl(
  currentUrl: string,
  expectedFileUrl: string,
  devServerUrl: string | undefined,
  allowDev: boolean
): boolean {
  if (!currentUrl) return false;
  const base = stripFragmentAndQuery(currentUrl);
  if (base === stripFragmentAndQuery(expectedFileUrl)) return true;
  if (allowDev && devServerUrl) {
    const cur = safeOrigin(currentUrl);
    const dev = safeOrigin(devServerUrl);
    if (cur !== null && dev !== null && cur === dev) return true;
  }
  return false;
}

// 外链策略：仅接受可规范化的 https 地址、含主机名、且不含内嵌凭据；其余拒绝。
// 由明确用户动作（window.open）触发时才交给系统浏览器。
export function isAllowedExternalUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (!u.hostname) return false;
  if (u.username || u.password) return false;
  return true;
}

export interface LockdownOptions {
  // 开发模式下允许的渲染来源 origin（如 http://127.0.0.1:5199）。生产为 undefined。
  devOrigin?: string;
}

// 拒绝渲染进程发起的一切权限请求（摄像头、麦克风、地理位置、通知等）。
// 网络：生产仅允许本地资源（file/devtools/data/blob）；开发额外仅放行精确匹配的开发 origin。
export function lockdownSession(session: Session, opts: LockdownOptions = {}): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  const devOrigin = opts.devOrigin ? safeOrigin(opts.devOrigin) : null;
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const localScheme =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:');
    if (localScheme) return callback({ cancel: false });
    // 仅开发模式放行精确匹配的开发服务器 origin（含其 ws/http 资源）。
    if (devOrigin) {
      const o = safeOrigin(url);
      if (o !== null && o === devOrigin) return callback({ cancel: false });
      // 允许 vite 的 HMR websocket（同 origin 的 ws://）。
      try {
        const u = new URL(url);
        if ((u.protocol === 'ws:' || u.protocol === 'wss:') && `http://${u.host}` === devOrigin) {
          return callback({ cancel: false });
        }
      } catch {
        /* fallthrough to cancel */
      }
    }
    return callback({ cancel: true });
  });
}

// 为本地页面注入内容安全策略响应头（与 index.html 的 meta 双重保障）。
export function attachCsp(session: Session): void {
  const CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    });
  });
}
