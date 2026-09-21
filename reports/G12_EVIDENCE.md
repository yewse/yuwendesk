# G12 教师备课主流程闭环证据

## 范围

G12 只关闭本地工程主流程：保存班级/教材/课时上下文，选择精确资料片段，本地自拟或模型辅助生成，软件审查，教师确认，三类五文件原子导出，一处修改同步，以及受限课堂展示。它不把合成材料、软件审查或模型自审当作合法现用教材和真人教师专业复核。

production `lesson.buildDemo` 已从 preload、IPC、schema gate、renderer 和构建产物移除。课堂展示仅接受当前已审查修订，按主窗口限制一个展示窗口，使用 sandbox 与 context isolation，不启动本地 HTTP/WebSocket 服务；提示和答案分别由教师显式揭示。

## G12-T01–T03 工程证据

- T01：schema 13、教学上下文、备课会话、来源范围/SHA-256、乐观修订、持久幂等和中断恢复。
- T02：只引用核验片段的本地 builder，固定 `lesson_plan_spec.v1` 严格模型输出，模型失败显式本地降级，当前审查修订确认，真实五文件暂存/回读/原子发布。
- T03：分步教师界面、内容来源与 unknowns 展示、课堂窗口、恢复入口，以及已导出会话执行一处修改后的 revision/review/bundle 同步。

## G12-T04 合同与提交前验证

- `g12-vertical-contract.test.ts` 先在旧指南上按预期失败，随后验证已启用流程、production 命名操作、冻结 130+40 验收定义及严格候选绑定证据。
- G12/G11 发行合同定向：84/84；完整 Vitest：689 passed / 1 skipped（690 total，76 files）。
- `npm run typecheck`、`npm run lint`、`npm run build` 均退出 0；`git diff --check` 必须在提交前再次执行。
- 提交前 `verify:contracts` 仍有 1 项预期失败：旧 G11 发行证据不再绑定当前 G12 源码、候选和输入哈希。该失败不能改名为 PASS；提交后必须从 clean commit 构建候选、追加运行并重建发行事务。
- Windows checkout 的 CRLF 不再让确定性公开 Markdown 产生伪失败；校验只规范化换行，逐文件 SHA-256 仍检查实际字节，其他文本差异仍失败。

## 提交后候选绑定步骤

1. `npm run build:candidate` 只接受 Windows clean tree，并生成绑定 HEAD 的固定未签名候选及来源记录。
2. `npm run --workspace @yuwendesk/desktop test:e2e:g12` 使用真实 Electron BrowserWindow、preload、命名 IPC 和 SQLite，以合成资料执行生成、审查、确认、五文件、展示、揭示答案、一处修改、重启恢复及 `integrity_check`。
3. 纵向 JSON 必须绑定同一 source commit 和候选字节，只含闭集观察值；来源漂移、候选漂移、秘密、路径或额外字段会整轮拒绝。
4. `acceptance:run -- --g12-evidence ...` 只把该文件作为追加运行的 supplemental evidence，不改变 170 个冻结案例的映射或由此提升外部案例状态。历史运行不覆盖。
5. 重新生成 release evidence、SBOM、清单、签名状态和公开状态；未签名、未完成外部门时 `release:verify` 应如实退出 2，而不是伪造正式发布通过。

## 首次候选运行发现与修复

clean commit `30198308b311d7e81315943517f8b98dea47860b` 生成的 131,049,170-byte 候选（SHA-256 `35520d8d945cebfc861d6c59356bad268f1d65d387321a8bef42a15f064e9fec`）在首次 G12 Electron 纵向运行中实际失败，失败点是课堂展示资格检查，故未产生或提交 PASS 证据。诊断确认五文件发布会保存一份加入材料包一致性检查的新审查报告，但备课会话仍指向导出前报告；展示服务按设计拒绝了不一致指针。

修复采用 fail-closed 语义：真实导出器返回发布审查报告 ID，`EXPORTED` 状态转换同时更新会话的 `bundleId` 和 `reviewReportId`。回归断言先复现旧指针与最新报告不一致，再验证同步后的指针；没有删除或放宽展示资格检查。该修复必须形成新 clean commit、重建候选并从头重跑纵向流程，旧候选不能借证。

## 外部边界

真实 DeepSeek 调用、WPS 打开/编辑/保存/分页/放映、干净标准用户 Windows 安装、合法现用教材覆盖、真人教师专业复核、正式签名/可信时间戳和授权分发地址，只有绑定当前 commit/候选实际执行后才能记为 PASS/FAIL；否则继续 `BLOCKED_EXTERNAL/NOT_RUN`。已提供的隐私外发许可不允许把密钥写入仓库、命令或证据。
