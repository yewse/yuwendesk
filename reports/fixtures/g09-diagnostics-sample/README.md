# G09 最小诊断样包说明

本目录只提交可审计的文本说明，不提交二进制诊断包。

- 夹具：`apps/desktop/tests/diagnostics.test.ts` 中的全虚构状态与 canary 数据。
- 规范化预览 SHA-256：`2986bc3279e5da4ca218ea06acaf32c772902f744b589f78a2b73ca58bdc1792`
- ZIP 条目（且仅有）：`diagnostics.json`、`README.txt`
- 生成/验证命令：`npm --workspace @yuwendesk/desktop exec vitest run tests/diagnostics.test.ts`
- 二进制位置：测试在操作系统临时目录生成并在用例结束后清理；它不是、也不包含真实用户诊断数据。

自动化断言会解包并核对精确条目和 `diagnostics.json` 内容，同时搜索 API 密钥、姓名式文件名、教材正文、学生正文、绝对路径、提示词、模型输出和异常消息的唯一 canary，确保这些内容不进入预览或诊断包。应用没有诊断上传代码。
