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
- **G11-E01 追加验收入口已实现，实际运行待候选**：runner 可从被忽略的 `apps/desktop/release/acceptance/` 接收外部执行输入，只把绑定当前 commit、固定候选字节、有效执行时窗及已 `PROVIDED` 外部条件的映射案例提升为 `PASS/FAIL`；其余保持 `BLOCKED/NOT_RUN`。来源/候选漂移、机器绝对路径、路径逃逸、重复案例、未提供条件和 API key/Bearer 内容会整轮拒绝。DeepSeek 默认预算费率已改为官方 2026-09-10 峰值（输入 ¥2/百万、输出 ¥8/百万），用户硬上限 10 元。新增 4 项回归；全量 **625 passed / 1 skipped（626 total，67 files）**，typecheck/lint/contracts/build/diff 均通过。
- **E01 证据边界**：冻结 `AI-001` 仍写 Grok，当前实现/授权是 DeepSeek，故 DeepSeek 实网结果只作真实工程证据，不能冒充该旧案例 PASS。GPT 合成材料/模型自审不能替代合法现用教材或真人教师专业复核；当前 Windows 11 主机也未证明为干净标准用户 VM。EXT07/EXT08 仍未提供。
- **G11-E02 Windows 候选构建修复已实现，待 clean commit 重建**：实际 `build:win` 首轮因 electron-builder 重建 `pdfjs-dist` 可选 `canvas`、缺 Cairo/GTK 而失败；新增 2 项先 RED 后 GREEN 的打包合同测试，现关闭 broad rebuild、排除 `canvas`，并只用 `--only better-sqlite3 --types prod` 定向重建必需原生模块。修复后 Windows 11 Pro `10.0.26200` x64 实际生成 131,024,560-byte NSIS 安装器，Authenticode `NotSigned`；因该次构建来自未提交工作树，只证明构建路径已恢复，不可进入追加验收。提交 E02 后必须从 clean commit 重建固定候选。
- **E02 验证**：打包/G11 候选边界定向 51/51；全量 **627 passed / 1 skipped（628 total，68 files）**；typecheck、lint、合同、diff 均退出 0。无构建来源的临时候选一度使 G11 测试/合同按设计拒绝，已隔离到 ignored provisional 目录，未放宽候选来源门禁。
- **E02 日志安全**：原生构建失败输出可能展开子进程环境；后续构建先在子进程移除凭据型变量并关闭 debug。不得把任何密钥写入命令、仓库、验收输入或证据。
- **G11-E03 候选来源闭环已实现，待 clean commit 实跑**：新增 `npm run build:candidate`，强制 Windows + clean tree，清理凭据型子进程环境，成功后原子写 ignored 来源记录，绑定 commit、固定 EXE hash/size、构建时间/命令及 OS/Node/npm。runner 会复算并拒绝缺失、路径逃逸、commit/字节漂移；修复了“候选存在但 runner 无来源输入通道”的死锁。新增 2 项回归先 RED 后 GREEN，G11/打包定向 53/53；全量 **629 passed / 1 skipped（630 total，68 files）**，typecheck/lint/contracts/build/Node 语法/diff 均通过。须提交 E03 后才运行该命令生成最终固定候选。
- **E03 测试隔离**：缺失候选及 60+24+170 静态覆盖测试已脱离 live ignored 候选/历史报告，保留候选漂移、派生篡改和伪造 RELEASE_READY 拒绝门，不再因真实候选刚生成而自相矛盾。
- **G11-E04 外部条件已登记**：EXT04=PROVIDED（本次 DeepSeek 真实测试人民币 10 元硬上限）、EXT10=PROVIDED（本次合成/最小必要字段外发许可，不代表真实学生材料已提供）、EXT11=PROVIDED（Windows 11 Pro 上 WPS Office Commercial 12.1.0.28022；Microsoft Office 未提供）。只有实际执行并绑定新候选的对应案例可 PASS/FAIL。
- **E04 仍阻断**：EXT02/03/05/06/07/08/09 继续 NOT_PROVIDED；DeepSeek 不满足冻结 AI-001 的 Grok 定义，GPT 合成材料/自审不满足合法现用教材/真人教师专业复核，当前主机不冒充干净标准用户 VM。
- **E04 发行链已刷新**：隔离候选后 `release:evidence`/`release:sbom` 退出 0，`release:verify` 按预期退出 2；状态仍为 `BLOCKED / RELEASE_ARTIFACT_MISSING`，缺口 12。EXT04/10/11 的登记只减少外部输入缺口，没有把任何未执行案例改成 PASS。
- **E04 验证**：全量 **629 passed / 1 skipped（630 total，68 files）**，合同与 diff 通过；既有告警/跳过项未改写。
- **G11-E05 已追加一轮候选绑定验收**：`run-20260920-e126a1a-01` 绑定 clean commit `e126a1a82c88420cfe26395c0ffd00496f5b8639` 和 131,024,555-byte 未签名候选（SHA-256 `0f0b5ba1f980fa37791ca144b0e2b36bad611701fa2248c7fabf1be82136d6e9`），结果 6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN。EXT04/10/11 已提供但外部案例未执行，未自动提升。
- **E05 精确白名单修复待提交**：发行聚合遗漏本轮 `vitest-run-*.json`，导致误报 SOURCE_DIRTY；现只允许已验证 AcceptanceRun 精确引用的 `reports/acceptance-runs/` 证据路径，仍拒绝未声明邻接文件/绝对/穿越路径。提交后需重建候选并追加下一轮，以验证 clean source 聚合。
- **E05 验证**：白名单回归先 RED 后 GREEN；全量 **630 passed / 1 skipped（631 total，68 files）**，typecheck/lint/contracts/build/Node 语法/diff 全通过。
- **G11-E06 clean-source 复验**：`10c4908` 候选 131,024,554 bytes / SHA-256 `7188f17a5e5f2e8fec41556b7c339e49a9a7841a5649d638ba0b51f126ac22fc`；`run-20260920-10c4908-01` 为 clean run，6/0/38/126。`release:evidence` 已从误报 SOURCE_DIRTY 修正为真实 `RELEASE_WINDOWS_EVIDENCE_REQUIRED`。
- **E06 待定位**：随后 `release:sbom` 在八文件事务的提交前派生复核中报错并回滚；只有预先 dirty 时可完成，指向事务临时文件遗漏。已增加只返回仓库相对路径的诊断和首个 JSON 差异路径，不改变发行合同；提交后用 clean source 重现，按精确路径修复，不允许整个目录。
- **G11-E07 历史失败已保全**：`b3d384f` 候选 131,024,555 bytes / SHA-256 `29d19d1a4fd412a24159d6f81a29360759e77de90a29f10fcffd32e3009d7584`；`run-20260920-b3d384f-01` 的完整 Vitest 命令实际有 1 项失败，因此按既有命令组规则记录 0/6/38/126。随后独立全量复跑为 630 passed / 1 skipped，不能倒改历史 FAIL。
- **E07 诊断修复**：归一化 Vitest 证据新增 `failedAssertions`，只含失败测试的仓库相对文件、名称、状态和计数；不含 failure message、堆栈、绝对路径或环境值。未来偶发失败可定位，验收判定规则未放宽。DeepSeek 密钥仍未进入工具命令/仓库；当前没有安全秘密注入通道。CUA 无原生应用入口，WPS 实际操作仍未执行。
- **E07 当前验证**：新增回归后全量 631 passed / 1 skipped（632 total，68 files），typecheck/lint/contracts/diff 均通过。发行链忠实保留 `RELEASE_REQUIRED_CASE_FAILED`，签名 `UNSIGNED`、13 个缺口，最终验证退出 2。
- **G11-E08 精确定位成功**：`5c0de04` 的 131,024,559-byte 候选（SHA-256 `f63d5809d8c47513c206907e680147e7c6330bbf31db18e2c5e943ad0edb86e5`）对应 `run-20260920-5c0de04-01` 再次记录 0/6/38/126。新字段定位到 `g11-release-evidence.test.ts` 的静态覆盖测试；历史失败未覆盖。
- **E08 根因修复**：测试为检查首个 JSON 差异路径却读取 live 候选快照，在新 EXE 与旧 `candidate-artifact.json` 的短暂窗口先命中 provenance 漂移。现用导出的纯 `firstDifferencePath` 断言精确路径，另保留 live 校验只验证篡改拒绝；提交后须重建候选并创建第三轮追加运行验证。
- **E08 当前验证**：全量 631 passed / 1 skipped（632 total，68 files），typecheck/lint/build/contracts/diff 均通过；发行仍为 `BLOCKED / RELEASE_REQUIRED_CASE_FAILED`，签名 `UNSIGNED`，最终验证退出 2。
- **G11-E09 第三轮追加验收通过**：`5d5fe78` 候选 131,024,555 bytes / SHA-256 `6d04a8a1871d2bb4ad45ab8b43464d3a9b5f0dd138e11ac60ed8cdb0c84d0b75`；`run-20260920-5d5fe78-01` 为 clean run，6/0/38/126。前两轮失败未删除或改写。
- **E09 事务根因与修复**：clean `release:sbom` 的精确差异为 `$.supplyChain.sbomStatus`。供应链脚本的第二份 dirty-path allowlist遗漏 AcceptanceRun 引用的 Vitest 文件，使环境记录与权威聚合输入对 source clean 的判断相反。现先调用 `loadReleaseAggregationInputs` 并复用其 `repositoryProvenance`，删除复制的 allowlist；dirty 源码下八文件事务已成功，提交后须在 clean source 上最终复验。
- **E09 当前验证**：全量 632 passed / 1 skipped（633 total，68 files），typecheck/lint/build/contracts/diff 均通过；dirty-source 发行验证退出 2。
- **G11-E10 clean-source 闭环已通过**：`189fd2a` 候选 131,024,559 bytes / SHA-256 `1859f83748555b9222b8233d7f5171977f263e6b125b7a3af83735e200c29d68`；`run-20260920-189fd2a-01` 为 clean run，6/0/38/126。随后 `release:evidence` 与八文件 `release:sbom` 均成功，`sourceTreeClean=true`，证明 E09 事务修复在 clean source 有效。
- **E10 最终真实状态**：`SBOM=PASS / checksum=PASS / signature=UNSIGNED / formalEnvironmentMatch=false`，发行仍为 `BLOCKED / RELEASE_WINDOWS_EVIDENCE_REQUIRED`，11 个缺口，`release:verify` 退出 2。WPS 无原生控制入口，密钥无不暴露于工具参数的安全注入通道，故相关实际案例未执行；Grok、签名、分发、真人教师复核等继续阻断。
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
npx electron-rebuild -f --only better-sqlite3 --types prod  # 真实 Electron 运行前按 Electron ABI 定向重建
npm rebuild better-sqlite3                    # 恢复 Node ABI 以再跑 test:unit
# （打包 build:win 会定向重建 better-sqlite3；可选 canvas 不进入应用包）

