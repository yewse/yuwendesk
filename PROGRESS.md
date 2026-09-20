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

## G03 资料导入 / 中文搜索 / 原文定位 — 真实原始文件闭环已交付（IN_PROGRESS）

### 第二批（真实原始文件 PDF/DOCX/XLSX/PPTX + 策略修正）

- **策略修正**：敏感（student_sensitive）在完整加密资料路径实现前**无条件阻塞**（不写入普通存储）；分类**严格枚举**未知拒绝；缺省分类为 `teacher_private`（本地私有不外发，不默认公开）。版本关系：同标题仅**疑似关联**，返回 `needs_confirmation`，不自动新增版本/切换当前版本；显式 `new_version`（保留旧版本、切换当前）或 `separate` 才落库。
- **真实文件导入**：`importFile`（base64）走 `src/main/sources/extract.ts`：PDF 逐页（pdfjs）、DOCX 段落/表格单元格（jszip+fast-xml-parser）、XLSX 工作表/行/列、PPTX 幻灯片页；txt/md/csv 行/行段。教师直接导入 Word/PDF，无需先转 Markdown。
- **原件保存 + 双哈希**：原件字节存 `source_file`；**原件哈希与文本哈希分开**（版本/来源面板可核对）。去重按原件哈希。
- **可核对结构化定位**：`source_segment` + 段级 FTS，命中定位到页/段落/表格行列/幻灯片，返回结构化 locator + 段内锚点 + 上下文 + 可读标签，不以统一文本行号冒充所有格式位置。
- **扫描件**：无可提取文字页标记 `scanned/不可靠`，可保留与在列表/版本面板显示，但**不参与可靠检索**、不做 OCR、不以预览/摘要冒充原文核验。
- **限额/分批/可取消**：原始文件上限 40MB；界面逐文件导入带进度与取消（文件间可取消），保留响应。
- **实测（真实 Electron，真实 PDF/DOCX 文件）**：合成拖拽(Phase A) 与 **真实文件选择(Phase B，CDP setFileInputFiles 触发真实 `<input type=file>` onChange)** 分别记录；PDF→第1页、DOCX→第2段、表格→第2行第1列定位；扫描件唯一词 0 可靠命中；同名不同内容→需确认→新版本 v2（原件/文本哈希分列）；敏感→PRIVACY_BLOCKED；重启恢复列表与检索。Node 单测 **163 项全通过**（新增 sources-file 8、ipc-sources versions 等）。证据：`/opt/cursor/artifacts/g03-files-walkthrough.mp4`、`g03f-*.png`、`g03f-transcript.json`。
- **支持格式清单**：txt / md / csv / pdf / docx / xlsx / pptx（真实文件）。
- **明确未验证项**：headless X11 下**原生 OS 文件选择对话框的弹出渲染**未确认（已尝试；不断定必为环境原因；已用 CDP 在 `<input>` 层驱动真实选择路径证明解析与检索不受其阻塞）。敏感学生材料加密业务落点未实现（阻塞）。Grok 连接属 G04。

### 第一批（自拟文本 txt/md/csv 核心闭环）

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

### G03 边界收尾（第三批）

- **来源准确性(G03-B)**：XLSX/PPTX 改为按 `workbook.xml`/`presentation.xml` 显示顺序 + `.rels` 解析真实工作表/幻灯片（不按内部文件名数字，补调序办公文件测试）。检索**标题命中(matchKind=title)与正文命中(matchKind=body)分开**；正文未定位到具体位置时 `anchor=null`（不制造精确锚点）。新增**原件核对途径** `readOriginal`（返回原件字节+原件哈希，界面“核对原件”本机重算 SHA-256 比对）。
- **处理边界(G03-A)**：完整读取前**初步大小检查**；解析施加**页数/zip 条目/文本量/处理时间上限**；解析移至 **worker 线程**不阻塞主进程；区分**停止后续**与**取消当前**，取消传播到解析与提交边界，已取消任务不静默入库。
- 测试：sources-file/sources-boundary 覆盖调序定位、标题/正文、原件重算一致、限额(页/条目/文本)、取消(解析中/提交前)、初步大小不解析即拒。

## G04 模型调用闭环 — 已交付(测试替身链路)（IN_PROGRESS）

- **可配置服务商，不绑定 Grok**（ADR-0005）：`test-double`（本机确定性、明标非真实，打通本地链路）与 `deepseek`（默认 `deepseek-flash`，真实联网未授权→BLOCKED，不伪造）。开发智能体选型与产品运行模型分开。
- **提示词工程**作为正式能力：稳定原则+任务模板(analyze_text/lesson_outline)+学科方法+正反例+输出合同，`PROMPT_VERSION` 版本化；教师不写提示词。
- **配置/探测/密钥保护/预算**：密钥仅经 safeStorage 保护（无安全后端拒存→真实不可用）；预算上限 `BUDGET_EXCEEDED`。
- **上下文边界**：仅**显式获准、非敏感、版本未停用**的片段进入模型上下文，记录引用；私有默认不外发；敏感 `PRIVACY_BLOCKED`。
- **缓存/取消/超时/重试/持久化/重启不确定态**：相同任务/模型/提示/参数/材料版本→缓存复用不重复生成；取消/超时/退避重试；作业持久化(记模型/提示/参数/材料版本)；重启时 running→uncertain。
- **实测**：Node 单测 **194 项**（新增 model 12、ipc-model 5）；真实 Electron e2e：测试替身配置+探测可用、DeepSeek 探测/运行 BLOCKED(不伪造)、获准片段结构化分析(明标测试替身)、未获准 INPUT_INVALID、缓存复用、重启后配置/作业持久。证据 `/opt/cursor/artifacts/g04-walkthrough.mp4`、`g04-*.png`、`g04-transcript.json`。
- **未验证/阻塞**：真实云 API（DeepSeek 等）需授权账户与联网 → 保持 BLOCKED/未验证；真实能力/参数/费用以接入时验证为准。数据/检索/业务本地，无远程向量数据库。

### G04 真实协议适配 + 保护收尾（第五批）

- **DeepSeek 真实协议**：`createDeepseekProvider(transport)` 实现 `/chat/completions` 请求构造(Bearer/messages/temperature/max_tokens/stream)、非流式与 **SSE 流式解析**、**错误映射**(401/403→AUTH_FAILED、429→RATE_LIMITED、5xx/传输异常→NETWORK_UNAVAILABLE、非JSON→MODEL_NOT_AVAILABLE)、用量与成本。传输**可注入**以离线测试，**禁止测试实网**；生产默认真实 fetch。真实账户联网烟测保持 BLOCKED/未验证。
- **输出合同真实校验**：`validateContract` 对模型正文做 schema + 引用区间校验；**非法JSON/缺字段/截断/越界引用**一律判不合格(EXPORT_INVALID)，**不进入可用成功缓存**；测试替身遵守同一合同。
- **上下文边界**：`readExactRange` 按批准版本与区间**精确读取**（不复用带未授权前后文的展示预览）；超单片段上限/越界→INPUT_INVALID(不静默截断冒称完整)。
- **保护收尾**：派发前**联网授权**(allowRealNetwork+受保护密钥，否则不发起)；**预算预留(running 计入)与结算**(succeeded 实际/uncertain 保留/明确未发生才置0，不因“失败”直接认定未计费)；**相同任务在途去重**；**取消后迟到结果不提交为成功**(cancelled 不缓存)；**超时→uncertain(REQUEST_UNCERTAIN)** 费用不确定；**探测遵守授权与预算**。
- **实测**：Node 单测 **211 项**（新增 model-deepseek 8 离线协议、model-protect 9 边界/去重/取消/超时/预算/探测；含既有 G04 定向检查转正式回归）；真实 Electron e2e：DeepSeek 真实协议经 App IPC **离线注入传输跑通**(provider=deepseek、isTestDouble=false、结算成本)，真实实网仍未验证。证据 `/opt/cursor/artifacts/g04b-walkthrough.mp4`、`g04b-*.png`、`g04b-transcript.json`。

### G04 保护收尾（第六批）+ G05 完整 LessonPlan + G06 首套三类五文件

