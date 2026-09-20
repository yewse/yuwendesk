# G11 完整发行验收与真实状态设计

日期：2026-09-20

## 1. 目标与边界

G11 把 G00–G10 已有的代码、测试、工程报告和外部阻断归集为可机器复核的发行候选证据。阶段分为四个有界工作包：全案例执行台账、发行证据聚合、SBOM/哈希/签名边界、中文手册与最终状态。目标不是把现有文档批量改成 PASS，而是建立一条在证据缺失、过期、矛盾或不匹配时可靠失败的发行门。

冻结的 `acceptance/cases.json` 与 `acceptance/addenda/classroom-delivery.cases.json` 继续只保存验收定义，初始 `status` 保持 `NOT_RUN`。实际结果写入 `reports/acceptance-runs/` 的独立运行记录，不能回写或删除定义。既有单元/集成测试只有在明确映射到案例、实际运行、绑定源码提交与原始输出后，才能作为相应环境层级的证据；合同可解析、测试文件存在或历史文字说明不能单独构成 PASS。

本阶段不生成或读取生产私钥，不伪造 Authenticode/时间戳，不上传或公开制品，不把 Linux/Node/开发机自动化冒充干净 Win11 标准账户、Office/WPS、真实 API、学生资料授权或教师专业复核。缺少这些输入时记录 `BLOCKED`，并用闭集 blocker code 指明 `BLOCKED_EXTERNAL` 来源。当前预计总体发行状态为 `BLOCKED`；若实际安装包可重新生成但未签名，其制品分类最多为 `UNSIGNED_TEST_BUILD`，两者不能互相替代。

## 2. 选择的方案

采用“不可变定义 + 追加运行记录 + 纯函数聚合 + 失败闭合验证”架构：

1. 验收定义保持冻结；每次运行产生绑定 commit、环境、命令、退出码、证据路径和哈希的新记录。
2. 聚合器只读取受控路径中的定义、运行记录、外部输入状态、制品和报告，不从 `PROGRESS.md` 的自然语言反推 PASS。
3. `release:evidence` 生成当前真实状态，即使结果为 BLOCKED 也可以成功完成归集；`release:verify` 只在正式 `RELEASE_READY` 时退出 0。
4. 发行制品类型、软件工程状态、资源覆盖状态、教学验证状态分别计算，不以总体百分比掩盖 P0/P1、隐私、签名或目标环境缺口。

不采用以下替代方案：

- 不修改验收定义中的 `status`，因为这会丢失运行历史并把合同与证据混为一体。
- 不用单份人工 Markdown 清单作为唯一真源，因为它不能可靠发现漏项、重复、过期 commit、缺失文件或哈希漂移。
- 不因存在旧构建报告就宣称当前 commit 有安装包；候选制品必须实际存在并重新计算哈希。

## 3. 四包职责

### G11-T01：全案例执行台账与候选制品登记

- 新增严格的验收运行记录合同，覆盖冻结基础案例与全部增补案例的并集；全量运行记录必须恰好包含每个 case ID 一次，不允许漏项、重复或未知 ID。
- 每条结果只允许 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。`PASS` 必须有实际执行时间、执行环境、命令退出码、至少一个存在且可哈希的证据文件；`BLOCKED` 必须有闭集 blocker code 和所需外部输入；`NOT_RUN` 必须说明尚未执行的具体层级，不能使用空理由。
- 建立案例到可执行检查的显式映射。自动化映射必须指向确切测试文件/测试名或脚本步骤，并声明证据层级；未映射案例不能从“全量测试通过”自动继承 PASS。
- 生成一次当前 commit 的全量执行台账：能在本机真实执行的工程案例运行并记录；要求干净 Windows、Office/WPS、真实 API、真实学生材料授权或教师判断的案例记录为 `BLOCKED`/`NOT_RUN`，不得降级标准。
- 候选制品登记只接受实际存在的文件、当前源码 commit、构建命令、构建环境、文件长度和重算 SHA-256。没有当前候选文件时登记 `artifactPresent=false`，不得沿用历史报告中的路径或哈希。

### G11-T02：发行证据聚合与资源缺口

