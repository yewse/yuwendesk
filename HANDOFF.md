# HANDOFF

新会话请先读：`README_START_HERE.md` → `AGENTS.md` → `docs/ENGINEERING_SPEC.md` → `planning/AUTONOMOUS_WORKPLAN.md` → 本文件与 `PROGRESS.md`。

## 当前状态（2026-09-19）

- 已完成 G00 环境锁定与 G01 可安装骨架的工程验证级实现。仓库含完整工程规格包 + `apps/desktop` 应用。
- 应用可在 Linux（Cloud Agent）以 Xvfb 无头运行，中文界面、单实例、离线可用、无本地监听、受限 IPC 与本地草稿持久化均已实测。
- 尚未产出 Windows `.exe` 安装包；G01-T04、G04、签名与在线更新为 BLOCKED_EXTERNAL。

## 如何构建 / 运行 / 测试

```bash
npm install                 # 安装（幂等）
npm run -w @yuwendesk/desktop typecheck
npm run -w @yuwendesk/desktop lint
npm run -w @yuwendesk/desktop test:unit
npm run -w @yuwendesk/desktop build         # vite 渲染层 + tsc 主/预加载
npm run verify:contracts                    # 轻量合同校验

# 无头环境运行演示（开发/CI 用；教师不使用命令行）
scripts/dev-run-xvfb.sh                      # 启动 Xvfb :99 + Electron（设 YUWENDESK_DEV_ALLOW_PLATFORM=1）

# Windows 安装包（Linux 上需 wine：sudo apt-get install -y wine wine64 wine32:i386）
# 未签名工程测试包（无证书）：
CSC_IDENTITY_AUTO_DISCOVERY=false npm run -w @yuwendesk/desktop build:win
# 产物 apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe（见 reports/WINDOWS_BUILD.md 的 SHA256）
```

> Windows 构建现状：Linux+wine 可产出**未签名**安装包（证据线①）。干净 Win11 普通用户**实机安装验收**（②）、**正式签名**（③）、**真实 Grok 连通**（④）仍需外部输入，四者分别记录、不可互相替代（ADR-0003）。

## 阻断项与所需外部输入（见 planning/EXTERNAL_INPUTS.json）

| 需要 | 用于 |
|---|---|
| EXT02 Windows 11 x64 干净 VM + 桌面自动化 | G01-T04 安装验收、`build:win` 实测 |
| EXT03/EXT04 Grok API 账户/密钥/费用上限 | G04 真实连通与能力探测 |
| EXT07 发布签名身份/凭据 | 正式签名发布 |
| EXT08 分发地址/可信更新公钥 | 在线更新发布 |

密钥放受控秘密环境（Cloud Agent Secrets），禁止贴进仓库或提示词。

## 下一个有界工作包建议

1. G02-T01 受限 IPC + Schema 门的正式化（把 `ui.*` 草稿并入 `settings.*`/SQLite 单写入者），补失败测试先行。
2. 或在获得 Windows VM 后先关闭 G01-T04（干净标准账户安装→桌面图标启动→退出重启→保留数据）。

## 重要纪律

- 不删验收项、不硬编码成功、不伪造 Windows/签名/真实 API 证据。未运行标 NOT_RUN，缺外部输入标 BLOCKED_EXTERNAL 并继续独立安全任务。
- 一个工作包一次小步提交，更新 PROGRESS 与本文件。
