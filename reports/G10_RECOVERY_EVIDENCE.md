# G10-T02 迁移恢复与不兼容回退工程证据

日期：2026-09-20

分支：`codex/g07-review-change`

基线：`4b542a0`（G10-T01）。本报告与 G10-T02 实现同一提交。

## 环境与边界

- OS：Microsoft Windows 11 专业版 10.0.26200；Node 24.15.0；npm 11.12.1；Vitest 2.1.1；TypeScript 5.5.4。
- 测试数据库、凭据密文、学生正文与安装版本均为虚构夹具；未使用真实学生资料、API、签名私钥或发行安装器。
- 本包证明本地数据库迁移、恢复和旧版只读保护，不证明旧程序二进制已恢复。真实签名安装器、Windows 升级/降级和 SmartScreen 仍为 `BLOCKED_EXTERNAL`。

## 本地工程闭环

- 启动时先以只读方式检查当前 SQLite；当前 schema 或未来 schema/数据世代不需要迁移时，不执行 checkpoint、不创建 WAL/SHM，也不原地改 schema。
- 需要迁移时先 checkpoint，再用 SQLite Online Backup 创建 `<userData>/migration-recovery/<id>.partial`；schema、数据世代、完整性及 `credential`/`secure_key` 指纹复核后，连同闭集 manifest 原子改名为 `.ready`。
- 空间门要求活动库三倍大小加 16 MiB 余量；不足时不创建恢复点、不改当前库。严格 journal 只保存内部 ID、版本、schema/世代、SHA-256、闭集 phase/error code，不保存路径、正文或密钥材料。
- 迁移只作用于恢复点的 staging 副本。候选必须通过完整性、精确目标 schema/世代、凭据/工作区密钥不漂移和迁移 job 谱系标记验证，才按“原库→rollback、候选→current”切换；切换后再次验证文件 hash、谱系和敏感指纹。
- 原库、候选或失败副本在每个 rename 崩溃点均可调和；失败候选进入 `migration-failed/<job>`，既有 rollback 不覆盖。完成后的清理为 best-effort，但 `completed` 只在最终验证后写入。
- `completed` 调和使用不可变 job 谱系和历史 schema/世代下界，不永久绑定会被正常业务写改变的整库 hash；因此正常保存和同 schema 的后续数据世代升级不会在下次启动误锁。数据库缺失、被旧库替换或谱系不符仍 fail-closed。
- G09 合法恢复把旧 `migration-journal.json`、`.partial` 和 maintenance lock 与旧数据库一起纳入同一可回滚组件集；恢复旧备份后不会被旧完成日志误锁，可由新迁移 job 重新旁路迁移。
- `SqliteStore` 在任何启动维护或业务写前推进数据世代。旧版遇到未来 schema/世代时保留可读数据并拒绝所有写；迁移证据未调和时，即使当前库不存在也不创建空库。IPC 只暴露闭集保护类别，设置页明确“旧版未覆盖新数据”或“迁移恢复状态待处理”。
- Vitest 文件级 worker 固定为 2；测试范围、真实 PPTX/DOCX/PDF 生成、15 秒单测阈值、断言和失败语义均未放宽，也未启用 retry。

## TDD、失败与门禁

| 命令/阶段 | 实际结果 |
|---|---|
| G10 迁移/降级首次 RED | 缺少迁移协调器、journal、数据世代与 UI 保护说明；按失败测试实现 |
| 独立复核首轮 | Critical 1 / Important 5 / Not ready；完成态写入时序、生产只读绑定、`secure_key` 指纹、世代推进顺序、lock 清理和失败目录崩溃点逐项以 RED 修复 |
| 后续生命周期 RED | 复现完成后正常保存被 hash 误锁、同 schema 新世代第二次启动误锁，以及恢复旧备份被旧 journal 阻断；改为谱系标记、历史完成线和恢复组件集 |
| `g10-migration-recovery + g10-downgrade-guard + g09-backup-restore-flow` | exit 0；31/31 |
| 既有超时文件串行复验 | exit 0；33/33；确认默认高并发下的失败是资源竞争，不删除或放宽测试 |
| 最终 `npm run test:unit` | exit 0；537 passed / 1 skipped（538 total，60 files） |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run verify:contracts` | exit 0；错误码目录保持一致 |
| `npm run build` | exit 0；renderer/main 完成 |
| `git diff --check` / staged diff check | exit 0 |

第一次把全量测试与构建并行运行时有 5 个既有重型用例超时；随后独立标准全量仍有 4 个同类超时，均如实视为失败。三个相关文件以单 worker 复验 33/33 后，将文件级 worker 固定为 2；最终标准仓库命令全量 537/537 通过，既有 1 个 skipped 未改名或冒充通过。pdfjs 的可选 `canvas` / `standardFontDataUrl` 警告仍存在，不代表 OCR 或 Office/WPS 保真通过。

最终独立复核：Critical 0 / Important 0、Ready。保留两个非阻断 Minor：内部 journal/recovery manifest 后续可在 JSON 读取前增加显式小文件上限；G09 通用恢复组件状态机已覆盖部分移动，但可再增加专门针对迁移 journal/partial/lock 中途故障的定向钩子测试。

## 冻结输入与外部门

- `acceptance/cases.json`：`cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`。
- `acceptance/addenda/classroom-delivery.cases.json`：`f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`。
- `package-lock.json`：`81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。
- 冻结验收项未删除，状态未改为 PASS。`UPD-002` / `UPD-003` 仅记本地 `ENGINEERING_VERIFIED`；真实旧程序二进制恢复、签名更新、干净 Windows 升降级仍 `BLOCKED_EXTERNAL`。
- 真实 API 模型辅助归因、学生材料隐私授权与逐次外发许可、教学专业复核、Office/WPS 保真、开发态 Electron 窗口和公开分发状态不因本包改变。
