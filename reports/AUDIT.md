# 依赖安全审计（F06 · 第三轮 7.2）

日期：2026-09-19　命令：`npm audit --json`（完整结果见 artifact `pr1_npm_audit.json`）

## 摘要

`{ moderate: 2, high: 1, critical: 1, total: 4 }`

## 逐项分析（构建/测试依赖 vs 运行依赖 vs 可达路径）

| 包 | 严重度 | 类别 | 是否随产品分发 | 可达路径 | 处置 |
|---|---|---|---|---|---|
| `vitest` | critical | 测试（devDependency） | 否 | 需运行 Vitest API/UI 服务器并访问恶意网站；产品不含 Vitest | 不影响分发；随工具链升级跟进 |
| `@vitest/mocker` | moderate | 测试（devDependency，vitest 传递） | 否 | 同上（仅测试期） | 同上 |
| `vite` | high | 构建/开发服务器（devDependency） | 否 | 需运行 Vite dev server 并被恶意站点访问；**生产应用通过 file:// 加载本地静态资源，不含 dev server** | 不影响分发；生产无该路径 |
| `esbuild` | moderate | 构建（devDependency，vite 传递） | 否 | 仅 dev server 场景 | 同上 |

## 结论

- 4 项全部集中在**开发/测试工具链**（`vite`/`vitest`/`esbuild`/`@vitest/mocker`），均为 `devDependencies`，**不打包进 Electron 安装包**，教师侧产品无对应可达路径（生产不启动 Vite/Vitest 服务、无本地监听，见 INS-008 证据）。
- 因此**不执行** `npm audit fix --force`（避免破坏锁定的构建/测试工具链）；作为 F06 的持续项，随 Vite/Vitest 的兼容安全版本按受控方式升级并回归。
- 运行依赖（当前 G01 阶段 `dependencies` 为空，运行时仅 Electron + 打包的本地静态资源）无本审计标记的漏洞。

> 说明：本审计针对 Linux 开发环境解析结果；CI（windows-latest）日志中的 audit 摘要一致（4 项）。此为构建/测试链风险，非产品运行时暴露。
