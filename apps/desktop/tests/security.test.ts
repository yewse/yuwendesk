import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl } from '../src/main/security';

const EXPECTED = 'file:///opt/app/dist/renderer/index.html';
const DEV = 'http://127.0.0.1:5199';

describe('渲染来源可信判定（生产安全边界）', () => {
  it('生产：完全匹配本地打包 index.html', () => {
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

  it('生产：即使提供了开发服务器地址也不放行（allowDev=false）', () => {
    expect(isTrustedRendererUrl(DEV, EXPECTED, DEV, false)).toBe(false);
    expect(isTrustedRendererUrl(DEV + '/', EXPECTED, DEV, false)).toBe(false);
  });

  it('开发：仅当 allowDev=true 且严格前缀匹配开发服务器时放行', () => {
    expect(isTrustedRendererUrl(DEV + '/', EXPECTED, DEV, true)).toBe(true);
    expect(isTrustedRendererUrl(DEV + '/index.html', EXPECTED, DEV, true)).toBe(true);
    // 前缀伪造不得放行
    expect(isTrustedRendererUrl('http://127.0.0.1:5199.evil.com/', EXPECTED, DEV, true)).toBe(false);
  });
});
