# G08 反馈、模型辅助归因与可逆纠偏证据

日期：2026-09-20  
分支：`codex/g07-review-change`  
证据基线提交：`828079abb1c89cd4aea25c01b8745801905a8ab2`（G08-T03）  
G08-T04 实现提交：包含本报告的 `feat(G08-T04): add reversible evidence-bounded corrections` 提交；提交后可用 `git log -1 --format=%H -- reports/G08_EVIDENCE.md` 解析，不在提交内容中伪造自引用哈希。

## 环境与 fixture

- OS：Microsoft Windows 11 专业版，10.0.26200，64 位；这是开发主机，不是干净安装验收 VM。
- Node.js：v24.15.0；npm：11.12.1；Vitest：2.1.1；TypeScript：5.5.4。
- 课时 fixture：`demoLessonSpec` 生成的自拟计划；纠偏链使用 `plan_correction_*`、`teaching_correction_*`、`observation_correction_*` 等稳定测试身份。
- 内容身份：确定性模型替身为 `simulated`；DeepSeek 仅使用离线注入传输并标 `offline-injected`。没有把任一结果写成真实 API 成功。
- 数据边界：所有观察摘要、样本和教学情境均为虚构测试数据，不含真实学生作品、姓名、联系方式或真实 API 凭据。

## 实际执行命令与结果

以下命令均在上述分支实际退出 0：

```text
npm run -w @yuwendesk/desktop test:unit -- tests/feedback-correction.test.ts tests/g08-correction-flow.test.ts tests/g08-evidence-boundary.test.ts tests/feedbackView.test.ts
  4 test files passed
  25 tests passed

npm run -w @yuwendesk/desktop test:unit
  41 test files passed
  353 tests passed / 1 skipped / 354 total

npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

全量测试仍出现既有 pdfjs 可选 `canvas` polyfill 与 `standardFontDataUrl` 警告；相关抽取断言通过。本报告不把这些自动化结果当成 Electron 窗口、Office/WPS 视觉保真或真实打印证据。

## G08-T04 机器可执行证据

- 严格 `CorrectionProposal` 复用 M12 字段；原始提案保持 `status=proposed`，接受、拒绝和撤回只追加决策事件并由历史重放派生当前状态。
- 纠偏先替换/缩减，再允许增加负担；空缩减、只增加十道课后题、全班排名和“教学有效已证明”等表述均被拒绝。
- 模型归因成功后在同一完成事务中创建一份最小纠偏提案；模型假设不会直接创建课时修订或五文件。
- `corrections.decide` / `corrections.revert` 同时校验反馈流版本、提案状态版本、幂等指纹和观察引用。跨重启同键同意图重放原结果；同键异意图拒绝。
- 在提案更新、偏好事件、效果事件、反馈流递增和幂等结果写入五个事务边界逐点注入失败；每次提案、双轨事件、流版本和幂等结果整体回滚。
- 接受提案只返回类型化 G07 `LessonChange` 预览建议；UI 明确要求再进入“一处修改”预览确认，不调用 G07 apply，也不生成新修订或材料包。
- “交付偏好”与“效果证据”分轨追加；重复表达偏好不会改变效果标签。`initial_support` 显示为“有限条件下的初步证据（非效果证明）”。
- `repeated_support` 至少需要两个当前未删除的观察身份，并包含相似新材料或不同情境、延迟和独立完成条件；仍不写成因果证明。
- `feedback.history` 合并经过验证的授课、当前观察、无正文删除墓碑、测量、归因、提案、偏好、效果与反馈流版本。删除后的观察 ID 不能再进入新的归因结果。
- 跨阶段边界覆盖：采用不等于授课；跳过反馈保持 unknown；典型 6/42 样本不显示百分比；同题/完整示范/即时观察保留迁移、延迟保持和独立表现限制；模拟/离线输出持续显示来源。
- 冻结验收 JSON 以测试固定哈希，未删除或改写状态：
  - `acceptance/cases.json`：`cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`
  - `acceptance/addenda/classroom-delivery.cases.json`：`f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`

## 合同哈希

| 文件 | SHA-256 |
|---|---|
| `contracts/TeachingAttribution.schema.json` | `7e0e6a70d1133d0d788625bc1647274386c4ac62dd4d3ca6277e2687f7f2e69e` |
| `contracts/Observation.schema.json` | `e17384baccc9bb142629a39329e71ea9b5de645dcb680e6dfd101af93115f4c3` |
| `contracts/ipc-catalog.json` | `9bfa462fdfc49288013b0c8e9baca0b6700ef94057700ff09022e67c9097457d` |

## 外部门（与本地 PASS 分开）

| 证据门 | 状态 | 原因 |
|---|---|---|
| 真实云 API 归因质量与费用行为 | `BLOCKED_EXTERNAL` | 缺获准账户、密钥、联网与费用授权；离线协议/测试替身不替代实网质量验证。 |
| 真实学生材料隐私授权与外发许可 | `BLOCKED_EXTERNAL` | 未取得真实数据处理授权；本轮只用虚构、去身份化 fixture，Observation 保持 LOCAL_ONLY。 |
| 教学专业复核 | `BLOCKED_EXTERNAL` | 待有资质教师复核归因、最小纠偏、反证条件及正常任务复核设计；模型输出不是专业结论。 |
| 开发态 Electron 窗口走查 | `BLOCKED_EXTERNAL` | 锁定 Electron 包缺少可运行二进制；未伪造窗口点击、截图或可访问性结果。 |
| 干净 Windows 11 标准账户安装验收 | `BLOCKED_EXTERNAL` | 当前是开发主机，不是要求的干净 VM。 |
| PowerPoint/WPS/Word 视觉保真 | `BLOCKED_EXTERNAL` | 未在真实 Office/WPS 应用打开成品；自动解析不替代视觉与打印检查。 |
| 正式发行签名 | `BLOCKED_EXTERNAL` | 无签名身份与凭据。 |

本地证据只证明确定性合同、事务、隐私守卫、来源标识和渲染代码边界；不证明教学有效性、一般匿名化能力、真实模型解释质量或教师实际实施质量。冻结验收状态保持原样。
