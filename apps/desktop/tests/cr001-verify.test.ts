import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 复用根脚本的纯校验模块（供 verify:contracts 与本测试共用）。
// @ts-expect-error 纯 JS ESM 模块，无类型声明
import { verifyCr001, expectedClsIds } from '../../../scripts/lib/cr001-verify.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(repoRoot + p, 'utf8'));

interface Dataset {
  requiredFiles: { path: string; present: boolean }[];
  requirements: { id: string; acceptance_case_ids?: string[] }[];
  workItems: { id: string; requirements?: string[] }[];
  cases: { id: string; requirement_ids?: string[]; status?: string }[];
  expectedCount: number;
}

function makeValid(): Dataset {
  return {
    requiredFiles: [{ path: 'x', present: true }],
    requirements: [
      { id: 'CR001-R01', acceptance_case_ids: ['CLS-001'] },
      { id: 'CR001-R02', acceptance_case_ids: ['CLS-002'] }
    ],
    workItems: [{ id: 'CR001-W01', requirements: ['CR001-R01', 'CR001-R02'] }],
    cases: [
      { id: 'CLS-001', requirement_ids: ['CR001-R01'], status: 'NOT_RUN' },
      { id: 'CLS-002', requirement_ids: ['CR001-R02'], status: 'NOT_RUN' }
    ],
    expectedCount: 2
  };
}
const hasFailure = (failures: string[], sub: string) => failures.some((f) => f.includes(sub));

describe('verifyCr001 正例', () => {
  it('合法数据集通过', () => {
    const r = verifyCr001(makeValid());
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it('expectedClsIds 生成零填充完整集合', () => {
    const ids = expectedClsIds(40);
    expect(ids.length).toBe(40);
    expect(ids[0]).toBe('CLS-001');
    expect(ids[39]).toBe('CLS-040');
  });
});

describe('verifyCr001 失败测试（有限补强目标）', () => {
  it('增补文件缺失 → 失败', () => {
    const d = makeValid();
    d.requiredFiles = [{ path: 'acceptance/addenda/classroom-delivery.cases.json', present: false }];
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '缺少必需的增补文件')).toBe(true);
  });

  it('空案例数组 → 失败', () => {
    const d = makeValid();
    d.cases = [];
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '为空数组')).toBe(true);
  });

  it('编号缺项（不完整集合）→ 失败', () => {
    const d = makeValid();
    d.expectedCount = 3; // 期望 CLS-001..003，实际只有 001/002
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '缺失案例编号')).toBe(true);
    expect(hasFailure(r.failures, 'CLS-003')).toBe(true);
  });

  it('重复编号 → 失败', () => {
    const d = makeValid();
    d.cases = [
      { id: 'CLS-001', requirement_ids: ['CR001-R01'], status: 'NOT_RUN' },
      { id: 'CLS-001', requirement_ids: ['CR001-R02'], status: 'NOT_RUN' }
    ];
    d.expectedCount = 1;
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '重复案例编号')).toBe(true);
  });

  it('超出预期编号 → 失败', () => {
    const d = makeValid();
    d.cases.push({ id: 'CLS-099', requirement_ids: ['CR001-R01'], status: 'NOT_RUN' });
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '超出预期的案例编号')).toBe(true);
  });

  it('案例悬空引用需求 → 失败', () => {
    const d = makeValid();
    d.cases[1].requirement_ids = ['CR001-R99'];
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '悬空引用需求 CR001-R99')).toBe(true);
  });

  it('需求悬空引用案例 → 失败', () => {
    const d = makeValid();
    d.requirements[0].acceptance_case_ids = ['CLS-999'];
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '悬空引用案例 CLS-999')).toBe(true);
  });

  it('孤立需求（无案例引用）→ 失败', () => {
    const d = makeValid();
    d.requirements.push({ id: 'CR001-R03', acceptance_case_ids: [] });
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, 'CR001-R03 未被任何验收案例引用')).toBe(true);
  });

  it('工作项悬空引用需求 → 失败', () => {
    const d = makeValid();
    d.workItems[0].requirements = ['CR001-R99'];
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '工作项 CR001-W01 悬空引用需求 CR001-R99')).toBe(true);
  });

  it('定义状态非 NOT_RUN（不得以修改定义冒充执行）→ 失败', () => {
    const d = makeValid();
    d.cases[0].status = 'PASS';
    const r = verifyCr001(d);
    expect(r.ok).toBe(false);
    expect(hasFailure(r.failures, '必须为 NOT_RUN')).toBe(true);
  });
});

describe('verifyCr001 对仓库真实 CR-001 数据', () => {
  it('真实 requirements/work-items/cases 一致且全部 NOT_RUN', () => {
    const cases = readJson('acceptance/addenda/classroom-delivery.cases.json').cases;
    const requirements = readJson('planning/changes/CR001/requirements.json').requirements;
    const workItems = readJson('planning/changes/CR001/work-items.json').work_items;
    const requiredFiles = [
      { path: 'acceptance/addenda/classroom-delivery.cases.json', present: true },
      { path: 'planning/changes/CR001/requirements.json', present: true },
      { path: 'planning/changes/CR001/work-items.json', present: true }
    ];
    const r = verifyCr001({ requiredFiles, requirements, workItems, cases, expectedCount: 40 });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(cases.length).toBe(40);
    expect(cases.every((c: { status: string }) => c.status === 'NOT_RUN')).toBe(true);
  });
});
