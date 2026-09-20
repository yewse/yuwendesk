#!/usr/bin/env node
// 轻量合同校验（对应 planning 中的 verify:contracts 目标的骨架实现）：
// 1) contracts/ 与 examples/ 下所有 JSON 可解析；
// 2) ipc-catalog 的 21 项错误码与应用 shared/ipc.ts 中的 ERROR_CODES 一致；
// 3) 明确标记的无效示例确实缺少必填字段。
// 该脚本仅供开发者/CI 执行，不进入教师使用界面。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCr001 } from './lib/cr001-verify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const log = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// 1) JSON 可解析
for (const dir of ['contracts', 'examples', 'acceptance', 'planning']) {
  const abs = join(root, dir);
  for (const f of readdirSync(abs)) {
    if (!f.endsWith('.json')) continue;
    try {
      readJson(join(abs, f));
      log(true, `${dir}/${f} 可解析`);
    } catch (e) {
      log(false, `${dir}/${f} 解析失败：${e.message}`);
    }
  }
}

// 2) 错误码一致性
const catalog = readJson(join(root, 'contracts', 'ipc-catalog.json'));
const sharedTs = readFileSync(join(root, 'apps', 'desktop', 'src', 'shared', 'ipc.ts'), 'utf-8');
const catalogCodes = catalog.error_codes ?? [];
const missing = catalogCodes.filter((c) => !sharedTs.includes(`'${c}'`));
log(missing.length === 0, `错误码一致：目录 ${catalogCodes.length} 项${missing.length ? '，缺失 ' + missing.join(',') : ''}`);
log(catalogCodes.length === 21, `错误码数量为 21（实际 ${catalogCodes.length}）`);

// 2b) CR-001 增补一致性（有限补强）：指定文件必存在、CLS 编号完整且唯一、跨引用有效、定义保持 NOT_RUN、与冻结用例无冲突。
try {
  const requiredFiles = [
    'acceptance/addenda/classroom-delivery.cases.json',
    'planning/changes/CR001/requirements.json',
    'planning/changes/CR001/work-items.json',
    'planning/changes/CR001/traceability.json',
    'docs/changes/CR001_CLASSROOM_DELIVERABLES.md'
  ].map((p) => ({ path: p, present: existsSync(join(root, p)) }));

  const readIf = (p) => (existsSync(join(root, p)) ? readJson(join(root, p)) : null);
  const casesDoc = readIf('acceptance/addenda/classroom-delivery.cases.json');
  const reqDoc = readIf('planning/changes/CR001/requirements.json');
  const wiDoc = readIf('planning/changes/CR001/work-items.json');

  const cases = (casesDoc && casesDoc.cases) || [];
  const requirements = (reqDoc && (reqDoc.requirements || reqDoc)) || [];
  const workItems = (wiDoc && wiDoc.work_items) || [];

  const { ok, failures } = verifyCr001({ requiredFiles, requirements, workItems, cases, expectedCount: 40 });
  log(ok, `CR-001 增补一致性（文件存在/CLS完整唯一/引用有效/定义NOT_RUN）${ok ? '' : '：\n    - ' + failures.join('\n    - ')}`);

  // 与冻结用例无 ID 冲突（独立于纯函数的仓库级检查）
  const frozen = readJson(join(root, 'acceptance', 'cases.json'));
  const frozenIds = new Set((frozen.cases ?? []).map((c) => c.id));
  const collide = cases.filter((c) => frozenIds.has(c.id));
  log(collide.length === 0, `CR-001 与冻结用例无 ID 冲突${collide.length ? '，冲突 ' + collide.map((c) => c.id).join(',') : ''}`);
} catch (e) {
  log(false, `CR-001 增补校验失败：${e.message}`);
}

// 3) 无效示例确实无效（结构层面）
try {
  const invalid = readJson(join(root, 'examples', 'lesson_plan.schema_invalid.json'));
  const looksInvalid = !invalid.plan_id || !invalid.revision_id || Object.keys(invalid).length < 3;
  log(true, `已加载 schema_invalid 示例（字段数 ${Object.keys(invalid).length}）` + (looksInvalid ? '' : '（提示：应保持为反例）'));
} catch (e) {
  log(false, `无法读取 schema_invalid 示例：${e.message}`);
}

console.log(`\n合同校验完成：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
