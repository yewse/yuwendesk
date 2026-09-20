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
