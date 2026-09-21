# G12 教师端备课闭环修复设计

## 1. 目标

在不重写 G00–G11 已有安全、资料、模型、LessonPlan、审查、材料生成和一处修改能力的前提下，交付普通教师可从图形界面完成的一条真实纵向路径：

`设置班级/教材/课时 → 导入并选择资料 → 本地或模型辅助生成 → 审查 → 确认 → 原子生成三类五文件 → 应用内课堂展示 → 一处修改 → 新修订重新审查与导出`。

DeepSeek 是可选增强而不是单点故障。无真实 API、网络或预算时，教师仍可通过本地结构化自拟模式完成流程；两种模式都必须显示真实内容来源并接受教师复核。

## 2. 根因与修复原则

当前 `PreparePage` 是 G01 骨架中的硬编码禁用占位；G05/G06 只向生产界面暴露 `lesson.buildDemo`，没有从资料、教学上下文和模型结果组建计划的业务编排层。后续包复用了演示计划，导致底层能力丰富但主流程不可达。

本修复遵守以下原则：

- 不以解除 `disabled`、复制演示 fixture 或硬编码计划冒充完成。
- 正式路径不调用 `lesson.buildDemo`；测试 fixture 不进入生产 IPC 目录。
- 复用现有 `SourceStore`、`ModelService`、`buildLessonPlan`、`reviewLessonPlan`、`LessonChangeService` 和材料原子发布边界。
- 新增的编排状态持久化、可恢复、幂等并带版本检查。
- 业务案例只有在当前 commit/候选包上实际执行后才可转为 `PASS/FAIL`。

## 3. 范围与非目标

### 3.1 本次范围

- 最小班级、教材、课题和课时上下文。
- 备课会话、资料选择、稳定状态恢复和生成身份。
- 严格的本地自拟与 DeepSeek 模型辅助两条生成路径。
- 计划预览、确定性审查、教师确认、五文件导出和历史恢复。
- 应用内只读课堂展示，教师控制提示/答案揭示。
- 从当前计划进入现有“一处修改”，产生新修订和新成品包。
- 当前 Windows 候选的端到端 UI 验收和诚实发行证据。

### 3.2 非目标

- 不建设全国教材目录、学校 SIS 或班级花名册。
- 不在本包证明 DeepSeek 教学质量、WPS 保真、真人教师专业有效性、代码签名或正式分发。
- 不自动上传真实学生原文，不让模型输出执行脚本、SQL 或 shell。
- 不覆盖旧课时、旧修订、旧成品包或既有验收运行。

## 4. 架构

新增 `preparation` 子系统作为现有能力之间的唯一正式编排边界：

```text
Prepare UI
  → named preload APIs
    → PreparationService
      → PreparationStore / SQLite
      → SourceStore（只读已选择片段）
      → ModelService（可选、预算与授权门）
      → LocalPlanSpecBuilder / ModelPlanSpecParser
      → buildLessonPlan + validateLessonPlan
      → reviewLessonPlan
      → 现有材料原子发布与 LessonChangeService
```

`PreparationService` 不接受 renderer 传入任意路径、提示词或任意 IPC 操作名。Renderer 只提交闭集字段、资料版本 ID、字符范围和明确的模型外发许可。

## 5. 数据模型

SQLite schema 从版本 12 迁移到版本 13。迁移必须保持既有数据库数据和迁移回滚机制。

### 5.1 `teaching_context`

| 字段 | 约束 |
| --- | --- |
| `context_id` | 主键，应用生成 |
| `class_display_name` | 1–80 字符，不要求真实学生姓名 |
| `grade` | 闭集：`grade7/grade8/grade9/other` |
| `textbook_title` | 1–120 字符 |
| `textbook_edition` | 0–80 字符，可留空并进入 unknowns |
| `unit_title` | 0–120 字符 |
| `lesson_title` | 1–160 字符 |
| `duration_sec` | 300–14,400 的整数 |
| `notes` | 最多 2,000 字符，仅本地 |
| `revision` | 乐观并发整数 |
| `created_at/updated_at` | ISO 时间 |

### 5.2 `preparation_session`

