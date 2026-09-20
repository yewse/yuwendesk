// 平台判定（F07）：区分三种含义，不混同——
//  - supported：当前进程「可运行」（正式目标平台 / 其它可运行 Windows / 显式开发放行）；
//  - targetSupported：正式目标平台支持（首版为 Windows 11 x64 工作站）；
//  - isDevOverride：仅因显式开发放行而可运行（非正式支持）；
//  - identity：系统身份判定结果，信息不足时为 unknown，不冒称 Win11。
// 不支持系统给中文说明并安全退出（INS-006）。开发放行在打包版本中必须失效。
//
// 重要：Windows Server 2025 与 Windows 11 24H2 同为 build 26100，仅凭 build 号不能判定工作站身份，
// 必须结合 ProductType（Win32_OperatingSystem.ProductType：1=工作站，2=域控，3=服务器）。

export type PlatformIdentity =
  | 'win11'
  | 'windows-server'
  | 'windows-domain-controller'
  | 'windows-other'
  | 'windows-unknown'
  | 'dev-override'
  | 'unsupported';

export interface PlatformSupport {
  supported: boolean;
  targetSupported: boolean;
  isDevOverride: boolean;
  identity: PlatformIdentity;
  reason_zh: string;
}

export interface EvaluateOptions {
  // 是否允许 YUWENDESK_DEV_ALLOW_PLATFORM 放行（仅未打包开发环境为 true）。
  allowDevOverride?: boolean;
  // Windows 版本判定用的 os.release()，形如 "10.0.22631"。
  osRelease?: string;
  // Win32_OperatingSystem.ProductType：1=工作站，2=域控，3=服务器；未知则 undefined。
  productType?: number;
}

// build ≥ 22000 是 Windows 11 的必要条件，但不充分（Server 2025 也 ≥ 22000）。
function buildAtLeast(osRelease: string | undefined, min: number): boolean {
  if (!osRelease) return false;
  const build = Number(osRelease.split('.')[2]);
  return Number.isFinite(build) && build >= min;
}

export function evaluatePlatform(
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: EvaluateOptions = {}
): PlatformSupport {
  const allowDevOverride = opts.allowDevOverride ?? true;

  if (platform === 'win32' && arch === 'x64') {
    const pt = opts.productType;
    const win11Build = buildAtLeast(opts.osRelease, 22000);
    if (pt === 3) {
      return {
        supported: true,
        targetSupported: false,
        isDevOverride: false,
        identity: 'windows-server',
        reason_zh: '检测到 Windows Server。可运行用于工程验证，但非正式目标平台（Windows 11 工作站）。'
      };
    }
    if (pt === 2) {
      return {
        supported: true,
        targetSupported: false,
        isDevOverride: false,
        identity: 'windows-domain-controller',
        reason_zh: '检测到 Windows 域控制器，非正式目标平台。'
      };
    }
    if (pt === 1 && win11Build) {
      return {
        supported: true,
        targetSupported: true,
        isDevOverride: false,
        identity: 'win11',
        reason_zh: '受支持的正式目标平台：Windows 11 x64 工作站。'
      };
    }
    if (pt === 1 && !win11Build) {
      return {
        supported: true,
        targetSupported: false,
        isDevOverride: false,
        identity: 'windows-other',
        reason_zh: '检测到较旧的 Windows 工作站（低于 Windows 11）。可运行用于工程验证，正式验收仅在 Windows 11。'
      };
    }
    // ProductType 未知：仅凭 build 号不能判定工作站/服务器身份，不冒称 Win11。
    return {
      supported: true,
      targetSupported: false,
      isDevOverride: false,
      identity: 'windows-unknown',
      reason_zh:
        '无法确认 Windows 系统身份（工作站/服务器）。可运行用于工程验证；正式 Windows 11 验收需在应用内确认系统身份后进行。'
    };
  }

  if (allowDevOverride && env.YUWENDESK_DEV_ALLOW_PLATFORM === '1') {
    return {
      supported: true,
      targetSupported: false,
      isDevOverride: true,
      identity: 'dev-override',
      reason_zh: '开发验证模式：当前系统仅用于工程验证 UI/IPC 冒烟，不作为正式发布平台承诺。'
    };
  }

  return {
    supported: false,
    targetSupported: false,
    isDevOverride: false,
    identity: 'unsupported',
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
