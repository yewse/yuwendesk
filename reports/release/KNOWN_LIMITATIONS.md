# 已知限制与未关闭发行门

当前发行判定：`BLOCKED`（`RELEASE_REQUIRED_CASE_FAILED`）。

校验清单：`reports/release/SHA256SUMS.txt`。本文件不嵌入该清单自身的哈希。

以下内容来自同一份机器可读发行证据。不得通过关闭系统保护、跳过签名、绕过隐私授权或删除验收项来关闭这些门。

## EXTERNAL_EXT06

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：本班精确适配
- 状态：BLOCKED
- 外部输入：EXT06
- 安全下一步：一次确认或从现有材料核对

## EXTERNAL_EXT09

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：教学适配/效果声明
- 状态：BLOCKED
- 外部输入：EXT09
- 安全下一步：正常教学中的必要判断，不要求日常填表

## EXTERNAL_EXT08

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：在线更新发布
- 状态：BLOCKED
- 外部输入：EXT08
- 安全下一步：仅在授权后配置，不生成虚假地址

## EXTERNAL_EXT05

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：真实内容覆盖
- 状态：BLOCKED
- 外部输入：EXT05
- 安全下一步：提供合法文件或授权来源

## EXTERNAL_EXT07

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：正式签名发布
- 状态：BLOCKED
- 外部输入：EXT07
- 安全下一步：由持有人控制凭据或签名服务

## EXTERNAL_EXT02

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：G01安装门；G11
- 状态：BLOCKED
- 外部输入：EXT02
- 安全下一步：提供或批准Windows执行环境

## EXTERNAL_EXT03

- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 范围：G04真实联网
- 状态：BLOCKED
- 外部输入：EXT03
- 安全下一步：通过秘密管理/图形设置配置，禁止贴进仓库

## DEFECT_AUDIT_NOT_COMPLETE

- 阻断码：`RELEASE_DEFECT_AUDIT_REQUIRED`
- 范围：P0/P1 已知缺陷审计
- 状态：NOT_RUN
- 外部输入：无
- 安全下一步：在候选 commit 上完成缺陷审计；空 items 只有在 COMPLETE 时才表示未发现已知缺陷。

## SUPPLY_CHAIN_ENVIRONMENT_MISMATCH

- 阻断码：`RELEASE_FORMAL_ENVIRONMENT_MISMATCH`
- 范围：SBOM 生成工具链与 ENV_LOCK.json 锁定版本不一致
- 状态：BLOCKED
- 外部输入：无
- 安全下一步：在 ENV_LOCK.json 锁定的 Node/npm 环境重新生成供应链证据；当前 SBOM 仅作工程证据。

## REQUIRED_CASE_FAILURES

- 阻断码：`RELEASE_REQUIRED_CASE_FAILED`
- 范围：DAT-005、JOB-003、JOB-006、JOB-007、SEC-009、UPD-001
- 状态：BLOCKED
- 外部输入：无
- 安全下一步：保留失败证据，修复根因后创建新的追加验收运行；不得把 FAIL 改写为 BLOCKED 或 PASS。

## FORMAL_CASES_NOT_RUN

- 阻断码：`RELEASE_REQUIRED_GATE_OPEN`
- 范围：尚未执行的正式验收案例
- 状态：NOT_RUN
- 外部输入：无
- 安全下一步：在对应证据层级创建新的追加验收运行；不得改写历史 NOT_RUN。

## SUPPLY_CHAIN_SIGNATURE_MISSING

- 阻断码：`RELEASE_SIGNATURE_MISSING`
- 范围：reports/release/signing-status.json
- 状态：BLOCKED
- 外部输入：无
- 安全下一步：由获授权的发布身份签名固定候选并加入可信时间戳，再重新检查。

## SOURCE_RUN_DIRTY

- 阻断码：`RELEASE_SOURCE_DIRTY`
- 范围：验收运行无法唯一绑定 sourceCommit
- 状态：BLOCKED
- 外部输入：无
- 安全下一步：在干净工作树对同一候选 commit 创建新的追加验收运行；不得改写本次 dirty 运行。

