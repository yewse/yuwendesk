# HANDOFF

新会话请先读：`README_START_HERE.md` → `AGENTS.md` → `docs/ENGINEERING_SPEC.md` → `planning/AUTONOMOUS_WORKPLAN.md` → 本文件与 `PROGRESS.md`。

## CR-001 课堂成品需求（已归档，功能未实现）

- 独立业务变更：最终课堂交付 = 可编辑 PPTX + 学生讲义 DOCX/PDF + 教师讲解版 DOCX/PDF（三类五文件）。教案/学校格式保留但不替代。
- 现状：**需求已归档 / 合同待实现 / 功能未实现**。`CR001-R01–R24`、`CLS-001–040`（全部 NOT_RUN）。归档见 `docs/changes/CR-001/`、`planning/changes/CR001/`、`acceptance/addenda/`、规范 §15.4、ADR-0005。
- 后续实现（不改现有阶段门/授权）：G05/G06 角色与内容映射合同 → G06 三类五文件与本地课堂模式 → G07 一处改动联动/旧版与失败恢复 → G09/G11 受众隔离与整包回归。实现阶段验收须提交真实 PPTX/DOCX/PDF + 角色清单 + 计划哈希 + 渲染/打开/编辑证据，不得用截图/提纲/自评替代。
- 严格 schema（`additionalProperties:false`）不放宽：用伴随合同或受控版本升级表达新字段。

## 当前状态（2026-09-19，最新）

- **G00 + G01 可执行项完成**并经三轮审查修复（F01–F08 + R3-01–R3-05）；唯一剩余 G01 门（干净 Win11 x64 实机安装 = G01-T04）为 BLOCKED_EXTERNAL。
- **G02 进行中**：
  - G02-T01 受限 IPC + **Schema 门**（`src/main/schemaGate.ts`，`hasOwnProperty` 白名单，拒绝多余/继承属性字段）——完成。
  - G02-T02 **真实 SQLite 存储**（`src/main/db/sqliteStore.ts`，better-sqlite3 13.0.3，WAL/外键、版本迁移、IMMEDIATE 事务原子乐观并发、失败回滚、旧 JSON 安全迁入、integrity_check 保护态）——完成并接入主进程（`index.ts` 用 `SqliteStore`，经 `DraftStore` 接口）。三级证据见 `reports/`（Node PASS / Electron 真实加载 PASS / Windows 目标包 BLOCKED）。
  - 待续：G02-T03 凭据/敏感 payload 加密（safeStorage/DPAPI）、G02-T04 持久幂等与业务事件事务（复用 `withTransaction`，不得让并发/保存保护退化）。
- 仓库单测 **93 项通过**；typecheck/lint/`verify:contracts` 通过。已产出未签名 Windows EXE（本地 Linux+wine + 原生 Windows CI，哈希见 `reports/WINDOWS_BUILD.md`）。
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

1. G02-T03 凭据/敏感 payload 加密（Electron safeStorage/DPAPI；加密不可用时阻止明文持久化），先补失败测试。
2. G02-T04 持久幂等（幂等结果落 SQLite，跨重启去重）与业务事件事务（同一事务提交业务更改 + outbox），复用 `SqliteStore.withTransaction`，回归并发/保存保护不退化。
3. 在获得 Windows VM 后关闭 G01-T04（干净标准账户安装→桌面图标启动→退出重启→保留数据）。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
