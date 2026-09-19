// 平台支持判定（对应 INS-006：不支持的系统给中文说明并安全退出，不假装安装成功）。
// 首版按 Windows 11 x64 设计；其他平台默认不承诺。
// 为便于在开发/CI 环境（如 Linux、macOS）进行工程验证，允许通过显式环境变量放行开发运行，
// 但该放行仅用于开发验证，不改变对教师正式发布的平台承诺。

export interface PlatformSupport {
  supported: boolean;
  reason_zh: string;
  isDevOverride: boolean;
}

export function evaluatePlatform(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv = process.env
): PlatformSupport {
  const isWin64 = platform === 'win32' && (arch === 'x64');
  if (isWin64) {
    return { supported: true, reason_zh: '受支持的系统：Windows x64。', isDevOverride: false };
  }

  const devOverride = env.YUWENDESK_DEV_ALLOW_PLATFORM === '1';
  if (devOverride) {
    return {
      supported: true,
      reason_zh: '开发验证模式：当前系统仅用于工程验证，不作为正式发布平台承诺。',
      isDevOverride: true
    };
  }

  return {
    supported: false,
    reason_zh:
      '当前系统或架构暂不受支持。语文备课工作台首个版本按 Windows 11 x64 设计。' +
      '请在受支持的 Windows 电脑上安装；已安全退出，未做任何更改。',
    isDevOverride: false
  };
}

export function isSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return evaluatePlatform(platform, arch, env).supported;
}