- 新增严格闭集的 `G11ReleaseEvidenceV1` 聚合合同与 `reports/release/release-evidence.json`。
- 聚合器读取案例定义、当前全量运行记录、候选制品登记、`planning/EXTERNAL_INPUTS.json`、需求追踪、SBOM/哈希/签名结果和已知限制；输入文件路径固定在仓库根下，不接受 renderer 或命令行传入任意路径。
- 每个原始需求、CR-001 需求、验收案例和 G11 必需交付物都必须有聚合条目。缺失映射、未知 ID、重复、证据文件不存在、哈希不符或来源 commit 与候选不一致均为发行门失败。
- 分开输出 `softwareStatus`、`resourceCoverageStatus`、`teachingValidationStatus`、`artifactClass` 和 `releaseDisposition`。不生成总体通过率作为决策依据。
- 已知缺口必须包含影响范围、状态、blocker code、所需外部输入和用户可采取的安全动作；不能建议关闭 SmartScreen、系统保护、签名校验或隐私授权。

### G11-T03：SBOM、哈希清单与签名边界

- 使用 `ENV_LOCK.json` 选定的 Node 22.14.0 / npm 10.9.7 从 `package-lock.json` 生成 CycloneDX JSON SBOM：`npm sbom --package-lock-only --sbom-format cyclonedx --sbom-type application`。记录实际 Node/npm 版本、生成命令、源码 commit 与 package-lock SHA-256；不增加运行时依赖。开发机版本不匹配时仍可产生明确标为工程证据的 SBOM，但不能进入正式发行候选。
- 接受 npm CLI 实际生成的 CycloneDX `specVersion`，首轮预期为 `1.5`，并验证 `bomFormat`、组件、依赖图和根应用身份。不得把现有 `SBOM.draft.json` 重命名为正式 SBOM；初稿只作历史输入。
- SBOM 必须包含锁文件解析得到的传递依赖，而不只列直接依赖。若 npm SBOM 命令失败、缺组件或与锁文件根版本不一致，G11-T03 失败。
- 生成规范排序的 SHA-256 清单，覆盖候选安装包、SBOM、锁文件、ENV_LOCK、发行证据、案例运行记录、中文手册和已知限制。清单内路径必须为仓库/发行目录下的正向斜杠相对路径，拒绝绝对路径、穿越、重复和大小写别名冲突。
- Windows 签名验证是独立结果：记录 `SIGNED_VALID`、`SIGNED_INVALID`、`UNSIGNED` 或 `NOT_RUN`。没有持有人签名身份时只能得到 `UNSIGNED`/`NOT_RUN`；正式 `RELEASE_READY` 要求真实 Authenticode 链与时间戳在目标 Windows 上通过。

### G11-T04：中文用户手册与最终真实状态

- 根据实际 renderer 导航、按钮、设置、备份、恢复、更新和诊断流程更新 `docs/TEACHER_QUICK_GUIDE.md`，删除“待实现”措辞，但只描述已经存在的能力。
- 增加安装/首次设置、离线使用、三类五文件、课堂展示、只改一处、课后观察、模型辅助归因、隐私授权、备份换机、离线更新、诊断、卸载数据保留和已知限制；教师说明中不出现开发命令。
- 生成 `reports/release/KNOWN_LIMITATIONS.md` 与 `reports/release/FINAL_STATUS.md`。最终状态列出实际制品、commit、哈希、软件门、外部条件、资源覆盖、教学状态和安全支持路径。
- 增加根脚本 `release:evidence` 与 `release:verify`。前者归集并校验内部一致性；后者在任何必需案例为 FAIL/BLOCKED/NOT_RUN、当前制品缺失、SBOM/哈希不一致、签名或目标 Windows 门未通过时非零退出。

## 4. 验收运行记录合同

全量运行记录采用 `AcceptanceRunV1`：

