# G10 可信升级、兼容与性能实施计划

> 依据 `docs/superpowers/specs/2026-09-20-g10-update-performance-design.md` 执行。沿用当前分支内联实施；不新建 PR、不 push、不签名、不发布。

## 共同纪律

- 不重做 G00–G09；冻结 acceptance 文件只校验哈希，不修改状态。
- 每个工作包先写失败测试，再实现最小闭环；每包更新 `PROGRESS.md`、`HANDOFF.md` 和报告并单独提交。
- 临时 Ed25519 私钥只在测试进程内生成，不写仓库；生产信任集为空时必须 fail-closed。
- 不新增自动下载、自动安装、强制关闭/重启、shell 执行或 renderer 路径输入。
- Windows、真实签名/分发、显示缩放、IME、目标硬件、Office/WPS、真实 API、隐私授权和教学复核分别诚实记录。

## Task 1：G10-T01 签名更新清单和离线更新

**新增文件：**

- `apps/desktop/src/main/update/types.ts`
- `apps/desktop/src/main/update/manifest.ts`
- `apps/desktop/src/main/update/container.ts`
- `apps/desktop/src/main/update/service.ts`
- `apps/desktop/src/main/update/trust.ts`
- `apps/desktop/src/renderer/updateView.ts`
- `apps/desktop/tests/update-manifest.test.ts`
- `apps/desktop/tests/offline-update.test.ts`
- `apps/desktop/tests/ipc-update.test.ts`
- `apps/desktop/tests/updateView.test.ts`
- `reports/G10_UPDATE_EVIDENCE.md`

**修改文件：**