| 字段 | 约束 |
| --- | --- |
| `session_id` | 主键 |
| `context_id` | 外键 |
| `status` | 状态机闭集 |
| `mode` | `local_authored/model_assisted` |
| `focus` | 教学重点，最多 2,000 字符 |
| `core_task` | 本地模式必填，最多 4,000 字符 |
| `answer_scope` | 本地模式必填，最多 4,000 字符 |
| `plan_id/revision_id` | 可空，成功组建后绑定 |
| `review_report_id` | 可空，审查后绑定 |
| `bundle_id` | 可空，导出后绑定 |
| `model_job_id` | 可空，不保存密钥或完整请求 |
| `content_origin` | `teacher_authored/model_assisted_real/model_assisted_simulated` |
| `last_error_code` | 闭集错误码，可空 |
| `revision` | 乐观并发整数 |
| `created_at/updated_at` | ISO 时间 |

### 5.3 `preparation_source`

复合主键为 `session_id + ordinal`。保存 `source_version_id`、`char_start`、`char_end`、`purpose`（`textbook/curriculum/teacher_reference`）、`approved_for_model` 和选中时的文本 SHA-256。每次生成前重新读取并验证版本、范围、分类和哈希；学生敏感资料默认拒绝模型外发。

状态推进使用现有持久幂等与 outbox 边界；不再增加第二套通用任务框架。

## 6. 状态机与恢复

稳定状态：

```text
CONTEXT_DRAFT → SOURCES_SELECTED → PLAN_REVIEW → READY_TO_EXPORT → EXPORTED
```

瞬时状态：`BUILDING`、`EXPORTING`。启动调和规则：

- 遗留 `BUILDING` 且没有有效新计划：回到 `SOURCES_SELECTED`，记录 `PREPARATION_INTERRUPTED`。
- 遗留 `EXPORTING`：调用现有包发布调和；只有清单、文件哈希和数据库登记一致时进入 `EXPORTED`，否则回到 `READY_TO_EXPORT`。
- 计划或来源修订变化使旧审查失效，状态退回 `PLAN_REVIEW`。
- 一处修改产生新计划修订，必须重新审查；成功后新 bundle 成为会话当前 bundle，旧 bundle 保留。

所有写操作要求 `expectedRevision + idempotencyKey`。相同键与相同载荷重放原结果；相同键与不同载荷拒绝。

## 7. 生成路径

### 7.1 本地自拟

教师填写教学重点、核心任务和答案范围。系统只进行确定性结构组装、时间分配和来源锚点连接，不生成未经来源支持的事实或引文。缺少教材版本、课标映射或学情时写入 `unknowns`，不得伪造。

### 7.2 模型辅助

模型任务新增严格的 `lesson_plan_spec` 合同。请求只含教学上下文、教师选择且逐片段授权的必要文字、固定系统指令和费用边界；教师不输入自由提示词。

模型输出必须满足：

- 严格 JSON，拒绝额外字段、脚本、路径和工具指令。
- 至少一个目标、任务、活动和来源锚点。
- 引用只能指向请求内已授权片段。
- 时间范围、答案范围和结构经本地校验。
- 真实网络成功标记 `model_assisted_real`；测试替身只能标记 `model_assisted_simulated`，且不进入正式教师候选的默认路径。

模型超时、取消、预算不足、无密钥、输出不合法或来源漂移时，不保存计划；会话回到 `SOURCES_SELECTED`，允许教师改用本地模式。

## 8. IPC 与组件边界

新增命名操作：

- `preparation.context.save/get`
- `preparation.session.create/get/list`
- `preparation.sources.set`
- `preparation.build`
- `preparation.review`
- `preparation.confirm`
- `preparation.export`
- `preparation.resume`
- `presentation.open/close`

每个操作加入 `ipc-catalog`、schema gate、共享类型和 preload 具名方法。`lesson.buildDemo` 从生产 catalog、preload 和 renderer 移除；fixture 通过测试内直接调用 builder。

Renderer 拆分为：

- `PreparePage`：加载当前会话和步骤导航。
- `ContextStep`：班级/教材/课时。
- `SourceSelectionStep`：资料与片段、外发许可。
- `BuildStep`：本地或模型模式及进度/降级。
- `PlanReviewStep`：计划、来源、unknowns、审查问题与教师确认。
- `ExportStep`：五文件、版本、哈希、打开位置和修改入口。
- `ClassroomPresentation`：独立受限窗口，只读当前已审查修订。

`App.tsx` 只保留导航和页面装配，不继续堆叠新业务状态。

## 9. 课堂展示

