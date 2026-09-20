# G10-T03 中文路径、缩放与辅助使用工程证据

日期：2026-09-20

分支：`codex/g07-review-change`

基线：`aef8bbd`（G10-T02）。本报告与 G10-T03 实现同一提交。

## 环境与证据边界

- 本地工程环境：Microsoft Windows 11 开发主机；Node 24.15.0；npm 11.12.1；Vitest 2.1.1；TypeScript 5.5.4。
- 所有数据库、正文、更新包、签名 keypair 和五文件均为运行时合成夹具；未使用真实学生材料、真实 API、生产签名或发行安装器。
- 本包的文件系统用例在 Windows 开发主机真实创建了含中文、空格、组合字符 `e\u0301` 和长度大于 150 字符的目录，并通过实际 SQLite、本机/便携备份、恢复 prepare→pending→apply、离线更新 staging 与五文件发布路径读写。它不是干净 Windows VM 安装证据。
- 布局结果是 React 静态语义和 CSS/断点模型的自动化工程验证，不是像素截图、真实显示缩放、中文 IME、键盘人工走查或屏幕阅读器报告。因此冻结验收 `INS-007` 仍为 `NOT_RUN/BLOCKED_EXTERNAL`，没有改为 PASS。

## Unicode 与固定根路径

`g10-unicode-paths.test.ts` 在每个用例创建独立临时根：`语文 备课/校本资料…/组合字符-é-长路径…`。测试只通过 Node `path` API 和产品服务传递路径，没有拼接 shell 命令。

| 路径 | 实际自动化结果 |
|---|---|
| `<Unicode userData>/yuwendesk.db` | SQLite 加载、中文/组合字符草稿保存和回读成功 |
| `<Unicode userData>/backups/*.ready` | SQLite Online Backup 创建、manifest 验证及数据库存在性检查成功 |
| 便携备份 → 另一 `<Unicode userData>/restore-staging` | 加密容器解封、旁路复核、pending marker、启动前 apply、中文草稿回读及 marker 清理成功 |
| 中文文件名 `.yuwenupdate` → `<Unicode userData>/updates/*.ready` | Ed25519 合成签名包重新读取、复验、暂存及 installer bytes 回读成功；renderer 摘要不暴露选择路径 |
| `<Unicode root>/materials` | 中文文件名三类五文件先暂存、后原子发布；五个文件均存在且位于固定材料根下 |

这些测试覆盖长但受控的路径，不声称 Windows 任意长度路径、UNC、网络盘或 Office 打开保真已经通过。

## 自动布局与辅助使用合同

- 根 shell 以 `min-height: 0` 和独立滚动主区避免固定头部/侧栏把主操作挤出视口；980px 以下导航堆叠，700px 以下核心双栏变单栏。
- DOM 顺序固定为“跳到主要内容”链接 → 命名主导航 → 带固定 ID 的主要内容；当前导航项使用 `aria-current="page"`。
- 大字模式是显式、可持久化的按键状态（`aria-pressed`），不依赖浏览器远程资源；大字模式强制核心网格单列。
- 通用交互控件使用 3px 白色内环 + 深蓝外环，在浅/深背景均可辨；强制色模式改用系统 `Highlight`。状态同时包含中文文本/可读标签，不只靠颜色或 hover。
- 草稿、资料检索、模型配置和备份口令有显式可访问名称。原文、分析和版本弹层声明为命名 modal dialog，打开后聚焦关闭按钮，并支持 Escape 关闭。
- 课程、授课、观察、归因、纠偏、变更、资源、模型、备份、诊断和更新的异步进度/结果统一使用原子 live region；普通进度/成功为 polite status，明确失败/阻断为 assertive alert。
- 样式包含 Windows 强制色和 reduced-motion 分支；字体栈均为系统/本地字体，没有 `@import` 或远程字体依赖。
- 大字模式覆盖状态 pill、tag、弹层正文、命中上下文、测量/纠偏/历史与诊断预览等原先显式 12–14px 文本；warning/tag 前景色另由自动对比计算约束为不低于 4.5:1。

自动矩阵由 `buildAccessibilityLayoutMatrix()` 生成；`contentViewportHeight` 是断点预算模型，不是 DOM 像素测量：

