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
- **G08 四包本地工程范围已完成**：采用/授课/观察/效果保持分离；固定五项测量门后才进入模型辅助归因；严格字段白名单、内容来源、G04 预算/授权/超时/幂等保护和 stale 审计已落地。T04 新增最小 `CorrectionProposal`、偏好/效果双轨追加事件、接受/拒绝/撤回、五处事务故障回滚、完整反馈历史与纠偏 UI。采用建议只返回类型化 G07 预览输入，不直接修改课时或五文件。证据见 `reports/G08_EVIDENCE.md`。
- **G09-T01 本地工程范围已完成**：SQLite Online Backup 取得 WAL 一致净化快照；凭据排除、成果文件清单/哈希、`.partial`→`.ready`、每日/每周保留和首次成功写入调度已落地。便携包以校准 scrypt + AES-256-GCM 整包加密，并独立封装工作区数据密钥；目标机重新 safeStorage 包装，API 密钥保持为空。恢复先旁路验证路径/资源/hash/schema/空间/完整性，经主进程单次绑定令牌后登记 pending，重启前切换失败会恢复 rollback。设置页与命名 IPC 不暴露任意路径。
- **G09-T02 本地工程范围已完成**：学生敏感导入/普通→敏感升级只落 AES-256-GCM 认证载荷；文档级分类一致，跨分类新版本不能绕过整文档升级。两张 FTS 启用独立 secure-delete，普通原件/正文/段/索引与精确关联的课时内容、审查、修改、材料文件、反馈/测量/归因/纠正及模型缓存均清除。材料文件经可恢复隔离与启动调和；独立文档 revision 绑定双确认 token，过期/消费/范围失效后不重放旧 token。永久删除墓碑含原因和分阶段备份工作流，启动可续做；manifest 范围来自快照，删除前后在备份排他锁内复核，漂移要求重新确认。损坏/不可读的 `.ready` 受管备份也纳入确认范围并可显式删除；已先行删除的授权备份在续做时按幂等成功处理。`backup.create` 先持久预留再发布，便携口令只存工作区密钥 HMAC 摘要。外部副本和 SSD 物理擦除仍不在保证范围。
- **G09-T03 本地工程范围已完成**：诊断预览/ZIP 只含固定白名单字段和闭集错误代码聚合，未知错误统一为 `UNKNOWN`，八类 canary 与真实 SQLite 全大写自由错误文本不可搜索；预览哈希绑定当前状态，在原生保存对话框返回和原子发布前重验，漂移不会留下 running 幂等预留。路径只由主进程选择，ZIP 仅有 `diagnostics.json` / `README.txt`，没有自动上传。集中构造器故障钩子覆盖备份、恢复、重分类、删除与诊断原子边界；恢复逐项记录旧数据移动，仅在组件全集与原 DB 哈希可证明时报告回滚成功，已有不确定 rollback 时停止而不删除。自动备份同码连续三次失败后停止自动重试，手动成功清零连续计数但保留历史错误。
- **G09-T04 本地工程范围已完成**：IPC 信任绑定实际窗口、sender、精确 top frame 与固定本地 URL；闭集普通对象校验拒绝原型继承、额外字段、URL 形输入和非法 Base64，模型 provider 的任意异常/路径/密钥样式文本只映射为闭集代码与固定中文说明。便携恢复在解压前读取 ZIP 中央目录，目录和文件均计数；拒绝原始及 Windows 别名重复、尾点/设备名、symlink、路径穿越、local/central 名称与元数据不一致、数据重叠和资源炸弹，并以带硬截止的流式解压复核实际展开量。归档条目必须与 manifest 精确相等；hash/schema/SQLite 在隔离 staging 内校验，失败清理，写入审计证明没有 staging 外瞬时写入。提示注入、DOCM 宏、OOXML 外部关系、HTML/script、PDF URI 只作为被动字节，测试中无网络派发。逐项状态和复现证据见 `reports/G09_THREAT_CHECKLIST.md`、`reports/G09_EVIDENCE.md`；SEC-006 保持 `NOT_RUN`，INS-008/DAT-002 保持 `BLOCKED_EXTERNAL`，冻结 acceptance 未改。
- **G10-T01 本地工程范围已完成**：固定非 ZIP 容器、规范闭集 manifest、Ed25519 应用内信任锚、目标/严格版本/package 完整性验证；生产信任集为空时 fail-closed。选择路径只在主进程，renderer 只取得安全摘要和两分钟单次绑定 token；确认时限额重读复验，固定 `.partial` 回读签名/版本/hash 后原子发布 `.ready`。损坏 ready 不列出/重放，同键异包拒绝；没有安装器执行、退出或重启能力。UI 无绕过并诚实显示未配置信任或“已验证暂存、未安装”。真实公钥/签名/分发/Windows 升级仍 `BLOCKED_EXTERNAL`。证据见 `reports/G10_UPDATE_EVIDENCE.md`。
- 当前仓库单测 **513 passed / 1 skipped（514 total，58 files）**（Windows 11 开发主机，Node 24.15.0；G10-T01 使用进程内临时 Ed25519 keypair 和虚构安装器字节，不替代真实签名/安装）；最终重点 74/74，typecheck、lint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0。首次全量如实保留 1 个白名单失败；独立复核首轮 Critical 0 / Important 3 / Not ready，均以 RED 复现并改为流式整包处理、独立原子幂等 ledger、故障钩子后及 rename 后复验，另补严格闭集与 superseded。第二轮 Critical 0 / Important 2 / Not ready 后又补发布后 ledger 丢失恢复、ledger 写入/改名故障回滚与 token 恢复、完整结果绑定和按实际字节淘汰；第三轮 Critical 0 / Important 0、Ready。既有跳过项未改为通过，pdfjs 可选警告仍有如实记录。G09 提交序列：`be728a2`、`3536a8e`、`0560bad`、`27cbe9e`；G10 设计/计划：`4d5ee39`、`f1b76d6`；T01 待本次提交。未签名 Windows EXE 见 `reports/WINDOWS_BUILD.md`。
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

1. **G10-T02 迁移失败恢复与不兼容回退**：先以失败测试固定迁移中断、完整性失败、切换 journal、既有 rollback、空间不足、未来 schema/数据世代和重复启动；复用 G09 恢复点，在旁路副本迁移并验证后才切换。真实旧程序二进制恢复需签名安装器与 Windows，继续 `BLOCKED_EXTERNAL`。
2. 获得真实学生材料处理授权、逐次外发许可和授权云 API 后，再执行 G08 真实归因质量与隐私门；随后由有资质教师完成教学专业复核。当前测试替身和离线协议不替代这些外部门。
3. 补齐锁定 Electron 二进制后执行开发态窗口走查；获得干净 Windows VM 后再关闭 G01-T04 与目标安装验收（安装→启动→保存→重启→保留数据 + SQLite/凭据/导出），两者不互相替代。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
