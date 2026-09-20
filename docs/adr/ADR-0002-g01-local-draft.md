# ADR-0002 G01 本地草稿与受限 IPC 子集

- 状态：已接受
- 日期：2026-09-19
- 阶段：G01

## 背景

G01 目标是"可安装骨架"：中文原生窗口、单实例、保存与退出生命周期、离线可用。需要一个最小但真实的纵向路径来验证受限 IPC 与本地持久化，同时不越界实现 G02+ 的数据库与业务逻辑。

## 决策

1. G01 仅实现 IPC 目录（contracts/ipc-catalog.json）的只读子集：`app.bootstrap`、`app.health`、`app.getStatus`；并新增两个受限本地 UI 操作 `ui.loadDraft`、`ui.saveDraft` 作为骨架期的本地草稿持久化。所有操作经统一请求外壳校验、发送者身份校验与操作白名单（规范 §09.1、§06.2）。
2. `ui.saveDraft` 采用乐观并发（expected_revision + idempotency_key），演示版本冲突返回 `VERSION_CONFLICT` 而非覆盖（规范 §07.3）。本地状态使用"临时文件→原子改名"写入（规范 §07.2）。
3. 预加载仅暴露固定命名方法，不暴露通用 `invoke(channel,...)`、fs、shell 或原始 ipcRenderer；在 `sandbox=true` 下预加载完全自包含（仅类型导入 + 本地常量），运行时只依赖 electron。
4. `ui.loadDraft/ui.saveDraft` 为骨架期占位。G02 引入 SQLite 单写入者与 `settings.*` 后，本地草稿将并入正式设置/计划存储合同，届时移除或改写这两个操作。

## 后果

- 骨架期即建立"受限 IPC + 版本并发 + 原子写入 + 无本地监听"的安全基线，后续阶段在此之上扩展。
- 该本地草稿仅保存教师自拟文字，不含 AI 生成正文或密钥；不违反"禁止硬编码教案/伪完成"约束。
