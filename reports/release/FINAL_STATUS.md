# 语文备课工作台最终发行状态

- 生成时间：2026-09-20T18:40:39.654Z
- 源码提交：`e126a1a82c88420cfe26395c0ffd00496f5b8639`
- 最终判定：`BLOCKED`
- 判定理由：`RELEASE_SOURCE_DIRTY`
- 软件工程状态：`BLOCKED`
- 资源覆盖状态：`BLOCKED`
- 教学专业复核：`NOT_REVIEWED`
- 制品类别：`UNSIGNED_TEST_BUILD`

## 当前候选与供应链

- 固定候选路径：`apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe`
- 候选存在：是
- 候选 SHA-256：0f0b5ba1f980fa37791ca144b0e2b36bad611701fa2248c7fabf1be82136d6e9
- SBOM：`PASS`
- 校验清单：`PASS`；路径 `reports/release/SHA256SUMS.txt`
- 签名：`UNSIGNED`
- 锁定环境一致：否

本状态页不嵌入校验清单自身的哈希。正式发行校验必须重新读取清单并逐文件计算。

## 未关闭阻断

- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜本班精确适配｜BLOCKED｜一次确认或从现有材料核对
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜教学适配/效果声明｜BLOCKED｜正常教学中的必要判断，不要求日常填表
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜在线更新发布｜BLOCKED｜仅在授权后配置，不生成虚假地址
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜真实内容覆盖｜BLOCKED｜提供合法文件或授权来源
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜正式签名发布｜BLOCKED｜由持有人控制凭据或签名服务
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜G01安装门；G11｜BLOCKED｜提供或批准Windows执行环境
- `BLOCKED_EXTERNAL_INPUT_NOT_PROVIDED`｜G04真实联网｜BLOCKED｜通过秘密管理/图形设置配置，禁止贴进仓库
- `RELEASE_DEFECT_AUDIT_REQUIRED`｜P0/P1 已知缺陷审计｜NOT_RUN｜在候选 commit 上完成缺陷审计；空 items 只有在 COMPLETE 时才表示未发现已知缺陷。
- `RELEASE_FORMAL_ENVIRONMENT_MISMATCH`｜SBOM 生成工具链与 ENV_LOCK.json 锁定版本不一致｜BLOCKED｜在 ENV_LOCK.json 锁定的 Node/npm 环境重新生成供应链证据；当前 SBOM 仅作工程证据。
- `RELEASE_REQUIRED_GATE_OPEN`｜尚未执行的正式验收案例｜NOT_RUN｜在对应证据层级创建新的追加验收运行；不得改写历史 NOT_RUN。
- `RELEASE_SIGNATURE_MISSING`｜reports/release/signing-status.json｜BLOCKED｜由获授权的发布身份签名固定候选并加入可信时间戳，再重新检查。
- `RELEASE_SOURCE_DIRTY`｜验收运行无法唯一绑定 sourceCommit｜BLOCKED｜在干净工作树对同一候选 commit 创建新的追加验收运行；不得改写本次 dirty 运行。

## 结论

当前不是正式教师发行版，不得公开分发，也不得把工程自动化结果表述为真实 Windows、签名、隐私授权或教学效果证据。
