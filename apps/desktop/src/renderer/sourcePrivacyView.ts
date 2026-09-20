export interface SourceDeleteSummaryInput {
  databaseDeleted: boolean;
  managedBackupDeletedIds: string[];
  managedBackupRemainingIds: string[];
  postDeleteBackupId: string | null;
  externalOrOfflineBackups: string;
  ssdPhysicalErasure: string;
  [key: string]: unknown;
}

export interface SourceDeleteSummary {
  database: string;
  managedBackups: string;
  postDeleteBackup: string;
  externalBackups: string;
  physicalErasure: string;
}

export function buildSourceDeleteSummary(input: SourceDeleteSummaryInput): SourceDeleteSummary {
  const deleted = input.managedBackupDeletedIds.length ? input.managedBackupDeletedIds.join('、') : '无';
  const remaining = input.managedBackupRemainingIds.length ? input.managedBackupRemainingIds.join('、') : '无';
  return {
    database: input.databaseDeleted ? '本机当前数据库已删除该资料及其本机派生缓存。' : '本机当前数据库未完成删除。',
    managedBackups: `已删除的应用受管备份（含确认时无法检查但选择删除的恢复点）：${deleted}；仍保留或无法确认清除的应用受管备份：${remaining}。`,
    postDeleteBackup: input.postDeleteBackupId ? `已创建删除后的恢复点：${input.postDeleteBackupId}。` : '未创建删除后的恢复点。',
    externalBackups: '已导出的文件、离线副本或由他人持有的副本无法召回，本次操作不声称已删除它们。',
    physicalErasure: '应用级删除不保证 SSD 物理擦除；需要介质级销毁时应遵循设备管理制度。'
  };
}

export function sensitiveSourceNotice(): string {
  return '升级后，原件与正文只保留认证加密载荷，不会进入全文检索，也不会发送给模型。为防止明文重新出现，学生敏感资料不可降级为普通资料。';
}
