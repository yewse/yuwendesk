# G11 发行验收与证据封口

## 结论

G11-T01–T04 的本地工程工作包已经完成，但当前候选不是正式发行版。固定验收运行与发行聚合给出的最终判定为 `BLOCKED / RELEASE_ARTIFACT_MISSING`；`release:verify` 对这一真实非就绪状态退出 2。没有候选安装器、锁定构建环境、签名与时间戳、干净 Windows、真实 API/预算、学生资料授权、教师专业复核或 Office/WPS 证据，因此没有把工程测试、SBOM 或校验和表述为外部门通过。

## 源码与固定输入

- G11 设计：`c993c9e`；实施计划：`b5dba42`；T01：`422b94a`；T02：`4e62f98`；T03：`6bd0223`；T04 由包含本报告的提交交付。
- 固定验收运行：`run-20260920-b5dba42-01`，绑定源码 `b5dba42579cbb325e1b3cbeadc582865256f88e4`，运行记录如实保留 `repositoryDirty=true`。
- 基础验收定义 130 项，SHA-256 `cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`。
- CR-001 增补定义 40 项，SHA-256 `f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`。
- `package-lock.json` SHA-256 `81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。
- 三份哈希与冻结值一致；没有删除验收项，也没有把定义中的 `NOT_RUN` 改成通过。

## 170 项验收与发行聚合

- 验收结果：6 PASS / 0 FAIL / 38 BLOCKED / 126 NOT_RUN，共 170 项。
- 需求覆盖：60 个基础需求 + 24 个 CR-001 需求。
- 五维状态：software=`BLOCKED`、resource=`BLOCKED`、teaching=`NOT_REVIEWED`、artifact=`NONE`、release=`BLOCKED`。
- 当前理由：`RELEASE_ARTIFACT_MISSING`；候选路径不存在，候选 hash、size 与构建 provenance 保持 null。
- 发行证据列出 15 个未关闭缺口：EXT02–EXT11 十个外部输入、候选缺失、缺陷审计未执行、正式案例未执行、dirty 验收来源与正式环境不匹配。

## SBOM、校验和与签名

- 实际 npm CLI 生成 CycloneDX 1.5；663 个锁定组件与 663 个 SBOM 组件精确一致。
- 依赖图为 664 个节点、1,133 条锁文件依赖边；应用根可达、purl 身份及 lock↔SBOM 双向边集合均通过校验。
- `SHA256SUMS.txt` 有 12 个规范条目，包含最终状态与已知限制但不包含清单自身；每项均以仓库内 realpath 和实际字节复算。
- T04 将 SBOM、环境、签名状态、发行证据、两份公开状态文档、发行输入和校验清单置于同一可恢复事务。规定的单轮 `release:evidence → release:sbom → release:verify` 可收敛，不需要重复运行来修补旧哈希。
- 本机 Node 24.15.0 / npm 11.12.1 与 `ENV_LOCK.json` 的 Node 22.14.0 / npm 10.9.7 不一致，故 `formalEnvironmentMatch=false`。
- 固定候选不存在，签名状态为 `NOT_RUN / RELEASE_ARTIFACT_MISSING`；没有用历史 EXE 或任意替代文件冒充候选。

## T04 门禁实测

| 命令/演练 | 退出码 | 观察 |
|---|---:|---|
| G11 四文件定向 Vitest | 0 | 71/71 passed |
| 全量 Vitest | 0 | 67 files；621 passed / 1 skipped（622 total） |
| `release:evidence` | 0 | 生成真实 BLOCKED 聚合，不把非就绪当错误结构 |
| `release:sbom` | 0 | 663 components / 664 dependency nodes；12 checksum entries |
| `release:verify` | 2 | `BLOCKED / RELEASE_ARTIFACT_MISSING`；非正式发行 |
| 篡改 `FINAL_STATUS.md` 后 `release:verify` | 1 | 检出 hash、派生状态和文档不一致 |
| 原子再生成后 `release:verify` | 2 | 恢复到结构有效但非就绪的真实状态 |
| typecheck / lint / `verify:contracts` / desktop build / `git diff --check` | 0 / 0 / 0 / 0 / 0 | 全部通过 |

全量测试仍打印既有 pdfjs 可选 canvas/标准字体告警；断言没有放宽，告警没有被改成假通过或新增跳过。`reports/release/` 的本机绝对用户路径、密钥样式、学生标识符、模型 payload 和堆栈模式扫描无命中。

## 教师说明与人工边界

教师快速指南以当前 renderer 文案和入口为准：当前“备下一课”的启动按钮仍禁用，尚无课堂展示入口，也没有班级、教材或实际课时设置入口。指南保留三类五文件、只改一处、课后观察、模型辅助归因、隐私、备份、离线更新、诊断和卸载边界，但不把目标能力写成已交付能力。

模型辅助归因从流程开始即纳入设计，但五项本地测量门之后才可调用；结果仅是待验证假设。真实 API 与费用（EXT03/EXT04）、真实学生资料处理和逐次最小外发授权（EXT10）、教师专业复核（EXT09）均为 `BLOCKED_EXTERNAL`。干净 Windows（EXT02）、合法教材/班级条件（EXT05/EXT06）、签名（EXT07）、分发（EXT08）与 Office/WPS（EXT11）同样未提供。

要创建新候选，必须先在锁定环境从当前源码构建，再对该固定字节完成签名/时间戳、干净 Windows、Office/WPS、隐私授权、真实 API 与教学复核，并创建绑定同一候选 commit 的追加验收运行和缺陷审计。历史 BLOCKED/NOT_RUN 记录不得覆盖。
