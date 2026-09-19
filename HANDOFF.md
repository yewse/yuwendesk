# HANDOFF

新会话请先读：`README_START_HERE.md` → `AGENTS.md` → `docs/ENGINEERING_SPEC.md` → `planning/AUTONOMOUS_WORKPLAN.md` → 本文件与 `PROGRESS.md`。

## CR-001 课堂成品需求（已归档，功能未实现）

- 独立业务变更：最终课堂交付 = 可编辑 PPTX + 学生讲义 DOCX/PDF + 教师讲解版 DOCX/PDF（三类五文件）。教案/学校格式保留但不替代。
- 现状：**需求已归档 / 合同待实现 / 功能未实现**。`CR001-R01–R24`、`CLS-001–040`（全部 NOT_RUN）。归档见 `docs/changes/CR-001/`、`planning/changes/CR001/`、`acceptance/addenda/`、规范 §15.4、ADR-0005。
- 后续实现（不改现有阶段门/授权）：G05/G06 角色与内容映射合同 → G06 三类五文件与本地课堂模式 → G07 一处改动联动/旧版与失败恢复 → G09/G11 受众隔离与整包回归。实现阶段验收须提交真实 PPTX/DOCX/PDF + 角色清单 + 计划哈希 + 渲染/打开/编辑证据，不得用截图/提纲/自评替代。
- 严格 schema（`additionalProperties:false`）不放宽：用伴随合同或受控版本升级表达新字段。

## 当前状态（2026-09-19，最新）

- **G00 + G01 可执行项完成**并经三轮审查修复（F01–F08 + R3-01–R3-05）；唯一剩余 G01 门（干净 Win11 x64 实机安装 = G01-T04）为 BLOCKED_EXTERNAL。
- **G02 本地数据能力已交付（T01–T04）**：
  - T01 受限 IPC + **Schema 门**（`schemaGate.ts`，`hasOwnProperty` 白名单）。
  - T02 **真实 SQLite 存储**（`db/sqliteStore.ts`，WAL/外键、版本迁移、IMMEDIATE 事务原子乐观并发、失败回滚、旧 JSON 安全迁入、高版本/必需记录/隔离·归档失败保护），主进程 `index.ts` 用 `SqliteStore`。
  - T03 **凭据/敏感 payload 保护**（`crypto/secrets.ts`：safeStorage 包裹凭据、AES-256-GCM 敏感载荷、加密不可用拒绝落明文、解密失败不覆盖），迁移 v3 + 注入 electron.safeStorage + health 显示。
  - T04 **持久幂等 + outbox 单事务**（`commitDraftSave`：业务修改+幂等结果+事件同一事务；跨进程重启不重复；IpcService 已委托）。
  - 联合验证：Node 128 项 + 真实 Electron 运行（SQLite 保存/迁移/保护/冲突/重载 + 凭据探测 + outbox）；证据 `reports/` 与 artifacts。**Windows 目标环境验收 BLOCKED_EXTERNAL**。
- 后续门（不在 G02 范围）：G03 资料/敏感数据落点、G04 provider.configure（凭据用户入口）；或获 Win11 后关闭 G01-T04 + G02 Windows 目标验收。
- 仓库单测 **128 项通过**；typecheck/lint/`verify:contracts` 通过。已产出未签名 Windows EXE（本地 Linux+wine + 原生 Windows CI，哈希见 `reports/WINDOWS_BUILD.md`）。
- 自动公开上传**已暂停**（工作流仅手动 `workflow_dispatch`）；公开工件可见范围待持有人确认。
- 数据基础说明：生产改用 `apps/desktop`（app.getPath('userData')）下的 `yuwendesk.db`；旧 `yuwendesk-local-state.json` 首次运行安全迁入并备份为 `.migrated.*`。LocalStore(JSON) 保留为迁入来源与 G01 回归。

## 如何构建 / 运行 / 测试

```bash
npm install                 # 安装（幂等）
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop build         # vite 渲染层 + tsc 主/预加载
npm run verify:contracts                    # 轻量合同校验

# 原生依赖（better-sqlite3）ABI：Node 测试用 Node ABI 预编译；真实 Electron/打包用 Electron ABI。
npx electron-rebuild -f -w better-sqlite3    # 真实 Electron 运行前按 Electron ABI 重建
npm rebuild better-sqlite3                    # 恢复 Node ABI 以再跑 test:unit
# （打包 build:win 会自动执行 @electron/rebuild；node_modules 不入库，锁文件固定版本）

# 无头环境运行演示（开发/CI 用；教师不使用命令行）
scripts/dev-run-xvfb.sh                      # 启动 Xvfb :99 + Electron（设 YUWENDESK_DEV_ALLOW_PLATFORM=1）

# Windows 安装包（Linux 上需 wine：sudo apt-get install -y wine wine64 wine32:i386）
# 未签名工程测试包（无证书）：
CSC_IDENTITY_AUTO_DISCOVERY=false npm run -w @yuwendesk/desktop build:win
# 产物 apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe（见 reports/WINDOWS_BUILD.md 的 SHA256）
```

> Windows 构建现状：Linux+wine 可产出**未签名**安装包（证据线①）。干净 Win11 普通用户**实机安装验收**（②）、**正式签名**（③）、**真实 Grok 连通**（④）仍需外部输入，四者分别记录、不可互相替代（ADR-0003）。

## 阻断项与所需外部输入（见 planning/EXTERNAL_INPUTS.json）

| 需要 | 用于 |
|---|---|
| EXT02 Windows 11 x64 干净 VM + 桌面自动化 | G01-T04 安装验收、`build:win` 实测 |
| EXT03/EXT04 Grok API 账户/密钥/费用上限 | G04 真实连通与能力探测 |
| EXT07 发布签名身份/凭据 | 正式签名发布 |
| EXT08 分发地址/可信更新公钥 | 在线更新发布 |

密钥放受控秘密环境（Cloud Agent Secrets），禁止贴进仓库或提示词。

## 下一个有界工作包建议

1. G03 资料与来源（安全解析导入、中文 FTS、精确锚点）——敏感 payload 保护（T03 能力）在此获得真实业务落点。
2. G04 provider.configure/probe/clear（凭据用户入口 + 真实 Grok 连通）——凭据保护（T03 能力）在此端到端接入；需 EXT03/04。
3. 获得 Windows VM 后关闭 G01-T04 与 G02 Windows 目标环境验收（安装→启动→保存→重启→保留数据 + SQLite/凭据在真实 Windows 的行为）。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
