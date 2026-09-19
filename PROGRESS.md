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

## CR-001 课堂 PPT 与讲义需求增补（独立业务变更，仅归档）

状态：**需求已归档 / 合同待实现 / 功能未实现**。独立命名空间 `CR001-R01–R24` + 验收 `CLS-001–040`（全部 NOT_RUN）；不重编 F01–F08 / R3 / R001–R060，不改冻结 `acceptance/cases.json`，不塞进 G00/G01，不改安装/安全/外部授权门。

- 归档：`docs/changes/CR-001/`（完整包）、`docs/changes/CR001_CLASSROOM_DELIVERABLES.md`、`planning/changes/CR001/{requirements,work-items,traceability}.json`、`acceptance/addenda/classroom-delivery.cases.json`（与冻结用例分离，`verify:contracts` 已识别并校验全部 NOT_RUN、无 ID 冲突）。
- 规范引用：`docs/ENGINEERING_SPEC.md` §15.4；决策 `docs/adr/ADR-0005`。
- 最终课堂交付正式定义：三类成品五文件（可编辑 PPTX + 学生讲义 DOCX/PDF + 教师讲解版 DOCX/PDF）；教案/学校格式保留但不替代。
- 实现落 G05–G07（映射 G06-T01..T04、G07-T02/T03），G09/G11 回归；严格 schema 不放宽（伴随合同/受控版本）。
- 授权不变：不构成公开上传/手动触发上传/扩大费用/合并 PR 的授权；自动上传仍暂停。

## PR#1 第三轮有限收尾（R3-01–R3-05，保持原 F 编号）

依据 `docs/reviews/`（第三轮核验包）。审查方 5 项残留复现 + 原 11 项，修复后用其自带 `run-residual.cjs`/`run-targeted.cjs` 对编译产物独立复现：**R3 5/5 + 原 11/11 全部通过**；仓库单测 **57 项通过**。

- R3-01（F03）：版本检查曾在写队列之外 → 新增 `LocalStore.saveDraftExpecting`，把版本检查+候选+写盘+提交+返回置于同一原子边界；`ipc.commitSaveDraft` 改用之。不同 key 同基线仅一个成功、另一个 VERSION_CONFLICT。
- R3-02/03（F02）：区分"确认不存在"与"存在但读取失败"；读取失败或隔离(rename)失败进入**保护态写屏障**，`saveDraft/saveDraftExpecting/saveWindow` 一律拒绝覆盖源文件；`persistBounds` 捕获异常不致崩溃。
- R3-04（F01）：`setContent` 不再解除冲突/阻塞；新增明确解决动作 `resolveKeepLocal`（提交前原子重查版本）/`resolveUseRemote`；界面提供两个按钮，普通打字不覆盖较新版本。
- R3-05（F07）：`isWindows11` 仅靠 build≥22000 会把 Server 2025(26100) 误判 → 引入 `ProductType`；无身份信息判 `windows-unknown`（不冒称 Win11）；主进程受控探测 ProductType 并把 targetSupported/identity 传入界面。
- CI/工件（7.1/7.2）：工作流改为**仅手动触发**（暂停对 push 的自动公开上传，待可见范围授权）；构建 `--publish never` + `publish: null` 显式禁自动发布；`reports/AUDIT.md` 分析 4 项 audit 均为 dev/test 链、不随产品分发，不 force 修复。
- 新 EXE：本地重建绑定修复提交产出新哈希（见 reports/WINDOWS_BUILD.md）；文件交付待批准渠道，未新增公开上传。

## PR#1 二次审查修复（原始 F01–F08，保持原编号）

依据 `docs/reviews/`（原始 F01–F08 + 二次审查 + 11 项定向检查）。审查方定向检查基线为 3 通过/8 失败；修复后用其自带 `run-targeted.cjs` 对编译产物独立复现为 **11/11 通过**；仓库单元测试 **48 项通过**。

