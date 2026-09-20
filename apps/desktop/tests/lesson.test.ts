import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec, validateLessonPlan, type LessonPlanSpec } from '../src/main/lesson/build';

describe('G05 校验严格化：不把缺失/错误/未知当作已验证', () => {
  it('无效锚点引用不被静默删除 → 校验报错 task_anchor_missing', () => {
    const spec = demoLessonSpec();
    spec.tasks[0].anchorIndexes = [9]; // 不存在的锚点
    const plan = buildLessonPlan(spec);
    // 引用被保留（未静默过滤）
    expect(plan.tasks[0].material_anchor_ids).toContain('anc_9');
    const v = validateLessonPlan(plan);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith('task_anchor_missing'))).toBe(true);
  });

  it('无课程依据 → coverage_state=needs_source_confirmation（不标 mapped）；有依据 → mapped', () => {
    const plan = buildLessonPlan(demoLessonSpec());
    expect(plan.objectives.every((o) => o.coverage_state === 'needs_source_confirmation')).toBe(true);
    const withRefs = demoLessonSpec();
    withRefs.objectives[0].curriculum_ref_ids = ['CURR-7-1'];
    const plan2 = buildLessonPlan(withRefs);
    expect(plan2.objectives[0].coverage_state).toBe('mapped');
    expect(validateLessonPlan(plan2).ok).toBe(true);
  });

  it('活动超出声明课时 → 拦截 activity_overtime', () => {
    const spec: LessonPlanSpec = demoLessonSpec({ declared_duration_sec: 600 });
    const plan = buildLessonPlan(spec); // 活动排到 2640s > 600s
    const v = validateLessonPlan(plan);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith('activity_overtime'))).toBe(true);
  });

  it('大段欠时且未解释 → 告警 schedule_underfilled（不拦截）', () => {
    const spec = demoLessonSpec();
    spec.activities = [{ title: '仅导入', start_sec: 0, end_sec: 300, actor: 'both', student_action: '齐读', teacher_action: '范读', priority: 'essential', taskIndexes: [1] }];
    const plan = buildLessonPlan(spec);
    const v = validateLessonPlan(plan);
    expect(v.ok).toBe(true); // 欠时不拦截
    expect(v.warnings.some((x) => x.startsWith('schedule_underfilled'))).toBe(true);
  });

  it('示例计划：活动覆盖声明课时，无欠时告警', () => {
    const v = validateLessonPlan(buildLessonPlan(demoLessonSpec()));
    expect(v.ok).toBe(true);
    expect(v.warnings.some((x) => x.startsWith('schedule_underfilled'))).toBe(false);
  });

  it('无效活动 task 引用 → 报错 activity_task_missing', () => {
    const spec = demoLessonSpec();
    spec.activities[0].taskIndexes = [7];
    const v = validateLessonPlan(buildLessonPlan(spec));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.startsWith('activity_task_missing'))).toBe(true);
  });
});