- **G04 收尾**：取消/费用分离（已派发取消→费用不确定，保留预留额；未派发→0）；未知用量/已派发后网络异常→uncertain 保留预留，不自动按零结算；预留含 输入+输出+重试(×(retries+1))+探测余量；**模拟费率与真实价格分离**（PricingConfig：币种/来源/生效时间/isEstimate）。取消/超时经 **AbortSignal 传播到传输层**；**真正增量流式**（async-iterable 分片消费）+核对 finish_reason 与 [DONE]，**截断/未完成不入可用成功缓存**；探测遵守授权与预算。**内容来源身份**（real/offline-injected/simulated）随 result/缓存/成品传递——经 DeepSeek 适配器的离线注入仍标 offline-injected（模拟内容）。补齐输出合同类型/必填/数值/异常检查。
- **G05 完整 LessonPlan**：`lesson/build.ts` 按 `contracts/LessonPlan.schema.json` 组建 objectives/tasks/rubrics(criteria: acceptable_variants 合理答案 + insufficient_examples 误解)/activities(actor+student_action+teacher_action+start/end_sec 时间与角色)/source_anchors(文本依据)/homework/unknowns；`validateLessonPlan` 校验时长≥300、minItems、角色枚举、anchor/rubric 引用。迁移 v7 lesson_plan/lesson_revision（修订链+content_origin）。lesson_outline 仅中间产物，不作最终成果。
- **G06 三类五文件**：`materials/generate.ts` 确定性生成 课堂 PPTX + 学生 DOCX/PDF + 教师 DOCX/PDF。**角色隔离**（教师合理答案/误解/教师动作/追问/小结仅教师版；学生版与投屏 PPTX 不含）；**版本一致**（内嵌 plan_id/revision_id/内容来源）；**一处修改联动**（成品为计划修订的纯函数）。迁移 v8 material_artifact 清单。
- **实测**：Node 单测 **220 项**（新增 materials 7：build/validate、生成回解析、角色隔离、版本一致、一处修改联动、PDF 角色隔离；model-deepseek/model-protect 扩充）。真实五文件工件 `/opt/cursor/artifacts/materials/`（回解析验证角色隔离/版本一致/一处修改联动全 true）。真实 Electron UI e2e：组建自拟完整计划→生成三类五文件→清单（版本水印/内容来源标注）。证据 `g06-walkthrough.mp4`、`g06-*.png`、`materials/MANIFEST.json`。
- **未验证/阻塞**：真实模型备课质量未通过（需真实 API 授权，保持 BLOCKED；自拟/模拟内容明确标注不冒充）；生成的 PPTX/DOCX 由本管线回解析验证结构有效，真实 Office 保真未用 Office/LibreOffice 验证（环境无）；一处修改联动的跨成品自动重生成流水线（G07）尚未接入 UI 自动触发。

### G05 课时计划接入（依赖满足部分·历史）

