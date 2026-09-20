# G10-T01 可信离线更新工程证据

日期：2026-09-20

分支：`codex/g07-review-change`

基线：`f1b76d6`（G10 四包实施计划）。本报告与 G10-T01 实现同一提交。

## 环境与夹具身份

- OS：Microsoft Windows 11 专业版 10.0.26200，Build 26200。
- Node：24.15.0；npm：11.12.1；Vitest：2.1.1；TypeScript：5.5.4。
- 锁文件 SHA-256：`81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。
- 测试只在进程内生成临时 Ed25519 keypair；清单 key id 为 `test-release-key` / `fixture-key`。私钥、公钥字节和签名凭据均未写入仓库或报告。
- 安装器内容为虚构短字节夹具，不是可执行发行安装器；测试没有启动子进程、shell、安装器、退出或重启应用。

## 本地工程闭环

- `.yuwenupdate` 使用固定 19 字节头和唯一 manifest/signature/package 三段，不使用 ZIP、自解压脚本或包内路径。
- manifest 为闭集规范 UTF-8 JSON；拒绝重复/额外/缺失字段、非规范空白/顺序、坏版本、错误目标、Windows 保留名/尾点/路径式文件名，以及不适合 staging 的 release id。
- 信任锚只从已安装应用注入。生产 `trustedUpdateKeys()` 当前有意返回空集并 fail-closed；包内 `publicKey` 等额外字段直接拒绝。
- 验证顺序为容器上限 → manifest → key id/Ed25519 → app/platform/arch → 版本单调性 → package 字节数/SHA-256。选择文件先经已打开文件句柄核对大小上限，再受限读取。
- renderer 只能调用 `updates.status`、无路径的 `updates.inspectOffline` 和带确认令牌的 `updates.stageOffline`；源路径、签名、公钥和 package bytes 不返回 renderer。
- 确认令牌两分钟有效、单次使用，绑定 manifest hash、当前版本和目标版本；过期选择从内存清理。确认时重新打开同一用户选择文件并完成全部验证，selection 不保留 package bytes。
- package 从选择、复制、回读到 `.ready` 状态扫描均按固定小块流式 hash，不随 1 GiB 格式上限产生整包多份内存复制。暂存只写 `<userData>/updates/<release>.partial/{installer.exe,manifest.json,verification.json}`；故障钩子后再复验，原子改名后又从 `.ready` 路径复验，失败会清理本次发布。
- `verification.json` 保存签名和严格闭集验证摘要以支持重启后再次核验；不含源路径、私钥或 package bytes。独立原子 idempotency ledger 记录每个成功键，包括复用既有 ready 的新键；相同请求可跨 service 重放，同键异摘要拒绝。损坏 `.ready` 不列出、不重放；旧的有效 release 标为 `superseded` 并保留证据。
- UI 在生产空信任集下明确显示“尚未配置可信发布身份，离线更新验证被阻止”，按钮禁用且无绕过；成功文案明确“已验证并暂存，未安装；不会自动关闭或重启”。

## TDD 与命令记录

| 命令/阶段 | 实际结果 |
|---|---|
| `tests/update-manifest.test.ts` 首次 RED | exit 1；更新模块不存在 |
| 同文件首次 GREEN | exit 0；24/24；随后 Windows staging 名边界以 4 个 RED 补测并修复为 28/28 |
| `tests/offline-update.test.ts` 首次 RED | exit 1；UpdateService 不存在 |
| 暂存状态机首次 GREEN | exit 0；10/10；随后损坏 ready、选择文件读上限、流式分块、第二幂等键、复验后篡改、闭集记录、superseded、发布后 ledger 丢失恢复、ledger 写入/改名故障回滚、完整结果绑定与字节上限以 RED/回归补测，最终 21/21 |
| `tests/ipc-update.test.ts tests/updateView.test.ts` 首次 RED | exit 1；3 个 IPC 失败且 renderer helper 不存在 |
| 四个 G10-T01 新测试文件 | exit 0；55/55 |
| 重点门禁（四个新文件 + `schemaGate.test.ts` + `security.test.ts`） | exit 0；74/74 |
| 首次全量 `test:unit` | exit 1；503 passed / 1 failed / 1 skipped；唯一失败为 `ipc.test.ts` 固定白名单未登记 3 个新增操作 |
| 白名单补齐后的 `ipc.test.ts ipc-update.test.ts schemaGate.test.ts` | exit 0；37/37 |
| 最终全量 `test:unit` | exit 0；513 passed / 1 skipped（514 total，58 files） |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run verify:contracts` | exit 0；21 个错误码保持一致 |
| `npm run -w @yuwendesk/desktop build` | exit 0；renderer/main 完成 |
| `git diff --check` / 提交前 staged diff check | exit 0 |

既有 1 个 skipped 没有删除、改名或冒充通过。全量输出中的 pdfjs 可选 `canvas` / `standardFontDataUrl` 警告与本包无关，仍不代表 Office/WPS 或扫描件 OCR 通过/失败。

独立复核首轮：Critical 0 / Important 3 / Not ready。三项分别为整包多份内存、复用既有 ready 时第二幂等键未持久、最终复验后的篡改窗口；均先以失败测试复现再按上述流式、ledger 和双重复验边界修复。第二轮：Critical 0 / Important 2 / Not ready，指出 ready 已发布而 ledger 落盘失败的一致性窗口，以及当时证据数字未同步。继续先以失败测试覆盖，再让 `verification.json` 保存首次幂等预留用于 ledger 丢失后的同键恢复；ledger 写入或改名失败会回滚本次新发布并恢复未过期 token；重放要求完整结果与重新验证的 ready 一致，并按 ledger 实际序列化字节淘汰。第三轮在核对最终数字与叙述后结论为 Critical 0 / Important 0、Ready。

## 冻结输入完整性

- `acceptance/cases.json`：`cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`。
- `acceptance/addenda/classroom-delivery.cases.json`：`f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`。
- 冻结验收状态未改为 PASS，未删除验收项。

## 工程结论与外部门

- `UPD-001`：只形成本地 `ENGINEERING_VERIFIED` 的清单、信任锚、离线选择和暂存边界；没有真实发布公钥、持有人签名或真实安装器，因此正式签名升级仍 `BLOCKED_EXTERNAL`。
- `UPD-002` / `UPD-003`：迁移失败恢复和不兼容回退属于 G10-T02，当前 `NOT_RUN`。
- `INS-007`：中文路径、缩放和辅助使用属于 G10-T03；自动代码边界不替代真实 Windows 显示/IME/辅助技术走查。
- `UPD-004`：真实课堂中发现更新、不打断授课与后续安装行为没有运行，保持 `NOT_RUN/BLOCKED_EXTERNAL`。
- 真实可信更新公钥、私钥托管/轮换、签名服务、授权分发地址、签名安装器、SmartScreen、干净 Windows 标准账户升级/回退均缺外部输入，保持 `BLOCKED_EXTERNAL`。
- 真实 API、学生资料隐私授权、逐次外发许可、教学专业复核和 Office/WPS 保真状态不因本包改变。
