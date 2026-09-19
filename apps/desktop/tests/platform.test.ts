import { describe, expect, it } from 'vitest';
import { evaluatePlatform, isSupportedPlatform } from '../src/main/platform';

describe('平台支持判定（INS-006）', () => {
  it('Windows x64 受支持', () => {
    const r = evaluatePlatform('win32', 'x64', {});
    expect(r.supported).toBe(true);
    expect(r.isDevOverride).toBe(false);
  });

  it('Windows arm64 首版不承诺', () => {
    expect(isSupportedPlatform('win32', 'arm64', {})).toBe(false);
  });

  it('非 Windows 默认不受支持并给出中文说明', () => {
    const r = evaluatePlatform('linux', 'x64', {});
    expect(r.supported).toBe(false);
    expect(r.reason_zh).toContain('Windows');
  });

  it('显式开发放行仅用于工程验证', () => {
    const r = evaluatePlatform('linux', 'x64', { YUWENDESK_DEV_ALLOW_PLATFORM: '1' });
    expect(r.supported).toBe(true);
    expect(r.isDevOverride).toBe(true);
  });
});
