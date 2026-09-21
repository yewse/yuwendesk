import { describe, expect, it } from 'vitest';
import { buildBackupRows, portableBackupNotice, restorePreviewNotice, storageProtectionNotice } from '../src/renderer/protectionView';

describe('G09 protection renderer copy', () => {
  it('distinguishes verified restore points from invalid entries and exposes no local path', () => {
    expect(buildBackupRows([{
      backupId: 'b1', createdAt: '2026-09-20T10:00:00.000Z', valid: true,
      retention: ['daily', 'weekly'], byteSize: 2048, path: 'C:\\private\\backup.ready'
    }])).toEqual([{
      backupId: 'b1', createdAt: '2026-09-20T10:00:00.000Z',
      statusLabel: '已验证可恢复', retentionLabel: '日备份 · 周备份', sizeLabel: '2.0 KB'
    }]);
  });

  it('states password and API-key limits before export and restore', () => {
    expect(portableBackupNotice()).toContain('忘记口令无法找回');
    const notice = restorePreviewNotice({ backupId: 'b1', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 10, apiReconnectRequired: true });
    expect(notice).toContain('API');
    expect(notice).toContain('重启');
  });

  it('tells a teacher that protected storage blocks AI and points to verified backup recovery', () => {
    const notice = storageProtectionNotice('other');
    expect(notice).toContain('AI');
    expect(notice).toContain('本机备份');
    expect(notice).toContain('恢复');
  });
});
