# G08 反馈、模型辅助归因与教学纠正设计

## 目标与范围

G08 在 G07 已交付的不可变课时修订、审查和三类五文件基础上，形成“明确记录实际授课 → 可选记录观察 → 先检查测量条件 → 模型辅助提出待验假设 → 教师决定最小纠正 → 后续正常任务复核”的本地闭环。

本阶段按既定工作计划交付四个有序工作包：

1. G08-T01：采用与实际授课分离，交付可持久化的授课事件。
2. G08-T02：可选观察与样本范围，交付严格 `Observation` 及伴随结果状态。
3. G08-T03：先查题目、评分和条件，再运行模型辅助归因，交付可审计的归因记录。
4. G08-T04：生成最小改进卡，分离交付偏好与教学效果证据，并支持拒绝和撤回。

首版只接收教师结构化观察和可选的已授权材料引用，不接收或保存学生原始作业正文。模型辅助从 G08 首版即进入架构，但真实云调用仍须满足受保护密钥、联网授权、预算和逐次派发许可；当前缺少真实 API 和教学专业复核时如实标记 `BLOCKED_EXTERNAL`。测试替身和离线注入只能证明工程链路，不证明真实教学解释质量。

本阶段不重做 G00–G07，不自动修改正式成绩，不建立学生账户、全班排名、永久能力标签或教学效果综合分，也不把一次采用、一次进步或模型判断写成因果证明。

## 不可变约束

- `adopted`、实际授课、观察到表现和效果证据是独立状态，不能自动晋级。
- 未明确记录实际授课时，不允许为该课时创建课堂观察。
- 跳过反馈保持未知；不催填、不扣分、不默认成功，也不伪造比例。
- Observation 遵守现有严格合同。其 `cloud_allowed` 恒为 `false`，Observation 对象和原始材料永不直接进入真实云模型上下文。
- 学生原始作品不由 G08 首版保存。可选来源引用只保存已授权本地对象的稳定 ID、定位和用途，不复制正文到反馈表。
- 典型样本只能解释可能困难；没有覆盖依据不得推算全班错误率，缺交不得判定不会。
- 模型只能提出待验证假设。输出不得包含人格、智力、家庭原因、永久标签、未经覆盖支持的比例或因果保证。
- 模型调用前必须经过确定性测量门。题目目标、评分规则、任务可比性、样本覆盖或实际时间存在决定性未知时，先返回测量复核，不调用模型补猜。
- 改进卡优先替换而非加量，必须说明减少什么、预期观察、否定信号、正常后续任务和退回模块。
- 交付偏好与教学效果证据分别追加记录；教师反复删除某种呈现不等于该方法无效。
- 所有写操作必须持久幂等并检查预期版本；同键异载荷拒绝，失败不得覆盖旧记录。
- 每个 G08 工作包独立小提交，并同步更新 `PROGRESS.md` 与 `HANDOFF.md`。

## 方案选择

采用“本地证据账本 + 确定性测量门 + 受控模型适配器 + 追加式纠正事件”。

不采用纯规则归因，因为规则适合阻断越界结论，却不足以表达多个有条件的语文教学原因。不采用直接把 Observation 交给通用 `model.run`，因为现有 Observation 明确不可上云，且 `instructionExtra` 不是敏感边界。也不采用只做反馈表单的最小方案，因为它无法满足 M11/M12 的测量复核、反证、撤回与双轨更新要求。

模型只处理由服务层重新构造的 `AttributionContext`。该上下文是最小、去身份化、字段白名单的派生对象；它不是 Observation 的序列化副本。模型输出必须通过新严格合同，并由服务层重新施加证据边界。即使真实模型返回越界结论，也不能进入可用结果或纠正卡。

## 领域对象与状态

### 授课事件

`TeachingEvent` 表示教师明确记录的一次实际实施，至少包含：

- `event_id`、`workspace_id`、`plan_id`、`plan_revision_id`；
- `taught_at`、`actual_duration_sec`；
- `implementation_state`：`completed`、`partial` 或 `stopped`；
- `adjustment_summary`：可为空的临场调整摘要；
- `created_at` 和反馈流版本。

授课事件不改变 `lesson_plan` 发布状态，也不创建新计划修订。采用计划不会自动生成授课事件。`partial` 或 `stopped` 是实施事实，不等于教学失败；取消活动但完成目标也不能按偏离比例判教师不合格。

### 观察与反馈结果

现有严格 `Observation` 继续作为 M11 的证据对象，保存任务、来源种类、提示程度、材料关系、延迟、样本数、总体数、选择方式、覆盖限制、摘要和质量状态。首版强制：