- `apps/desktop/src/shared/ipc.ts`
- `apps/desktop/src/main/schemaGate.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/global.d.ts`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/styles.css`
- `PROGRESS.md`
- `HANDOFF.md`

### Step 1：以失败测试固定清单和签名边界

在 `update-manifest.test.ts` 生成两组临时 Ed25519 keypair。覆盖：合法规范清单；额外/缺失字段；重复 JSON key；非规范字节；坏版本；错误 app/platform/arch；尾点/设备名/路径式 packageName；未知 key id；包内自带公钥字段；由非信任私钥生成但 hash 正确的签名；manifest/signature/package 任意位翻转。

预期初始失败：更新模块尚不存在。

### Step 2：实现固定容器和纯验证

实现严格版本比较、规范 JSON、容器长度上限、Ed25519 信任锚验证、package 长度/hash 和目标匹配。验证 API 不写磁盘：

```ts
inspectUpdateContainer(container, {
  currentVersion, appId, platform, arch, trustedKeys
}): VerifiedUpdate
```

禁止从 manifest/container 读取并信任公钥。生产 `trustedUpdateKeys()` 当前返回空集并附 `BLOCKED_EXTERNAL` 原因；测试通过构造器注入临时公钥。

### Step 3：以失败测试固定 staging、幂等和无自动安装

`offline-update.test.ts` 覆盖：空信任集拒绝；原生选择取消无副作用；合法容器先预览后确认；token 绑定 hash/current/target、两分钟有效且单次使用；同幂等请求跨 service 重放；同键异包拒绝；状态漂移复验；`.partial` 不可列为 ready；回读失败/rename 失败清理；输出路径固定；没有 `spawn/exec/shell.openPath/app.quit/relaunch` 调用。

### Step 4：实现 UpdateService 和窄 IPC

`UpdateService` 只读用户选取 bytes，返回去路径摘要；确认后重读/复验并写 `<userData>/updates/<release-id>.partial/installer.exe`、`manifest.json`、`verification.json`，回读后原子改为 `.ready`。renderer 不能给路径、package、公钥或签名。

新增 `updates.status/inspectOffline/stageOffline` schema、preload 命名方法与设置页卡片。空信任集显示“尚未配置可信发布身份，离线更新验证被阻止”，不提供绕过按钮。验证成功只显示“已验证并暂存，未安装；不会自动关闭或重启”。

### Step 5：证据、复核和提交

运行：

```powershell
npm run -w @yuwendesk/desktop test:unit -- tests/update-manifest.test.ts tests/offline-update.test.ts tests/ipc-update.test.ts tests/updateView.test.ts tests/schemaGate.test.ts tests/security.test.ts
npm run -w @yuwendesk/desktop test:unit
npm run typecheck
npm run lint
npm run verify:contracts
npm run -w @yuwendesk/desktop build
git diff --check
```

`reports/G10_UPDATE_EVIDENCE.md` 记录临时 key id、命令、实际计数、冻结哈希和外部门。UPD-001 只标本地工程验证；真实签名安装仍 `BLOCKED_EXTERNAL`。UPD-002/003 留给 T02；INS-007 留给 T03；真实课堂中 UPD-004 保持 `NOT_RUN/BLOCKED_EXTERNAL`。

提交：

```powershell
git commit -m "feat(G10-T01): verify and stage offline updates"
```

## Task 2：G10-T02 迁移失败恢复与不兼容回退

**新增文件：**

- `apps/desktop/src/main/update/migration.ts`
- `apps/desktop/src/main/update/journal.ts`
- `apps/desktop/tests/g10-migration-recovery.test.ts`
- `apps/desktop/tests/g10-downgrade-guard.test.ts`
- `reports/G10_RECOVERY_EVIDENCE.md`

**修改：** `db/sqliteStore.ts`、`protection/backup.ts`、`protection/startupRestore.ts` 或等效启动编排、`index.ts`、设置页、`PROGRESS.md`、`HANDOFF.md`。

1. RED：迁移中断、完整性失败、切换各阶段故障、既有 rollback、磁盘不足、新数据世代后旧版启动、重复启动调和。
2. 实现迁移维护锁、G09 可验证恢复点、旁路副本迁移、完整性/schema/credential 检查、逐项切换 journal 和闭集错误证据。
3. 旧版看到未来 schema/世代只读拒绝；回退保留新数据副本，不自动覆盖。
4. UI 显示“旧版未覆盖新数据”和受支持恢复路径，不承诺旧 EXE 已自动恢复。
5. 全门禁、独立复核、报告和提交：`feat(G10-T02): recover failed migrations without overwriting data`。

## Task 3：G10-T03 中文路径、缩放与辅助使用

**新增文件：**

- `apps/desktop/tests/g10-unicode-paths.test.ts`
- `apps/desktop/tests/g10-accessibility-layout.test.ts`
- `reports/G10_ACCESSIBILITY_EVIDENCE.md`

**修改：** renderer 组件/样式、必要的固定根路径辅助函数、`PROGRESS.md`、`HANDOFF.md`。

1. RED：中文+空格 userData、长但受限的材料/更新/备份路径；核心视图在宽高/字体比例矩阵中有可滚动主区、主操作语义、label/aria、focus 顺序和非颜色状态。
2. 修复路径拼接、溢出、固定 footer/对话框遮挡、焦点可见性和大字模式；不引入远程字体或网页依赖。
3. 生成自动布局矩阵和真实 Windows 待执行清单。没有显示/IME/辅助技术环境时相关行 `BLOCKED_EXTERNAL`，不生成假截图。
4. 全门禁、独立复核、报告和提交：`fix(G10-T03): harden unicode paths and accessible layouts`。

## Task 4：G10-T04 冷启动、检索、导出性能与压力

**新增文件：**

- `apps/desktop/tests/performance/g10-fixture.ts`
- `apps/desktop/tests/performance/g10-core-bench.test.ts`
- `scripts/run-g10-performance.mjs`
- `reports/G10_PERFORMANCE_RAW.json`
- `reports/G10_COMPATIBILITY_MATRIX.md`

**修改：** 只修改由 profiling 证明的热点及其测试、`PROGRESS.md`、`HANDOFF.md`。

1. 固定种子创建 100 plans/5000 source segments 与约定成品，不含真实资料。
2. 先运行并保存基线；测量 SQLite open、计划打开、长短中文查询、五文件生成/一致性检查的每次原始毫秒值和 P50/P95。
3. 仅对已证明热点做有界优化；性能断言使用规范阈值，不删除离群样本。Node 指标标 `ENGINEERING_MEASUREMENT`，不冒充 Electron 冷启动。
4. 兼容矩阵分别列 Node/开发 Windows、真实 Electron、干净 Win11 8GB/SSD、Office/WPS；未执行项保持 `NOT_RUN/BLOCKED_EXTERNAL`。
5. 全门禁、独立复核、报告和提交：`perf(G10-T04): measure local startup search and export`。

## G10 最终复核

确认四包提交、`PROGRESS.md` / `HANDOFF.md`、冻结验收哈希、完整门禁和外部门分离。不得在没有签名身份、Windows 安装证据和授权分发位置时宣称 G10 正式升级通过或发行就绪。不得 merge、push 或创建 PR，除非用户另行明确授权。
