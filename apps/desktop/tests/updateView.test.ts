import { describe, expect, it } from 'vitest';
import {
  buildUpdateSummaryRows,
  canStageUpdate,
  updateReadyNotice,
  updateTrustNotice
} from '../src/renderer/updateView';

describe('offline update renderer wording and controls', () => {
  it('states that an absent release trust identity blocks verification without a bypass', () => {
    const notice = updateTrustNotice(false);
    expect(notice).toContain('尚未配置可信发布身份');
    expect(notice).toContain('阻止');
    expect(canStageUpdate({ trustConfigured: false, confirmationToken: 'token', busy: false })).toBe(false);
  });

  it('distinguishes verified staging from installation and promises no automatic exit', () => {
    const notice = updateReadyNotice();
    expect(notice).toContain('已验证并暂存');
    expect(notice).toContain('未安装');
    expect(notice).toContain('不会自动关闭或重启');
  });

  it('formats only a safe manifest summary and omits path, signature, key and package bytes', () => {
    const rows = buildUpdateSummaryRows({
      releaseId: 'release-0.2.0', currentVersion: '0.1.0', targetVersion: '0.2.0',
      packageBytes: 2048, packageSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      createdAt: '2026-09-20T00:00:00.000Z', path: 'C:\\private\\update.yuwenupdate',
      signature: 'secret-signature', signingKey: 'secret-key', package: 'raw-package'
    });
    const text = JSON.stringify(rows);
    expect(text).toContain('0.1.0');
    expect(text).toContain('0.2.0');
    expect(text).not.toContain('private');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('raw-package');
  });
});