```ts
type CaseStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
type EvidenceLevel =
  | 'engineering_automation'
  | 'developer_windows'
  | 'clean_windows_standard_user'
  | 'office_wps'
  | 'live_api_authorized'
  | 'privacy_authorized_material'
  | 'teacher_professional_review';

interface AcceptanceCaseResultV1 {
  caseId: string;
  status: CaseStatus;
  evidenceLevel: EvidenceLevel | null;
  command: string | null;
  exitCode: number | null;
  executedAt: string | null;
  environment: string;
  evidence: Array<{ path: string; sha256: string; sizeBytes: number }>;
  artifactHashes: Array<{ path: string; sha256: string; sizeBytes: number }>;
  blockerCode: string | null;
  externalInputIds: string[];
  observedResult: string;
}

interface AcceptanceRunV1 {
  schemaVersion: 1;
  runId: string;
  sourceCommit: string;
  repositoryDirty: boolean;
  startedAt: string;
  completedAt: string;
  environment: { os: string; release: string; arch: string; node: string; npm: string };
  definitionSources: Array<{ path: string; sha256: string }>;
  results: AcceptanceCaseResultV1[];
}
```

状态不变量：

- `PASS`：`exitCode=0`，有执行时间、非空证据、无 blocker；证据层级满足案例要求。
- `FAIL`：实际执行且观察到不满足，保留非零退出或人工复核失败证据；不能自动改成 BLOCKED。
- `BLOCKED`：未完成实际判定，必须给 blocker code 与外部输入 ID；`BLOCKED_EXTERNAL` 通过 blocker code 表达，不增加第五种顶层状态。
- `NOT_RUN`：尚未执行且当前没有声明决定性外部阻断；无命令、无退出码、无伪证据。
- 运行记录是追加证据。新运行不得覆盖旧文件；聚合器按显式候选 run ID 选择，不以文件修改时间猜测。

## 5. 聚合状态与发行判定

`G11ReleaseEvidenceV1` 至少包含：候选 commit/run/artifact，四维状态，案例统计与逐项引用，需求覆盖，必需交付物，外部输入快照，已知缺口，SBOM/hash/signature 结果和最终判定理由。

闭集状态定义如下：

- `softwareStatus`：`PASS | PARTIAL | BLOCKED | FAIL`；
- `resourceCoverageStatus`：`VERIFIED | PARTIAL | BLOCKED | NOT_VERIFIED`；
- `teachingValidationStatus`：`TEACHER_REVIEWED | PARTIAL | BLOCKED | NOT_REVIEWED`；
- `artifactClass`：`NONE | UNSIGNED_TEST_BUILD | SIGNED_TEST_BUILD | SIGNED_RELEASE_CANDIDATE`；
- `releaseDisposition`：`RELEASE_READY | CONTROLLED_TRIAL | UNSIGNED_TEST_BUILD | BLOCKED`。

发行状态规则按以下顺序计算：

1. 任一必需 P0/P1 为 `FAIL`、证据篡改、候选 commit 不一致或签名无效：`BLOCKED`。
2. 当前候选安装包不存在，或干净 Win11 标准账户安装主流程没有 PASS：`BLOCKED`。
3. 实际候选存在且工程证据一致，但未签名：制品为 `UNSIGNED_TEST_BUILD`；总体正式发行仍未就绪。
4. `CONTROLLED_TRIAL` 只在持有人明确授权受控范围、目标 Windows 主流程通过、已知 P0/P1 为 0、签名有效且所有数据/费用边界清楚时使用；它不表示教学效果已验证，也不允许公开发布。
5. `RELEASE_READY` 要求全部必需软件门、外部发行门、签名、目标 Windows、升级/恢复、SBOM/哈希和手册证据通过，没有必需 FAIL/BLOCKED/NOT_RUN，并有授权分发位置。

`release:evidence` 对“真实生成了一个结构有效的 BLOCKED 报告”退出 0；`release:verify` 对 `BLOCKED`、`UNSIGNED_TEST_BUILD` 或 `CONTROLLED_TRIAL` 均退出非零，只有 `RELEASE_READY` 退出 0。这样日常归集可以持续，而正式发行门不会被软化。

## 6. 证据路径、哈希与隐私

