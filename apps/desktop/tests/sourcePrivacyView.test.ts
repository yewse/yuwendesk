import { describe, expect, it } from 'vitest';
import { buildSourceDeleteSummary, sensitiveSourceNotice } from '../src/renderer/sourcePrivacyView';

describe('G09 source privacy renderer copy', () => {
  it('renders database, managed backup, and external backup outcomes as separate facts', () => {
    const summary = buildSourceDeleteSummary({
      databaseDeleted: true,
      managedBackupDeletedIds: ['backup_1'],
      managedBackupRemainingIds: ['backup_2'],
      postDeleteBackupId: 'backup_after',
      externalOrOfflineBackups: 'not_recalled',
      ssdPhysicalErasure: 'not_guaranteed',
      path: 'C:\\private\\must-not-render',
      ciphertext: 'must-not-render'
    });
    expect(summary.database).toContain('本机当前数据库已删除');
    expect(summary.managedBackups).toContain('backup_1');
    expect(summary.managedBackups).toContain('backup_2');
    expect(summary.postDeleteBackup).toContain('backup_after');
    expect(summary.externalBackups).toContain('无法召回');
    expect(summary.physicalErasure).toContain('不保证 SSD 物理擦除');
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(JSON.stringify(summary)).not.toContain('ciphertext');
  });

  it('states local encryption and model-dispatch privacy boundaries before reclassification', () => {
    const notice = sensitiveSourceNotice();
    expect(notice).toContain('认证加密');
    expect(notice).toContain('不会进入全文检索');
    expect(notice).toContain('不会发送给模型');
    expect(notice).toContain('不可降级');
  });
});
