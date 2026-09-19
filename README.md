# 语文备课工作台 · YuwenDesk

面向初中语文教师的中文 Windows 桌面备课应用（Electron + TypeScript + React）。教师最终只需安装、双击桌面图标使用，不接触命令行、网址或手工服务。

> 当前进度：**G00 环境锁定 + G01 可安装骨架（工程验证级，非正式教学发布）**。数据基础、资料导入、AI 生成、材料导出、审查与纠正等（G02–G11）尚未实现。真实完成状态见 `PROGRESS.md` 与 `reports/G00_G01_EVIDENCE.md`。

## 工程文档（先读）

- `README_START_HERE.md`：给项目持有人。
- `AGENTS.md`：编码智能体执行章程。
- `docs/ENGINEERING_SPEC.md`：完整产品与技术规范。
- `docs/MODULES_AND_SKILLS.md`、`docs/IPC_AND_STORAGE.md`、`docs/REPOSITORY_AND_CI.md`。
- `contracts/`：数据 Schema、IPC 目录、状态机、SQL 基线。
- `acceptance/cases.json`：验收用例。`planning/`：工作包与外部输入。`baseline/`：原始 60 条需求（只读保留）。
- `docs/adr/`：工程决策记录（ADR-0001 技术基线、ADR-0002 G01 本地草稿与受限 IPC）。

## 目录

```
apps/desktop/            Electron 桌面应用
  src/main/              窗口、单实例、平台判定、受限 IPC、本地存储
  src/preload/           最小 IPC 桥（仅命名方法，不暴露通用 invoke）
  src/renderer/          简体中文界面（React）
  src/shared/            IPC 契约类型与错误码
  tests/                 单元测试（平台判定、IPC 白名单/外壳/版本并发）
scripts/                 开发/CI 辅助脚本（教师不使用）
docs/ contracts/ acceptance/ planning/ baseline/ examples/ reports/
ENV_LOCK.json SBOM.draft.json PROGRESS.md HANDOFF.md
```

## 开发命令（仅开发者 / CI 执行）

```bash
npm install                                  # 安装依赖（幂等）
npm run -w @yuwendesk/desktop typecheck      # 类型检查
npm run -w @yuwendesk/desktop lint           # 代码规范
npm run -w @yuwendesk/desktop test:unit      # 单元测试
npm run -w @yuwendesk/desktop build          # 构建渲染层 + 主/预加载
npm run verify:contracts                     # 轻量合同校验

# 无头环境运行（开发/CI 演示；教师正常使用不需要）
scripts/dev-run-xvfb.sh

# Windows x64 离线安装包（需 Windows 或 wine + 签名凭据）
npm run -w @yuwendesk/desktop build:win
```

## 安全基线（骨架期已落实）

- 渲染进程 `contextIsolation`/`sandbox` 开启、`nodeIntegration` 关闭；预加载仅暴露固定命名方法。
- 生产环境不监听任何本地 HTTP/WebSocket 端口；渲染层由本地静态资源经 `file://` 加载。
- IPC 逐调用做发送者校验 + 请求外壳校验 + 操作白名单；写操作使用乐观版本并发；本地写入原子化。
- NSIS：当前用户安装、不提权、不装服务、不改 PATH、卸载默认保留数据；appId 固定 `org.yuwendesk.app`。

## 已知限制与阻断

无 Windows 实机（EXT02）、无 Grok 账户（EXT03/04）、无签名身份（EXT07）、无分发地址（EXT08）时，相应门保持 BLOCKED_EXTERNAL；本仓库不冒充已安装、真实联网或正式签名。详见 `ENV_LOCK.json` 与 `HANDOFF.md`。