- 任务/方法示例/**课时计划合同** `lesson_outline.v1`（objectives/steps[stage,minutes,activity,citations]/notes），受同一输出合同校验；资料页“生成课时计划”按获准片段生成，**模拟结果明确标注“测试替身（非真实模型）”**，不冒充真实备课；教师不写提示词。无授权不调用真实 API。

## G07 审查与一处修改 — DONE（四包本地工程范围；外部验收门仍 BLOCKED_EXTERNAL）

- [x] **G07-T01 确定性审查层与严格 ReviewReport**：新增 `reviewLessonPlan`，将现有结构/引用/时间/来源核验问题映射到明确返回模块；冲突来源阻断发布，待核验来源保留教师审查；`is_effectiveness_proof` 固定为 `false`，不把软件就绪冒充教学有效。运行时校验拒绝缺字段、多余字段、非法枚举/类型与效果证明声明。
- [x] **审查持久化与窄 IPC**：SQLite migration v9 一次建齐 G07 的 `review_report/change_proposal/material_bundle/lesson_change_idempotency` 表及 `material_artifact.bundle_id`；审查报告保存、跨重启读取前重新严格校验。`review.run` 支持指定修订，Schema 门拒绝多余字段，缺修订返回 `SOURCE_MISSING`，保护态返回 `DATABASE_LOCKED`。
- **本包实测（Node 22.23.2）**：`review.test.ts` 6 + `g07-review-store.test.ts` 5 定向通过；主/渲染 TypeScript、ESLint、`verify:contracts` 通过；全量 Vitest **237 passed / 1 skipped（238 total，25 files）**。跳过项为既有 LibreOffice 环境条件用例，不改为通过。
- **未执行/外部门**：真实模型语义审查、教师专业复核、Office/WPS 保真分别保持 `NOT_RUN` / `BLOCKED_EXTERNAL`；Windows 目标安装、真实 API、正式签名门不因本包改变。npm 原生依赖重装在本机缺 ClangCL 工具链时失败，但锁定 Node 22 的现有 `better-sqlite3` 绑定已由真实 SQLite 测试通过；不把安装失败写成通过。
- [x] **G07-T02 依赖失效与受控一处修改**：`change_duration` / `increase_independent_time` / `remove_link` / `edit_task` / `edit_rubric` / `presentation_only` 为闭合请求联合；运行时拒绝未知字段、未知枚举、越界时长/字号与超长文本。修改基于 `structuredClone` 保持无关稳定 ID；缩短课时先处理非核心活动且不自动增加作业；联读删除同步清理专属任务、量规、时间线引用；题意与合理答案范围同步。严格 `ChangeProposal` 不塞伴随元数据，失效模块按设计固定映射。
- [x] **原子接纳与跨成品发布**：五文件先写入 `.staging/<bundleId>`，逐文件重读并核对 SHA-256，再提升到 `<revisionId>/<bundleId>`；SQLite 单一 `IMMEDIATE` 事务提交候选修订（仅语义变更）、accepted proposal、ReviewReport、bundle、五条 artifact、幂等结果与 current pointer。旧修订/旧包保留；同键同指纹跨重启重放原结果，同键异载荷拒绝，两个键竞争同一基础修订恰一成功。纯呈现修改保持语义 revision，并让字号/纸张/主题实际进入 PPTX/DOCX/PDF 生成与新的呈现规格哈希。
- [x] **窄 IPC**：新增 `change.preview` / `change.apply` / `change.history`；预加载仅暴露命名方法。`change.apply` 强制幂等键；嵌套 change 多余字段也拒绝；版本冲突/键复用/来源缺失/审查阻断/存储保护/文件写入分别映射到现有错误码，不暴露任意文件系统能力。
- **本包实测（Node 22.23.2）**：`change.test.ts` 6 + `g07-change-sqlite.test.ts` 5 定向通过；全量 Vitest **248 passed / 1 skipped（249 total，27 files）**；主/渲染 TypeScript、ESLint、`verify:contracts`、Vite renderer build 与 main/preload build 均退出 0。真实临时目录验证五文件存在且哈希一致。JOB-002/003/006 与 CLS-021/022/023/038 获得机器可执行覆盖，但冻结验收状态未擅自改为 PASS。
- **未执行/外部门**：真实 Office/WPS 打开与视觉保真、真实模型复核、Windows 目标运行仍为 `NOT_RUN` / `BLOCKED_EXTERNAL`；正式签名与真实 API 门不变。
- [x] **G07-T03 单方案最少选择 UI（代码与自动化范围）**：“我的课程”每次仅激活一种受控修改；显示一份提案、受影响模块/三类五文件和字段级差异；一次确认复用同一稳定幂等键，并以同步在途锁防双击生成新键。成功显示语义修订是否变化、五文件名/完整哈希、ReviewReport disposition/未执行检查、旧修订仍可用与历史；失败保留当前清单并显示“旧版未受影响”及 next_action。题意/答案/联读等变化触发固定纸本重印提醒，纯版式不触发。页面不显示“已授课”或效果通过声明。
- **本包实测（Node 22.23.2）**：`lessonChangeView.test.ts` 3 + `g07-change-sqlite.test.ts` 5 定向通过；全量 Vitest **251 passed / 1 skipped（252 total，28 files）**；主/渲染 TypeScript、ESLint、Vite renderer build、main/preload build、`verify:contracts` 均退出 0；renderer 源码与构建产物远程 URL/localhost 扫描无匹配。
- **开发态 Electron 走查：BLOCKED_EXTERNAL**。当前依赖安装为 `--ignore-scripts`，仓库无 Electron 二进制/既有 `.exe`；尝试补齐锁定 Electron 44.4.3 时下载约三分钟无输出且未产生文件，已终止。未伪造启动、点击、截图或 Win11/Office 证据；CLS-027/031/039 保持 NOT_RUN。
- [x] **G07-T04 整包 fail-closed 与一致性回归**：新增发布前 `reviewMaterialSet`，重算五文件哈希并重解析 PPTX/DOCX/PDF，检查精确三类五文件、plan/revision、学生/PPT 角色隔离、任务/答案同步；PDF 中文/ASCII 混排改用分段字体，确保“方案 A/B”等文本可精确回读。`LessonChangeService` 在暂存前执行整包审查；旧 `materials.generate` 不再吞写盘/DB 错误，改用同一暂存、回读哈希、原子改名和专用 `commitMaterialBundle` 事务。
- [x] **故障恢复与持久重试截止**：逐点覆盖 5 次写入、5 次回读、目录改名和 6 个 SQLite 事务边界；任一失败均不推进候选修订、当前指针、bundle 或 artifact，并清理候选目录。同键同指纹连续 3 次失败后持久化 `failed_final`；第 4 次直接返回可靠基线且不再生成/写盘，同键异载荷仍拒绝且不增加计数。
- **本包实测（Windows 11 开发主机，Node 24.15.0）**：`g07-bundle-failure.test.ts` 20、`materials.test.ts` 16、`g07-change-sqlite.test.ts` 5 均通过；全量 Vitest **279 passed / 1 skipped（280 total，29 files）**；主/渲染 typecheck、ESLint、合同校验、renderer/main build、`git diff --check` 均退出 0。一次实际自拟材料包的五个 SHA-256 与命令记录见 `reports/G07_EVIDENCE.md`。pdfjs 仍输出可选 canvas/standardFontDataUrl 警告，但相应文字抽取断言通过；不把它当 Office/WPS 保真证据。
- **外部门保持分离**：开发态 Electron UI（锁定包缺二进制）、干净 Win11 标准账户安装、真实 API 语义审查、PowerPoint/WPS/Word 视觉保真、正式签名均为 `BLOCKED_EXTERNAL`。冻结验收定义与 NOT_RUN 状态未删除、未伪改为 PASS。

## G08 反馈与教学纠正 — 本地工程范围完成（T01–T04）

- [x] **G08-T01 采用与实际授课分离**：新增严格 `TeachingEvent`（实际时间、时长、完整/部分/中止、可选临场调整），不含采用状态或有效性字段；事件绑定已存在的课时修订，但不改变 `lesson_plan` 当前修订或发布状态。
- [x] **反馈流存储边界**：SQLite schema v10 一次创建 G08 表；`recordTeaching` 在 `IMMEDIATE` 事务内完成来源核对、expected revision、持久幂等、事件写入与反馈流递增。同键同载荷跨重启重放不重复写，同键异载荷拒绝，同基础版本两个不同键仅一个成功。
- [x] **命名 IPC 与 UI**：`plans.recordTeaching` 强制 expected revision 与幂等键；`feedback.history` 只读返回反馈流版本、授课历史和 `knowledgeState: unknown`。预加载不暴露通用 invoke。“我的课程”分别显示采用/授课状态，表单阻止双击并复用未变化提交的幂等键；记录后明确提示不会自动认定采用或教学有效。
- [x] **G08-T02 可选观察与透明样本范围**：新增未改动既有 `Observation` 的严格伴随合同 `ObservationOutcome`；四种结果、提示程度、材料关系、延迟、样本数/总体数/选择方式和覆盖限制分开保存。只有已记录 `TeachingEvent` 的课时才能新增观察；跳过不落库并保持 unknown。
- [x] **隐私与删除边界**：Observation 强制 `sensitive_payload_ref=null`、`cloud_allowed=false`；IPC 不接受原始作品、任意路径或额外字段，本地保守规则阻断显式姓名字段、明显手机号/证件号。删除必须经主进程原生确认签发的短时绑定 token；正文与结果在一个事务内删除，仅保留无正文墓碑并明确外部/离线备份未覆盖，失败则原记录与反馈流版本均回滚。
- [x] **可选反馈 UI**：实际授课后显示一次四选反馈；“暂不反馈”只关闭本次卡片，不写成功/失败。样本明细默认折叠，但选择方式与覆盖限制始终可见；典型/自愿/未知样本不显示全班百分比。历史可经再次原生确认删除。
- [x] **G08-T03 确定性测量门与模型辅助归因**：新增固定五项 `MeasurementReview`（目标对齐、评分可用、任务可比、样本覆盖、实施条件）。任一关键项为 fail/unknown 即持久化 `needs_measurement_review` 并保持 provider 调用为 0；同题、即时、完整示范和非代表样本只形成明确推断限制，不冒充迁移、延迟保持、独立表现或全班结论。
- [x] **归因隐私与严格合同**：新增 `TeachingAttribution` 严格合同和字段白名单 `AttributionContext`；服务层逐字段派生稳定 ID、结构枚举和受限样本元数据，不序列化 Observation JSON、观察摘要、临场调整原文、原始作品、身份、联系方式、任意路径或来源正文。模型结果仅允许六类待验假设，强制限制、反证/撤回条件、退回模块和 `is_effectiveness_proof=false`；比例/排名、人格/智力/家庭归因、永久标签、因果保证、未知字段和虚构观察引用均拒绝。
- [x] **复用 G04 保护并持久审计**：`teaching_attribution.v1` 通过现有 provider、受保护密钥、联网授权、预算、缓存、超时/取消/重试和内容来源身份运行；凭据型 provider 还须逐次 `dispatchConsent=true`。测试替身固定输出两个模拟假设；DeepSeek 只以离线注入传输验证协议并保持 `offline-injected`。测量快照、running 记录、输入哈希、反馈流版本和幂等状态分阶段落库；迟到结果在流变化后标 `stale`，不用于当前纠正；损坏持久 JSON fail-closed。
- [x] **命名 IPC 与 UI**：新增严格 `feedback.analyze`，只接受计划/授课/观察稳定 ID 与逐次派发许可；`feedback.history` 在存在分析历史时返回测量与归因记录。界面始终先列测量检查，再显示内容来源、待验假设、限制、反证和退回模块；模拟/离线身份与未执行的真实 API/教学专业复核持续可见，不显示教学有效分或证明措辞。
- [x] **G08-T04 最小纠偏与可逆决策**：严格 `CorrectionProposal` 复用 M12 字段；归因成功在同一完成事务中创建一份“先替换/缩减、再谈增加负担”的最小提案。原始提案不改写，接受/拒绝/撤回以追加事件重放当前状态；接受只返回类型化 G07 预览建议，不直接应用修订或生成材料。
- [x] **偏好/效果双轨与原子事务**：`PreferenceEvent` 和 `EffectEvidenceEvent` 分开追加；重复偏好不晋级效果。`repeated_support` 要求至少两个当前未删除的观察，并包含相似新材料/不同情境、延迟与独立完成条件；仍标非因果证明。决策事务同时校验反馈流版本、提案状态版本、幂等指纹和观察引用；五个中途故障点均整体回滚。
- [x] **严格 IPC、完整历史与纠偏 UI**：新增 `corrections.decide/revert` 命名 IPC 和预加载方法；嵌套事件拒绝多余字段。`feedback.history` 汇总当前观察、无正文墓碑、测量、归因、提案和双轨事件。界面完整显示替换/减少/预期/反证/正常任务复核，并以稳定幂等键支持“采用建议/不采用/撤回采用”；“交付偏好”和“效果证据”分栏，接受后明确还需 G07 预览确认。
- **T02 实测（Windows 开发主机，Node 24.15.0 / npm 11.12.1；全为虚构数据）**：定向 19/19；全量 Vitest **311 passed / 1 skipped（312 total，34 files）**；主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0。覆盖无授课拒绝、跨重启幂等、过期版本、插入/删除事务故障回滚、单次 token、内容无关墓碑和删除后 `deleted` 知识状态。
- **T03 实测（Windows 开发主机，Node 24.15.0 / npm 11.12.1；全为虚构数据）**：计划定向 50/50；全量 Vitest **331 passed / 1 skipped（332 total，37 files）**；主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0。覆盖测量阻断零派发、严格上下文/输出、真实 provider 无逐次许可零调用、模拟归因跨重启/幂等、DeepSeek 离线注入、非法/截断输出、超时费用不确定、流变化后 stale 和损坏持久结果保护读取。
- **T04 实测（Windows 11 开发主机，Node 24.15.0 / npm 11.12.1；全为虚构数据）**：计划定向 **25/25**；全量 Vitest **353 passed / 1 skipped（354 total，41 files）**；主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0。覆盖提案/双轨严格校验、接受/拒绝/撤回、跨重启幂等、五处事务故障回滚、只建议 G07 预览、删除观察后的新归因阻断、来源标签与冻结验收文件哈希。证据见 `reports/G08_EVIDENCE.md`。
- **状态边界**：机器测试只证明事件、事务、IPC、隐私守卫、离线协议与渲染代码边界，不证明一般匿名化能力、真实云模型解释质量、教师实际实施质量或教学有效性；冻结验收未改为 PASS。真实学生材料隐私授权与逐次外发许可、开发态 Electron UI 走查、干净 Windows 安装、真实 API 归因质量、教学专业复核、Office/WPS 保真与正式签名仍为 `BLOCKED_EXTERNAL`。
- 设计规格：`docs/superpowers/specs/2026-09-20-g08-feedback-attribution-design.md`；实施计划：`docs/superpowers/plans/2026-09-20-g08-feedback-attribution.md`。首版仍不保存学生原始作业正文；Observation 保持 `cloud_allowed=false`。

## G09 保护与恢复 — DONE（四包本地工程范围；外部门仍 BLOCKED_EXTERNAL）

- [x] **G09-T01 WAL 一致快照与原子发布**：新增 `protection` 领域；使用 better-sqlite3 Online Backup API，而非复制主 `.db`。快照经独立 `integrity_check`，删除全部 `credential` 行，再与应用登记的成果文件逐项重算 SHA-256；任何缺失/不符均不发布。备份先写 `.partial`，完整校验后原子改名 `.ready`，列表忽略半成品。
- [x] **日/周保留与自动触发**：成功业务写入后通知 `BackupCoordinator`，按本地日历日合并为每日最多一次；备份记录日/周标签，轮换保留最近 7 个日点和 4 个周点，并不删除唯一有效恢复点。自动备份失败不回滚已提交业务写入，维护错误保持独立。
- [x] **跨机认证加密**：便携 `.yuwenbackup` 为版本化 ZIP 载荷的 AES-256-GCM 整包信封；口令经运行时校准、参数有界的 scrypt 派生，最低 `N=32768,r=8,p=1`，拒绝短/常见口令。信封头作为 AAD；错误口令或 header/nonce/ciphertext/tag/KDF 篡改均认证失败，不返回部分明文。
- [x] **密钥迁移边界**：API 凭据永不进入同机或便携备份。便携快照移除原机 `secure_key`，将工作区数据密钥在整包内部再独立认证封装；恢复时只在目标 `safeStorage` 可用时重新包装。测试以两个互不兼容的伪机器后端证明敏感载荷可恢复、原机 DPAPI 式 blob 未复用、API 连接保持为空。
- [x] **旁路恢复与启动切换**：解密后先执行容器/条目/展开量/压缩比限制、固定路径白名单、manifest/hash、磁盘空间、schema 和 SQLite 完整性检查；通过后写 `restore-staging`。恢复确认令牌由主进程原生对话框签发，绑定 job/preview hash、两分钟有效且单次使用；登记 pending 后受控重启，在数据库打开前切换，失败自动还原 rollback。
- [x] **受限 IPC 与设置页**：实现 `backup.create/restore`、`backups.list/delete`，schemaGate 拒绝渲染层任意路径，预加载只暴露命名方法。设置页提供本机备份、跨机导出/恢复、已验证恢复点及删除；明确“忘记口令无法找回”“API 不迁移”“恢复需重启”。主进程返回值主动移除本机路径。
- **T01 实测（Windows 11 开发主机，Node 24.15.0；全为虚构数据）**：新增 30 项保护测试；提交前最终全量 Vitest **383 passed / 1 skipped（384 total，46 files）**；主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0。首次完整门禁发现并修复 1 个 ESLint 未使用参数问题，修复后完成上述全门禁复跑。冻结 acceptance 状态未修改。
- **外部门/未覆盖**：真实两台 Windows 机器跨机恢复、干净 Win11 安装后恢复、真实 DPAPI、生产进程监听检查、签名与真实学生数据仍为 `BLOCKED_EXTERNAL`。本包不把 Node 伪后端或代码检查冒充这些验收证据。
- 设计：`docs/superpowers/specs/2026-09-20-g09-protection-recovery-design.md`；计划：`docs/superpowers/plans/2026-09-20-g09-protection-recovery.md`。

- [x] **G09-T02 学生敏感资料认证加密**：SQLite migration v11 新增 `source_sensitive_payload`、无内容 `source_tombstone`、文件隔离登记与 `maintenance_idempotency`；`source_document.revision` 独立于版本号。敏感导入和普通→敏感升级使用工作区数据密钥、随机 96 位 nonce、AES-256-GCM 与只含 workspace/document/version 内部 ID 及 payload 版本的 AAD；原件、全文与结构段按固定 v1 载荷整体认证加密。文档内版本分类必须一致，跨分类新增版本 fail-closed，普通→敏感只能走整文档升级；安全密钥不可用即 `PRIVACY_BLOCKED/KEY_UNAVAILABLE`，绝不降级落明文。
- [x] **原子清理、派生去内容化与可恢复文件隔离**：升级先写密文，再逐界清理启用 FTS5 `secure-delete` 的两张索引、段、全文和 `source_file.original_blob`，换通用标题并推进文档修订号。精确引用的课时修订被去内容化并标 `valid=0/source_review_required=1`；相关 ReviewReport、ChangeProposal、材料包/文件、反馈、测量、归因、纠正、偏好/效果事件与模型缓存同时删除。受管材料文件先移入登记隔离区，SQLite 事务失败恢复原位；进程中断后启动按幂等提交状态恢复或清除。全部清理、依赖与幂等边界有故障回滚测试。
- [x] **永久删除与稳定备份范围**：多版本永久删除在一个 `IMMEDIATE` 事务内清除正文、FTS、原件、密文、版本、文档及派生内容，只留 document ID、原因码、时间、版本数、备份范围与无正文工作流状态。主进程双确认 token 绑定 workspace/document/独立 revision/受管备份集合/策略；删除前在备份排他锁内重扫范围，漂移即要求重新确认。manifest 的 source ID 从已完成快照读取，不再从随后变化的 live store 读取；删除后再次扫描并如实报告残留。
- [x] **崩溃可恢复的备份收尾**：数据库删除、受管备份处理、确定性删除后恢复点和最终结果分阶段持久化；启动时自动续做未完成阶段。删除后恢复点使用幂等确定 ID，已发布恢复点不会重复创建；授权范围内已先行删除的备份按幂等成功记录。损坏/不可读的 `.ready` 受管备份也保守纳入确认范围，并可按受管目录 ID 显式删除。外部/离线副本不可召回，SSD 物理擦除不作保证。
- [x] **窄 IPC、先预留幂等与 UI**：开放命名 `sources.reclassify/sources.prepareDelete/sources.delete`，严格 schema 拒绝路径、密文和额外字段；preload 仅暴露命名方法。已过期、已消费或范围失效的 prepare grant 不重放旧 token，同一幂等请求会在重新确认后签发新 grant；备份范围漂移映射为 `VERSION_CONFLICT` 并要求核对最新范围。`backup.create` 在发布副作用前原子写入 `running` 预留，崩溃后以 `incomplete` fail-closed，避免重复发布；便携口令只以工作区密钥 HMAC 后的摘要参与语义指纹，原口令不持久化。资料页使用独立 revision 进行并发确认，并分开显示数据库、受管备份、外部副本和介质擦除范围。
- **T02 实测（Windows 11 开发主机，Node 24.15.0；全为虚构数据与伪 safeStorage）**：代码复核发现的跨分类绕过、派生明文残留、FTS 残留、备份范围竞态、删除工作流续做、prepare grant 重放与不可读受管备份遗漏均逐项补测试并修复。最终重点定向 **45/45**；全量 Vitest **419 passed / 1 skipped（420 total，49 files）**。主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0；覆盖跨服务/跨重启幂等、全部清理边界、文件隔离回滚、备份范围漂移、快照/live 竞态、删除工作流重启续做和不可读备份的保守纳入/显式删除。既有跳过项未改为通过。
- **T02 外部门/未覆盖**：真实学生资料处理授权、真实 Windows DPAPI、真实设备 SSD/备份介质销毁、已外发/离线副本召回均为 `BLOCKED_EXTERNAL` 或能力外边界；真实 API 不接收敏感资料，真实模型辅助归因仍需逐次隐私授权；教学有效性仍待有资质教师专业复核。本包只证明本地工程边界，不宣称完成上述外部验收。

- [x] **G09-T03 白名单诊断与两阶段导出**：SQLite schema v12 只保存维护错误代码、时间与计数；诊断对象逐字段构造，仅含应用/平台、schema/保护/凭据加密布尔、固定对象计数、备份有效/无效计数、维护代码与错误代码聚合。输出错误码使用闭集，未知值统一合并为 `UNKNOWN`；标题、姓名式文件名、正文、路径、密钥、密文、prompt、模型完整 IO 和自由文本异常不进入预览。`diagnostics.export` 先返回规范 JSON 与 SHA-256，保存对话框返回后、ZIP 回读后及原子 rename 前均重算同一生成时刻下的当前状态；漂移返回 `VERSION_CONFLICT` 且不预留 running 幂等记录。渲染层不能提交路径，主进程原生对话框选址；ZIP 原子发布且精确只有 `diagnostics.json` / `README.txt`，无上传调用。保存幂等结果可跨服务实例重放，同键异摘要拒绝。
- [x] **集中故障边界与恢复保全**：`ProtectionFaultHooks` 只能经构造器注入，生产不从环境、IPC 或持久数据启用。覆盖 Online Backup 快照后、manifest 发布前、便携密钥封装后、pending marker 前、当前数据库/全部当前数据移入 rollback 后、敏感密文插入后、FTS 清理后、永久删除中途和诊断 rename 前。未发布 `.partial`/临时目录被清理或不可列出；SQLite 故障整体回滚。恢复逐项记录旧 DB/WAL/SHM/materials 的存在与移动状态；旧数据仅部分移动时只逆向恢复已移动项，全部移动后还须组件全集与原 DB SHA-256 可证明，才保全候选并恢复旧数据。发现既有 rollback/marker 或证明失败时停止并保留副本，不自动删除不确定数据。启动错误只显示固定中文恢复说明，不展示异常栈、路径或自由消息。
- [x] **维护重试截止与可见状态**：自动日备份连续三次失败后停止自动重试，持久记录 `AUTO_BACKUP_FAILED`、次数与时间；手动备份入口仍可用，成功后清零连续计数但不删除历史错误计数。手动备份/恢复只记录固定状态码，状态元数据写失败不反向改写已完成备份/恢复阶段。
- [x] **窄 IPC、设置页预览和样包说明**：新增单一命名 `diagnostics.export` 的 `preview/save` 动作，schema 拒绝任意路径和额外字段；preload 只暴露两个命名方法。设置页必须先显示完整 JSON 预览，再启用保存，并明确“不包含”范围与“不会自动上传”。`reports/fixtures/g09-diagnostics-sample/README.md` 记录全虚构夹具摘要、精确条目和生成命令；二进制只在临时目录生成并清理。
- **T03 实测（Windows 11 开发主机，Node 24.15.0；全为虚构状态、canary 与伪 safeStorage）**：计划定向 **93/93**；全量 Vitest **441 passed / 1 skipped（442 total，52 files）**。主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0；独立复审 Critical 0 / Important 0，结论 Ready。覆盖八类敏感 canary 搜索、真实 SQLite 全大写自由错误码闭集映射、ZIP 解包复核、零网络调用、保存对话框内状态漂移且零 running 预留、路径拒绝、跨实例幂等、数据库已移动而 materials 未移动的恢复故障、九类其余故障/重启恢复和三次自动重试截止。既有跳过项未改为通过；pdfjs 可选 canvas/standardFontDataUrl 警告仍如实保留。
- **T03 外部门/未覆盖**：诊断样包没有真实用户内容；真实学生资料隐私授权、逐次外发许可、真实 API 归因质量、教学专业复核、干净 Windows/DPAPI 跨机恢复、真实 Office/WPS、正式签名和开发态 Electron 真实窗口走查仍为 `BLOCKED_EXTERNAL`。不以 canary、Node 测试或构建产物替代这些验收。

- [x] **G09-T04 威胁边界验证**：IPC 信任判断绑定实际 BrowserWindow、sender id、精确 top-frame 对象和固定本地 URL，窗口导航只接受当前精确 URL；信封和嵌套对象必须是无继承字段的普通对象，字段闭集、长度和 Base64 语法在分发前校验，错误响应不回显攻击字段。模型 provider 的任意异常、路径、密钥样式文本和响应正文统一映射为闭集代码/固定中文说明，既不返回 renderer 也不进入持久错误码。提示注入仅作为资料字节处理，不能取得联网、备份或 IPC 权限；DOCM 宏、OOXML 外部关系、HTML/script 与 PDF URI 保持被动，测试期间无网络派发。
- [x] **归档攻击前置拒绝与恢复闭集**：公开 `preparePortableRestore` 路径在解压前解析 EOCD/中央目录，所有目录和文件都计入条目上限；拒绝多盘/ZIP64、原始及 Windows 大小写别名重复、尾点/设备名、符号链接、危险路径、local/central 名称/flags/method/CRC/size 不一致和数据范围重叠。解压采用流式单项/总量硬截止并复核实际展开量，不能靠低报中央目录大小绕过；恢复要求非 manifest 条目集合与 manifest 完全相等。hash/size/schema/SQLite 完整性在生成的隔离 staging 内校验，失败后清理；写入审计证明所有瞬时文件写目标也位于该 staging 根内，目标区和 staging 外无写入。
- [x] **证据与状态边界**：`reports/G09_THREAT_CHECKLIST.md` 保留逐项状态；SEC-006 因产品没有 URL 下载能力且尚无重定向逐跳集成面，诚实标 `NOT_RUN`，INS-008 与 DAT-002 所需生产监听/真实 Windows-DPAPI 跨机证据标 `BLOCKED_EXTERNAL`。冻结 acceptance 文件未修改，SHA-256 与基线一致；详见 `reports/G09_EVIDENCE.md`。
- **T04 实测（Windows 11 开发主机，Node 24.15.0 / npm 11.12.1；全为合成攻击样例与伪 safeStorage）**：最终重点定向 **111/111**；全量 Vitest **458 passed / 1 skipped（459 total，54 files）**。主/渲染 typecheck、ESLint、`verify:contracts`、renderer/main build、`git diff --check` 均退出 0；首轮独立复审的 4 项 Important 全部先以新增失败测试复现再修复，第二轮复审 Critical 0 / Important 0、Ready。覆盖认证信封篡改、路径穿越/绝对路径/UNC、原始及 Windows 别名重复、尾点/设备名、symlink、local/central 元数据不一致、目录/压缩/低报大小炸弹、额外条目、manifest/hash/size/path/missing、损坏 SQLite、未来 schema、瞬时写入路径审计、越权 sender/导航、原型继承载荷、模型异常去自由文本、token 过期/重放/跨对象、提示/宏/脚本/PDF URI 被动化与敏感文件名跨存储不可搜索。既有跳过项未改为通过。
- **T04 外部门/未覆盖**：真实学生材料隐私授权与逐次外发许可、真实 API 模型辅助归因质量、教学专业复核、生产进程监听动态证据、真实两机 Windows/DPAPI 恢复、开发态 Electron 窗口、干净 Win11 安装、Office/WPS 保真、正式签名及公开上传授权仍为 `BLOCKED_EXTERNAL`；本地威胁测试不替代这些门。

## G10 升级与性能 — IN_PROGRESS（T01–T04 本地工程包已完成，外部门未闭）；G11 — IN_PROGRESS（T01–T02 完成）

- [x] **G10-T01 签名更新清单和离线更新（本地工程范围）**：固定 `.yuwenupdate` 容器、闭集规范 manifest、Ed25519 已安装信任锚、app/platform/arch 与严格版本单调性、package size/hash 均已落地。生产信任集当前为空并 fail-closed；测试 keypair 只在进程内生成。原生选择不接受 renderer 路径，短时单次 token 绑定 manifest/current/target；确认时按句柄限额重读复验，只写固定 `.partial`，三个文件回读再跑签名/版本/hash 后原子发布 `.ready`。损坏 ready 不列出或重放；跨 service 同请求幂等、同键异包拒绝。设置页无绕过按钮并明确“已验证并暂存，未安装；不会自动关闭或重启”。证据见 `reports/G10_UPDATE_EVIDENCE.md`。
- **T01 测试**：55 项新增测试；重点门禁 74/74。首次全量因既有固定 IPC 白名单未登记 3 个新操作而 1 failed；独立复核首轮 Critical 0 / Important 3 / Not ready，三项以 RED 复现后改为流式整包处理、独立原子幂等 ledger、故障钩子后及 rename 后双重复验，并补严格闭集/superseded。第二轮 Critical 0 / Important 2 / Not ready 指出 ready/ledger 故障一致性与证据数字滞后；继续以 RED 覆盖发布后 ledger 丢失恢复、ledger 写入/改名失败回滚与 token 恢复、完整结果绑定和按序列化字节淘汰。第三轮复核 Critical 0 / Important 0、Ready。最终 **513 passed / 1 skipped（514 total，58 files）**；typecheck、lint、合同、build、diff 均通过。冻结 acceptance 哈希未变，状态未改为 PASS。
- **T01 外部门**：真实发布公钥/私钥托管与轮换、持有人签名服务、授权分发地址、真实签名安装器、SmartScreen 和干净 Windows 升级仍 `BLOCKED_EXTERNAL`；UPD-001 仅记本地工程证据，UPD-004 保持 `NOT_RUN/BLOCKED_EXTERNAL`。性能边界见 T04。
- [x] **G10-T02 迁移失败恢复与不兼容回退（本地工程范围）**：启动协调器只在旧 schema 时 checkpoint；先用 SQLite Online Backup 建立经 schema/世代/完整性/`credential`+`secure_key` 指纹验证的 `.ready` 恢复点，再迁移 staging 副本。严格 journal、空间余量、原库→rollback/候选→current 分相切换、切换后复验、失败候选保留、各 rename 崩溃点调和及既有 rollback 不覆盖均落地。候选写入 job 谱系标记并推进精确数据世代；完成态按谱系和历史完成线调和，正常业务写及后续同 schema 世代升级不误锁，缺库/旧库替换仍 fail-closed。G09 恢复把旧 journal/partial/lock 与旧库一起可回滚隔离，恢复旧备份后可重新迁移。
- [x] **旧版保护与可见说明**：任何启动维护/业务写前推进数据世代；未来 schema/世代保持可读并拒绝写，迁移恢复未决且当前库缺失时不创建空库。IPC 仅返回 `none/newer_data/migration_recovery/other`，健康页和设置页分别说明旧版未覆盖新数据、迁移待恢复及受支持导出/恢复边界，不承诺自动恢复旧程序。
- **T02 测试与复核**：新增迁移 17 项、降级保护 7 项；迁移+降级+G09 恢复重点 **31/31**。标准全量初跑在高并发下出现既有重型 PDF/ZIP 用例超时，相关三个文件单 worker 复验 **33/33**；保持 15 秒单测阈值与真实文件生成，把文件级 worker 固定为 2 后，最终标准 `test:unit` **537 passed / 1 skipped（538 total，60 files）**。typecheck、lint、合同、build、diff 均退出 0。独立复核首轮 Critical 1 / Important 5 / Not ready，逐项以 RED 修复；后续又捕获完成日志跨业务写/跨世代及恢复旧备份误锁，最终 Critical 0 / Important 0、Ready。证据见 `reports/G10_RECOVERY_EVIDENCE.md`。
- **T02 外部门/限制**：真实签名安装器、旧程序二进制恢复、干净 Windows 升降级、SmartScreen 与正式分发仍 `BLOCKED_EXTERNAL`。内部 journal/恢复 manifest 显式读取上限及迁移控制文件部分移动专用故障钩子为非阻断 Minor；真实 API 归因、隐私授权/逐次外发许可、教学专业复核和 Office/WPS 状态不变。性能边界见 T04。
- [x] **G10-T03 中文路径与辅助使用（本地工程范围）**：Windows 开发主机真实创建含中文、空格、组合字符与长度大于 150 字符的目录，实际跑通 SQLite、G09 本机/便携备份、另一 Unicode 根下的恢复 prepare→pending→apply、G10 离线更新 staging 和三类五文件原子发布；路径只经 `path` API 与固定根传递，不拼 shell 命令。renderer 新增 skip link、命名主导航/主要内容、`aria-current`、15 处异步 live message、显式表单标签和可持久化大字模式；modal 具名、初始聚焦、Tab 闭环、Escape 关闭与焦点恢复。主 shell/侧栏/内容区建立独立滚动和 `min-height:0`，980/700px 断点、大字单列/完整小字号覆盖、浅深背景双环焦点、强制色、warning 文本 4.5:1 对比门和 reduced-motion 分支均有自动合同。
- **T03 测试与证据**：首次 RED 中 Unicode/长路径 3/3 已通过，布局因契约模块缺失失败；后续又以 RED 固定 dialog Tab 闭环、opener 恢复、显式小字号、大字 label、浅深焦点环、强制色与 warning 对比。自动布局矩阵覆盖 1366×768、1920×1080 × 100/125/150% × 普通/大字共 12 行，明确只是断点预算模型。定向 **7/7**；全量 Vitest **544 passed / 1 skipped（545 total，62 files）**。typecheck、lint 已退出 0；独立复核最终 Critical 0 / Important 0、Ready。完整最终门禁与复核记录见 `reports/G10_ACCESSIBILITY_EVIDENCE.md`。
- **T03 外部门/限制**：冻结 `INS-007` 仍为 `NOT_RUN/BLOCKED_EXTERNAL`；自动 CSS/SSR/Node 文件系统证据不替代干净 Windows 11 的实际显示缩放、中文 IME、纯键盘、Narrator/屏幕阅读器和人工视觉走查。真实 API 归因、学生材料隐私授权与逐次外发许可、教学专业复核、真实两机 Windows/DPAPI、Office/WPS、签名、SmartScreen 和公开分发状态均未改变。
- [x] **G10-T04 冷启动、检索、生成核心性能与压力（本地工程范围）**：固定 LCG 种子 `20260920` 经真实 SQLite 计数生成 100 个计划、5000 个来源片段；长查询走 trigram FTS、短查询走 LIKE 回退。脚本记录环境、benchmark 源码 SHA-256、每次原始毫秒值、nearest-rank P50/P95，绝不删除离群值。逐样本原子更新 partial；中途异常写闭集 `FAILED` 并保留已完成样本；没有 partial 时 runner 以本轮失败标记替换旧 PASS。所有带阈值的计划/长词/短词/混合查询分别断言。
- **T04 工程测量（Windows 开发主机，Node 24.15.0）**：SQLite 打开 30 次 P95 420.444ms（无 Node 发布阈值）；计划打开+JSON 解析 30 次 P95 3.747ms（warm-cache，≤2000ms）；长/短混合查询 60 次 P95 99.405ms（warm-cache，≤1500ms）。三类五文件内存生成+确定性一致性复核 20 次 P95 1416.597ms、最大 7346.092ms，只标 `ENGINEERING_CORE_WITHIN_BUDGET`。它没有覆盖 staging、写盘、回读、原子发布，也没有证明 DOCX 在 Office/WPS 中约 10 页，故正式本地备课包导出仍 `NOT_RUN/BLOCKED_EXTERNAL`，不标 PASS。原始数组和矩阵见 `reports/G10_PERFORMANCE_RAW.json`、`reports/G10_COMPATIBILITY_MATRIX.md`。
- **T04 测试与复核**：固定夹具、nearest-rank 离群保留、逐样本 partial、runner 旧 PASS 替换、中断样本保留与终态归一化定向 **6/6**；完整 Vitest **550 passed / 1 skipped（551 total，63 files）**。typecheck、lint、`verify:contracts`、desktop build、`git diff --check` 均退出 0；benchmark 三份源码 SHA-256 为 `f15709bf63ed9410a9e47a0b1ec6bfbe9e529e7f8e13faa85d81c0b2fd104b27`，与 RAW/矩阵一致。独立最终复审 Critical 0 / Important 0 / Minor 0、Ready；既有跳过项未改为通过。
- **T04 外部门/限制**：真实 Electron 冷启动 30 次、Electron 总进程空闲内存、干净 Win11 8GB/SSD、正式 10 页 DOCX/20 页课件分别导出、Office/WPS 分页/视觉保真均 `NOT_RUN/BLOCKED_EXTERNAL`。Node/Vitest RSS 和 `SqliteStore.load()` 不替代上述门；真实 API 模型辅助归因、学生资料隐私授权/逐次外发许可及教学专业复核状态不变。

- [x] **G11-T01 全量验收账本与候选盘点（本地工程范围）**：新增闭集 `AcceptanceRunV1` 合同、symlink-safe 仓库相对证据路径与 SHA-256/size 回读、170 项显式映射、固定路径 runner、原子 JSON 发布和候选安装包盘点。冻结定义仍是 130 + 40 项且全部保持 `NOT_RUN`；`verify:contracts` 强制定义 ID 唯一、总数 170、状态未改以及映射无重复/遗漏/未知项。新增外部输入 `EXT10`（真实学生资料处理与逐次外发授权）和 `EXT11`（Office/WPS 兼容环境），均为 `NOT_PROVIDED`。
- **T01 真实运行**：`reports/acceptance-runs/run-20260920-b5dba42-01.json` 绑定源码 `b5dba42579cbb325e1b3cbeadc582865256f88e4`，工作树 dirty；Windows `10.0.26200` x64、Node `v24.15.0`、npm `11.12.1`。结果为 **6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN（170 total）**。提交前语义审计把 40 条“只覆盖子集或场景不一致”的自动映射降回 NOT_RUN；PASS 只保留 `SEC-009/JOB-003/JOB-006/JOB-007/DAT-005/UPD-001`，精确绑定测试文件 + Vitest `fullName`，未从宽泛 suite 继承。固定候选 EXE 不存在，故 `artifactPresent=false`、`artifactClass=NONE`、hash/size/build provenance 均为 null。T01 定向 **24/24**；runner 全量 Vitest **574 passed / 1 skipped（575 total，64 files）**；typecheck、lint、`verify:contracts`、desktop build 均退出 0。发布采用唯一临时文件、追加记录 no-clobber 与固定事务日志恢复；证据校验拒绝 NTFS ADS、路径逃逸、历史运行借证和倒序时间。
- [x] **G11-T02 发行证据聚合与已知缺口（本地工程范围）**：新增闭集 `G11ReleaseEvidenceV1`、固定路径聚合器与 `release:evidence`。报告逐项归集 **60 个基础需求 + 24 个 CR-001 需求 + 170 个验收案例 + 11 个固定交付物**，回读九份输入的 SHA-256/size，并拒绝来源 commit 不一致、dirty run 升级、候选字节漂移、未知/畸形外部输入、缺陷审计未绑定、需求语义映射篡改、敏感输出及合同外字段。当前五维状态分别为 **software=BLOCKED / resource=BLOCKED / teaching=NOT_REVIEWED / artifact=NONE / release=BLOCKED**，理由 `RELEASE_ARTIFACT_MISSING`；18 个缺口覆盖 EXT02–EXT11 未提供项、候选缺失、dirty run、缺陷审计未执行、正式案例未执行及 T03/T04 交付物缺失。`defect-audit.json` 为诚实 `NOT_RUN`，空 items 不代表已知 P0/P1 为零；三份固定输出以可恢复事务成组发布；`release:evidence` 对有效 BLOCKED 报告退出 0，不声明可发行。
- **T02 实测**：定向 **16/16**（与 T01 合计 40/40）；全量 Vitest **590 passed / 1 skipped（591 total，65 files）**。typecheck、lint、`verify:contracts`、desktop build、`git diff --check` 均退出 0；既有 pdfjs 可选 canvas/字体告警未改成失败或跳过。
- [x] **G11-T03 CycloneDX、校验和与签名边界（本地工程范围）**：`release:sbom` 调用实际 npm CLI 生成 CycloneDX 1.5，不使用手写组件清单；逐项核对 `package-lock.json` 的 **663 个唯一 name/version**，SBOM 为 **663 components / 664 dependency nodes / 1,133 条锁文件依赖边**，应用根、全图可达性与 lock↔SBOM 双向边集合均经闭集校验；外部 scoped 包必须保持完整 purl 名称，只有 lock 中明确的 workspace 可使用 npm 的短显示名。`package-lock.json` SHA-256 为 `81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。11 项固定输入的 `SHA256SUMS.txt` 使用规范排序、逐文件 realpath/hash 复读，拒绝绝对路径、`..`、反斜杠、大小写别名、symlink/junction 逃逸及自引用；SBOM/环境/签名输出递归拒绝本机路径和秘密模式；四份供应链输出以受限 journal 成组发布。发行聚合现记录 `SBOM=PASS / checksum=PASS / signature=NOT_RUN`，但总判定仍为 `BLOCKED / RELEASE_ARTIFACT_MISSING`，当前缺口 16 个。
- **T03 环境、源码与签名实况**：实际 Node **24.15.0** / npm **11.12.1**，锁定环境 Node **22.14.0** / npm **10.9.7**，故 `formalEnvironmentMatch=false` 并新增正式环境阻断；工程 SBOM 通过不等于锁定环境通过。生成与聚合均重新核对 live Git HEAD 和排除固定生成物后的相关工作树，不能沿用 T01 的历史 clean 位把已修改校验脚本或 lockfile 升级为就绪。固定候选 EXE 不存在，Authenticode 脚本未对任意替代文件运行，签名严格记录 `NOT_RUN / RELEASE_ARTIFACT_MISSING`；Windows 检查器只允许内核锚定 `GLOBALROOT\\SystemRoot` 的系统 PowerShell，拒绝环境变量、PATH 或仓库内解释器劫持，并从 `$PSHOME` 显式加载/限定签名与哈希 cmdlet；正式签名身份仍 `BLOCKED_EXTERNAL`。定向 T03 **17/17**，T02+T03 **39/39**，T01–T03 **63/63**；全量 Vitest **613 passed / 1 skipped（614 total，66 files）**；typecheck、lint、`verify:contracts`、desktop build、`git diff --check` 均退出 0，既有 pdfjs/canvas/字体告警与跳过项未改写。独立最终复核 Critical 0 / Important 0、Ready。
- [x] **G11-T04 中文指南、最终状态与正式发行门（本地工程范围）**：新增固定路径 `release:verify`，逐项复算 12 条校验和并交叉核对发行聚合、SBOM/环境/签名状态、最终状态、已知限制和教师指南；结构或篡改退出 1，真实非就绪候选退出 2，只有完整 `RELEASE_READY` 才能退出 0。最终两份公开状态从同一聚合确定性生成，按阻断码/范围排序，不嵌入校验清单自身哈希。供应链生成器把 SBOM、环境、签名、聚合、两份状态文档、发行输入和校验清单合并为一次可恢复事务，消除了旧证据↔新清单的多轮收敛问题；单轮规定命令链已实测退出 0/0/2。
- **T04 指南与实况**：教师指南逐项对照 renderer，明确当前“开始准备下一课”禁用、尚无课堂展示入口、尚无班级/教材/课时设置入口，不把目标功能写成已交付；保留模型辅助归因五项测量门、假设边界、逐次隐私授权、备份口令不可恢复、凭据不迁移、可信离线更新、诊断和卸载范围。当前总状态仍为 **BLOCKED / RELEASE_ARTIFACT_MISSING**，15 个缺口；`SBOM=PASS / checksum=PASS / signature=NOT_RUN / formalEnvironmentMatch=false`。
- **T04 测试与证据**：G11 定向 **71/71**；全量 Vitest **621 passed / 1 skipped（622 total，67 files）**。typecheck、lint、`verify:contracts`、desktop build、`git diff --check` 全部退出 0；冻结 130+40 验收定义和 lockfile 哈希未变；发行目录隐私扫描无命中。篡改 `FINAL_STATUS.md` 时 `release:verify` 如实退出 1，原子再生成后恢复到预期退出 2。完整记录见 `reports/G11_EVIDENCE.md`。
- **T01–T04 外部门/限制**：四个本地工程包完成不等于正式发布完成。干净 Windows、授权材料、真实 API/预算、真实学生资料处理与逐次外发授权、Office/WPS、锁定环境候选、签名/时间戳、分发位置、缺陷审计和教师专业复核仍为 `BLOCKED_EXTERNAL` 或 `NOT_RUN`；不得把当前工程 SBOM、621 项单测或退出 2 表述为发布通过。

## G11-E01 追加外部验收准备 — 本地实现完成，实际运行待候选

- [x] **外部证据安全入口**：`acceptance:run -- --external-evidence ...` 只读取 `apps/desktop/release/acceptance/` 下的输入；逐项校验当前源码、固定候选实际 SHA-256/size、执行时窗、外部案例映射、证据层级及 `EXTxx=PROVIDED`。外部 `PASS/FAIL` 必须回指本轮规范证据并附候选哈希；未提供或未执行项目继续 `BLOCKED/NOT_RUN`。历史运行保持追加、不可覆盖。
- [x] **秘密与借证拒绝**：外部输入中的 API key、Bearer Authorization、绝对/逃逸证据路径、候选漂移、重复案例、来源 commit 不符和无关外部条件均拒绝整轮发布。密钥不进入源码、证据或命令日志。
- [x] **DeepSeek 预算身份**：`deepseek-flash` 默认费率改为官方 2026-09-10 峰值上限（缓存未命中输入 ¥2/百万 token、输出 ¥8/百万 token），以 CNY 分为单位保守结算；用户授权硬上限为 1000 分。夜间实际单价较低不用于放宽预算门。
- **验证**：新增 4 项回归先 RED 后 GREEN；G11 验收定向与 DeepSeek 协议定向 **38/38**，全量 Vitest **625 passed / 1 skipped（626 total，67 files）**；typecheck、lint、合同、desktop build、`git diff --check` 均退出 0。既有 pdfjs/canvas/字体告警和一个环境跳过项保持原样。
- **边界**：冻结 `AI-001` 仍明确要求 Grok，而当前产品与用户授权为 DeepSeek；本轮可记录 DeepSeek 真实工程证据，但不得把该旧定义冒充 PASS。GPT 生成资料只算合成测试材料，GPT 复核只算 `model_reviewed`，不替代 EXT05 合法现用教材或 EXT09 真人教师专业复核。当前 Windows 主机也尚未证明为干净标准用户 VM。

## G11-E02 Windows 候选构建修复 — 本地实现完成，待干净提交重建

- [x] **可选原生依赖边界**：Windows 打包首次实际执行发现 electron-builder 会连同 `pdfjs-dist` 的可选 `canvas` 一起重建，并因本机无 Cairo/GTK 失败；未把失败写成通过。新增打包合同回归先以 2 项失败复现，再配置 `npmRebuild: false`、从应用包排除 `canvas`，并用 `electron-rebuild --only better-sqlite3 --types prod` 只重建唯一必需的原生运行依赖。
- [x] **Windows 11 工程构建**：修复后在 Windows 11 Pro `10.0.26200` x64 上，renderer/main 构建、定向原生重建、win-x64 解包和 NSIS 安装器生成均退出 0。临时候选 `YuwenDesk-Setup-0.1.0-x64.exe` 为 **131,024,560 bytes**，Authenticode 实测 `NotSigned`；它生成于尚未提交的修复工作树，只是构建验证，**不得用于追加验收或分发**。必须提交本包后从 clean commit 再构建并重新计算 hash/size。
- **验证**：打包/G11 候选边界定向 **51/51**，全量 Vitest **627 passed / 1 skipped（628 total，68 files）**；typecheck、lint、合同与 `git diff --check` 均退出 0。把无构建来源的临时 EXE 放在固定候选路径时，既有 G11 测试和合同检查按设计以 `CANDIDATE_BUILD_PROVENANCE_MISSING` 失败；移至隔离的 ignored provisional 目录后恢复全绿，没有放宽门禁。
- **安全边界**：底层失败日志曾显示会展开子进程环境，因此后续构建在子进程环境中移除凭据型变量并关闭 debug；报告、源码和候选元数据不记录密钥。正式签名身份/时间戳与可信分发地址仍为 `BLOCKED_EXTERNAL`。

## G11-E03 候选构建来源闭环 — 本地实现完成，实际候选待提交后生成

- [x] **可验证来源记录**：新增 `npm run build:candidate`，只允许 Windows + clean tree；以无 shell 的 npm CLI 执行锁定的 `build:win`，在子进程移除凭据型环境变量并禁用自动签名发现。成功后才原子写入 ignored 的 `apps/desktop/release/acceptance/candidate-build-provenance.json`，绑定源码 commit、固定候选路径、SHA-256、size、时间、命令与 OS/Node/npm 环境；失败前先移除旧来源，避免旧记录为新/残留候选背书。
- [x] **runner 闭环与漂移拒绝**：追加验收 runner 现先加载来源记录，逐字节复算候选 hash/size，并校验 source commit、固定路径、闭集字段和秘密模式；缺失、畸形、路径逃逸或字节漂移均拒绝。候选盘点不再存在“要求 build provenance 但没有输入通道”的死锁。
- [x] **测试隔离**：G11 的缺失候选测试改用独立 fixture；60+24+170 静态覆盖测试不再读取可变的 ignored 候选或历史生成报告，避免实际候选出现时测试自相矛盾，同时保留派生篡改/伪造 RELEASE_READY 拒绝断言。
- **验证状态**：新增 2 项来源绑定/漂移回归已先 RED 后 GREEN；G11/打包定向 **53/53**，全量 Vitest **629 passed / 1 skipped（630 total，68 files）**；typecheck、lint、合同、desktop build、Node 语法检查与 `git diff --check` 均退出 0。本包提交前不会生成正式固定候选；提交后必须用 `npm run build:candidate` 重新生成并再跑完整回归/追加验收。

## G11-E04 已提供外部条件登记 — 已登记，实际案例待新候选执行

- [x] **预算（EXT04）**：登记用户授权本次 DeepSeek 真实测试人民币 **10 元硬上限**；密钥仍不进入目录。此项只解除费用输入缺口，不把 DeepSeek 冒充冻结 `AI-001` 所要求的 Grok。
- [x] **隐私授权（EXT10）**：登记本次合成/最小必要字段外发许可。未提供真实学生材料，故只对实际执行且证明必要字段边界的案例有意义；不得推导教学有效或真实学生资料覆盖。
- [x] **WPS 环境（EXT11）**：Windows 11 Pro 已核实安装 **WPS Office Commercial 12.1.0.28022**。Microsoft Office 未提供；只有在该 WPS 中对新候选生成文件实际打开/编辑/保存/分页/放映并绑定证据的案例才可 PASS/FAIL，其余继续 NOT_RUN/BLOCKED。
- **仍未提供**：EXT02 干净标准用户 VM、EXT03 Grok 账户、EXT05 合法现用教材、EXT06 真实班级/课长/设备/进度、EXT07 签名身份、EXT08 分发地址、EXT09 真人教师专业复核。GPT 合成/自审不替代 EXT05/EXT09。
- **发行证据刷新**：候选保持隔离时按规定执行 `release:evidence → release:sbom → release:verify`，前两项退出 0，最终验证按预期退出 2；仍为 `BLOCKED / RELEASE_ARTIFACT_MISSING`，正式环境、签名、干净 Windows、分发与缺陷审计门未关闭。外部缺口因真实登记由 15 降至 12，不等于案例已通过。
- **E04 验证**：全量 Vitest **629 passed / 1 skipped（630 total，68 files）**，合同与 `git diff --check` 退出 0；既有 pdfjs/canvas/字体告警和环境跳过项保持原样。

## G11-E05 候选绑定追加运行与精确证据白名单 — 运行已追加，白名单修复待提交

- [x] **新候选与追加运行**：`e126a1a82c88420cfe26395c0ffd00496f5b8639` clean tree 通过 `build:candidate` 生成固定未签名候选（**131,024,555 bytes**，SHA-256 `0f0b5ba1f980fa37791ca144b0e2b36bad611701fa2248c7fabf1be82136d6e9`），来源记录逐字节复核通过。追加运行 `run-20260920-e126a1a-01` 在开始时 `repositoryDirty=false`，候选盘点为 `UNSIGNED_TEST_BUILD`，结果 **6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN**；未执行的 WPS/API/隐私案例没有因 EXT04/10/11 已提供而自动提升。
- [x] **本轮证据精确白名单**：发行聚合此前把新追加运行的 Vitest JSON 误当成源代码脏文件。新增 `collectAcceptanceEvidencePaths`，只从已通过 `AcceptanceRun` 校验的 `results[].evidence[].path` 收集 `reports/acceptance-runs/` 下精确文件；去重排序，拒绝绝对/穿越/非验收目录路径。未声明的相邻文件继续使 `relevantTreeClean=false`，不放宽整个目录。
- **当前发行状态**：基于 e126a1a 运行生成的供应链记录确认候选 `UNSIGNED`，正式环境不匹配，签名、干净 Windows、分发和缺陷审计仍阻断。E05 源码修复本身使当前工作树真实为 dirty；提交后必须重建候选并创建下一轮追加运行，才能验证 `RELEASE_SOURCE_DIRTY` 已由白名单修复而消失。
- **E05 验证**：白名单回归先 2 项失败后 GREEN；全量 Vitest **630 passed / 1 skipped（631 total，68 files）**，typecheck、lint、合同、desktop build、Node 语法与 diff 均通过。

## G11-E06 clean-source 聚合复验与事务诊断 — 复验完成，供应链事务待定位

- [x] **clean-source 复验**：`10c4908769e6c57f5b34888f48041119bc723b18` 通过 `build:candidate` 生成 131,024,554-byte 未签名候选（SHA-256 `7188f17a5e5f2e8fec41556b7c339e49a9a7841a5649d638ba0b51f126ac22fc`）；追加运行 `run-20260920-10c4908-01` 为 `repositoryDirty=false`，结果仍是 **6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN**。
- [x] **E05 修复已证实**：`release:evidence` 首次在候选+新增 Vitest 证据存在时得到 `sourceTreeClean=true`，发行理由从错误的 `RELEASE_SOURCE_DIRTY` 变为真实的 `RELEASE_WINDOWS_EVIDENCE_REQUIRED`。
- **新发现且未伪造通过**：紧接的 `release:sbom` 在八文件原子发布的 `beforeCommit` 自校验中报 `RELEASE_AGGREGATE_DERIVATION_MISMATCH` 并完整回滚；工作树预先 dirty 时该链可完成，表明差异来自事务期间的临时 Git 状态。新增非秘密诊断：`inspectRepositoryProvenance` 返回仓库相对 dirty paths，派生不一致报告首个 JSON 路径和精确 dirty path；不把诊断字段写入发行证据合同。提交后将以 clean source 重现并修复精确遗漏，不放宽目录级白名单。

## G11-E07 失败验收保全与安全诊断 — 历史失败保留，诊断已补强

- [x] **失败运行不覆盖**：`b3d384f03d07f5b44fd801197f2c02d70d12e54f` 的 clean 候选为 **131,024,555 bytes**、SHA-256 `29d19d1a4fd412a24159d6f81a29360759e77de90a29f10fcffd32e3009d7584`。`run-20260920-b3d384f-01` 实际执行时完整 Vitest 命令有 1 项失败，故命令组对应六项如实记录为 **FAIL**，总计 **0 PASS / 6 FAIL / 38 BLOCKED / 126 NOT_RUN**；该追加记录永久保留，不用随后复跑结果覆盖。
- [x] **复跑事实**：相同源码和当前报告状态下，随后独立全量测试为 **630 passed / 1 skipped（631 total，68 files）**，未复现失败。这只能说明失败非持续性，不能倒改历史运行；原归一化报告只保存映射断言，导致首次失败的测试身份已经不可恢复。
- [x] **最小安全诊断**：runner 今后在保留映射断言之外，额外保存所有失败断言的仓库相对测试文件、测试名、完整名、状态和失败计数；明确不保存 failure message、堆栈、绝对路径或环境值。判定规则未放宽：完整命令非零仍保持对应命令组 FAIL。新增回归先 RED 后 GREEN。
- **E07 验证与发行实况**：新增测试后全量为 **631 passed / 1 skipped（632 total，68 files）**；typecheck、lint、合同和 diff 均通过。发行链如实聚合历史失败为 `BLOCKED / RELEASE_REQUIRED_CASE_FAILED`，签名实测 `UNSIGNED`，13 个缺口，`release:verify` 按预期退出 2；没有把独立复跑的绿色结果借给失败验收。
- **外部边界**：DeepSeek 密钥没有写入命令、环境、仓库或证据；当前执行面没有安全秘密注入通道，真实 API 仍未执行。WPS 已安装但当前自动化控制面无原生应用入口，因此 Office/WPS 案例继续 NOT_RUN/BLOCKED，未伪造截图或操作证据。

## G11-E08 候选切换窗口回归 — 根因已定位并修复，失败运行保留

- [x] **第二次失败被新诊断捕获**：clean commit `5c0de0429c2bab13765190817921a334c32e0522` 生成 131,024,559-byte 候选（SHA-256 `f63d5809d8c47513c206907e680147e7c6330bbf31db18e2c5e943ad0edb86e5`）。`run-20260920-5c0de04-01` 再次为 **0 PASS / 6 FAIL / 38 BLOCKED / 126 NOT_RUN**；`failedAssertions` 精确指出 `g11-release-evidence.test.ts` 的静态覆盖测试，证明 E07 诊断有效。该失败运行继续追加保留。
- [x] **根因与修复**：该测试为断言首个 JSON 差异路径，实际调用 live `release-input/candidate-artifact`。新 EXE 已构建而 runner 尚未发布新候选快照的窗口里，校验先命中候选 provenance 漂移，导致预期以 `$` 开头的差异路径断言失败；runner 发布快照后同一测试恢复通过。现导出并直接测试纯 `firstDifferencePath`，live 集成断言仍验证派生篡改必被拒绝，测试不再借用可变候选状态决定诊断细节。
- **判定边界**：修复不会重写 `run-20260920-5c0de04-01`，也不会把其六个 FAIL 降级；必须提交后从新 clean commit 重建候选并创建第三个追加运行才能形成新证据。
- **E08 验证与发行实况**：全量 **631 passed / 1 skipped（632 total，68 files）**；typecheck、lint、build、合同和 diff 均通过。发行链聚合当前失败运行后仍为 `BLOCKED / RELEASE_REQUIRED_CASE_FAILED`，签名 `UNSIGNED`、13 个缺口，最终验证按预期退出 2；验收和发行报告秘密模式扫描无命中。

## 下一步

见 `HANDOFF.md`。提交 E08 后从 clean commit 重建候选并创建第三个追加运行；若通过，再在 clean source 上运行完整发行证据链，利用 E06 诊断定位事务临时路径。能安全实际执行的案例才追加证据；干净标准用户 VM、Grok 定义、签名/时间戳、分发、真人教师复核及当前不可控的 WPS 操作继续 `BLOCKED_EXTERNAL/NOT_RUN`。
