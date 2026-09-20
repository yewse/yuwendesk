# G07 审查与一处修改证据

日期：2026-09-20
分支：`codex/g07-review-change`
证据基线提交：`c6002e7d191cc4539484f96c7f255b507f85a9ed`（G07-T03）
G07-T04 实现提交：包含本报告的 `fix(G07-T04): publish lesson bundles fail-closed with recovery` 提交；提交后可用 `git log -1 --format=%H -- reports/G07_EVIDENCE.md` 解析，不在提交内容中伪造自引用哈希。

## 环境

- OS：Microsoft Windows 11 专业版，10.0.26200，ProductType 1；这是开发主机，不是干净安装验收 VM。
- Node.js：v24.15.0；npm：11.12.1。
- Vitest：2.1.1；TypeScript：5.5.4。
- Electron：锁定 44.4.3，但 `node_modules/electron/dist/electron.exe` 不存在；本轮未执行 Electron 窗口走查。
- Fixture：仓库内自拟《春》演示计划；`content_origin=authored`，不含真实学生数据或真实 API 结果。

## 本地确定性证据

以下命令均实际退出 0：

```text
npm run test:unit
  29 test files passed
  279 tests passed / 1 skipped / 280 total

npm run typecheck
npm run lint
npm run verify:contracts
npm run build
git diff --check
```

G07-T04 新增或加强的机器覆盖：

- 发布前重算五文件 SHA-256，并通过现有抽取路径重解析 PPTX、DOCX、PDF；检查精确三类五文件、plan/revision、学生与投屏角色隔离、任务及答案同步。
- PDF 中文/ASCII 混排按字符段使用 CJK/标准字体，避免“方案 A/B”在回解析时丢失拉丁字符而产生假同步或假失败。
- 对 5 次写入、5 次回读/哈希检查、1 次目录改名逐点注入失败；每次均保持基线修订、空候选历史、空新清单并清理暂存目录。
- 对 SQLite 的修订写入前、修订写入后、包写入后、文件清单写入后、当前指针更新前、幂等成功写入前共 6 个事务边界注入失败；每次整个业务事务回滚，已发布候选目录被清理。
- 同一幂等键/同一指纹连续三次 `DISK_FULL` 后持久化为 `failed_final`；第四次返回可靠基线修订，不再调用材料生成或文件写入。同键异载荷仍是 key reuse，且不增加失败次数。
- 旧 `materials.generate` 已移除吞错的直接写入；现在也执行内存审查、暂存、逐文件回读哈希、原子改名，并用一个 SQLite 事务登记包、五文件和 ReviewReport。目录不可写时返回诚实 `DISK_FULL`，不登记不存在的文件，消息明确“旧版未受影响”。

全量测试输出仍出现 pdfjs 关于可选 `canvas` polyfill 和 `standardFontDataUrl` 的警告；相关文字抽取断言实际通过。本证据不把这些测试等同于 Office/WPS 视觉保真。

## 一次实际生成的材料摘要

本次证据运行的 `plan_id=plan_a728726c-783d-4231-bdca-34d74cc716f2`，`revision_id=rev_da7038bb-6e3f-488f-932c-a8749ac6025c`；发布前确定性审查问题数为 0。

| 角色 | 格式 | 字节 | SHA-256 |
|---|---:|---:|---|
| presentation | pptx | 82084 | `6f1924aa0786fc335380d7a741f369e607e3afcc9ab5b4c3007fe3f6f59eb8d5` |
| student | docx | 5506 | `9c0208c2ca8d5ae80a2c3a7d9816f54ab01eabc92efebdae237de1de17b6e7c6` |
| student | pdf | 13063 | `52c0dfd8550c5acd84d631ac6863ba6996906e5bfdf4dfe0e1897eff3cb585d5` |
| teacher | docx | 5743 | `bf6e74d61f6510df272cfe2661bc2f9776cf8d6fc657072f2f49b839df91f1e8` |
| teacher | pdf | 20800 | `f13ed07a0f3b1e923bb74e4995fee063caf337a18d58318ebd55dc3c50a6476a` |

这些哈希只对应上述一次自拟 fixture 生成；PPTX/DOCX 容器元数据可能令另一轮生成得到不同字节，不将其冒充固定发布哈希。

## 外部门（与本地 PASS 分开）

| 证据门 | 状态 | 原因 |
|---|---|---|
| 开发态 Electron UI 走查 | `BLOCKED_EXTERNAL` | Electron 44.4.3 包目录存在但二进制缺失；此前补下载约三分钟无输出后终止，本轮未伪造启动或截图。 |
| 干净 Windows 11 标准账户安装验收 | `BLOCKED_EXTERNAL` | 当前是开发主机，不是要求的干净 VM；未执行安装包安装→启动→保存→重启。 |
| 真实模型语义复核 | `BLOCKED_EXTERNAL` | 无获准真实 API 账户、密钥和费用授权。 |
| PowerPoint/WPS/Word 视觉保真 | `BLOCKED_EXTERNAL` | 未在这些真实应用中打开五文件；自动抽取只证明结构和文字一致性。 |
| 正式发行签名 | `BLOCKED_EXTERNAL` | 无签名身份和凭据。 |

冻结验收项及 CR-001 增补定义均未删除、未放宽；本地单元/集成覆盖没有被改写成上述外部门的 PASS，也不构成教学有效性证明。
