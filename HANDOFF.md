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
- **G10-T02 本地工程范围已完成**：旧 schema 先建立 SQLite Online Backup 恢复点，再在旁路副本迁移、推进数据世代、写入 job 谱系并复核 schema/完整性/`credential`+`secure_key` 指纹；空间不足、迁移失败、切换中断和失败副本均 fail-closed。严格 journal 驱动原库→rollback/候选→current 的分相切换与重启调和，完成态允许正常业务写和后续同 schema 世代升级，但缺库或谱系不符仍拒绝。G09 恢复会把旧 journal/partial/lock 与旧库一起隔离，恢复旧备份后可重新迁移。未来 schema/世代可读但拒写；缺库且恢复未决时不新建空库。IPC/UI 只显示闭集、诚实的旧版/迁移保护说明。证据见 `reports/G10_RECOVERY_EVIDENCE.md`。
- **G10-T03 本地工程范围已完成**：Windows 开发主机真实跑通含中文、空格、组合字符和长目录的 SQLite、本机/便携备份、另一 Unicode 根下的恢复 prepare→pending→apply、离线更新 staging 与三类五文件原子发布。renderer 增加 skip link、命名区域/当前页、显式 labels、15 处异步 live message、可持久化大字模式、浅深背景双环焦点、warning 文字对比门、强制色/reduced-motion、980/700px 断点和独立主区滚动；具名 modal 支持初始聚焦、Tab 闭环、Escape 与焦点恢复。12 行布局预算矩阵覆盖两个视口 × 100/125/150% × 普通/大字。该矩阵不是实际 Windows DPI/IME/辅助技术证据，`INS-007` 仍 `NOT_RUN/BLOCKED_EXTERNAL`。证据见 `reports/G10_ACCESSIBILITY_EVIDENCE.md`。
- **G10-T04 本地工程范围已完成**：固定种子夹具经 SQLite 真实计数为 100 plans/5000 source segments；30 次 SQLite 打开、30 次计划打开、长/短查询各 30 次和 20 次三类五文件内存生成+一致性复核均保存逐次原始毫秒值，nearest-rank 统计不删离群。计划打开 P95 3.747ms、混合搜索 P95 99.405ms；内存生成+复核 P95 1416.597ms 仅标 `ENGINEERING_CORE_WITHIN_BUDGET`，不是完整导出 PASS。逐样本 partial、闭集中途失败、runner 无报告/中断失败标记、12 分钟硬截止及 benchmark 源码 SHA-256 均有回归。正式导出 I/O、约 10 页 DOCX、Electron/目标硬件/Office-WPS 仍为 `NOT_RUN/BLOCKED_EXTERNAL`。证据见 `reports/G10_PERFORMANCE_RAW.json`、`reports/G10_COMPATIBILITY_MATRIX.md`。
- **G11-T01 本地工程范围已完成**：`AcceptanceRunV1`、170 项显式映射、冻结 130+40 的固定 SHA-256、map/evidence-level/time-window 交叉校验、symlink-safe 路径与 SHA-256/size 回读、完整 Vitest 名匹配、追加 no-clobber、候选盘点和两份固定报告的失败回滚均已落地。首个运行 `run-20260920-b5dba42-01` 绑定源码 `b5dba42579cbb325e1b3cbeadc582865256f88e4`（运行时工作树 dirty），结果 **6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN**。逐项语义审计后只保留 `SEC-009/JOB-003/JOB-006/JOB-007/DAT-005/UPD-001` 为工程 PASS；其余覆盖不足者没有冒充通过。固定候选 EXE 缺失，`artifactClass=NONE`，hash/size/build provenance 均为 null；新增 EXT10/EXT11 只登记非秘密外部条件。
- T01 定向测试 **24/24**，runner 全量 Vitest **574 passed / 1 skipped（575 total，64 files）**；Windows 11 开发主机、Node 24.15.0/npm 11.12.1，全为虚构/工程夹具。typecheck、lint、`verify:contracts`、desktop build 均退出 0。发布路径已覆盖唯一临时文件、追加记录 no-clobber、候选/发行输入成组事务恢复，以及 NTFS ADS、symlink/junction、历史借证和倒序时间拒绝。既有跳过项没有转为通过；T02 已如实聚合为 BLOCKED，当前仍不能称为发布就绪。G09 提交序列：`be728a2`、`3536a8e`、`0560bad`、`27cbe9e`；G10 设计/计划：`4d5ee39`、`f1b76d6`；T01：`4b542a0`；T02：`aef8bbd`；T03：`2861c68`；T04：`61ba230`。G11 设计/计划：`c993c9e`、`b5dba42`。
- **G11-T02 本地工程范围已完成**：`release:evidence` 从显式选择的 T01 run/candidate、冻结定义、两份需求追踪、EXT01–11 固定闭集和严格 v1 缺陷审计派生报告；完整覆盖 60+24 个需求、170 个案例和 11 个固定交付物。当前五维状态为 `BLOCKED / BLOCKED / NOT_REVIEWED / NONE / BLOCKED`，理由 `RELEASE_ARTIFACT_MISSING`，共 18 个排序缺口（含 dirty run）；有效 BLOCKED 报告可生成，但不等于正式门通过。候选固定字节每次重算，输出做绝对路径/秘密模式扫描，三文件以受限 journal 成组发布；缺陷审计保持 `NOT_RUN`，空列表不冒充零 P0/P1。定向 **16/16**（与 T01 合计 40/40）；全量 **590 passed / 1 skipped（591 total，65 files）**；typecheck、lint、`verify:contracts`、desktop build、`git diff --check` 均退出 0。
- **G11-T03 本地工程范围已完成**：实际 npm CLI 生成并解析 CycloneDX 1.5；`package-lock.json` SHA-256 `81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`，锁定组件与 SBOM 精确核对为 **663/663**，依赖图为 **664 个节点 / 1,133 条 lock 边**，并做 root 可达、完整 purl 身份、workspace scoped 短名白名单及双向边集合校验。11 项固定输入的规范 `SHA256SUMS.txt` 已逐文件 realpath/hash 复读，拒绝绝对/穿越/反斜杠/大小写别名、链接逃逸和自引用；SBOM/环境/签名输出还递归拒绝本机路径和秘密模式；四文件成组原子发布。当前聚合为 `SBOM=PASS / checksum=PASS / signature=NOT_RUN`，总发行状态仍 `BLOCKED / RELEASE_ARTIFACT_MISSING`，缺口 16 个。
- **T03 真实边界与门禁**：本机 Node **24.15.0** / npm **11.12.1** 不等于 ENV_LOCK 的 Node **22.14.0** / npm **10.9.7**，因此 `formalEnvironmentMatch=false`；工程 SBOM 不冒充锁定环境证据。生成器和聚合器重新核对 live HEAD 与相关工作树，修改签名脚本、lockfile 或其他非生成输入会保持源码门阻断。固定候选安装器仍不存在，未拿历史包或任意 EXE 代替，Authenticode 为 `NOT_RUN / RELEASE_ARTIFACT_MISSING`；Windows 检查仅接受内核锚定 `GLOBALROOT\\SystemRoot` 的系统 PowerShell，不信任 `SystemRoot` 环境变量或 PATH，并从 `$PSHOME` 显式加载/限定签名与哈希 cmdlet；EXT07 签名身份仍未提供。T03 定向 **17/17**，T02+T03 **39/39**，T01–T03 **63/63**；全量 **613 passed / 1 skipped（614 total，66 files）**；typecheck、lint、合同、desktop build、`git diff --check` 均退出 0。独立最终复核 Critical 0 / Important 0、Ready。下一包必须先保持这些阻断，再生成最终状态。
- **G11-T04 本地工程范围已完成，正式发行仍阻断**：中文教师指南已按真实 renderer 更正，明确备课启动按钮禁用、课堂展示入口和班级/教材/课时设置尚不存在；模型辅助归因仍受五项测量门、真实 API/预算、逐次隐私许可和教师专业复核约束。`release:verify` 固定回读并复算聚合、12 项清单、SBOM/环境/签名与三份公开文档；篡改退出 1，当前真实非就绪状态退出 2，只有 `RELEASE_READY` 可退出 0。SBOM/环境/签名/聚合/状态文档/清单改为八文件原子发布，规定的单轮命令链可收敛。当前仍是 `BLOCKED / RELEASE_ARTIFACT_MISSING`，15 个缺口，Node/npm 与 ENV_LOCK 不一致、签名 `NOT_RUN`。
- **T04 验证**：G11 定向 **71/71**；全量 **621 passed / 1 skipped（622 total，67 files）**；typecheck、lint、合同、desktop build、diff 全部退出 0。冻结哈希未变，发行目录隐私扫描无命中；篡改/恢复演练为 1→2。完整证据见 `reports/G11_EVIDENCE.md`。G11 四个本地工程包已完成，但不可称为正式 G11 DONE 或可分发。
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
| EXT10 真实学生资料处理授权 + 每次必要字段外发许可 | G08 真实模型辅助归因、G11 隐私验收 |
| EXT11 实际支持版本的 Office/WPS 环境 | 成品打开/编辑/保存/分页/放映兼容性 |

密钥放受控秘密环境（Cloud Agent Secrets），禁止贴进仓库或提示词。

## 下一个有界工作包建议

1. 在 `ENV_LOCK.json` 锁定的 Node/npm 与 Electron 环境从当前源码生成新候选；不得复用历史 EXE、哈希或本次 dirty 验收运行。
2. 对同一固定候选补齐干净 Win11、Office/WPS、签名与可信时间戳、授权分发位置、真实 API/预算、学生资料处理与逐次外发许可、教师专业复核和 P0/P1 缺陷审计。
3. 外部输入齐备后创建新的追加验收运行，再依次运行 `release:evidence`、`release:sbom` 和 `release:verify`；保留本次 6 PASS / 38 BLOCKED / 126 NOT_RUN 历史记录，不覆盖或删除。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
