# G09 保护与恢复证据

日期：2026-09-20

分支：`codex/g07-review-change`

T04 开始基线：`0560badc425a07438bcf5781322268b1674b1e67`
G09 提交链：`1849b59`（设计）、`80b44b1`（计划）、`be728a2`（T01）、`3536a8e`（T02）、`0560bad`（T03）；T04 与本报告同一提交。

## 环境

- OS：Microsoft Windows 11 专业版，10.0.26200，Build 26200。
- Node：24.15.0；npm：11.12.1。
- Vitest：2.1.1；TypeScript：5.5.4。
- 测试数据：仅虚构文本、canary、临时 SQLite、伪 safeStorage；没有真实学生资料、真实 API key 或外部上传。
- 锁文件 SHA-256：`81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。

## 执行记录

| 命令 | 结果 |
|---|---|
| `npm run -w @yuwendesk/desktop test:unit -- tests/g09-threat-boundaries.test.ts tests/g09-archive-attacks.test.ts tests/security.test.ts tests/sources-boundary.test.ts`（首次 RED） | exit 1；4 failed / 24 passed。暴露缺少 sender 纯边界、非普通对象未拒绝、ZIP 重复名未拒绝，以及 manifest 集合错误分类 |
| 同一命令（最小修复后） | exit 0；28/28，4 files |
| 独立复审后 `npm run -w @yuwendesk/desktop test:unit -- tests/g09-archive-attacks.test.ts tests/g09-threat-boundaries.test.ts tests/model-protect.test.ts`（第二次 RED） | exit 1；5 failed / 21 passed。复现目录条目绕过、Windows 别名碰撞、central size 低报、模型自由异常进入持久错误码/IPC；同时暴露证据对 staging 写入时序描述不准确 |
| 同一命令（资源硬截止、Windows 规范化、闭集错误与写入审计修复后） | exit 0；26/26，3 files |
| `npm run -w @yuwendesk/desktop test:unit -- tests/backup-manifest.test.ts tests/portable-backup.test.ts tests/g09-backup-restore-flow.test.ts tests/source-privacy.test.ts tests/g09-source-delete-flow.test.ts tests/diagnostics.test.ts tests/g09-failure-recovery.test.ts tests/g09-threat-boundaries.test.ts tests/g09-archive-attacks.test.ts tests/security.test.ts tests/sources-boundary.test.ts tests/g08-evidence-boundary.test.ts tests/model-protect.test.ts` | exit 0；111/111，13 files |
| `npm run -w @yuwendesk/desktop test:unit` | exit 0；458 passed / 1 skipped（459 total，54 files） |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run verify:contracts` | exit 0 |
| `npm run -w @yuwendesk/desktop build` | exit 0；renderer/main 均完成 |
| `git diff --check` 与提交前 `git diff --cached --check` | exit 0 |

既有 1 个 skipped 没有被删除、改名或伪装为通过。测试输出仍出现 pdfjs 可选 `canvas` / `standardFontDataUrl` 警告；这不等于真实 Office/WPS 或扫描件 OCR 验收通过。

## T04 攻击夹具身份

- 加密归档：`backupId=attack_fixture`、`jobId=envelope_* / path_* / duplicate_path / symlink / unlisted / too_many / ratio / *_mismatch / corrupt_db / new_schema`。
- 认证信封使用测试专用固定参数：scrypt `N=32768,r=8,p=1`，salt 为 16 个 `0x07`，nonce 为 12 个 `0x09`。这些只用于确定性攻击夹具，不是生产密钥或生产随机源。
- ZIP：路径穿越、绝对路径、盘符、UNC、反斜杠、原始重复、Windows 大小写别名、尾点、设备名、local/central 名称或 size 不一致、Unix symlink mode、4097 文件、4097 目录、2 MiB 高压缩项、未登记安全路径、manifest hash/size/path/缺失项；每个失败夹具审计 `writeFile` 目标只在其 staging 根内。
- SQLite：损坏字节与实际 `user_version=13`、manifest 仍声明当前版本的夹具。
- IPC/内容：伪 sender、missing/child frame、恶意 URL、继承属性、额外字段、URL-shaped base64、自造/过期/重用/跨对象 token、带路径/密钥/上游正文的 provider 异常、提示注入、DOCM macro、OOXML external relationship、HTML script、PDF URI action。
- 隐私 canary：`CANARY_STUDENT_NAME_ALICE_7CC2.docx`；只代表虚构姓名式文件名，不是一般匿名化证明。
- 二进制攻击包只在 OS 临时目录生成并由测试清理，没有把可误用的二进制样包提交到仓库。

## 冻结输入完整性

- `acceptance/cases.json`：`cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`。
- `acceptance/addenda/classroom-delivery.cases.json`：`f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`。
- 两个哈希与 G08 记录一致；文件内验收状态未改为 PASS。

## 已验证的工程结论

- IPC 权限依赖单一主窗口、顶层 frame 对象和精确受信 URL；载荷及外壳拒绝非普通对象、原型继承、额外字段和伪文件输入，错误响应不回显 hostile key/path。
- 可移植恢复在创建 staging 前完成认证信封、ZIP 中央目录、路径/Windows 别名/重复/符号链接/声明资源和 manifest 精确集合检查；展开过程带单项/总量硬截止并核对真实大小。hash/size、schema 和 SQLite 完整性只在生成的隔离 staging 内完成；失败时 staging 被清理，写入审计确认从未写到 staging 外。
- 首轮独立复审结论为 Critical 0 / Important 4 / Not ready；四项均以第二次 RED 复现并修复。第二轮复审结论为 Critical 0 / Important 0 / Ready。
- 材料内指令、宏/脚本、外部关系、PDF URI 都没有获得 IPC、文件、密钥或网络能力；session 层取消外部请求，主窗口拒绝不可信导航。
- 普通资料升级为敏感后，虚构姓名式标题不出现在活动 DB bytes、诊断、managed manifest、portable entry path 或 entry bytes。

## BLOCKED_EXTERNAL / NOT_RUN

- `INS-008`：仍需干净 Windows 安装态的进程、命令行窗口与监听套接字外部观测；代码检查和状态字段不能替代。
- `SEC-006`：当前不暴露 URL 下载；未来启用前必须执行每一跳 DNS/IP 重新判断并阻断 localhost、私网、链路本地和云元数据地址。当前状态保持 `NOT_RUN`。
- `DAT-002`：真实两台 Windows 机器、真实 DPAPI 和普通用户安装后的跨机恢复仍未运行；伪 safeStorage 只证明协议分层。
- 真实学生资料处理授权和逐次外发许可未提供；现有 canary 不替代隐私授权或一般匿名化评估。
- 真实云 API、费用授权和模型辅助归因质量未执行；离线/测试替身不替代。
- 教学专业复核、真实课堂有效性、真实 Office/WPS 打开/编辑/保存/放映、开发态 Electron 窗口走查、正式代码签名与发布仍为 `BLOCKED_EXTERNAL`。
