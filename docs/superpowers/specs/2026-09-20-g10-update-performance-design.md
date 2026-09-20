# G10 可信升级、兼容与性能设计

日期：2026-09-20

## 1. 目标与边界

G10 在 G09 已完成的保护与恢复能力上增加四个有界工作包：可信离线更新、迁移失败恢复与不兼容回退、中文路径/缩放/辅助使用、冷启动/检索/导出性能与压力。目标是让升级工件可验证、数据迁移可回退、旧程序不能静默覆盖新数据，并给出真实可复现的兼容与性能记录。

本阶段不读取或生成生产私钥，不上传工件，不创建公开发布，不静默下载或安装更新，不强制关闭/重启应用，也不把 Node 自动化冒充干净 Win11、真实代码签名、SmartScreen、真实显示缩放或目标硬件性能证据。缺少发布身份、签名服务、可信更新公钥、授权分发地址、干净 Windows/显示环境或真实 Office/WPS 时，分别记 `BLOCKED_EXTERNAL` / `NOT_RUN`，继续完成不依赖它们的工程边界。

冻结的 `acceptance/cases.json` 和增补验收保持不变。自动化可记录 `ENGINEERING_VERIFIED`，但不擅自把冻结条目改成 PASS。

## 2. 四包职责

### G10-T01：签名更新清单与离线更新

- 定义闭集、规范序列化的更新清单和固定二进制离线容器，不采用通用自解压脚本或包内路径解压。
- 使用 Ed25519 分离签名；信任锚只来自当前已安装应用的受控配置，离线包内的公钥、证书或 key id 不能自行获得信任。
- 签名先于包哈希信任；签名、应用 ID、平台、架构、版本单调性、包字节数和 SHA-256 全部通过后，才允许写入应用自有 staging。
- 当前仓库没有持有人提供的真实更新公钥。生产默认信任集为空并明确显示“尚未配置可信发布身份”；测试只注入临时 Ed25519 密钥且明确为测试夹具。
- 离线导入与安装分离：本包最多产生 `verified_ready` 的待安装文件和摘要，不启动安装器、不关闭窗口、不重启应用。
- renderer 不提交任意路径；主进程通过原生文件对话框选取 `.yuwenupdate`，staging 路径由主进程固定生成。

### G10-T02：迁移失败恢复与不兼容回退

- 新版本首次打开数据前，先以 G09 Online Backup 生成可验证的迁移前恢复点，再在旁路副本上执行迁移和完整性检查。
- 迁移副本验证成功后才切换；失败时原数据库和旧程序可读格式保持不变，错误证据只含闭集代码、版本、时间和哈希。
- 若新版本已经写入新数据，旧版本启动检测到更高 schema/数据世代时必须 fail-closed；不得用旧备份静默覆盖。保留新数据副本并给出导出/受支持恢复路径。
- 实际恢复“旧程序二进制”需要真实签名安装器与 Windows 安装环境，保持 `BLOCKED_EXTERNAL`；本地自动化只证明数据副本、切换、回滚和兼容门。

### G10-T03：中文路径、缩放与辅助使用

- 数据目录、离线更新 staging、备份/恢复和五文件成品在中文、空格和长路径边界下使用 `path` API 与固定根，不拼 shell 命令。
- renderer 在 1366×768 与 1920×1080、100/125/150% 和大字模式下保持主操作可滚动、可聚焦、可见；不依赖仅 hover 或颜色表达状态。
- 为导航、对话框、进度、错误和主操作建立键盘顺序、可见焦点、语义标签与中文输入保留边界。
- 代码/布局自动化与真实 Windows 显示缩放、IME、屏幕阅读器走查分开记录；后者缺环境时为 `BLOCKED_EXTERNAL`。

### G10-T04：冷启动、检索、导出性能与压力

- 使用固定生成器创建 100 个计划、5000 个来源片段和约定导出样本；记录生成器版本、随机种子、机器、Node/Electron、原始样本和统计脚本。
- 指标沿用工程规范初始目标：冷启动 P95≤8 秒（Win11/8GB/SSD/30 次）、计划打开 P95≤2 秒、中文搜索 P95≤1.5 秒、约定备课包导出 P95≤30 秒。
- Node 层可测 SQLite 打开、计划读取、搜索和生成核心；真实 Electron 冷启动与目标硬件 P95 必须在真实 Windows 环境执行，不能由 Node 进程时间替代。
- 性能失败保留原始记录，不通过放宽阈值、删除慢样本或无限延长超时伪造通过。

## 3. 可信更新格式

### 3.1 规范清单

更新清单采用 UTF-8 规范 JSON，字段闭集如下：

```ts
interface UpdateManifestV1 {
  format: 'yuwendesk-update-manifest';
  version: 1;
  releaseId: string;
  appId: 'org.yuwendesk.app';
  targetVersion: string;
  minimumSourceVersion: string;
  platform: 'win32';
  arch: 'x64';
  packageName: string;
  packageBytes: number;
  packageSha256: string;
  signingKeyId: string;
  createdAt: string;
}
```