- F01 关闭可靠保存：关闭协调器（唯一 requestId、等待在途、失败/超时询问用户而非静默 1.5s 强关、忽略过期回执）+ 跨页面单例草稿控制器（串行提交、加载竞争保护、冲突保留本地不隐式覆盖、订阅可释放）。运行时实测立即关闭仍持久化。
- F02 存储：写盘成功后才提交内存版本（T08）；坏 JSON/非法字段类型加载隔离原文件不覆盖（T09/T10）；串行 mutator 队列；每次返回自身提交快照（T11）。
- F03 版本/幂等：expected_revision 必填非负安全整数（T04/T05）；idempotency_key 绑定请求指纹、同键异载荷拒绝（T06）；同键并发在途去重（T07）；写盘失败可重试不缓存。
- F04 状态证据：health 分离设计保证/实测探针/未知；storage 实测写入探针；本地服务=设计保证（非端口扫描）；如实标运行模式/沙箱/损坏恢复。
- F05 生产边界：发送者顶层 frame + 缺身份拒绝；lockdown 区分开发/生产网络例外；外链规范化 https 策略。
- F06 版本：确认 Electron 44.4.3 为核查时稳定版，不为追新反复换版本；保留锁文件与回归。
- F07 平台判定：区分可运行/正式 Win11 目标/开发放行；打包版本禁用开发放行；os.release 判定 Win11。
- F08 测试与分期：11 项定向检查转正式测试 + 关闭/慢写/失败/竞争/冲突用例；测试名称与断言对应；ADR-0004 + `planning/ins-acceptance-mapping.json` 明确 INS 父子映射（父项全部子项通过前不 PASS），保留冻结用例。
- Windows：修复后重建未签名 EXE（SHA256 3e6c1c03…），新增原生 Windows CI 工件工作流；EXE 超工件渠道上限，交付走 CI，工件可见范围待确认。

## PR#1 首轮修复（历史记录）

- F01 保存：新增"关闭前刷新"主↔渲染握手 + 失焦/隐藏落盘，避免防抖丢失末次编辑；实测立即关闭仍保存。
- F02 并发：修复 `LocalStore.flush` 临时文件名仅含 pid 导致的并发 rename ENOENT 竞争（唯一 tmp 名 + 串行化写入），补并发写入回归测试。
- F03 幂等：真正实现 `idempotency_key` 去重（有界缓存），重放不重复递增/不误报冲突；渲染层按内容轮换稳定幂等键并串行化保存。
- F04 状态证据：`app.health` 增加真实 `build_mode/sandbox_enabled/platform_dev_override`，界面如实显示"开发验证/OS 沙箱已禁用"，不写死。
- F05 生产安全边界：权限请求全拒绝、生产禁用 devtools、`app.isPackaged` 门控开发服务器、发送者顶层 frame 校验、CSP 响应头、拦截非本地网络请求、`--no-sandbox` 告警。
- F06 Electron 版本：确认 31 已 EOL，升级至受支持的 44.4.3 + electron-builder 26.15.3。
- F07 验收分期：ADR-0003 明确 G01 工程验证 vs 干净 Win11 实机两级 + 四条证据线互不替代；INS-008 追加到 G01 验收（保留 G09，不降低要求）。
- F08 Windows 构建：产出未签名工程测试安装包 `YuwenDesk-Setup-0.1.0-x64.exe`（SHA256 见报告）。

## G02 本地安全数据基础 — IN_PROGRESS（起步，无外部依赖）

