import type { UpdateSummary } from '../main/update/types';

export interface UpdateSummaryRow {
  label: string;
  value: string;
}

export function updateTrustNotice(trustConfigured: boolean): string {
  return trustConfigured
    ? '只接受当前安装版本内置可信发布身份签名的离线更新包。'
    : '尚未配置可信发布身份，离线更新验证被阻止；当前版本不提供绕过验证的按钮。';
}

export function updateReadyNotice(): string {
  return '更新已验证并暂存，未安装；应用不会自动关闭或重启。';
}

export function canStageUpdate(input: { trustConfigured: boolean; confirmationToken: string | null; busy: boolean }): boolean {
  return input.trustConfigured && !!input.confirmationToken && !input.busy;
}

export function buildUpdateSummaryRows<T extends UpdateSummary>(summary: T): UpdateSummaryRow[] {
  return [
    { label: '当前版本', value: summary.currentVersion },
    { label: '目标版本', value: summary.targetVersion },
    { label: '发布标识', value: summary.releaseId },
    { label: '包大小', value: `${summary.packageBytes} B` },
    { label: '包摘要', value: summary.packageSha256 },
    { label: '清单摘要', value: summary.manifestSha256 },
    { label: '清单时间', value: summary.createdAt }
  ];
}

export function downgradeProtectionNotice(reason: string | null): string {
  if (reason?.startsWith('schema_newer:') || reason?.startsWith('data_generation_newer:')) {
    return '旧版未覆盖新数据：当前数据由更高版本写入，已保持只读保护并保留原副本。请使用受支持的新版本导出，或按支持流程恢复；系统不会回灌数据库，旧程序二进制回退仍需签名安装器和 Windows 验证。';
  }
  return '升级迁移只在旁路副本验证后切换；发生不兼容时保留数据副本，并通过受支持的导出或恢复流程处理。';
}
