# ADR-0001 技术基线与目录（G00）

- 状态：已接受
- 日期：2026-09-19
- 阶段：G00

## 背景

规范 §05 规定采用 Electron + TypeScript + React + SQLite + electron-builder(NSIS) 的独立桌面路线。docs/REPOSITORY_AND_CI.md 给出推荐目录。需在 G00 固定可协同工作的版本并锁定。

## 决策

1. 采用 npm workspaces 单仓库；首个应用包位于 `apps/desktop`（对应推荐目录 `apps/desktop/src/{main,preload,renderer}`）。共享 IPC 契约暂置于 `apps/desktop/src/shared`，后续按需要抽取到 `packages/contracts`。
2. 锁定开发工具链版本（见 `ENV_LOCK.json`）：Electron 31.7.7、electron-builder 24.13.3、React 18.3.1、TypeScript 5.5.4、Vite 5.4.8、Vitest 2.1.1、ESLint 8.57.0。精确版本 + `package-lock.json`，不使用 "latest"。
3. 渲染层由 Vite 打包为本地静态资源，生产环境通过 `file://` 加载，不使用生产开发服务器，不监听任何本地端口（规范 §06.1、INS-008）。
4. 数据库 better-sqlite3 推迟到 G02；届时需针对目标 Electron ABI 重建并在 Windows 包内冒烟测试，若不可行按规范经 ADR 切换受支持驱动但维持事务/FTS/备份合同。

## 后果

- 开发/构建主机为 Linux（Cloud Agent），教师目标平台为 Windows 11 x64；二者分离，Windows 实机安装验收（INS-001..006）在无 Windows VM 时记 BLOCKED_EXTERNAL。
- 版本迁移风险以锁文件与本 ADR 跟踪；electron-builder 配置以选定版本 Schema 验证 [S08]。
