import { createHash } from 'node:crypto';
import type { LessonPlan } from '../lesson/types';
import type { GeneratedFile, MaterialSet } from '../materials/generate';
import { extractBuffer } from '../sources/extract';
import type { ReviewIssue } from './types';

const EXPECTED_FILES = ['presentation:pptx', 'student:docx', 'student:pdf', 'teacher:docx', 'teacher:pdf'] as const;

function fileKey(file: GeneratedFile): string {
  return `${file.role}:${file.format}`;
}

function issue(ruleId: string, objectIds: string[], message: string, evidence: string): ReviewIssue {
  const stable = createHash('sha256').update(`${ruleId}\0${objectIds.join('\0')}\0${evidence}`).digest('hex').slice(0, 16);
  return {
    issue_id: `issue_${stable}`,
    severity: 'blocking',
    rule_id: ruleId,
    object_ids: objectIds,
    message,
    evidence,
    return_module: 'M09',
    verification_type: 'deterministic',
    status: 'open'
  };
}

function meaningful(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function comparable(value: string): string {
  return value
    .split(String.fromCharCode(0))
    .join('')
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function includesContent(text: string, value: string): boolean {
  const target = comparable(value);
  return text.includes(value) || (target.length > 0 && comparable(text).includes(target));
}

function firstIncluded(text: string, values: string[]): string | undefined {
  return meaningful(values).find((value) => includesContent(text, value));
}

function privateStudentValues(plan: LessonPlan): string[] {
  return [
    plan.teacher_summary,
    ...plan.unknowns,
    ...plan.tasks.map((task) => task.teacher_notes),
    ...plan.activities.map((activity) => activity.teacher_action),
    ...plan.rubrics.flatMap((rubric) =>
      rubric.criteria.flatMap((criterion) => [...criterion.acceptable_variants, ...criterion.insufficient_examples])
    )
  ];
}

function privatePresentationValues(plan: LessonPlan): string[] {
  return [plan.teacher_summary, ...plan.unknowns, ...plan.activities.map((activity) => activity.teacher_action)];
}

function expectedTexts(plan: LessonPlan): { tasks: string[]; answers: string[] } {
  return {
    tasks: meaningful(plan.tasks.map((task) => task.prompt)),
    answers: meaningful(
      plan.rubrics.flatMap((rubric) =>
        rubric.criteria.flatMap((criterion) => [...criterion.acceptable_variants, ...criterion.insufficient_examples])
      )
    )
  };
}

/**
 * 对内存中的材料包做发布前确定性复核。这里验证可抽取内容、角色隔离、
 * 版本戳与摘要；它不声称验证 Office 渲染保真度或课堂效果。
 */
export async function reviewMaterialSet(plan: LessonPlan, set: MaterialSet): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const counts = new Map<string, number>();
  for (const file of set.files) counts.set(fileKey(file), (counts.get(fileKey(file)) ?? 0) + 1);
  const actualKeys = [...counts.keys()].sort();
  const expectedKeys = [...EXPECTED_FILES].sort();
  const exactShape =
    set.files.length === EXPECTED_FILES.length &&
    expectedKeys.every((key) => counts.get(key) === 1) &&
    actualKeys.every((key) => (EXPECTED_FILES as readonly string[]).includes(key));
  if (!exactShape) {
    issues.push(
      issue(
        'G07_BUNDLE_SHAPE',
        [set.revisionId],
        '材料包必须且只能包含三类五文件。',
        `expected=${expectedKeys.join(',')}; actual=${set.files.map(fileKey).sort().join(',')}`
      )
    );
  }

  if (set.planId !== plan.plan_id || set.revisionId !== plan.revision_id) {
    issues.push(
      issue(
        'G07_VERSION_STAMP',
        [plan.plan_id, plan.revision_id],
        '材料包元数据与待发布课时修订不一致。',
        `bundle=${set.planId}/${set.revisionId}; plan=${plan.plan_id}/${plan.revision_id}`
      )
    );
  }

  const parsed = new Map<GeneratedFile, string>();
  for (const file of set.files) {
    const digest = createHash('sha256').update(file.bytes).digest('hex');
    if (digest !== file.sha256) {
      issues.push(
        issue('G07_BUNDLE_SHA256', [file.filename], '文件摘要与实际字节不一致。', `declared=${file.sha256}; actual=${digest}`)
      );
    }
    try {
      const result = await extractBuffer(file.bytes, file.format);
      if (!result.reliableText || !result.fullText.trim()) {
        issues.push(issue('G07_BUNDLE_PARSE', [file.filename], '文件没有可用于发布复核的可靠文本。', `format=${file.format}`));
      } else {
        parsed.set(file, result.fullText);
      }
    } catch (error) {
      issues.push(
        issue(
          'G07_BUNDLE_PARSE',
          [file.filename],
          '文件无法在发布前重新解析。',
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  const { tasks, answers } = expectedTexts(plan);
  for (const [file, text] of parsed) {
    if (!text.includes(plan.plan_id) || !text.includes(plan.revision_id)) {
      issues.push(
        issue(
          'G07_VERSION_STAMP',
          [file.filename],
          '文件正文缺少当前 plan_id 或 revision_id。',
          `required=${plan.plan_id}/${plan.revision_id}`
        )
      );
    }

    if (file.role === 'student') {
      const leaked = firstIncluded(text, privateStudentValues(plan));
      if (leaked) {
        issues.push(
          issue('G07_STUDENT_ROLE_LEAK', [file.filename], '学生材料泄漏教师私密、答案或误区内容。', `matched=${leaked}`)
        );
      }
    }
    if (file.role === 'presentation') {
      const leaked = firstIncluded(text, privatePresentationValues(plan));
      if (leaked) {
        issues.push(
          issue('G07_PRESENTATION_ROLE_LEAK', [file.filename], '投屏课件泄漏仅供教师使用的内容。', `matched=${leaked}`)
        );
      }
    }

    if (file.role === 'student' || file.role === 'teacher' || file.role === 'presentation') {
      const missingTask = tasks.find((task) => !includesContent(text, task));
      if (missingTask) {
        issues.push(issue('G07_TASK_SYNC', [file.filename], '材料中的任务未与当前课时计划同步。', `missing=${missingTask}`));
      }
    }
    if (file.role === 'teacher' || file.role === 'presentation') {
      const missingAnswer = answers.find((answer) => !includesContent(text, answer));
      if (missingAnswer) {
        issues.push(issue('G07_ANSWER_SYNC', [file.filename], '教师答案或误区未与当前课时计划同步。', `missing=${missingAnswer}`));
      }
    }
  }

  return issues;
}
