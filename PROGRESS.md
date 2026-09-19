# PROGRESS

> 逐阶段真实进度。状态：DONE / IN_PROGRESS / BLOCKED / NOT_STARTED。仅基于实际工件与测试。

## G00 环境与授权 — DONE（在 Linux 开发环境范围内）

- [x] G00-T01 核实模型/账户 → `ENV_LOCK.json`（Grok 真实探测 BLOCKED_EXTERNAL：无账户）
- [x] G00-T02 锁定开发依赖与许可证 → `ENV_LOCK.json` + `package-lock.json` + `planning/EXTERNAL_INPUTS.json`（EXT01 已具备）
- [x] G00-T03 登记 Windows 运行环境与资源权限 → `SBOM.draft.json`（Windows VM = EXT02 BLOCKED）
- [x] G00-T04 受限命令/费用/外部阻断清单 → `ENV_LOCK.blocked_gates`、`reports/G00_G01_EVIDENCE.md`

## G01 安装骨架 — IN_PROGRESS（工程验证 PASS；Windows 实机验收 BLOCKED）

- [x] G01-T01 原生窗口与中文导航（备下一课/我的课程/资料/帮助与设置）
- [x] G01-T02 单实例、保存与退出生命周期 → 截图/视频 + 单测
- [x] G01-T03 NSIS 安装配置（oneClick/perMachine=false/无提权/桌面+开始菜单快捷方式/保留数据）+ 进程与监听记录（无 HTTP 监听）
- [ ] G01-T04 干净 Windows 标准账户安装证据 → **BLOCKED_EXTERNAL（EXT02，无 Windows VM）**；`npm run build:win` 待 Windows/wine + 签名

已通过：typecheck、lint、单元测试(14)、渲染+主进程构建、Linux 工程验证运行、单实例、无本地监听。

## G02–G11 — NOT_STARTED

数据基础、资料与引用、Grok 与任务、教学业务 M01–M12、材料交付、审查与修改、反馈与纠正、备份恢复、升级性能、发布验收，均未开始。界面相应页面标注"后续版本开放"。

## 下一步

见 `HANDOFF.md`。优先在获得 Windows VM 后完成 G01-T04 安装验收，或在 G02 建立 SQLite/IPC 数据基础。