课堂展示从已审查的 `LessonPlan` 构造本地只读视图，不读取任意文件路径，也不启动 HTTP/WebSocket。主进程只允许为当前会话、当前审查通过修订创建一个受限 BrowserWindow；保持 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`。

展示顺序来自 activities/tasks。任务题面先显示，提示和答案范围仅由教师显式推进；关闭窗口不会修改课程。未审查、过期修订或来源失效时拒绝打开。

## 10. 错误、隐私与安全边界

- 至少一个可重新读取和校验的来源片段才可生成。
- 本地模式不调用网络；模型模式逐片段授权，学生敏感资料默认本地。
- API 密钥只经一次性 IPC 进入主进程安全存储，不回传、不记录、不进入备份。
- 模型调用继续受 1,000 分人民币硬上限、超时、取消、缓存和重试截止控制。
- 模型输出不执行；任何非合同输出都映射到闭集错误码。
- 未审查计划不能确认、导出或展示；审查未执行项在 UI 中保持可见。
- 文件生成和数据库登记使用现有 staging、哈希复读、原子发布与失败清理。
- Renderer 不接收任意本机路径；打开/定位成品只针对数据库登记且哈希复核通过的当前制品。
- 真实 API、WPS、签名、教师专业复核和正式分发继续独立标记 `BLOCKED/NOT_RUN`。

## 11. 验收标准

### 11.1 自动化

- Schema 13 迁移保留既有数据，并覆盖升级中断和重启调和。
- 状态机拒绝非法跳转、过期 revision、幂等键换载荷、来源漂移和重复导出。
- 本地模式生成完整有效 LessonPlan，不伪造引用，并传播 `teacher_authored`。
- 模型模式覆盖真实协议替身、严格 JSON、超时、取消、预算、隐私拒绝和非法引用。
- 审查失败不能确认；确认前来源或上下文变化使审查失效。
- 五文件生成、登记和当前 bundle 指针在故障注入下全成或全不成。
- 课堂展示拒绝未审查/过期修订，任务、提示、答案按显式操作推进。
- 生产 renderer/preload/catalog 不含 `lesson.buildDemo`。
- 全量 typecheck、lint、合同、单测、隐私扫描和 `git diff --check` 通过。

### 11.2 当前候选 UI 纵向验收

从新安装或隔离 userData 开始，实际完成：

1. 保存班级、教材、课题和课时。
2. 导入合成资料并选择精确片段。
3. 以本地自拟模式生成计划。
4. 查看来源、unknowns 和审查报告并确认。
5. 生成并复核三类五文件清单与哈希。
6. 打开课堂展示，验证任务先于提示/答案显示。
7. 执行一处修改，生成新修订和新 bundle，旧版本仍可查。
8. 在至少两个稳定状态重启并恢复会话。

真实 DeepSeek、WPS、教师专业复核、干净标准用户 VM、签名和分发只有实际执行且证据绑定当前 commit/候选时才更新案例状态。

## 12. 四包拆分

### G12-T01 数据模型与状态机

交付 schema 13、三类记录、事务 API、恢复调和、IPC 合同和状态机测试。同步更新 `planning/work-packages.json`、`PROGRESS.md`、`HANDOFF.md`。

### G12-T02 本地/模型备课编排

交付 `PreparationService`、本地自拟 builder、严格 `lesson_plan_spec` 模型合同、来源/隐私/预算门、审查与确认。移除生产 `lesson.buildDemo`。

### G12-T03 教师界面与课堂展示

交付拆分后的备课步骤界面、历史恢复、导出/修改接线和受限课堂展示窗口；保留最少教师输入与明确来源身份。

### G12-T04 端到端验收与候选

交付 Electron UI 纵向测试、当前 Windows 候选安装/启动/闭环运行、新追加验收运行、中文指南、SBOM、校验和及诚实的阻断清单。外部门不因内部闭环完成而自动转为 PASS。

## 13. 完成定义

内部闭环完成要求 T01–T04 的代码和自动化全部通过，且当前候选实际走通本地模式纵向路径。只有这时才可删除教师指南中的“备下一课入口禁用”限制。

项目正式发行仍需独立满足：真实 API 证据、WPS/Office 保真、真人教师专业复核、干净 Windows 标准用户验收、锁定构建环境、缺陷审计、代码签名/时间戳和授权分发位置。