- [x] G02-T01 受限 IPC 及 **Schema 门**：声明式载荷 Schema 门 `src/main/schemaGate.ts`，`handle()` 分发前统一校验（类型/必填/多余字段 additionalProperties:false/超长；读操作拒绝夹带载荷）。修复字段白名单 `in` 继承属性误判（改 `hasOwnProperty`，拒绝 constructor/toString/__proto__）。测试 `schemaGate.test.ts`(11)。
- [~] G02-T02 真实 SQLite 存储与单写入者（**进行中，未标整体完成**）：`src/main/db/sqliteStore.ts`（better-sqlite3 13.0.3，WAL/外键/busy_timeout、user_version 版本迁移、`saveDraftExpecting` IMMEDIATE 事务原子乐观并发、`withTransaction` 失败回滚、旧 JSON 安全迁入并备份、integrity_check 保护态）。主进程 `index.ts` 已切换为 `SqliteStore`（经 `DraftStore` 接口）。
  - 本轮加固：**高版本 DB/未知结构拒写**（user_version>目标→保护）；**旧 JSON 读取/隔离失败→迁入保护**（不以空库覆盖）；**必需记录缺失/UPDATE 零行→抛出不假成功**；迁入标记与数据同一事务提交（可恢复一致）；**原件归档失败如实记录**（legacyArchive=failed，不吞掉后宣称完成）；**正常迁入(migratedFromJson) 与损坏恢复(recoveredFromCorruption) 分开表达**。
  - 实测：仓库单测 **104 项 PASS**（`sqliteStore.test.ts` 16 + 新增 `ipc-sqlite.test.ts` 6，经**真实 SqliteStore+IPC 路径**回归幂等/并发/冲突/失败保护，不依赖旧 LocalStore 说明不退化）；Electron 真实加载 PASS（加固版）；Windows 目标包运行 BLOCKED_EXTERNAL（未验证）。证据 artifact `g02_t02_hardening_evidence.txt`、`g02_sqlite_restored.png`。
- [x] G02-T03 凭据/敏感 payload 保护：`src/main/crypto/secrets.ts`（CredentialProtector 经 safeStorage 包裹凭据、只存密文+末四位；AES-256-GCM 敏感载荷，随机 96 位 nonce 不复用、AAD 绑定工作区/对象/版本；DataKeyManager 封装数据密钥）。加密不可用→拒绝落明文；解密失败→不覆盖原密文。接入 SqliteStore（migration v3：credential/secure_key/sensitive）+ 主进程注入 electron.safeStorage + health `credential_encryption` 界面如实显示。
- [x] G02-T04 持久幂等 + 业务事件事务：`commitDraftSave` 将 草稿修改 + 持久幂等结果 + outbox 事件 置于同一 IMMEDIATE 事务；跨进程/重启重试不重复修改；同键异请求 key_reuse；任一必要步骤失败回滚。IpcService.saveDraft 已委托之（幂等落存储层）。
- **G02 本地可执行数据能力已交付并联合验证**：Node 128 项 + 真实 Electron 运行（SQLite 保存/迁移/保护/冲突/重载 + 凭据探测 + outbox 单事务）。既有保存/并发/关闭/来源边界/权限经真实 SqliteStore+IPC 回归未退化。证据 artifact `g02_capability_evidence.txt`、`g02_full_run.png`。
- **未通过外部门**：Windows 目标环境验收（EXT02）BLOCKED_EXTERNAL。依赖后续门（不在 G02 范围）：凭据用户入口 provider.configure IPC/设置界面属 G04；敏感 payload 业务落点（学生材料）属 G03。

### G02 保护加固补丁（同批次，保留已通过正常路径）

- **T03 敏感读取加固**：新增只读 `readDataKey()`，`getSensitive` 改用之——**读取不自动创建/替换数据密钥**（无密钥→not_found，不生成 secure_key）；有密钥但解不开**不替换**。凭据/敏感读取**遇存储保护态直接拒绝**（不穿透）。
- **T03 不安全后端拒绝**：新增 `isSecureSafeStorage()`，`basic_text`/`unknown` 降级后端视为不可用；`credentialEncryptionAvailable/protect/wrap` 均基于安全后端——明确拒绝不安全的 safeStorage 降级。
- **T04 中途故障回归**：`commitDraftSave` 增测试用中途故障注入点（草稿更新后 / outbox 写入后 / 幂等写入前）；验证任一处失败时**草稿+outbox 事件+幂等结果一起回滚**，不改事务主路径。
- 测试：`credentials-sqlite.test.ts`(10，含不安全后端拒绝/读不建密钥/读不穿保护态)、`sqliteStore.test.ts`(24，含三处中途故障回滚)。仅用虚构数据，不涉真实凭据/学生资料。

