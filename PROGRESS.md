# PROGRESS

> 逐阶段真实进度。状态：DONE / IN_PROGRESS / BLOCKED / NOT_STARTED。仅基于实际工件与测试。

## G00 环境与授权 — DONE（在 Linux 开发环境范围内）

- [x] G00-T01 核实模型/账户 → `ENV_LOCK.json`（Grok 真实探测 BLOCKED_EXTERNAL：无账户）
- [x] G00-T02 锁定开发依赖与许可证 → `ENV_LOCK.json` + `package-lock.json` + `planning/EXTERNAL_INPUTS.json`（EXT01 已具备）
- [x] G00-T03 登记 Windows 运行环境与资源权限 → `SBOM.draft.json`（Windows VM = EXT02 BLOCKED）
- [x] G00-T04 受限命令/费用/外部阻断清单 → `ENV_LOCK.blocked_gates`、`reports/G00_G01_EVIDENCE.md`

## G01 安装骨架 — IN_PROGRESS（工程验证 + 未签名 Windows 包 PASS；干净 Win11 实机验收/签名 BLOCKED）

- [x] G01-T01 原生窗口与中文导航（备下一课/我的课程/资料/帮助与设置）
- [x] G01-T02 单实例、保存与退出生命周期 → 截图/视频 + 单测；**关闭前刷新握手**（save-on-quit）已实测
- [x] G01-T03 NSIS 安装配置（oneClick/perMachine=false/无提权/桌面+开始菜单快捷方式/保留数据）+ 进程与监听记录（无 HTTP 监听，INS-008 自 G01 起验证）
- [~] G01-T04 干净 Windows 标准账户安装证据 → **部分**：Windows 未签名工程测试包已产出（Linux+wine，SHA256 见 reports/WINDOWS_BUILD.md）；**干净 Win11 实机安装验收仍 BLOCKED_EXTERNAL（EXT02）**，正式签名 BLOCKED（EXT07）

已通过：typecheck、lint、单元测试(24)、渲染+主进程构建、Linux 工程验证运行、单实例、无本地监听、Windows 未签名安装包构建。

## PR#1 审查修复（F01–F08，本轮）

- F01 保存：新增"关闭前刷新"主↔渲染握手 + 失焦/隐藏落盘，避免防抖丢失末次编辑；实测立即关闭仍保存。
- F02 并发：修复 `LocalStore.flush` 临时文件名仅含 pid 导致的并发 rename ENOENT 竞争（唯一 tmp 名 + 串行化写入），补并发写入回归测试。
- F03 幂等：真正实现 `idempotency_key` 去重（有界缓存），重放不重复递增/不误报冲突；渲染层按内容轮换稳定幂等键并串行化保存。
- F04 状态证据：`app.health` 增加真实 `build_mode/sandbox_enabled/platform_dev_override`，界面如实显示"开发验证/OS 沙箱已禁用"，不写死。
- F05 生产安全边界：权限请求全拒绝、生产禁用 devtools、`app.isPackaged` 门控开发服务器、发送者顶层 frame 校验、CSP 响应头、拦截非本地网络请求、`--no-sandbox` 告警。
- F06 Electron 版本：确认 31 已 EOL，升级至受支持的 44.4.3 + electron-builder 26.15.3。
- F07 验收分期：ADR-0003 明确 G01 工程验证 vs 干净 Win11 实机两级 + 四条证据线互不替代；INS-008 追加到 G01 验收（保留 G09，不降低要求）。
- F08 Windows 构建：产出未签名工程测试安装包 `YuwenDesk-Setup-0.1.0-x64.exe`（SHA256 见报告）。

## G02–G11 — NOT_STARTED

数据基础、资料与引用、Grok 与任务、教学业务 M01–M12、材料交付、审查与修改、反馈与纠正、备份恢复、升级性能、发布验收，均未开始。界面相应页面标注"后续版本开放"。

## 下一步

见 `HANDOFF.md`。优先在获得 Windows VM 后完成 G01-T04 安装验收，或在 G02 建立 SQLite/IPC 数据基础。
