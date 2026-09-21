# G12-T07 AI 主导教师备课流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将真实“备下一课”入口改为“导入资料、填写少量信息、AI 自动规划、一次确认后生成教学文件”的教师流程。

**Architecture:** 保留主进程 PreparationService 与所有安全门，在 renderer 增加可测试的串行编排器和两个教师语义组件。PreparePage 只协调加载、恢复、导入和阶段状态，App 不再向备课页追加工程诊断卡。

**Tech Stack:** React 18、TypeScript 5.5、Electron 命名 IPC、Vitest、现有 SQLite/PreparationService。

**Spec:** `docs/superpowers/specs/2026-09-21-g12-t07-ai-first-teacher-flow-design.md`

## Global Constraints

- 不新增依赖，不改主进程合同和冻结验收定义。
- AI 外发必须逐次授权；不自动重试、追加消费或冒充教师确认。
- 主界面不得显示状态枚举、UUID、revision、bundle、哈希或字节数。
- 真实 API、WPS、签名、分发和真人教师复核继续 `BLOCKED_EXTERNAL/NOT_RUN`。
- 使用现有隔离 worktree；不推送或合并 GitHub `main`。

---

### Task 1: 锁定真实入口与编排行为

**Files:**
- Create: `apps/desktop/src/renderer/preparation/aiFlow.ts`
- Create: `apps/desktop/tests/g12-ai-first-workflow.test.ts`
- Modify: `apps/desktop/tests/g10-accessibility-layout.test.ts`

**Interfaces:**
- Produces: `runAiPlanning(gateway, input)` 返回已审查 session/report；`confirmAndExport(gateway, session)` 返回已导出 session。

```ts
export interface AiPlanningInput {
  context: PreparationContextPayload;
  contextRevision: number;
  sourceVersionId: string;
  guidance: string;
  idempotencyPrefix: string;
}

export async function runAiPlanning(
  gateway: AiFlowGateway,
  input: AiPlanningInput
): Promise<{ session: PreparationSession; report: ReviewReport }>;

export async function confirmAndExport(
  gateway: AiFlowGateway,
  session: PreparationSession,
  idempotencyPrefix: string
): Promise<PreparationSession>;
```

- [ ] 写真实 `App` 初始渲染失败测试：必须出现 AI 价值说明，不得出现“备课草稿（本地保存）”和“系统状态”。
- [ ] 写严格假网关失败测试：每一步核对输入 session/revision，证明 build 后 review，且没有 confirm/export。
- [ ] 写确认导出失败测试：证明 confirm 返回的新 revision 被 export 使用。

```ts
const planned = await runAiPlanning(strictGateway, {
  context: contextPayload,
  contextRevision: 0,
  sourceVersionId: 'version-1',
  guidance: '',
  idempotencyPrefix: 'test-plan'
});
expect(planned.session.status).toBe('PLAN_REVIEW');
expect(planned.report.disposition).toBe('ready_for_teacher');
expect(strictGateway.finalizedCount()).toBe(0);

const exported = await confirmAndExport(strictGateway, planned.session, 'test-export');
expect(exported.status).toBe('EXPORTED');
```
- [ ] 运行 `npm run -w @yuwendesk/desktop test:unit -- tests/g12-ai-first-workflow.test.ts tests/g10-accessibility-layout.test.ts`，确认因缺少新入口/编排器而失败。
- [ ] 实现 `aiFlow.ts` 的最小串行编排与错误短路。
- [ ] 重新运行定向测试，确认编排测试通过而 UI 测试仍因旧界面失败。

### Task 2: 新建教师输入与结果组件

**Files:**
- Create: `apps/desktop/src/renderer/preparation/AiPreparationStart.tsx`
- Create: `apps/desktop/src/renderer/preparation/AiPreparationResult.tsx`
- Modify: `apps/desktop/tests/g12-ai-first-workflow.test.ts`

**Interfaces:**
- Consumes: `ContextDraft`、`SourceCandidateView`、`LessonPlan`、`ReviewReport`、`PreparationArtifactView`。
- Produces: `AiPreparationStart` 单一 `onStart` 入口；`AiPreparationResult` 单一 `onConfirmAndExport` 入口。

```tsx
<AiPreparationStart
  candidates={candidates}
  selectedVersionId={selectedVersionId}
  context={contextDraft}
  guidance={guidance}
  approvedForModel={approvedForModel}
  busy={busy}
  onFiles={importFiles}
  onSelect={setSelectedVersionId}
  onContext={setContextDraft}
  onGuidance={setGuidance}
  onApproval={setApprovedForModel}
  onStart={startAiPreparation}
/>
```

- [ ] 写失败测试：初始组件包含文件选择、已有资料、年级/课题/课时、可选要求、授权和“让 AI 完成备课”，没有三项教学判断。
- [ ] 写失败测试：结果组件只显示教师语义，不显示传入的计划/修订/成品包 ID；完成态按三类用途分组，技术哈希默认折叠。

