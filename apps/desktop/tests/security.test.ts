import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isTrustedRendererUrl } from '../src/main/security';

const EXPECTED = 'file:///opt/app/dist/renderer/index.html';
const DEV = 'http://127.0.0.1:5199';

describe('渲染来源可信判定（F05 生产安全边界）', () => {
  it('生产：完全匹配本地打包 index.html（允许 hash/query）', () => {
    expect(isTrustedRendererUrl(EXPECTED, EXPECTED, undefined, false)).toBe(true);
    expect(isTrustedRendererUrl(EXPECTED + '#/home', EXPECTED, undefined, false)).toBe(true);
    expect(isTrustedRendererUrl(EXPECTED + '?x=1', EXPECTED, undefined, false)).toBe(true);
  });

  it('生产：拒绝任何非本地 index.html 的来源', () => {
    expect(isTrustedRendererUrl('https://evil.example/index.html', EXPECTED, undefined, false)).toBe(false);
    expect(isTrustedRendererUrl('file:///opt/app/dist/renderer/other.html', EXPECTED, undefined, false)).toBe(false);
    expect(isTrustedRendererUrl('file:///etc/passwd', EXPECTED, undefined, false)).toBe(false);
    expect(isTrustedRendererUrl('', EXPECTED, undefined, false)).toBe(false);
  });

  it('生产：即使提供开发地址也不放行（allowDev=false）', () => {
    expect(isTrustedRendererUrl(DEV, EXPECTED, DEV, false)).toBe(false);
    expect(isTrustedRendererUrl(DEV + '/', EXPECTED, DEV, false)).toBe(false);
  });

  it('开发：仅当 origin 与开发服务器完全一致时放行（URL 解析而非前缀）', () => {
    expect(isTrustedRendererUrl(DEV + '/', EXPECTED, DEV, true)).toBe(true);
    expect(isTrustedRendererUrl(DEV + '/index.html', EXPECTED, DEV, true)).toBe(true);
    // 前缀伪造不同 origin，必须拒绝
    expect(isTrustedRendererUrl('http://127.0.0.1:5199.evil.com/', EXPECTED, DEV, true)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:6000/', EXPECTED, DEV, true)).toBe(false);
  });
});

describe('外链策略（F05：规范化 https，拒绝非法/带凭据/非 https）', () => {
  it('接受正常 https', () => {
    expect(isAllowedExternalUrl('https://docs.x.ai/')).toBe(true);
  });
  it('拒绝非 https / 含内嵌凭据 / 非法 URL', () => {
    expect(isAllowedExternalUrl('http://example.com/')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('https://user:pass@example.com/')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });
});
