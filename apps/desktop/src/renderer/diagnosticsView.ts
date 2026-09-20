import type { DiagnosticsPreview } from '../main/protection/diagnostics';

export function diagnosticsPreviewText(preview: DiagnosticsPreview): string {
  return JSON.stringify(preview, null, 2);
}

export function diagnosticsScopeNotice(): string {
  return '诊断包会在保存前完整预览；不包含资料正文、学生作答、文件名、本地路径、API 密钥、提示词或模型完整输入输出，也不会自动上传。';
}

export function diagnosticsSaveEnabled(
  displayedPreviewHash: string | null,
  reviewedPreviewHash: string | null,
  busy: boolean
): boolean {
  return !busy && typeof displayedPreviewHash === 'string' && displayedPreviewHash.length === 64 &&
    displayedPreviewHash === reviewedPreviewHash;
}