版本只接受无前导零的 `major.minor.patch`，首版不实现预发布或构建元数据。`releaseId`、`signingKeyId` 和 `packageName` 只接受有界 ASCII；`packageName` 必须为单一 `.exe` 文件名且不能是 Windows 保留名。清单必须与规范序列化字节逐字一致，拒绝重复键、额外字段、非规范空白和歧义数字。

### 3.2 固定容器

`.yuwenupdate` 不是 ZIP。固定布局为：magic、容器版本、manifest 长度、signature 长度、package 长度、manifest bytes、Ed25519 signature、package bytes。读取前先核对总长度和上限；manifest 最大 64 KiB、签名固定 64 字节、package 默认最大 1 GiB。容器没有任意路径、脚本或额外条目。

验证顺序：

1. 容器 magic/version/长度和整数边界；
2. 清单 JSON 重复键/字段/类型/规范字节；
3. 当前应用信任集中存在 `signingKeyId`；
4. 用该固定公钥验证 manifest bytes 的 Ed25519 签名；
5. `appId/platform/arch` 与当前应用一致；
6. `minimumSourceVersion <= currentVersion < targetVersion`，拒绝降级和同版本；
7. package 实际长度和 SHA-256 与已签名清单一致；
8. staging 磁盘空间和固定根；写 `.partial`，回读复验，再原子改名 `.ready`。

更新包内出现 `publicKey`、`certificate`、脚本、路径或第二个 package 均因闭集格式直接拒绝。SHA-256 只证明字节一致，不能替代签名。

## 4. 状态机与用户动作

离线更新状态只有：

- `trust_not_configured`：没有可信发布公钥，不能验证；
- `selected`：主进程已读取用户选取的容器，尚未验证；
- `verified`：签名、版本和 package 完整性通过，尚未写 staging；
- `verified_ready`：固定 staging 原子发布完成，可由后续明确安装动作处理；
- `rejected`：闭集错误码，未留下可安装文件；
- `superseded`：新选择替代旧待安装项，旧项仍保留到明确清理策略执行。

选择、验证和 staging 是同一用户动作的两阶段结果；安装/关闭/重启不在 T01 自动发生。运行中的课堂展示、保存、导出或模型任务不会因发现更新而取消。未来在线发现也必须复用同一签名与 staging 边界，下载完成不等于安装获准。

## 5. IPC、路径与错误边界

- 命名 IPC：`updates.status`、`updates.inspectOffline`、`updates.stageOffline`。
- `inspectOffline` 无路径 payload，由主进程原生对话框选择文件；返回规范摘要、验证状态、当前/目标版本和固定中文说明，不返回源路径、签名、公钥或 package bytes。
- `stageOffline` 只接受短时、单次、绑定 manifest hash/current version/target version 的确认 token 和幂等 key；主进程重读同一已选容器并复验，不能信任 renderer 回传摘要。
- 错误闭集：`UPDATE_TRUST_NOT_CONFIGURED`、`UPDATE_CONTAINER_INVALID`、`UPDATE_MANIFEST_INVALID`、`UPDATE_SIGNATURE_INVALID`、`UPDATE_TARGET_MISMATCH`、`UPDATE_VERSION_REJECTED`、`UPDATE_PACKAGE_INVALID`、`UPDATE_SPACE_INSUFFICIENT`、`UPDATE_STATE_CHANGED`、`UPDATE_STAGE_FAILED`。
- 错误响应不含任意路径、签名材料、异常栈、package 内容或自由上游文本。

## 6. 迁移与回退不变量

- 当前用户数据只由一个进程持有；迁移启动前关闭业务 store，并持有更新维护锁。
- 每个迁移作业有固定 ID、source app/schema/generation、target app/schema、恢复点 ID、staging/rollback 哈希和闭集阶段。
- 迁移只在旁路副本执行。失败时原数据没有被写；成功切换使用与 G09 恢复相同的逐项移动记录和可证明回滚。
- 新版本第一次业务写入会推进数据世代。旧版本看到高于自身的 schema 或世代时只读拒绝，保留副本，不自动回灌旧备份。
- 更新日志不记录学生正文、密钥、路径、prompt、模型 IO 或任意异常消息。

## 7. 证据与完成定义

每包遵循 RED→GREEN→重构，执行重点测试、全量 Vitest、主/渲染 TypeScript、ESLint、`verify:contracts`、renderer/main build 和 `git diff --check`；更新 `PROGRESS.md`、`HANDOFF.md` 与相应 G10 报告后形成一个小提交。

G10 本地工程范围完成不等于发行就绪。以下始终独立：

- 真实持有人签名、可信公钥轮换和签名服务：`BLOCKED_EXTERNAL`；
- 授权分发地址与真实在线更新：`BLOCKED_EXTERNAL`；
- 干净 Windows 上签名安装/升级/回退、SmartScreen 和标准账户：`BLOCKED_EXTERNAL`；
- 真实 Windows 显示缩放、IME、辅助技术、目标 8GB/SSD 冷启动 P95：没有环境则 `BLOCKED_EXTERNAL`；
- 真实 API、学生资料隐私授权、教学专业复核、Office/WPS 保真：不因 G10 改变。

