import { describe, expect, it } from 'vitest';
import { evaluatePlatform, isSupportedPlatform } from '../src/main/platform';

describe('平台判定（F07：区分可运行/正式目标/开发放行）', () => {
  it('Windows 11 工作站（ProductType=1 且 build≥22000）为正式目标平台', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { osRelease: '10.0.22631', productType: 1 });
    expect(r.supported).toBe(true);
    expect(r.targetSupported).toBe(true);
    expect(r.isDevOverride).toBe(false);
  });

  it('Windows 10 工作站（build<22000）可运行但非正式目标平台', () => {
    const r = evaluatePlatform('win32', 'x64', {}, { osRelease: '10.0.19045', productType: 1 });
    expect(r.supported).toBe(true);
    expect(r.targetSupported).toBe(false);
  });

  it('Windows arm64 首版不承诺', () => {
    expect(isSupportedPlatform('win32', 'arm64', {})).toBe(false);
  });

  it('非 Windows 默认不受支持并给出中文说明', () => {
    const r = evaluatePlatform('linux', 'x64', {});
    expect(r.supported).toBe(false);
    expect(r.targetSupported).toBe(false);
    expect(r.reason_zh).toContain('Windows');
  });

  it('开发放行仅在允许时生效（未打包）', () => {
    const r = evaluatePlatform('linux', 'x64', { YUWENDESK_DEV_ALLOW_PLATFORM: '1' }, { allowDevOverride: true });
    expect(r.supported).toBe(true);
    expect(r.isDevOverride).toBe(true);
    expect(r.targetSupported).toBe(false);
  });

  it('打包版本禁用开发放行：即使设了环境变量也不受支持（F07）', () => {
    const r = evaluatePlatform('linux', 'x64', { YUWENDESK_DEV_ALLOW_PLATFORM: '1' }, { allowDevOverride: false });
    expect(r.supported).toBe(false);
    expect(r.isDevOverride).toBe(false);
  });
});