- 证据只允许仓库相对路径，根限定为 `reports/`、`docs/`、`acceptance/`、`planning/`、`ENV_LOCK.json`、`package-lock.json` 和明确的本地发行目录；拒绝绝对路径、UNC、URL、穿越与 symlink 逃逸。
- 聚合时重新读取每个文件，验证大小与 SHA-256；不信任运行记录自报值。
- 安装包、PPTX、DOCX、PDF 等二进制只记录哈希、大小、类型与受控相对路径，不把字节嵌入 JSON。
- 发行证据、SBOM、日志和手册不得含 API 密钥、凭据、学生原文、真实姓名、教材全文、prompt、模型完整输入输出、本机绝对路径或异常栈。
- 测试夹具继续使用虚构内容，并在运行记录中声明；真实学生材料案例只有在明确授权后执行。

## 7. 错误处理与重跑

- 解析失败、未知字段、案例漏项、重复 ID、未知 evidence level、证据缺失、hash 漂移、commit 不一致和制品消失均使用闭集错误码并非零退出。
- 生成器先写同目录 `.partial`，回读并校验后原子 rename；中断不能覆盖上一份完整证据。
- 已存在同 run ID 或同 release ID 且语义输入不同则拒绝；相同输入允许返回同一结果摘要，但不能静默覆盖历史。
- 外部阻断解除后创建新运行记录；不编辑旧 BLOCKED 记录来伪装当时已执行。
- `release:verify` 不自动构建、签名、上传或发布。构建、签名和分发是独立显式步骤，其产物再进入证据聚合。

## 8. 测试策略

每包遵循 RED→GREEN→重构并形成一个小提交：

- T01：冻结定义哈希、案例并集完整性、重复/漏项、PASS 证据约束、BLOCKED/NOT_RUN 约束、路径逃逸、证据哈希漂移、候选制品存在性。
- T02：需求/案例/交付物全覆盖、P0/P1 优先级、四维状态分离、外部输入映射、旧 commit/错误 run 拒绝、BLOCKED 报告可生成但正式门失败。
- T03：真实 `npm sbom` 输出、传递依赖覆盖、根组件/锁文件绑定、规范哈希清单、路径别名、制品篡改、UNSIGNED 与 SIGNED_INVALID 区分。
- T04：手册必须包含现有核心流程和限制、不含开发命令/虚假承诺；最终状态与聚合 JSON 一致；`release:verify` 对四种 disposition 的退出码固定。

每包运行定向测试、全量 Vitest、typecheck、lint、`verify:contracts`、desktop build 和 `git diff --check`；更新 `PROGRESS.md`、`HANDOFF.md` 与 G11 证据报告。冻结 acceptance 定义、CR-001 增补定义和 package-lock 哈希只有在对应包明确需要且有原因时才变化，不能为通过门禁改状态或删案例。

## 9. 完成定义与当前外部门

G11 本地工程实现完成的定义是：全案例被无遗漏归集，聚合器/发行门失败闭合，当前真实阻断可机器读取，SBOM/哈希可重算，手册与实际功能一致。它不等于正式发布。

以下门在获得外部输入前保持独立阻断：

- EXT02：干净 Win11 x64 标准账户安装、启动、升级、回退、监听、性能与辅助使用；
- EXT03/EXT04：真实 API 账户、费用上限和模型辅助归因质量；
- EXT05/EXT06：合法教材/评分资料与真实班级条件；
- EXT07：持有人发布身份、Authenticode 签名与可信时间戳；
- EXT08：授权分发位置与可信更新身份；
- EXT09：有资质教师的教学专业复核与实际使用证据；
- 学生资料处理与逐次外发许可、Office/WPS 分页/编辑/放映保真：在相应授权与环境提供前保持 `BLOCKED_EXTERNAL`。

## 10. 标准来源决策

SBOM 采用 `ENV_LOCK.json` 当前固定的 Node 22.14.0 / npm 10.9.7 所带 `npm sbom`，避免为 G11 额外引入生成器依赖。npm 官方文档说明该命令可从 package-lock 生成 CycloneDX 或 SPDX，并支持 `--package-lock-only` 与 application 类型；当前文档示例生成 CycloneDX 1.5。CycloneDX 当前规范版本为 1.7，但 G11 不把“使用最新版本”设为发布条件，而是记录并验证实际工具生成的合法 specVersion；执行环境偏离 ENV_LOCK 时只记工程证据：

- https://docs.npmjs.com/cli/v11/commands/npm-sbom/
- https://cyclonedx.org/specification/overview/
