# 验收执行记录（与冻结定义分离）

本目录用于**实际执行结果**，与**验收定义**严格分离，二者不可互相替代。

## 定义 vs 执行

- **验收定义（不可变）**：
  - 冻结基线：`acceptance/cases.json`（原 60 条业务 + INS/SEC/AI/EXP/SRC/JOB/PED/DAT/UPD 等）。
  - 增补定义：`acceptance/addenda/*.json`（如 CR-001 的 `CLS-001–040`）。
  - 定义中的 `status` 保持初始 **NOT_RUN**，表示"待执行"，不随运行改变；`verify:contracts` 强制校验增补定义全部 NOT_RUN、编号完整唯一、引用有效。
  - **禁止**通过修改定义状态（改成 PASS）或文档/结构校验通过，来冒充产品测试。

- **执行记录（本目录，按运行与版本另存）**：
  - 每次真实执行产生一个独立记录文件 `run-<YYYYMMDD>-<shortsha>-<seq>.json`，不回写定义文件。
  - 记录绑定：`source_commit`、`plan_id/revision_id`（如适用）、交付规格/渲染版本、构建/环境、每条用例的 `PASS/FAIL/BLOCKED/NOT_RUN`、证据路径与哈希、已知限制。
  - 同一用例可在不同运行/版本有不同结果；历史记录保留，不覆盖。

## 当前状态

已归集首个 G11 全量工程运行：`run-20260920-b5dba42-01.json`，绑定源码 `b5dba42579cbb325e1b3cbeadc582865256f88e4`，运行时工作树为 dirty（包含本包尚未提交的 G11-T01 实现）。运行环境为 Windows `10.0.26200` x64、Node `v24.15.0`、npm `11.12.1`。

- 定义联合：170 项（冻结基线 130 + CR-001 增补 40），ID 唯一且定义状态全部仍为 `NOT_RUN`。
- 本次结果：`PASS 6 / FAIL 0 / BLOCKED 38 / NOT_RUN 126`。
- `PASS` 仅来自逐项语义审计后仍能由单一测试完整支撑的 6 条工程自动化映射，精确绑定测试文件和 Vitest `fullName`；原先覆盖不足的候选映射没有被保留为 PASS。归一化 Vitest 证据为 `vitest-run-20260920-b5dba42-01.json`，只保存这 6 条映射断言、全量计数和实际相对命令，不含本机绝对路径或异常栈。
- `BLOCKED` 只用于已有明确外部输入 ID 的案例；缺少 Windows、授权来源、真实 API/预算/逐次外发授权、Office/WPS、签名或分发条件时不执行、不模拟。
- `NOT_RUN` 表示尚无满足对应证据层级的正式执行；不能从宽泛测试通过、文件存在或文档说明推断为 `PASS`。
- 固定候选 `apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe` 当前不存在；`reports/release/candidate-artifact.json` 记录 `artifactPresent:false`、`artifactClass:NONE`、hash/size 均为 null，不借用历史安装包哈希。

这份全量账本只证明记录结构完整和已列工程案例的实际自动化结果，**不表示 170 项全部通过，也不表示 G11 正式发行通过**。后续运行继续使用新序号追加，不覆盖本次记录。

## 记录格式

闭集合同见 `contracts/AcceptanceRun.schema.json`，显式映射见 `planning/g11-acceptance-map.json`，模板 `run-template.json` 仍仅作历史说明。软件、资源覆盖和教学效果须分别报告；工程验收通过不代表教学有效。
