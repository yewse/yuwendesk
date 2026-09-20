# 已知限制与未关闭发行门

当前发行判定：`BLOCKED`（`RELEASE_ARTIFACT_MISSING`）。

本文件列出当前证据中的真实缺口。不得通过关闭 SmartScreen、系统保护、签名校验或隐私授权绕过这些门。

## CURRENT_CANDIDATE_MISSING

- 范围：apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe
- 状态：BLOCKED
- 阻断码：`RELEASE_ARTIFACT_MISSING`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：在锁定构建环境从当前源码生成候选；不得复用历史安装包或哈希。

## DEFECT_AUDIT_NOT_COMPLETE

- 范围：P0/P1 已知缺陷审计
- 状态：NOT_RUN
- 阻断码：`RELEASE_DEFECT_AUDIT_REQUIRED`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：在候选 commit 上完成缺陷审计；空 items 只有在 COMPLETE 时才表示未发现已知缺陷。

## DELIVERABLE_FINAL_STATUS_MISSING

- 范围：reports/release/FINAL_STATUS.md
- 状态：NOT_RUN
- 阻断码：`RELEASE_REQUIRED_DELIVERABLE_MISSING`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：执行负责该固定交付物的后续 G11 工作包，并在生成后重新归集证据。

## EXTERNAL_EXT02

- 范围：G01安装门；G11
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT02
- 安全下一步：提供或批准Windows执行环境

## EXTERNAL_EXT03

- 范围：G04真实联网
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT03
- 安全下一步：通过秘密管理/图形设置配置，禁止贴进仓库

## EXTERNAL_EXT04

- 范围：付费网络调用
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT04
- 安全下一步：确认明确金额与币种

## EXTERNAL_EXT05

- 范围：真实内容覆盖
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT05
- 安全下一步：提供合法文件或授权来源

## EXTERNAL_EXT06

- 范围：本班精确适配
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT06
- 安全下一步：一次确认或从现有材料核对

## EXTERNAL_EXT07

- 范围：正式签名发布
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT07
- 安全下一步：由持有人控制凭据或签名服务

## EXTERNAL_EXT08

- 范围：在线更新发布
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT08
- 安全下一步：仅在授权后配置，不生成虚假地址

## EXTERNAL_EXT09

- 范围：教学适配/效果声明
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT09
- 安全下一步：正常教学中的必要判断，不要求日常填表

## EXTERNAL_EXT10

- 范围：G08真实模型辅助归因；G11隐私验收
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT10
- 安全下一步：由资料责任方明确本地处理范围；每次云端外发前确认必要字段，禁止把真实正文贴入仓库或提示词

## EXTERNAL_EXT11

- 范围：G06真实成品保真；G10正式导出性能；G11兼容性验收
- 状态：BLOCKED
- 阻断码：`BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`
- 外部输入：EXT11
- 安全下一步：提供受控测试环境，分别执行打开、编辑、保存、分页和放映验证

## FORMAL_CASES_NOT_RUN

- 范围：尚未执行的正式验收案例
- 状态：NOT_RUN
- 阻断码：`RELEASE_REQUIRED_GATE_OPEN`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：在对应证据层级创建新的追加验收运行；不得改写历史 NOT_RUN。

## SOURCE_RUN_DIRTY

- 范围：验收运行无法唯一绑定 sourceCommit
- 状态：BLOCKED
- 阻断码：`RELEASE_SOURCE_DIRTY`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：在干净工作树对同一候选 commit 创建新的追加验收运行；不得改写本次 dirty 运行。

## SUPPLY_CHAIN_ENVIRONMENT_MISMATCH

- 范围：SBOM 生成工具链与 ENV_LOCK.json 锁定版本不一致
- 状态：BLOCKED
- 阻断码：`RELEASE_FORMAL_ENVIRONMENT_MISMATCH`
- 外部输入：无；属于尚未执行的本地发行步骤
- 安全下一步：在 ENV_LOCK.json 锁定的 Node/npm 环境重新生成供应链证据；当前 SBOM 仅作工程证据。