# 无头环境运行演示（开发/CI 用；教师不使用命令行）
scripts/dev-run-xvfb.sh                      # 启动 Xvfb :99 + Electron（设 YUWENDESK_DEV_ALLOW_PLATFORM=1）

# Windows 安装包（Linux 上需 wine：sudo apt-get install -y wine wine64 wine32:i386）
# 未签名工程测试包（无证书）：
CSC_IDENTITY_AUTO_DISCOVERY=false npm run -w @yuwendesk/desktop build:win
# 绑定 clean commit 并生成可供追加验收复核的固定候选（推荐）：
npm run build:candidate
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

0. G12-T01–T03 本地实现已完成；不要重做 G00–G11，也不要恢复 production `lesson.buildDemo`。
1. 下一步直接执行 G12-T04：先提交 T03，再以 RED 合同测试更新教师指南和追加验收入口；随后从 clean commit 构建候选并实际运行 G12 Electron 纵向脚本。
2. 新验收运行只能使用绑定当前 commit、当前候选和当前输入哈希的实际证据；旧 G11 运行永久保留，不能覆盖或借证。
3. 真实 DeepSeek/WPS/干净标准用户 Windows/签名/分发/真人教师复核只有实际执行后才能转为 PASS/FAIL，否则保持 `BLOCKED_EXTERNAL/NOT_RUN`。

