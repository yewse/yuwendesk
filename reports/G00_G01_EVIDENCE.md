# G00 / G01 真实证据报告

日期：2026-09-19　提交阶段：G00 环境锁定 + G01 可安装骨架（工程验证级）

> 状态口径：PASS / FAIL / BLOCKED / NOT_RUN。开发/构建主机为 Linux（Cloud Agent）；教师目标平台 Windows 11 x64。凡需 Windows 实机、签名或真实 Grok 账户的门保持 BLOCKED，未运行项标 NOT_RUN，不写"全部通过"。

## 环境与命令

| 项目 | 结果 |
|---|---|
| Node / npm | v22.14.0 / 10.9.7 |
| `npm install` | PASS（495 包，`package-lock.json` 已锁定） |
| `npm run typecheck`（tsc 主/预加载 + 渲染） | PASS（无错误） |
| `npm run lint`（eslint） | PASS（无告警/错误） |
| `npm run test:unit`（vitest） | PASS（2 文件 / 14 用例） |
| `npm run build`（vite 渲染层 + tsc 主/预加载） | PASS（产物见 `apps/desktop/dist/`） |
| `npm run build:win`（electron-builder NSIS x64） | NOT_RUN（需 Windows/wine 与签名，见下） |

## G01 验收对照（INS-001..006, 008）

| 用例 | 状态 | 证据 |
|---|---|---|
| INS-001 中文原生窗口可操作、无浏览器地址/终端/运行时下载 | 工程验证 PASS（Linux）；Windows 实机 BLOCKED | 截图 `yuwendesk_home.png`；生产从 `file://` 加载本地静态资源，无开发服务器 |
| INS-002 不请求提权/不装服务/不改 PATH/不开机自启 | 配置 PASS；实机 BLOCKED | `electron-builder.yml`：oneClick、perMachine=false、allowElevation=false、无 service |
| INS-003 唤醒同一实例、编辑不丢失 | PASS | 单实例锁 `requestSingleInstanceLock` + `second-instance` 聚焦；第二实例退出、窗口数保持 1（见 `g01_process_listener_evidence.log`） |
| INS-004 中文/空格路径正确 | 部分 PASS | 使用 `app.getPath('userData')`，中文标题、无硬编码英文路径；含中文用户名的 Windows 路径需实机复测（BLOCKED） |
| INS-005 卸载默认保留用户数据 | 配置 PASS；实机 BLOCKED | `deleteAppDataOnUninstall=false`；appId 固定 `org.yuwendesk.app` |
| INS-006 不支持系统安全退出并给中文说明 | PASS | `evaluatePlatform` + 启动时 `dialog.showErrorBox` 后 `app.exit(0)`；单测覆盖 |
| INS-008 无 HTTP/WebSocket 监听 | PASS | `ss -ltn` 无任何监听套接字；进程树仅 zygote + network utility（`g01_process_listener_evidence.log`） |

## 安全基线（骨架期即落实）

- 渲染进程 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webviewTag=false`。
- 预加载仅暴露固定命名方法，不暴露通用 `invoke`/fs/shell/原始 ipcRenderer；`sandbox=true` 下预加载完全自包含（只依赖 electron）。
- 每个 IPC 调用做发送者身份校验 + 统一请求外壳校验 + 操作白名单；写操作 `ui.saveDraft` 使用 expected_revision + idempotency_key，冲突返回 `VERSION_CONFLICT`（不覆盖）。
- 本地状态"临时文件→原子改名"写入；CSP 禁止远程脚本与外部资源（`connect-src 'none'`）。
- 外链仅允许 https 交由系统浏览器；阻止渲染进程任意导航与新开窗口。

## 运行演示（工程验证级）

在无头 Xvfb 上运行真实构建的 Electron 应用（`--no-sandbox` 仅为容器内启动开发验证所用，产品 `webPreferences.sandbox` 保持 true）：

- `yuwendesk_home.png`：首页"备下一课"，系统状态四项全绿（含"本地网络监听：无"），备课草稿保存为"版本 v1 / 已保存 …"（真实 IPC + 本地持久化）。
- `yuwendesk_settings.png`：帮助与设置，AI 连接"待配置（BLOCKED · 需外部账户）"，关于面板标注"工程验证版·非正式教学发布"。
- `yuwendesk_walkthrough.mp4`：四个中文页面导航 + 草稿粘贴自动保存与版本递增的端到端演示。
- `g01_process_listener_evidence.log`：进程树与监听套接字证据（INS-008）。

## 被阻断门（BLOCKED_EXTERNAL）

| 门 | 缺失外部输入 | 说明 |
|---|---|---|
| G01 干净 Windows 安装验收 (INS-001..006) | EXT02 Windows 11 x64 VM + 桌面自动化 | 已提供 NSIS 配置与 Linux 工程验证运行；签名安装包与实机安装另测 |
| G04 真实联网/Grok 探测 | EXT03/EXT04 Grok 账户/密钥/预算 | 界面"检查连接"入口就绪，真实连通 NOT_RUN；未提供密钥前不产生付费调用 |
| 正式签名发布 (S13) | EXT07 签名身份/凭据 | 无凭据输出未签名工程测试包，不冒称正式发行 |
| 在线更新发布 | EXT08 分发地址/可信公钥 | 不生成虚假下载地址 |

## 已知限制

- 本轮未生成 Windows `.exe` 安装包（需 Windows/wine 与签名），因此不声称"已安装"；仅完成 NSIS 打包配置与跨平台工程验证运行。
- G02+ 的数据库、资料导入、AI 生成、材料导出、审查与纠正等均未实现，界面对应页面明确标注"后续版本开放"。