```ts
const html = renderToStaticMarkup(createElement(AiPreparationResult, resultFixture));
expect(html).toContain('AI 已完成备课方案');
expect(html).not.toContain('READY_TO_EXPORT');
expect(html).not.toContain('plan-internal-id');
expect(html).not.toContain('revision-internal-id');
expect(html).toContain('<details');
```
- [ ] 实现两个组件与人类可读 session 状态映射。
- [ ] 运行定向测试确认通过。

### Task 3: 将真实 PreparePage 接入一次 AI 编排

**Files:**
- Modify: `apps/desktop/src/renderer/preparation/PreparePage.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/tests/g12-ai-first-workflow.test.ts`
- Modify: `apps/desktop/tests/g10-accessibility-layout.test.ts`

**Interfaces:**
- Consumes: `runAiPlanning`、`confirmAndExport`、window.yuwen 命名 IPC。
- Produces: 真实应用三段流程；文件导入支持 txt/md/csv/pdf/docx/xlsx/pptx。

- [ ] 写/完善失败测试：完整 App 使用三段价值流程且不渲染六段状态机、草稿或健康卡。
- [ ] 在 PreparePage 中加载已有资料、处理文件导入、派生教材名并以现有来源哈希门绑定资料。
- [ ] 单次主按钮保存最小 context、创建 model session、绑定授权片段、build、review，再恢复方案。
- [ ] 单次确认按钮调用 confirm、export 并恢复完成态；失败保留现有方案和教师可执行信息。

```ts
const planned = await runAiPlanning(windowGateway, {
  context: normalizedContext,
  contextRevision: context?.revision ?? 0,
  sourceVersionId: selectedVersionId,
  guidance,
  idempotencyPrefix: requestKey('ai-plan')
});
await resume(planned.session.sessionId);

const exported = await confirmAndExport(
  windowGateway,
  session,
  requestKey('ai-export')
);
await resume(exported.sessionId);
```
- [ ] App 真实入口删除备课页后的 DraftNote/HealthPanel，更新导航提示；CSS 提供单列主任务、文件投放和结果卡响应式样式。
- [ ] 运行定向测试、typecheck 与 lint。

### Task 4: 完整验证、视觉走查与交接

**Files:**
- Modify: `PROGRESS.md`
- Modify: `HANDOFF.md`
- Modify: `reports/G12_EVIDENCE.md`

**Interfaces:**
- Produces: G12-T07 提交、当前提交绑定候选/纵向/追加验收和新的 outputs 交付目录。

- [ ] 构建生产 renderer/main，以隔离临时 SQLite 与合成资料实际渲染初始、方案、完成三个页面并检查无枚举/UUID。
- [ ] 运行全量 `test:unit`、typecheck、lint、build、`verify:contracts`、`git diff --check`。
- [ ] 更新 PROGRESS/HANDOFF/G12 证据，明确 UI 证据不替代真实 API、WPS 或真人复核。
- [ ] 提交 G12-T07 源码，从 clean HEAD 执行 `build:candidate`、Electron G12 纵向、Node ABI 恢复、追加 AcceptanceRun、发行证据/SBOM/最终校验。
- [ ] 创建不覆盖旧交付的 `outputs/YuwenDesk-0.1.0-g12-<commit>` 目录和 ZIP，逐文件回读 SHA-256。

### Task 5: 使用真实教材完成一次教师业务并评估质量

**Files:**
- Create: `reports/G12_T07_TEACHER_RUN.md`
- Create: `reports/G12_T07_EXPERT_RUBRIC.json`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: T07 clean candidate、`C:\Users\ye\Desktop\初中语文教材`、应用内 safeStorage 模型配置。
- Produces: 绑定 candidate/source commit 的教师业务记录与非认证 AI 专业量规。

- [ ] 只读盘点六本教材文件名、大小和 SHA-256，不把教材或正文复制进仓库/outputs。
- [ ] 在真实新候选中导入一本教材，选择可核验课文，输入年级/课题/课时及“AI 补充参考”要求。
- [ ] 只读取模型配置的非秘密字段；若已有受保护凭据，执行一次真实模型生成并记录 provider/model、开始结束时间、状态、用量与费用，不记录密钥或请求正文；否则记录 `BLOCKED_EXTERNAL` 并继续离线可执行检查。
- [ ] 完成软件检查、一次教师确认、教学文件生成、课堂展示和一次修改，记录每步实际结果与失败恢复。
- [ ] 按固定 10 项量规逐项给出 0–4 分、证据和缺口，输出以下闭集结论之一：

```json
{
  "reviewKind": "AI_SIMULATED_PEDAGOGICAL_REVIEW",
  "totalScore": 0,
  "maxScore": 40,
  "disposition": "NEEDS_REVISION",
  "humanExpertCertification": "NOT_RUN"
}
```

- [ ] 报告明确：`READY_FOR_HUMAN_EXPERT_REVIEW` 只表示具备送真人评审条件；没有真实特级教师时不得写“达到特级教师标准”。
- [ ] 将业务记录、量规、候选来源、验收和已知限制一起放入最终交付目录，重新核验全部 SHA-256。
