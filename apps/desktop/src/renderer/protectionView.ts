export interface BackupRowInput {
  backupId: string;
  createdAt: string;
  valid: boolean;
  retention: string[];
  byteSize: number;
  path?: string;
}

export interface BackupRow {
  backupId: string;
  createdAt: string;
  statusLabel: string;
  retentionLabel: string;
  sizeLabel: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function buildBackupRows(backups: BackupRowInput[]): BackupRow[] {
  return backups.map((backup) => ({
    backupId: backup.backupId,
    createdAt: backup.createdAt,
    statusLabel: backup.valid ? '已验证可恢复' : '不可用',
    retentionLabel: backup.retention.map((tag) => tag === 'daily' ? '日备份' : tag === 'weekly' ? '周备份' : '未分类').join(' · '),
    sizeLabel: formatSize(backup.byteSize)
  }));
}

export function portableBackupNotice(): string {
  return '跨机备份使用强口令加密；忘记口令无法找回。API 密钥不会写入备份，恢复后需重新连接 AI。';
}

export function restorePreviewNotice(preview: { apiReconnectRequired: boolean }): string {
  return `恢复将在完整验证后通过重启切换数据。${preview.apiReconnectRequired ? 'API 密钥不会迁移，重启后需重新连接 AI。' : ''}`;
}

export function storageProtectionNotice(kind: 'none' | 'newer_data' | 'migration_recovery' | 'other'): string {
  if (kind === 'newer_data') return '本地数据来自更新版本，当前版本已停止写入。请先更新应用，不要继续配置 AI。';
  if (kind === 'migration_recovery') return '本地数据升级尚未安全完成，AI 和备课写入已暂停。请在“备份与恢复”中完成恢复。';
  return '本地数据库未能可靠读取，AI 和备课写入已暂停。请在“备份与恢复”中选择已验证本机备份并恢复。';
}