| 物理视口 | 显示比例 | CSS 视口 | 导航 | 普通列数 | 大字列数 | 主区预算高度 |
|---|---:|---:|---|---:|---:|---:|
| 1366×768 | 100% | 1366×768 | sidebar | 2 | 1 | 688px |
| 1366×768 | 125% | 1092×614 | sidebar | 2 | 1 | 534px |
| 1366×768 | 150% | 910×512 | stacked | 2 | 1 | 352px |
| 1920×1080 | 100% | 1920×1080 | sidebar | 2 | 1 | 1000px |
| 1920×1080 | 125% | 1536×864 | sidebar | 2 | 1 | 784px |
| 1920×1080 | 150% | 1280×720 | sidebar | 2 | 1 | 640px |

普通/大字合计 12 行均保留可滚动主区，预算高度不低于 220px。真实渲染可能受 Windows 字体、DPI、IME 候选窗、系统主题和辅助技术影响，必须另行实测。

## TDD 与门禁

| 命令/阶段 | 实际结果 |
|---|---|
| T03 首次 RED | Unicode/长路径 3/3 已通过；布局套件因缺少 `accessibilityLayout` 模块失败，证明新布局合同先于实现 |
| T03 第二轮 RED | 缺 React 测试运行时绑定及无健康数据时的状态断言方法不成立；修正测试装配，状态可读标签改查源码合同，不伪造健康数据 |
| 辅助使用加固 RED | 独立复核指出异步结果无 live region、大字遗漏显式小字号、深色导航焦点对比不足及恢复路径未覆盖；逐项增加失败合同/真实恢复用例后修复 |
| G10-T03 定向测试 | exit 0；7/7 |
| 最终 `npm run test:unit` | exit 0；544 passed / 1 skipped（545 total，62 files） |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run verify:contracts` | exit 0；错误码目录和冻结增补合同一致 |
| `npm run build` | exit 0；renderer/main 完成 |
| `git diff --check` / staged diff check | exit 0（最终 staged 检查在提交前复核） |

既有唯一 skipped 未改为通过；pdfjs 的可选 `canvas` / `standardFontDataUrl` 告警仍如实保留，不代表 OCR、像素渲染或 Office/WPS 保真通过。

独立复核首轮发现异步 live region、大字覆盖、焦点对比和 Unicode 恢复覆盖问题；后续又捕获 React `autoFocus` 先于 effect 导致 opener 恢复失效，以及一处修改 label 未随大字放大。所有 Critical/Important 均经失败合同或真实路径用例闭环；最终 fresh 定向复跑 7/7，Critical 0 / Important 0，结论 Ready。保留两个非阻断 Minor：错误严重度目前由闭集中文文案规则推断，后续可改为显式 severity；布局矩阵仍是预算/静态合同而非真实 DOM 几何，已在本报告边界中明确。

## 真实 Windows 待执行清单

以下项目需要可观察的实际环境，状态均为 `BLOCKED_EXTERNAL`：

1. 在干净 Windows 11 标准账户、1366×768 与 1920×1080，分别设置 100%/125%/150% 显示缩放；逐页走核心操作并保存真实截图/操作记录。
2. 用微软拼音等真实 IME 在草稿、搜索、观察记录和模型配置非密钥字段输入中文，检查候选窗、组合文本、回车和焦点保持。
3. 仅用键盘从 skip link、主导航到各页面主操作；打开/关闭三个 modal，并确认焦点不会被遮挡或丢失。
4. 使用 Windows 高对比度/强制色和大字模式检查状态、错误、禁用与当前页不只靠颜色表达。
5. 使用 Narrator 或经批准的屏幕阅读器核对命名区域、label、status live region、dialog 名称与朗读顺序。
6. 由人工视觉/辅助使用复核者确认滚动区、主按钮、IME 候选窗和 dialog 在每个矩阵点均可见可操作。

## 冻结输入与未改变的外部门

- `acceptance/cases.json`：`cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5`。
- `acceptance/addenda/classroom-delivery.cases.json`：`f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06`。
- `package-lock.json`：`81444aa6fe366746defc6ccd5de13fec244a1e0297e7246b381c93c1415795ed`。
- 冻结验收项未删除、未改状态。真实 API 模型辅助归因、学生材料隐私授权与逐次外发许可、教学专业复核、真实两机 Windows/DPAPI 恢复、Office/WPS、正式签名、SmartScreen、公开分发和开发态 Electron 窗口状态均不因本包改变。
