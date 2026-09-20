# G10-T04 性能与兼容矩阵

日期：2026-09-20
范围：G10-T04 本地工程测量；全为固定种子合成数据，不含真实教材、学生资料、API 密钥或模型输入输出。
原始记录：`reports/G10_PERFORMANCE_RAW.json`

## 结论边界

- Windows 开发主机上的 Node 核心路径已完成 `ENGINEERING_MEASUREMENT`。固定夹具版本 `g10-performance-v1`、种子 `20260920`，精确生成 100 个计划和 5000 个来源片段。
- 计划打开与长短中文搜索的 Node 核心 P95 低于 `docs/ENGINEERING_SPEC.md` §19 的相应初始阈值。三类五文件“内存生成 + 确定性一致性复核”P95 为 1416.597ms，只标 `ENGINEERING_CORE_WITHIN_BUDGET`；它不含 staging、写盘、回读和原子发布，也未证明 DOCX 在 Office/WPS 中约 10 页，因此不标正式“备课包导出 PASS”。所有原始样本均保留，nearest-rank P50/P95 未剔除离群值。
- 未发现越过已实际覆盖阈值的生产热点，因此本包没有为“跑分”修改生产查询、生成或审查逻辑。SQLite 打开、Node RSS 与内存生成核心只记录工程观察值，没有拿它们套用 Electron 或完整导出发布门。
- 真实 Electron 冷启动、Electron 总进程空闲内存、干净 Win11 8GB/SSD、Office/WPS 分页和视觉保真没有执行，保持 `NOT_RUN/BLOCKED_EXTERNAL`。

## 固定夹具与方法

| 项目 | 实际值 | 状态/说明 |
|---|---:|---|
| 生成器 | `g10-performance-v1` | 固定 LCG 种子 `20260920`；同一源代码下确定性内容 |
| 计划 | 100 | SQLite 实际计数断言 |
| 来源片段 | 5000 | SQLite 实际计数断言；TXT 每行一段 |
| 查询 | 长词 `固定检索长词`；短词 `春` | 长词走 FTS trigram，短词走 LIKE 回退 |
| 导出样本 | 三类五文件；9 个任务生成 20 张 PPT 页 | PPTX 内部 slide XML 实际计数为 20；DOCX 约定目标 10 页需 Office/WPS 渲染确认 |
| 百分位 | nearest-rank | 原始数组复制排序；不修改输入，不删慢样本 |
| 缓存状态 | warm-cache | SQLite 先预热一次；计划打开和长短查询重复同一对象/查询，不冒充冷缓存 |
| SQLite 打开 | 30 次 | 每次包含 `SqliteStore.load()` + `close()` |
| 计划打开 | 30 次 | 包含 SQLite 读取和 `contentJson` 解析 |
| 搜索 | 长 30 + 短 30；混合 60 | 每个命中必须非空 |
| 五文件生成/复核 | 20 次 | 每次完整生成 5 文件并执行确定性一致性复核 |

## Windows 开发主机 Node 实测

环境：Windows `10.0.26200` x64，Node `v24.15.0`，8 逻辑 CPU，Intel i5-1135G7，约 16GB 物理内存。Electron 版本字段为 `null`，因为该轮没有启动 Electron。测量基于提交 `2861c68d389c5435245c95c127f4b517c7054c47` 加 G10-T04 工作树；benchmark 三个源文件按确定顺序计算 SHA-256 `f15709bf63ed9410a9e47a0b1ec6bfbe9e529e7f8e13faa85d81c0b2fd104b27`，报告随本包提交。

| 指标 | 样本 | P50 | P95 | 最大值 | 初始目标 | 状态 |
|---|---:|---:|---:|---:|---:|---|
| SQLite 打开/关闭 | 30 | 368.759ms | 420.444ms | 424.897ms | 无 Node 发布阈值 | `MEASURED_NO_RELEASE_THRESHOLD` |
| 已有计划打开+解析 | 30 | 3.026ms | 3.747ms | 3.824ms | ≤2000ms | `PASS`（仅 Node warm-cache 核心路径） |
| 中文长词搜索 | 30 | 80.982ms | 102.733ms | 102.749ms | ≤1500ms | `PASS`（仅 Node warm-cache 核心路径） |
| 中文短词搜索 | 30 | 46.554ms | 57.438ms | 61.252ms | ≤1500ms | `PASS`（仅 Node warm-cache 核心路径） |
| 长短混合搜索 | 60 | 61.252ms | 99.405ms | 102.749ms | ≤1500ms | `PASS`（仅 Node warm-cache 核心路径） |
| 五文件内存生成 | 20 | 542.607ms | 807.466ms | 3525.831ms | 无完整导出阈值 | `MEASURED_NO_RELEASE_THRESHOLD` |
| 五文件确定性复核 | 20 | 407.830ms | 592.264ms | 3801.492ms | 无完整导出阈值 | `MEASURED_NO_RELEASE_THRESHOLD` |
| 内存生成+复核核心 | 20 | 972.291ms | 1416.597ms | 7346.092ms | 30s 仅作预算参照 | `ENGINEERING_CORE_WITHIN_BUDGET`；不是正式导出 PASS |

