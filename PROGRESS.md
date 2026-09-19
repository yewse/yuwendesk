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

- [~] G02-T01 受限 IPC 及 **Schema 门**：新增声明式载荷 Schema 门 `src/main/schemaGate.ts`，在 `IpcService.handle` 分发前对所有已实现操作统一校验载荷结构（类型/必填/多余字段 additionalProperties:false/超长）；读操作拒绝夹带载荷。测试 `schemaGate.test.ts`(8) + ipc 多余字段拒绝用例；运行时冒烟确认不阻断正常保存。SEC-001/SEC-002 的结构门部分已具备。
- [ ] G02-T02 SQLite 迁移与单写入者、G02-T03 凭据/敏感 payload 加密、G02-T04 版本并发与事务事件：待续（better-sqlite3 需针对 Electron ABI 重建，属已知后续项，无外部账户依赖）。

## G03–G11 — NOT_STARTED

资料与引用、Grok 与任务、教学业务 M01–M12、材料交付（含 CR-001 三类五文件，落 G05–G07）、审查与修改、反馈与纠正、备份恢复、升级性能、发布验收，均未开始。界面相应页面标注"后续版本开放"。

## 下一步

见 `HANDOFF.md`。优先在获得 Windows VM 后完成 G01-T04 安装验收，或在 G02 建立 SQLite/IPC 数据基础。