## G03 资料导入 / 中文搜索 / 原文定位 — 核心闭环已交付（IN_PROGRESS）

- [x] **数据基础**：SqliteStore 迁移 v4（`source_document` / `source_version` / `source_text` + FTS5 **trigram** 虚表）。
- [x] **导入 + 来源版本与哈希**：`importSource` 计算 SHA-256 内容哈希；按标题**去重**（同哈希→duplicate，不新增版本）；内容变更→**新版本**并标记 `versionConflict`；空/超限拒绝；敏感分类需安全后端否则**阻塞**（普通非敏感继续）。单事务写入。
- [x] **提取与精确定位**：抽取全文入库并建 FTS 索引；检索返回**精确锚点**（char_start/char_end/line）+ 上下文；`readSource` 按锚点跨度定位或受限预览。
- [x] **中文搜索 + 短词回退**：≥3 字用 FTS5 trigram；1–2 字短词**回退 LIKE**（含标题）；仅命中活跃当前版本。
- [x] **停用 + 重启恢复**：`retireSource` 停用后不再命中；SQLite 持久化，重开连接资料与检索恢复（停用状态持久）。
- [x] **界面（复用资料页）**：原生文件选择 + 拖拽导入 txt/md/csv（渲染层 `file.text()` 读取，不暴露 fs/dialog）；导入结果提示；检索框（短词回退）；结果卡片（标题/版本/行号/字符跨度/上下文）；查看原文弹层；已导入列表（分类/版本/状态/哈希）+ 停用。
- [x] **IPC**：白名单新增 `sources.import/list/search/read/retire` + schemaGate 载荷校验；`IpcServiceContext.sourceStore`；preload 命名方法。
- **实测**：Node 单测 **151 项 PASS**（新增 `sources.test.ts` 11 + `ipc-sources.test.ts` 6）；**真实 Electron 端到端**（真实 preload+渲染层+IPC+SqliteStore，合成 drop 走真实拖拽路径）跑通 导入→去重→新版本→中文检索(FTS)→原文定位→短词回退→无结果→停用→停用后不命中→**重启恢复**，`better-sqlite3`+FTS5 trigram 在 Electron ABI 下验证通过。证据：`/opt/cursor/artifacts/g03-walkthrough.mp4`、`g03e2e-*.png`、`g03e2e-transcript.json`。
- **本轮范围内格式**：txt / md / csv（自拟非敏感文本）。**未做（G03 剩余）**：PDF / DOCX / XLSX / PPTX 解析导入；扫描件——**不以扫描件预览冒充可靠文字识别**，OCR 未接入即视为不可靠文字，阻塞；不用模型摘要代替原文定位。敏感样例导入待 **G02 安全后端**在目标平台可用后接入（当前 headless Linux 无安全后端→敏感功能阻塞，普通资料继续）。
- **未通过外部门**：Grok `provider.configure/probe/clear` 真实连接属 G04；缺安全后端时敏感资料落点阻塞（依赖 Windows 加密后端）。

## G04–G11 — NOT_STARTED

Grok 与任务、教学业务 M01–M12、材料交付（含 CR-001 三类五文件，落 G05–G07）、审查与修改、反馈与纠正、备份恢复、升级性能、发布验收，均未开始。界面相应页面标注"后续版本开放"。

## 下一步

见 `HANDOFF.md`。G03 剩余：富格式（PDF/DOCX/XLSX/PPTX）解析导入与扫描件可靠性边界；敏感样例在安全后端可用后接入。外部门保留：G01 目标环境安装验收、Windows 加密、正式签名、真实 API、公开上传授权。
