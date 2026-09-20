// CR-001 增补一致性校验（纯函数，便于单元测试）。
// 不修改冻结验收定义；仅校验"定义"的完整性与引用有效性。执行结果另存（见 reports/acceptance-runs/）。

// 预期的 CLS 编号完整集合：CLS-001 .. CLS-0NN。
export function expectedClsIds(count = 40) {
  return Array.from({ length: count }, (_, i) => `CLS-${String(i + 1).padStart(3, '0')}`);
}

/**
 * @param {object} p
 * @param {{path:string, present:boolean}[]} [p.requiredFiles] 指定增补文件及其是否存在
 * @param {{id:string, acceptance_case_ids?:string[]}[]} [p.requirements]
 * @param {{id:string, requirements?:string[]}[]} [p.workItems]
 * @param {{id:string, requirement_ids?:string[], status?:string}[]} [p.cases]
 * @param {number} [p.expectedCount]
 * @returns {{ ok:boolean, failures:string[] }}
 */
export function verifyCr001({ requiredFiles = [], requirements = [], workItems = [], cases = [], expectedCount = 40 } = {}) {
  const failures = [];

  // 1) 指定增补文件必须存在
  for (const f of requiredFiles) {
    if (!f || !f.present) failures.push(`缺少必需的增补文件：${f ? f.path : '(未命名)'}`);
  }

  // 2) 验收案例非空
  if (!Array.isArray(cases) || cases.length === 0) {
    failures.push('验收案例为空数组或缺失');
    return { ok: false, failures };
  }

  const caseIds = cases.map((c) => c.id);
  const caseIdSet = new Set(caseIds);

  // 3) 编号唯一（无重复）
  const seen = new Set();
  const dups = new Set();
  for (const id of caseIds) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  if (dups.size) failures.push(`重复案例编号：${[...dups].sort().join(',')}`);

  // 4) 编号集合完整（CLS-001..CLS-0NN 无缺项、无超出）
  const expected = expectedClsIds(expectedCount);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !caseIdSet.has(id));
  if (missing.length) failures.push(`缺失案例编号：${missing.join(',')}`);
  const extra = [...caseIdSet].filter((id) => !expectedSet.has(id));
  if (extra.length) failures.push(`超出预期的案例编号：${extra.sort().join(',')}`);

  // 5) 定义状态必须保持 NOT_RUN（不得用修改定义冒充执行）
  const nonNotRun = cases.filter((c) => c.status !== 'NOT_RUN');
  if (nonNotRun.length) {
    failures.push(`验收定义状态必须为 NOT_RUN；异常：${nonNotRun.map((c) => `${c.id}:${c.status}`).join(',')}`);
  }

  const reqIds = new Set(requirements.map((r) => r.id));

  // 6) 案例 → 需求 引用有效（无悬空）
  for (const c of cases) {
    for (const rid of c.requirement_ids ?? []) {
      if (!reqIds.has(rid)) failures.push(`案例 ${c.id} 悬空引用需求 ${rid}`);
    }
  }

  // 7) 需求.acceptance_case_ids → 案例 引用有效（无悬空）
  for (const r of requirements) {
    for (const cid of r.acceptance_case_ids ?? []) {
      if (!caseIdSet.has(cid)) failures.push(`需求 ${r.id} 悬空引用案例 ${cid}`);
    }
  }

  // 8) 每条需求至少被一个案例引用（无孤立需求）
  const referenced = new Set();
  for (const c of cases) for (const rid of c.requirement_ids ?? []) referenced.add(rid);
  for (const r of requirements) {
    if (!referenced.has(r.id)) failures.push(`需求 ${r.id} 未被任何验收案例引用`);
  }

  // 9) 工作项 → 需求 引用有效（无悬空）
  for (const w of workItems) {
    for (const rid of w.requirements ?? []) {
      if (!reqIds.has(rid)) failures.push(`工作项 ${w.id} 悬空引用需求 ${rid}`);
    }
  }

  return { ok: failures.length === 0, failures };
}