- `source_kind` 允许 `teacher_observation`、`student_work`、`existing_exam`，但后两者只表示已授权来源的观察身份，不保存原始正文；
- `sensitive_payload_ref` 固定为 `null`；
- `cloud_allowed` 固定为 `false`；
- `summary` 通过本地确定性检查拒绝明显的姓名、联系方式等不必要身份字段，并在界面提示只写表现事实；
- `sample_count`、`population_count` 与 `selection` 必须逻辑一致。`typical_cases` 和 `voluntary` 不得产生全班比例。

现有合同没有“一次可选课后反馈”的四个界面结果字段，因此新增独立严格伴随合同 `ObservationOutcome`，包含 `observation_id` 和 `outcome`：`met_expectation`、`needed_prompt`、`clear_difficulty`、`insufficient_evidence`。不修改或放宽现有 `Observation.schema.json`。其中 `insufficient_evidence` 必须把质量状态保持为 `needs_measurement_review`，不能转成成功或失败。

### 测量检查

`MeasurementReview` 是确定性结果，包含以下固定检查：

| 检查 | 可通过条件 | 未通过处理 |
|---|---|---|
| 目标对齐 | 观察任务引用当前修订中的稳定任务或明确的外部核实题目 | 返回 M07 核对题目是否测到目标 |
| 评分可用 | 有对应量规版本，或教师明确标记仅作非评分观察 | 返回 M07 核对评分尺子 |
| 任务可比 | 材料关系、提示程度和延迟均已记录 | 只描述本次条件，不比较进步 |
| 样本覆盖 | 样本数、总体数、选择方式和限制一致 | 禁止比例与全班结论 |
| 实施条件 | 实际授课时长和临场调整已记录 | 返回 M08/M11 核对时间与实施 |

检查结果为 `pass`、`fail` 或 `unknown`，并带对象 ID 和本地证据说明。存在决定性 `fail` 或 `unknown` 时 disposition 为 `needs_measurement_review`，不派发模型。全部必要项通过时为 `ready_for_attribution`。

### 模型归因输入与输出

`AttributionContext` 由服务层从白名单字段构造，包含：

- 当前计划/修订和授课事件 ID；
- 目标、任务和量规的稳定 ID 及必要的非敏感结构摘要；
- Observation ID、结果枚举、提示程度、材料关系、延迟、样本选择和覆盖限制；
- 实际时长、临场调整类别和测量检查结果；
- 明确的禁止项和允许的原因类别。

它不得包含学生姓名、联系方式、原始作品、自由文件内容、任意路径、Observation 原始 JSON 或未获准来源片段。真实服务商派发前，服务层再次扫描白名单并要求本次 `dispatch_consent=true`。该许可只用于这一归因请求，不修改 Observation 的 `cloud_allowed=false`。

新增严格输出合同 `teaching_attribution.v1`。每个假设包含：

- `kind`：`prerequisite_gap`、`support_mismatch`、`activity_mismatch`、`retention_gap`、`expression_gap` 或 `time_constraint`；
- `summary`：待验假设而非定论；
- `observation_ids` 和 `evidence_basis`；
- `limitations`；
- `disconfirming_evidence`；
- `return_modules`。

完整结果还包含 `attribution_run_id`、模型作业 ID、内容来源、测量结果、假设数组、未执行检查和 `is_effectiveness_proof=false`。不得输出置信度百分比、学生标签、全班比例或因果措辞。非法 JSON、额外字段、未知枚举、引用不存在的观察、越界比例或禁止归因均判合同失败，不进入可用缓存。

### 改进卡与双轨事件

M12 使用现有 `Observation.schema.json` 内严格 `ChangeProposal` 定义，但在存储和代码中命名为 `CorrectionProposal`，避免与 G07 的计划修改提案混淆。它必须关联实际 Observation，并填入：

- 待验原因；
- 替换动作；
- 删除或减少的内容；
- 预期证据与否定信号；
- 正常后续任务；
- 退回模块；
- `proposed`、`accepted`、`rejected`、`reverted` 或 `supported_with_limits` 状态。

接受改进卡不会原地改写历史计划，也不会直接写“有效”。若需要修改后续课时，服务层把明确的受控请求交给 G07 变更域，仍经过预览、教师确认、整包审查和原子发布。

`PreferenceEvent` 只记录呈现或工作流偏好，例如减少默认联结数量；`EffectEvidenceEvent` 只记录在特定条件下的初步或重复支持，状态限制为 `unknown`、`initial_support`、`repeated_support`、`disconfirmed`。两条轨道互不自动派生。拒绝或撤回通过追加反向事件表达，旧依据不覆盖。

## 组件与职责

### 反馈领域模块

新增 `feedback` 领域，拆分为聚焦组件：

