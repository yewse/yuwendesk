# G09 威胁检查清单

日期：2026-09-20

范围：G09-T01–T04 本地工程边界；夹具均为虚构数据。
证据基线：`0560badc425a07438bcf5781322268b1674b1e67`。

状态含义：`ENGINEERING_VERIFIED` 只表示列出的自动化工程检查已实际执行；`NOT_RUN` 表示目标验收没有可执行证据；`NOT_APPLICABLE_CURRENT_CAPABILITY` 表示当前未暴露该能力；`BLOCKED_EXTERNAL` 表示需要仓库外环境、账户或授权。这里的状态不改写冻结的 `acceptance/cases.json`，其中验收状态仍保持原值。

| ID | 威胁/目标 | 预防层 | 已执行夹具/命令 | 观察结果 | 状态 |
|---|---|---|---|---|---|
| INS-008 | 生产应用不得启动 HTTP/WebSocket 监听 | 生产 `file://` 加载、`connect-src 'none'`、无服务入口 | `security.test.ts`、`g09-threat-boundaries.test.ts`；代码与构建检查 | 本地代码路径和请求锁定符合设计；未在干净 Windows 安装态做进程/套接字外部观测 | `BLOCKED_EXTERNAL` |
| SEC-003 | 材料内“读密钥/附数据库/外发/调用恢复”不得提升权限 | 资料只按文本入库；工具/网络能力只来自命名 IPC 和主进程注入 | `g09-threat-boundaries.test.ts` prompt-injection fixture | 文本可检索但未调用备份、恢复或网络，也未得到 token/path | `ENGINEERING_VERIFIED` |
| SEC-004 | 恶意 renderer、伪 sender、子 frame、跨对象/自造 token 或 provider 自由异常回显 | 单一主窗口 webContents + 顶层 frame 对象 + 精确 URL；闭合请求外壳；短时绑定单次 token；模型失败闭集映射 | `g09-threat-boundaries.test.ts` sender/token/provider-canary matrix；`model-protect.test.ts` | wrong sender、missing/child frame、untrusted URL、自造/过期/重放/跨对象 token 均拒绝；provider 路径/密钥/正文 canary 不进入 IPC 或持久错误码 | `ENGINEERING_VERIFIED` |
| SEC-005 | 路径穿越、Windows 别名、重复项、符号链接、压缩炸弹或越界写 | 加密后公开恢复入口先解析 ZIP 中央目录；全部记录计数；Windows 规范化碰撞键；local/central 名称与元数据一致；有硬截止的流式展开；manifest 精确集合 | `g09-archive-attacks.test.ts` public-entry matrix + `writeFile` 写目标审计 | traversal/absolute/drive/UNC/backslash、大小写别名、尾点/设备名、duplicate、symlink、4097 files/directories、低报 size、ratio bomb 均拒绝；失败时瞬时写目标只在 staging 且最终清理 | `ENGINEERING_VERIFIED` |
| SEC-006 | URL 下载每次重定向都需重新阻断 localhost/私网/元数据地址 | 当前没有 URL 下载能力；本地导入只接受真实 base64 或主进程文件对话框结果 | `g09-threat-boundaries.test.ts` 拒绝 `http://`、`https://`、`file://`、UNC、盘符作为 base64/path 输入 | URL download is not an exposed capability; redirect-hop integration is required before enabling it. 未执行逐跳网络集成验收 | `NOT_RUN` |
| SEC-007 | 学生敏感正文不得进入普通 SQLite/FTS/缓存/云请求 | AES-256-GCM 认证载荷、LOCAL_ONLY、FTS secure-delete、无逐次许可不派发 | `source-privacy.test.ts`、`g09-source-delete-flow.test.ts`、`g09-threat-boundaries.test.ts` | 虚构敏感夹具仅保留密文/通用标题；普通读取和网络未获得正文 | `ENGINEERING_VERIFIED` |
| SEC-008 | 普通→敏感后清除明文索引/缓存并使旧引用失效 | 单事务密文写入、FTS/段/全文/原件清理、依赖去内容化、材料隔离和故障回滚 | `source-privacy.test.ts`、`g09-failure-recovery.test.ts` | 成功态无明文/旧派生，注入故障时原状态整体保留 | `ENGINEERING_VERIFIED` |
| SEC-009 | 姓名式文件名不得出现在磁盘、诊断、manifest 或归档路径 | 敏感资料通用标题；诊断逐字段白名单；备份仅内部 ID 和登记路径 | `g09-threat-boundaries.test.ts` `CANARY_STUDENT_NAME_ALICE_7CC2.docx` | 提升后 DB bytes、诊断 JSON、managed manifest、portable entries/bytes 均无 canary | `ENGINEERING_VERIFIED` |
| SEC-010 | DOCM/宏、HTML/脚本、PDF 动作、外链图片不得执行或自动获取；主窗口不得导航 | 非 DOCX 格式拒绝；OOXML 仅抽取指定 XML；PDF `isEvalSupported:false`；session 网络锁定；导航精确同页 | `g09-threat-boundaries.test.ts` passive-content fixtures | 宏 blob/外部 relationship/HTML/PDF URI 均未执行或 fetch；外部和 `file:///etc/passwd` 导航被拒绝 | `ENGINEERING_VERIFIED` |
| DAT-001 | WAL 写入下取得一致快照 | better-sqlite3 Online Backup API + 独立 integrity check | `backup-manifest.test.ts`、`g09-backup-restore-flow.test.ts` | 已提交草稿在独立快照可读；凭据表被清空 | `ENGINEERING_VERIFIED` |
| DAT-002 | 跨机器恢复数据而不迁移 API 密钥 | 便携整包认证加密；工作区数据密钥二次封装；目标 safeStorage 重包；API credential 排除 | `g09-backup-restore-flow.test.ts` 使用两个互不兼容的伪 safeStorage | 伪机器夹具恢复成功且 API 密钥为空；真实两台 Windows/DPAPI 尚未执行 | `BLOCKED_EXTERNAL` |
| DAT-003 | 密文、nonce、AAD/header/tag/KDF 篡改必须认证失败且无部分明文 | AES-256-GCM，信封头纳入 AAD；KDF 参数闭集 | `portable-backup.test.ts`、`g09-archive-attacks.test.ts` envelope matrix | magic/header/nonce/ciphertext/tag/KDF 改动均在 staging 前失败 | `ENGINEERING_VERIFIED` |
| DAT-004 | 中断产生的半成品不得列为可用且旧备份仍在 | `.partial`→校验→原子 `.ready`；列表只认 manifest/hash 有效 ready | `g09-failure-recovery.test.ts` snapshot/manifest/key-wrap faults | 新半成品不可列出并被清理；既有有效恢复点仍可列出 | `ENGINEERING_VERIFIED` |
| DAT-005 | 明确删除敏感作品并如实区分备份范围 | 双确认、绑定 token、排他锁内重扫、事务删除、无正文墓碑、可续做备份收尾 | `g09-source-delete-flow.test.ts`、`source-privacy.test.ts` | 本机正文/索引/缓存/派生记录清理；受管与外部/离线备份结果分开报告 | `ENGINEERING_VERIFIED` |
| DAT-006 | 诊断包不得含密钥、教材/学生正文或完整模型 IO，且默认不上传 | 闭合字段/错误码白名单、完整预览哈希、两阶段本地保存、ZIP 精确两项、无上传路径 | `diagnostics.test.ts`、`g09-threat-boundaries.test.ts` | 八类 canary、姓名式文件名和未知错误自由文本均缺失；网络调用为 0 | `ENGINEERING_VERIFIED` |

## 保留边界

- `SEC-006` 没有被改成通过；当前拒绝 URL 输入不等于执行了重定向逐跳阻断。
- `INS-008` 没有用 `httpListeners:0` 状态字段替代干净 Windows 上的进程/监听套接字观测。
- 真实学生资料隐私授权、真实 API、教学专业复核、Windows/DPAPI 跨机恢复、Office/WPS、签名与正式发布均不由上述虚构夹具替代。