Node/Vitest 单进程 RSS 从 96,034,816 bytes 到 387,506,176 bytes。它包含测试运行器、夹具、Office/PDF 解析依赖和生成缓存，不是 Electron 主/渲染/辅助进程总和，因此状态是 `MEASURED_NO_RELEASE_THRESHOLD`，不能用于关闭“空闲内存 ≤700MB”发布门。

`pdfjs-dist` 在没有可选 native canvas 与 `standardFontDataUrl` 的测试进程中继续输出既有警告；文件生成和确定性文本回解析均成功。这不是 Office/WPS 视觉保真证据。

## 兼容矩阵

| 环境/能力 | 运行方式 | 实际状态 | 证据或阻断 |
|---|---|---|---|
| Node 核心 / Windows 开发主机 | 真实 `better-sqlite3`、固定夹具、真实五文件生成与回解析 | `ENGINEERING_MEASUREMENT` | 原始样本见 `G10_PERFORMANCE_RAW.json`；阈值项见上表 |
| 真实 Electron 开发态冷启动 | 需锁定 Electron 二进制与真实窗口，30 次到可操作首页 | `NOT_RUN/BLOCKED_EXTERNAL` | 当前锁定包的 Electron 二进制未就绪；Node `SqliteStore.load()` 不能替代窗口冷启动 |
| 真实 Electron 空闲总进程内存 | 需主/渲染/辅助进程稳定后统计 | `NOT_RUN/BLOCKED_EXTERNAL` | Node/Vitest RSS 不可替代 Electron 总进程内存 |
| 干净 Win11、8GB、SSD、标准账户 | 30 次冷启动 P95≤8s；无开发运行时 | `NOT_RUN/BLOCKED_EXTERNAL` | 缺 EXT02 目标 VM/实机与可安装、签名候选；开发主机约 16GB，不冒充目标条件 |
| Microsoft Office | 打开/分页/编辑约定 DOCX，打开 20 页 PPTX，核对中文字体、分页和布局 | `NOT_RUN/BLOCKED_EXTERNAL` | 未获得真实 Office 环境；仅验证 OOXML 结构和可抽取文本 |
| WPS Office | 同上，单独执行，不继承 Office 结果 | `NOT_RUN/BLOCKED_EXTERNAL` | 未获得真实 WPS 环境 |
| 正式本地备课包导出 | 约定 10 页 DOCX 与 20 页课件分别测量，覆盖 staging、写盘、回读和原子发布 | `NOT_RUN/BLOCKED_EXTERNAL` | 当前只完成内存生成核心；DOCX 分页和 Office/WPS 打开依赖外部环境，不把 30s 预算参照写成 PASS |
| 正式签名更新/升级回退 | 签名安装器、SmartScreen、目标机 vA→vB 与失败恢复 | `NOT_RUN/BLOCKED_EXTERNAL` | 缺持有人签名身份、可信公钥、授权分发和干净 Windows；T01/T02 仅本地工程验证 |
| 真实 API 模型辅助归因 | 授权账户、费用、联网、逐次外发许可 | `NOT_RUN/BLOCKED_EXTERNAL` | 本包不改变 G04/G08 外部门 |
| 真实学生资料与教学专业复核 | 隐私授权、受控样本、有资质教师复核 | `NOT_RUN/BLOCKED_EXTERNAL` | 合成夹具和自动审查不替代隐私授权或教学判断 |

## 复现

```powershell
node scripts/run-g10-performance.mjs
```

脚本使用固定样本量运行 `tests/performance/g10-core-bench.test.ts`，在每个样本后原子更新临时 `.partial`。生成、复核或测试中途失败时，文件改写为闭集 `FAILED` 并保留已完成的样本；如果连 partial 都没有，runner 会发布本轮 `G10_RUNNER_NO_MEASUREMENT`，不会沿用旧 PASS。子进程另有 12 分钟硬截止；非零退出或遗留 `IN_PROGRESS` 会保留已有原始数组并归一化为终态 `FAILED`。runner 先解析验证 partial，再用同目录 rename 替换正式 RAW；进程退出码仍保留失败。