- 类型与严格运行时校验：TeachingEvent、ObservationOutcome、MeasurementReview、AttributionResult、CorrectionProposal 和双轨事件；
- `reviewMeasurement`：纯函数，只做确定性测量检查；
- `buildAttributionContext`：纯函数，从允许字段构造最小模型上下文并返回隐私错误；
- `validateAttributionResult`：严格模型输出和证据引用校验；
- `buildCorrectionProposal`：从已通过的测量结果与已校验假设生成一张最小改进卡；
- `FeedbackService`：协调存储、模型调用、幂等、授权和状态转换。

纯函数不读写数据库、不调用网络，便于用正例和违反规则的反例直接测试。服务只接受当前工作区内对象，不能由渲染层提交任意 Observation JSON 或自由模型提示词。

### 模型服务扩展

扩展现有提示词注册表和严格合同校验，加入 `teaching_attribution.v1`。为避免绕过 G04 的授权、预算、缓存、取消、超时和费用不确定态，G08 不另写网络客户端；由 `ModelService` 提供窄的结构化任务入口，接收已经过白名单构造的上下文和本次派发许可。

该入口复用现有：

- provider 配置与受保护密钥；
- `allowRealNetwork` 授权；
- 预算预留与结算；
- 在途去重、缓存、取消、超时和重试；
- `real`、`offline-injected`、`simulated` 内容来源身份；
- 非正常 `finish_reason` 和不合格合同不缓存。

测试替身输出固定、明确标为模拟的合法假设；DeepSeek 离线注入验证真实协议适配但仍标 `offline-injected`。真实 API 未授权时返回阻断，不触发网络；Observation、测量结果和教师历史仍可正常查看。

### SQLite 存储

新增一次向前迁移，至少包含：

- `feedback_stream`：每个计划的反馈流版本，用于 expected revision 比较；
- `teaching_event`；
- `learning_observation` 与 `observation_outcome`；
- `observation_tombstone`；
- `measurement_review`；
- `attribution_run`；
- `correction_proposal`；
- `preference_event`；
- `effect_evidence_event`；
- `feedback_idempotency`。

严格 JSON 入库前校验，读取后再次校验；损坏或未知版本进入保护错误，不以空记录掩盖。所有表按 workspace、plan 和稳定 ID 建索引。Observation 删除在单一事务中删除可识别摘要和来源引用、写入无正文墓碑、记录受影响备份范围并提升反馈流版本。删除不把“曾有观察”改成“从未发生”，但墓碑不得保留摘要正文。

一个业务写入事务同时提交对象、状态事件、幂等结果和反馈流版本。模型网络调用不持有数据库事务；先保存不可变输入快照和 running 记录，返回后按输入哈希和流版本提交结果。版本已变化时保存为历史但不自动用于当前改进卡。

### IPC 与界面

实现现有目录操作：

- `plans.recordTeaching`；
- `observations.add`；
- `observations.list`；
- `observations.delete`。

新增窄接口：

- `feedback.analyze(planId, teachingEventId, observationIds, dispatchConsent, expected_revision, idempotency_key)`；
- `feedback.history(planId)`；
- `corrections.decide(proposalId, decision, expected_revision, idempotency_key)`；
- `corrections.revert(proposalId, reason, expected_revision, idempotency_key)`。

所有 payload 经 `schemaGate` 拒绝多余字段、未知枚举、过长文本、任意路径和缺失版本/幂等键。预加载只暴露命名方法。观察删除需要主进程签发的一次性交互确认令牌；渲染层不能自行构造令牌。

“我的课程”保持单一路径：

1. 已采用课程显示独立的“记录已授课”动作。
2. 教师记录实际时长和可选临场变化。
3. 页面出现一次可选反馈：达到要求、仍需提示、明显困难、证据不足。
4. 教师可以跳过；页面只显示“尚无反馈”，不出现打卡提醒。
5. 选择分析时先展示测量检查。条件不足时只显示需核对项；条件足够时显示模型来源、未执行检查和多个待验假设。
6. 界面只呈现一张最小改进卡，可接受、拒绝或撤回。接受后仍需通过 G07 的明确修改确认才能重建材料。
7. 历史页分列“交付偏好”和“效果证据”，并显示每项的条件、来源和撤回事件。

界面不显示“模型已证明”“全班掌握率”“教学有效分”或永久学生分类。模拟与离线注入内容使用持续可见的非真实标记。

## 错误处理与降级

