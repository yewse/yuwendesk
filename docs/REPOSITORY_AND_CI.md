# 源码目录与构建约定

本文件是未来应用仓库的组织基线，当前文档包不包含应用源码。目录可以通过ADR作小范围调整，不得改变安全与交付要求。

## 推荐目录

```text
apps/desktop/
  src/main/            窗口、授权文件句柄、凭据、网络代理、更新
  src/preload/         最小IPC桥，不暴露通用invoke
  src/renderer/        简体中文界面、结构编辑、课堂展示
  src/worker/          编排、解析、单数据库写入者
packages/contracts/    Schema、类型、IPC/状态与错误目录
packages/domain/       无UI的计划、目标、任务、联结、观察规则
packages/workflow/     有限阶段、版本依赖、预算与恢复
packages/resources/    安全解析、版本、锚点、检索、许可过滤
packages/provider/     Grok适配、能力探测、请求限制与脱敏
packages/renderers/    DOCX、PPTX、PDF与HTML同源渲染
packages/storage/      迁移、事务、备份、密文载荷
resources/             许可明确的图标、模板、自拟示例和翻译文案
migrations/            单调版本迁移与校验
scripts/               构建/测试工具，仅开发者与CI执行
ci/                    受控流水线配置与Windows VM测试说明
tests/unit/            纯规则、负例、状态/引用/预算
tests/integration/     SQL、文件事务、解析、协议、导出
tests/e2e/             Electron窗口真实操作
tests/windows/         干净安装、签名、升级、卸载与恢复
tests/fixtures/        明确合成或有权限的样本，禁止真实学生数据
docs/adr/              工程决策与合同变更
reports/               自动结果，含commit/build/env和未运行项
```

## 依赖与构建规则

采用精确依赖和锁文件；每个依赖记录官方来源、许可证、用途、原生ABI与更新风险。不要盲目安装任何名称相似的npm包。解析器、Office输出、SQLite原生模块、安装器属于高关注依赖。不能把个人缓存和机器全局环境当构建前提。

源码build不得下载未校验的可执行文件。CI缓存按锁文件、OS、架构及Electron ABI隔离。运行时配置不写真实key。DEV、TEST、LIVE_API、RELEASE分模式，生产包不可使用测试provider。构建号与源码commit、锁文件hash、renderer版本、schema版本绑定。

应用层Schema适配provider支持的JSON Schema子集时，保留主合同。不得为满足模型输出而删掉业务约束；超出provider支持的检查仍在本地执行。金额/时间、SQLite查询、资源路径均由确定性逻辑处理，不让模型任意计算后直接当权威结果。

## 流水线阶段

提交检查：lint、typecheck、合同检查、单测、秘密扫描与许可证检查，不使用生产密钥。

集成检查：固定fixture的资料、工作流、导出、备份测试。网络mock明确标识，不能充当真实API验收。

Windows构建：目标x64与锁定Electron ABI；离线安装包包含运行依赖。检查安装包中没有真实用户数据和开发凭据。

桌面与安装验收：独立干净Win11标准账户。安装后从快捷方式启动；没有Node/Python/Office；检查中文路径、分辨率、监听、退出、重启和数据保留。仅通过Electron测试接口不能替代安装器真实操作。

真实API：独立授权预算，在合成/允许数据上运行；账户无权限则BLOCKED。不对每次普通提交自动调用付费模型。真实usage与超时不确定项保留。

发行：在未受污染的制品上注入受控签名，生成SBOM和哈希；执行签名和发行门。公共/受控分发都需持有人授权。没有签名或真实Windows证据不得将构建标正式发布。

## 可重复构建的边界

要求相同源码、锁文件与环境产生可追溯功能相同的构建，记录不确定时间戳和签名差异。除非实际证实，不宣称带签名安装包字节完全可复现。升级包身份和来源独立验证，不能只依靠“文件看起来能运行”。