## G12-T01 当前状态

- schema 13、`PreparationStore`、显式状态机、重启回退和来源 SHA-256 绑定已实现；G12/Schema/IPC 定向 42/42、typecheck 通过。
- 修改前全量基线为 631 passed / 1 failed / 1 skipped；既有失败仅是 G11 生成 Markdown 的 CRLF/LF 不一致，尚未在 T01 顺手改写。
- `verify:contracts` 当前失败仅因历史 G11 发行证据不再绑定 G12 当前源码/候选；留到 T04 以追加运行重建，不把旧证据改成 PASS。
- 真实 API/WPS/签名/分发/真人教师复核没有在 T01 执行，状态保持 `BLOCKED_EXTERNAL/NOT_RUN`。

## G12-T02 当前状态

- 离线本地自拟、固定 `lesson_plan_spec.v1`、来源重验、计划构建、软件审查、确认和真实五文件原子导出已接入 `PreparationService` 与命名 IPC。生产启动会注入真实 SQLite、ModelService 和材料发布器。
- 内容来源三分：`teacher_authored`、`model_assisted_real`、`model_assisted_simulated`；模拟结果不会冒充真实 API。模型不可用只返回可见错误并允许本地降级，不自动消耗预算重试。
- T02 计划内定向 52/52，最终合并 local/model/service/DeepSeek/G07 failure/IPC/schema 为 89/89，G07 failure + materials 另跑 36/36；typecheck、lint、diff 均通过。`verify:contracts` 实际执行后仍有 1 项失败，原因是历史 G11 证据不绑定当前 G12 commit/候选/输入哈希，留待 T04 追加验收重建。
- 下一步 G12-T03：实现 renderer 分步界面、移除 production `lesson.buildDemo`、加入受限课堂展示和实际 UI 纵向脚本。真实 API/WPS/签名/分发/真人教师复核仍保持阻断。