- 未记录授课：拒绝新增 Observation，提示先确认实际授课事实。
- 过期反馈流版本：返回 `VERSION_CONFLICT`，展示新事件，不覆盖。
- 同幂等键异载荷：返回输入错误；同键同载荷重放原结果。
- 样本或测量条件不足：保存 Observation，归因 disposition 为 `needs_measurement_review`，不派发模型。
- 隐私白名单失败：返回 `PRIVACY_BLOCKED`，本地观察不丢失。
- 未配置真实 API、无联网授权、无逐次许可或无受保护密钥：返回明确阻断，不触发网络；允许教师使用本地历史和手工改进卡。
- 模型非法输出、越界归因或不完整终止：保存失败运行记录，不产生可接受改进卡；不把模型文字降格后偷偷使用。
- 模型超时或已派发网络异常：沿用 G04 `uncertain` 和费用保留规则，不自动重发。
- 改进卡应用失败：旧计划、旧材料、Observation 和历史事件保持不变。
- 删除失败：Observation 保持可见，不写成功墓碑；备份影响未核实时明确显示未完成。
- 同一路径三次无进展：停止自动重试，保留可靠状态并给出下一步。

## 测试与验收

所有生产行为按 TDD 实现，先运行能暴露缺失能力的失败测试，再写最小实现。冻结验收项保持原状态；机器测试覆盖不自动把需要真人或真实环境的项目改为 PASS。

### G08-T01

- 已采用计划仍显示未授课；只有明确操作创建 TeachingEvent。
- 授课事件绑定存在的当前或历史 revision，不改变计划发布状态。
- `partial`、`stopped` 和临场调整不自动判失败。
- expected revision 竞争只有一个提交成功；幂等重放不重复创建。
- 覆盖 BIZ-R055 的可机器执行部分；不宣称教师专业实施质量通过。

### G08-T02

- 四种反馈结果均形成严格 Observation + ObservationOutcome。
- 没有 TeachingEvent 时拒绝观察；跳过反馈后历史保持 unknown。
- `typical_cases`、`voluntary` 或未知总体不能产生全班比例。
- 提示程度、材料关系和延迟被保留；同题提示后答对不标迁移或延时保持。
- 摘要中的明显身份数据被阻断；原始作品正文和任意路径不能进入请求或数据库。
- 删除成功后正文不可检索，墓碑无正文；事务失败时原观察保留。
- 覆盖 BIZ-R016–R020、BIZ-R051–R052、JOB-005、PED-004、PED-008 的可机器执行部分。

### G08-T03

- 缺题目目标、评分规则、可比性、覆盖或实际时间时只返回测量复核，不调用 provider。
- 合格上下文仅含白名单字段，Observation JSON、原始作品和身份信息不进入模型请求。
- 测试替身与 DeepSeek 离线注入均通过 `teaching_attribution.v1`；来源身份分别保持 `simulated` 和 `offline-injected`。
- 无逐次许可的真实 provider 不发请求；真实 API 路径记录 `BLOCKED_EXTERNAL`。
- 非法 JSON、未知字段、虚构 observation ID、全班比例、人格/家庭归因和因果保证均拒绝。
- 模型失败仍可读取 Observation 和测量结果，且不生成伪改进卡。
- 覆盖 BIZ-R053–R054、PED-004 的工程边界；解释质量另列专业判断状态。

### G08-T04

- 改进卡包含替换、删减、成本、预期、反证、正常任务和退回模块。
- 同一问题不默认增加作业；重复原题改善不单独升级为迁移证据。
- 接受、拒绝、撤回均为追加事件，旧依据可查；撤回后当前建议恢复可靠前态。
- 偏好变化不能修改效果状态，效果事件不能静默改变交付偏好。
- 没有可比条件时最多记录 `initial_support`；一次采用率不能升级效果。
- 后续计划变更仍经过 G07 预览、审查、五文件原子发布和失败回退。
- 覆盖 BIZ-R056–R060、PED-006、PED-008 的可机器执行部分。

### 每包验证

每包完成后运行定向测试、全量 Vitest、主/渲染 TypeScript、ESLint、`verify:contracts`、renderer/main build 和 `git diff --check`。记录实际环境、命令、退出码、fixture 身份、内容来源和阻断项。缺少 Electron 二进制、真实 API、干净 Windows、Office/WPS、签名或教学专业复核时分别记 `BLOCKED_EXTERNAL`，互不替代。

## 交付与提交边界

- 提交 1：G08-T01 授课事件、反馈流版本、IPC/UI、测试、`PROGRESS.md`、`HANDOFF.md`。
- 提交 2：G08-T02 Observation、样本边界、删除墓碑、IPC/UI、测试和进度文档。
- 提交 3：G08-T03 测量门、模型辅助归因合同与适配、来源身份、测试和进度文档。
- 提交 4：G08-T04 改进卡、双轨事件、撤回、历史 UI、证据边界测试和进度文档。

不直接合并 `main`。完成并验证后留在功能分支供审查；没有外部证据时不关闭相应验收门。
