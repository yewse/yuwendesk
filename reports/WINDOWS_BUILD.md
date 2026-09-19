# Windows 构建报告（工程测试包）

日期：2026-09-19　阶段：PR#1 续开发（F08）

## 结论：Windows x64 未签名工程测试安装包构建成功

- 命令：`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis --x64 --config electron-builder.yml`
- 构建主机：Linux（Cloud Agent），通过 `apt-get install wine`（wine 9.0）在授权构建环境内启用 NSIS 打包所需的 Windows 工具链。
- 产物：`apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe`
  - 文件类型：`PE32 executable (GUI) Intel 80386, for MS Windows, Nullsoft Installer self-extracting archive`
  - 大小：111,317,468 字节
  - **SHA256：`98ff155e11d18e47a3fd0aa78b28ea95b718157114cc8f9ce2bdabbe6e20c20d`**
- 中间产物：`apps/desktop/release/win-unpacked/语文备课工作台.exe`（PE32+ x86-64，未打包应用主程序）。

> 说明：该 EXE 约 111MB，超出本环境工件存储的附件体积上限，无法作为可下载工件随附；上方 SHA256 与本报告即其可核验证据，且可用上述命令在锁定依赖下**可复现**地重新生成。

## 四条证据线分别记录，不得互相替代

| 证据线 | 状态 | 说明 |
|---|---|---|
| ① Windows 自动构建（未签名安装包） | **PASS** | 已产出 `YuwenDesk-Setup-0.1.0-x64.exe`（NSIS，oneClick/perMachine=false），SHA256 见上 |
| ② 干净 Win11 普通用户安装验收（INS-001..006） | **NOT_RUN / BLOCKED_EXTERNAL** | 需真实 Windows 11 x64 干净标准账户（EXT02）。在 Linux 上构建 ≠ 实机安装、双击图标、退出重启、保留数据的验收 |
| ③ 正式代码签名（受信任发布者） | **BLOCKED_EXTERNAL** | 未提供代码签名证书（EXT07）。本包为未签名工程测试包；无 signtool 可信证书即不构成受信任发布者签名，SmartScreen/信誉提示可能出现（S09/S13） |
| ④ 真实 Grok 连通/能力探测 | **BLOCKED_EXTERNAL** | 无 Grok 账户/密钥/预算（EXT03/04）。界面"检查连接"入口就绪但真实连通未运行 |

## 已知限制

- 构建在 Linux + wine 上完成，可验证打包配置与产物形态；但 **不能替代** 在真实 Windows 上的安装体验、SmartScreen 行为与桌面自动化验收（②）。
- 未设置应用图标（`default Electron icon is used`）：图标为后续任务，不影响可安装性。
- 该包未签名，仅供工程验证/受控测试，不作正式教学发布（对应规范"工程验证版"）。