## G12-T03 当前状态

- “备下一课”已接通上下文→资料→本地/模型生成→软件审查→教师确认→五文件导出→一处修改→课堂展示；production `lesson.buildDemo` 已删除，课堂窗口不暴露路径/网络端点并要求当前审查修订。
- 已导出备课会话的一处修改会同步新 revision/review/bundle；未导出会话不能从课程页绕过准备状态机。模型失败只提供显式本地降级，不自动重试或消耗预算。
- 定向验证 59/59，加迁移/无障碍回归 31/31；全量 683 passed / 1 failed / 1 skipped。唯一失败仍是既有 G11 Markdown CRLF/LF 差异。typecheck、lint、build 通过；合同校验的唯一失败是旧 G11 证据对当前 G12 commit/候选/输入哈希失效。
- G12 Electron 纵向脚本已实现但尚未绑定 clean commit/候选实际执行，保持 NOT_RUN。下一步 T04 从提交后的 clean source 构建候选、运行脚本并创建新的追加验收，不覆盖历史运行。
- 真实 API、WPS、干净标准用户 Windows、签名/时间戳、分发和真人教师复核仍为 `BLOCKED_EXTERNAL/NOT_RUN`。

## G12-T04 当前状态

- 教师指南、G12 纵向合同、候选绑定 evidence validator、AcceptanceRun supplemental evidence 和发行来源白名单已实现；冻结 130+40 案例及其哈希没有修改。
- 新合同先 RED 后 GREEN；G12/G11 发行定向 84/84，全量 689 passed / 1 skipped；typecheck、lint、build 通过。Windows CRLF 只做公开文档比较规范化，文件哈希门没有放宽。
- 当前旧 G11 发行证据对 G12 源码和候选已漂移，`verify:contracts` 仍有 1 项真实失败。下一步必须先提交 T04，随后从 clean HEAD 执行 `build:candidate`、G12 Electron 纵向、Node ABI 恢复、带 `--g12-evidence` 的新增 acceptance run，以及 release evidence/SBOM/verify；历史运行不得覆盖。
- G12 本地工程完成不等于正式发行：真实 DeepSeek、WPS、干净标准用户 Windows、签名/时间戳、分发、合法现用教材和真人教师复核仍按实际证据保持 `BLOCKED_EXTERNAL/NOT_RUN`。
- 首个 `3019830` 候选纵向运行真实失败于展示审查指针不一致，未记 PASS。修复已让五文件导出同步发布阶段的新 `reviewReportId`，回归先红后绿；必须提交该修复后重建候选并从头重跑。
- `5acf2cf` 候选的 G12 Electron 纵向已通过，但追加验收 runner 在落盘前暴露 worktree 依赖定位缺陷；没有生成或提升运行记录。现已改为按项目 Node 模块解析层级寻找 Vitest，回归先红后绿；提交后仍须重新构建并绑定新候选，不能复用 `5acf2cf` 证据。

1. 提交 E10，保留第四轮追加验收与 clean-source 发行证据；不要覆盖前两轮 FAIL 或其他历史记录。
2. 真实 DeepSeek 仅在出现不会暴露密钥的受保护输入通道后执行；WPS 仅在原生 UI 可控时执行。
3. 补齐干净标准用户 VM、Grok、签名/时间戳、可信分发、锁定环境、缺陷审计和真人教师复核后，再创建新的追加运行；当前不得发布。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
