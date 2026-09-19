import type { Session } from 'electron';

// 生产安全边界工具。纯函数便于单元测试；副作用函数集中在此，主进程统一调用。

function stripFragmentAndQuery(url: string): string {
  return url.split('#')[0].split('?')[0];
}

// 判定渲染进程当前 URL 是否为受信任来源：
// - 生产：必须严格等于本地打包的 index.html 的 file:// URL；
// - 开发：仅当 allowDev=true 且严格匹配开发服务器来源（防止 http://host.evil 前缀伪造）。
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
    const dev = stripFragmentAndQuery(devServerUrl);
    if (base === dev) return true;
    if (base.startsWith(dev + '/')) return true;
  }
  return false;
}

// 拒绝渲染进程发起的一切权限请求（摄像头、麦克风、地理位置、通知等）：
// 首版桌面备课应用不需要这些权限（S05 安全清单）。
export function lockdownSession(session: Session): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // 禁止渲染进程发起任何网络请求；对外网络仅由主进程在受控出口进行（生产不含本地监听）。
  // 允许加载本地打包资源（file:）与开发服务器（devtools 场景），其余一律拦截。
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('http://127.0.0.1:') ||
      url.startsWith('http://localhost:') ||
      url.startsWith('ws://127.0.0.1:') ||
      url.startsWith('ws://localhost:') ||
      url.startsWith('blob:') ||
      url.startsWith('data:');
    callback({ cancel: !allowed });
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
