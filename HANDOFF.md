# HANDOFF

新会话请先读：`README_START_HERE.md` → `AGENTS.md` → `docs/ENGINEERING_SPEC.md` → `planning/AUTONOMOUS_WORKPLAN.md` → 本文件与 `PROGRESS.md`。

## CR-001 课堂成品需求（需求已归档；G06 确定性生成已交付）

- 独立业务变更：最终课堂交付 = 可编辑 PPTX + 学生讲义 DOCX/PDF + 教师讲解版 DOCX/PDF（三类五文件）。教案/学校格式保留但不替代。
- 需求归档：`CR001-R01–R24`、`CLS-001–040`（验收用例仍 NOT_RUN）。归档见 `docs/changes/CR-001/`、`planning/changes/CR001/`、`acceptance/addenda/`、规范 §15.4、ADR-0005。
- **G06 已交付确定性三类五文件**（角色隔离 / 版本一致 / 一处修改纯函数）；G07 跨成品自动重生成流水线、真实 Office 保真、CLS 验收执行尚未关闭。
- 严格 schema（`additionalProperties:false`）不放宽：用伴随合同或受控版本升级表达新字段。

## 当前状态（2026-09-20，与 `PROGRESS.md` 对齐）

- **G00 + G01 可执行项完成**并经三轮审查修复（F01–F08 + R3-01–R3-05）；唯一剩余 G01 门（干净 Win11 x64 实机安装 = G01-T04）为 BLOCKED_EXTERNAL。
- **G02 本地数据能力已交付（T01–T04）**：Schema 门、真实 SQLite、凭据/敏感加密、持久幂等 + outbox 单事务。Windows 目标环境验收 BLOCKED_EXTERNAL。
- **G03 资料与来源已交付**：TXT/MD/CSV + PDF/DOCX/XLSX/PPTX 解析定位、中文 FTS/短词回退、原件核对、处理边界（大小/限额/超时/取消/worker）。扫描件 OCR 未接入则阻塞。
- **G04 模型闭环已交付（测试替身 + DeepSeek 真实协议离线）**：可配置服务商、提示词工程、上下文边界、预算/缓存/取消/重试、保护收尾。真实云 API 备课质量 BLOCKED（需授权账户与联网）。
- **G05 完整 LessonPlan 已交付**：按 `contracts/LessonPlan.schema.json` 组建并校验；`lesson_outline` 仅为中间产物。
- **G06 三类五文件已交付**：课堂 PPTX + 学生 DOCX/PDF + 教师 DOCX/PDF；角色隔离、版本水印、内容来源身份。真实 Office/LibreOffice 保真未验证。
- **G07 四包本地工程范围已完成**：T01 确定性审查/严格 `ReviewReport`/持久化；T02 受控变更/依赖失效/严格 `ChangeProposal`/五文件暂存哈希复核/SQLite 原子接纳/持久幂等；T03 单方案最少选择 UI/差异/历史/纸本提醒；T04 整包内容审查、17 个文件系统/SQLite 故障边界、三次持久失败截止，以及旧 `materials.generate` fail-closed 替换均已落地。旧修订与旧包保留，纯呈现变化不创建语义修订。证据见 `reports/G07_EVIDENCE.md`。
- **G08 设计已确认，实施未开始**：四包边界为授课事件、可选结构化 Observation、确定性测量门后的模型辅助归因、最小纠正与偏好/效果双轨撤回。首版不保存学生原始作业正文；Observation 不上云，真实模型只允许接收单独构造的去身份化白名单上下文并要求逐次派发许可。规格见 `docs/superpowers/specs/2026-09-20-g08-feedback-attribution-design.md`；G08 冻结验收仍为 NOT_RUN，真实 API 与教学专业复核为 BLOCKED_EXTERNAL。
- 仓库单测 **279 passed / 1 skipped（280 total，29 files）**（以 `PROGRESS.md` 最近实测为准）；主/渲染 typecheck、lint、`verify:contracts`、renderer/main build、`git diff --check` 通过。既有跳过项未改为通过。pdfjs 的可选 canvas/standardFontDataUrl 警告有如实记录，不等同于 Office/WPS 保真失败或通过。未签名 Windows EXE 见 `reports/WINDOWS_BUILD.md`。
- 本机开发态 Electron 走查 **BLOCKED_EXTERNAL**：锁定包的二进制因 `--ignore-scripts` 未下载，补下载无进度且仓库无可复用 `.exe`；未伪造 UI 截图或 Win11 证据。
- 自动公开上传**已暂停**（工作流仅手动 `workflow_dispatch`）；公开工件可见范围待持有人确认。
- 生产数据：`app.getPath('userData')` 下 `yuwendesk.db`；旧 JSON 首次运行安全迁入。

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

1. **G08 反馈与教学纠正**：先依据已确认规格写实施计划，再按 G08-T01–T04 内联执行；不重做 G00–G07，保持“模型辅助归因不等于教学有效”。
2. 获得授权云 API 后关闭 G04/G07 真实语义复核门（当前仅测试替身 + 离线协议；不伪造实网成功）。
3. 补齐锁定 Electron 二进制后执行开发态窗口走查；获得干净 Windows VM 后再关闭 G01-T04 与目标安装验收（安装→启动→保存→重启→保留数据 + SQLite/凭据/导出），两者不互相替代。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
