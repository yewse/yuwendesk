# Windows 构建报告（工程测试包）

最近更新：2026-09-19（PR#1 二次审查续开发）

## 结论：Windows x64 未签名工程测试安装包构建成功（修复后重建）

- 命令：`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 --config electron-builder.yml`
- 本地构建主机：Linux（Cloud Agent）+ `wine 9.0`（授权构建环境内安装，供 NSIS 打包）。
- 产物：`apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe`
  - 文件类型：`PE32 executable (GUI) Intel 80386 ... Nullsoft Installer self-extracting archive`
  - 大小：111,322,686 字节
  - **SHA256（修复后新构建）：`3e6c1c03a465c57f64485e1ed8bcf381bb2fbbf3796cb7ed1fc88aba7664db85`**
  - 说明：与上一轮 `98ff155e…`（旧源码）不同，本包来自修复 F01–F08 后的源码；新修复=新来源=新哈希。

## 交付渠道现状（第 5 条证据线：可获得性）

- **Cloud Agent 工件渠道无法承载该 EXE**：实测该渠道约 100MB 上限（50MB/95MB 可存，111MB 写入被丢弃），因此无法把 EXE 作为可下载工件随附。
- 已新增 **CI 工件渠道**（reviewer 首选，原生 Windows、锁文件驱动）：`.github/workflows/windows-build.yml` 在 `windows-latest` 上 `npm ci` → typecheck/lint/test → `build:win`（未签名）→ 计算 SHA256 → 以工作流工件 `YuwenDesk-Setup-unsigned-x64` 上传（含 `SHA256SUMS.txt`、`BUILD_ENV.txt`，保留 30 天）。原生 Windows 构建的哈希会与 Linux+wine 构建不同，属正常（不同来源）。
- **需持有人确认的最小事项（工件可见范围）**：当前仓库为 public，GitHub Actions 工作流工件对可访问该仓库 Actions 的人可下载。请确认此可见范围在既有授权内；若不允许，请指定一个私有工件渠道。**在确认前不建立公开 Release、不改仓库可见性、不采购服务、不把 111MB 二进制塞入 git 历史（GitHub 普通文件上限 100MiB）。**

## 五条证据线分别记录，不得互相替代

| 证据线 | 状态 |
|---|---|
| ① 未签名工程包构建（本地 Linux+wine） | PASS（SHA256 见上） |
| ② 原始 EXE 上传、持有人可下载、独立重算哈希 | PENDING（受工件渠道限制；CI 工件待运行/授权确认） |
| ③ 干净 Win11 x64 普通用户安装验收 | BLOCKED_EXTERNAL（无目标机器，EXT02） |
| ④ 正式代码签名（受信任发布者） | BLOCKED_EXTERNAL（无签名证书，EXT07；缺证书不阻断未签名构建） |
| ⑤ 真实 Grok 连通/能力探测 | BLOCKED_EXTERNAL（无账户/密钥/预算，EXT03/04） |

## 说明与限制

- 日志中的 `signing with signtool.exe` 在未提供证书时不构成受信任发布者签名；本包按未签名工程测试包处理，SmartScreen/信誉提示可能出现（S09/S13）。
- Linux+wine 构建可验证打包配置与产物形态，但**不能替代**真实 Windows 安装体验与 SmartScreen 行为（③）。CI 的 windows-latest 通常为 Server 镜像、管理员且 UAC 关闭，也**不等于**干净 Win11 普通用户验收。
- 未设置应用图标（使用默认 Electron 图标），不影响可安装性；图标为后续任务。
- 哈希不能替代文件本身；"提供重建命令"不等于逐字节可复现证明（无二次独立构建比对）。
