// 平台判定（F07）：区分三种含义，不混同——
//  - supported：当前进程「可运行」（正式目标平台 / 其它可运行 Windows / 显式开发放行）；
//  - targetSupported：正式目标平台支持（首版为 Windows 11 x64）；
//  - isDevOverride：仅因显式开发放行而可运行（非正式支持）。
// 不支持系统给中文说明并安全退出（INS-006）。开发放行在打包版本中必须失效。

export interface PlatformSupport {
  supported: boolean;
  targetSupported: boolean;
  isDevOverride: boolean;
  reason_zh: string;
}

export interface EvaluateOptions {
  // 是否允许 YUWENDESK_DEV_ALLOW_PLATFORM 放行（仅未打包开发环境为 true）。
  allowDevOverride?: boolean;
  // Windows 版本判定用的 os.release()，形如 "10.0.22631"。
  osRelease?: string;
}

// Windows 11 的内核版本仍是 10.0，但 build ≥ 22000。
function isWindows11(osRelease: string | undefined): boolean {
  if (!osRelease) return false;
  const parts = osRelease.split('.');
  const build = Number(parts[2]);
  return Number.isFinite(build) && build >= 22000;
}

export function evaluatePlatform(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: EvaluateOptions = {}
): PlatformSupport {
  const allowDevOverride = opts.allowDevOverride ?? true;

  if (platform === 'win32' && arch === 'x64') {
    if (isWindows11(opts.osRelease)) {
      return {
        supported: true,
        targetSupported: true,
        isDevOverride: false,
        reason_zh: '受支持的正式目标平台：Windows 11 x64。'
      };
    }
    // 其它 Windows x64（Win10/Server 或版本不可判定）：可运行，但非正式目标平台，须显式区分。
    return {
      supported: true,
      targetSupported: false,
      isDevOverride: false,
      reason_zh:
        '当前为 Windows x64，但未确认是正式目标平台 Windows 11。可运行用于工程验证，' +
        '正式安装验收仅在 Windows 11 x64 标准账户上进行。'
    };
  }

  if (allowDevOverride && env.YUWENDESK_DEV_ALLOW_PLATFORM === '1') {
    return {
      supported: true,
      targetSupported: false,
      isDevOverride: true,
      reason_zh: '开发验证模式：当前系统仅用于工程验证 UI/IPC 冒烟，不作为正式发布平台承诺。'
    };
  }

  return {
    supported: false,
    targetSupported: false,
    isDevOverride: false,
    reason_zh:
      '当前系统或架构暂不受支持。语文备课工作台首个版本按 Windows 11 x64 设计。' +
      '请在受支持的 Windows 电脑上安装；已安全退出，未做任何更改。'
  };
}

export function isSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  opts: EvaluateOptions = {}
): boolean {
  return evaluatePlatform(platform, arch, env, opts).supported;
}
