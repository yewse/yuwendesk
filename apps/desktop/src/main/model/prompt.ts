// 提示词工程作为正式产品能力：稳定原则 + 任务模板 + 必要上下文 + 学科方法 + 代表性正反例 + 输出合同。
// 教师不负责编写或调试提示词；此处为产品内置、可版本化的组合。
import type { Citation } from './types';
import { validateTeachingAttributionModelOutput } from '../feedback/attribution';
import { parseModelLessonPlanSpec } from '../preparation/modelSpec';

// 提示词版本：随原则/模板/示例/合同变化递增，用于结果持久化与基线对照。
export const PROMPT_VERSION = 'yuwen-prompt-1.2.0';

// 稳定原则：允许主动分析、联结与教学创造；精确事实/引文/版本以提供材料或明确标注不确定为准，不编造出处。
const PRINCIPLES = [
  '你是面向中国中小学语文教师的备课助手。',
  '可主动进行文本分析、候选联结与教学创造；但具体版本、引文、史实与本班事实须依据所提供的材料，或明确标注“需教师核实”，不得编造出处或引文。',
  '只使用下方“获准材料片段”作为原文依据；不得臆造未提供的原文。',
  '输出必须是严格符合“输出合同”的 JSON，不要输出多余文本。'
].join('\n');

// 学科方法提示（语文）。
const SUBJECT_METHOD = ['语文学科方法：关注主旨与情感、结构与线索、语言与修辞、朗读与停连、任务与活动设计。'].join('\n');

// 任务模板 + 输出合同。
interface TaskTemplate {
  id: string;
  instruction: string;
  outputContract: string;
  contractShape: string;
  // 代表性正反例（简）。
  goodExample: string;
  badExample: string;
}
const TASKS: Record<string, TaskTemplate> = {
  analyze_text: {
    id: 'analyze_text',
    instruction: '基于获准片段，分析课文的主旨、结构与主要修辞，并给出可操作的教学建议；对每条依据标注引用序号。',
    outputContract: 'analyze_text.v1',
    contractShape: '{"summary":string,"structure":string[],"rhetoric":string[],"teaching_suggestions":string[],"citations":number[]}',
    goodExample: '正例：主旨简明；修辞点明“比喻/拟人”并引用具体句子的引用序号。',
    badExample: '反例：凭空断言作者生平或版本，未引用且无“需核实”标注。'
  },
  lesson_outline: {
    id: 'lesson_outline',
    instruction: '基于获准片段，设计一课时的教学环节与时间分配，标注每步所依据的引用序号；不确定处标注“需教师核实”。',
    outputContract: 'lesson_outline.v1',
    contractShape: '{"objectives":string[],"steps":[{"stage":string,"minutes":number,"activity":string,"citations":number[]}],"notes":string[]}',
    goodExample: '正例：环节含朗读/研读/活动，时间合理，引用到具体片段。',
    badExample: '反例：照搬检索片段拼接，无教学结构与时间安排。'
  },
  lesson_plan_spec: {
    id: 'lesson_plan_spec',
    instruction: '根据固定教学上下文和获准材料片段生成一课时结构。anchor_ids 只能使用 source-1、source-2 等本次片段编号；答案范围必须写入 acceptable_variants；不确定事实写入 unknowns。',
    outputContract: 'lesson_plan_spec.v1',
    contractShape: '{"title":string,"objectives":[{"description":string,"cognitive_demand":"recall|understand|summarize|explain|compare|evaluate|create|communicate|aesthetic_response"}],"tasks":[{"prompt":string,"cognitive_demand":string,"support_level":"full_model|partial_prompt|independent","teacher_notes":string,"acceptable_variants":string[],"insufficient_examples":string[],"anchor_ids":["source-1"]}],"activities":[{"title":string,"start_sec":integer,"end_sec":integer,"actor":"teacher|student|both","student_action":string,"teacher_action":string,"priority":"essential|compressible|optional","task_indexes":[0]}],"teacher_summary":string,"unknowns":string[]}',
    goodExample: '正例：每个任务只引用本次 source-N，时间不越过课时，答案范围明确，不确定项写入 unknowns。',
    badExample: '反例：输出文件路径、脚本、工具调用、未提供的原文或本次材料以外的 anchor_id。'
  },
  teaching_attribution: {
    id: 'teaching_attribution',
    instruction: '只依据产品提供的去身份化结构字段提出多个待验证教学假设。不得声称教学有效，不得给出全班比例、排名、永久学生标签、人格/智力/家庭归因或因果保证；每条必须写限制、可反证证据和退回模块。',
    outputContract: 'teaching_attribution.v1',
    contractShape: '{"hypotheses":[{"kind":"prerequisite_gap|support_mismatch|activity_mismatch|retention_gap|expression_gap|time_constraint","summary":string,"observation_ids":string[],"evidence_basis":string[],"limitations":string[],"disconfirming_evidence":string[],"return_modules":["M07|M08|M11|M12"]}],"is_effectiveness_proof":false}',
    goodExample: '正例：以“待验证/可能”表述，逐条关联观察 ID，明确样本限制和撤回条件。',
    badExample: '反例：声称“全班 60% 未掌握”、把表现归因于懒惰/智力/家庭，或断言教学已经有效。'
  }
};

export function isKnownTask(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TASKS, id);
}
export function taskContract(id: string): string | null {
  return TASKS[id]?.outputContract ?? null;
}

export type ContractCheck = { ok: true; parsed: unknown } | { ok: false; reason: string };

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function citationsInRange(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= n);
}

// 真实输出合同校验（供真实模型与测试替身共同遵守）：非法 JSON/缺字段/类型错误/越界引用一律判不合格。
// citationCount = 提供给模型的获准引用数（引用序号须落在 1..citationCount）。
export function validateContract(outputContract: string, text: string, citationCount: number, allowedObservationIds: string[] = []): ContractCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' }; // 含被截断的 JSON
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'not_object' };
  const o = parsed as Record<string, unknown>;
  if (outputContract === 'analyze_text.v1') {
    if (typeof o.summary !== 'string') return { ok: false, reason: 'missing_summary' };
    if (!isStringArray(o.structure)) return { ok: false, reason: 'bad_structure' };
    if (!isStringArray(o.rhetoric)) return { ok: false, reason: 'bad_rhetoric' };
    if (!isStringArray(o.teaching_suggestions)) return { ok: false, reason: 'bad_suggestions' };
    if (!citationsInRange(o.citations, citationCount)) return { ok: false, reason: 'citation_out_of_range' };
    return { ok: true, parsed };
  }
  if (outputContract === 'lesson_outline.v1') {
    if (!isStringArray(o.objectives)) return { ok: false, reason: 'bad_objectives' };
    if (!Array.isArray(o.steps) || o.steps.length === 0) return { ok: false, reason: 'bad_steps' };
    for (const st of o.steps as Record<string, unknown>[]) {
      if (typeof st.stage !== 'string' || typeof st.minutes !== 'number' || typeof st.activity !== 'string') return { ok: false, reason: 'bad_step_shape' };
      if (!citationsInRange(st.citations, citationCount)) return { ok: false, reason: 'citation_out_of_range' };
    }
    return { ok: true, parsed };
  }
  if (outputContract === 'lesson_plan_spec.v1') {
    try {
      parseModelLessonPlanSpec(
        parsed,
        Array.from({ length: citationCount }, (_item, index) => ({
          id: `source-${index + 1}`,
          anchor: {
            source_version_id: `contract-version-${index + 1}`,
            locator: { citation: index + 1 },
            quote: `contract-citation-${index + 1}`,
            source_class: 'teacher_private' as const,
            verification: 'exact_checked' as const
          }
        })),
        { taskContextId: 'contract-context', declaredDurationSec: 14_400 }
      );
      return { ok: true, parsed };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'PREPARATION_MODEL_INVALID' };
    }
  }
  if (outputContract === 'teaching_attribution.v1') {
    const errors = validateTeachingAttributionModelOutput(parsed, allowedObservationIds);
    return errors.length ? { ok: false, reason: errors.join('|') } : { ok: true, parsed };
  }
  return { ok: false, reason: 'unknown_contract' };
}

export interface AssembledPrompt {
  system: string;
  user: string;
  outputContract: string;
  promptVersion: string;
}

// 组装提示词：原则 + 学科方法（system）；任务指令 + 正反例 + 获准片段（编号引用）+ 输出合同（user）。
export function assemblePrompt(taskId: string, instructionExtra: string, citations: Citation[]): AssembledPrompt {
  const t = TASKS[taskId];
  if (!t) throw new Error('unknown_task');
  const system = [PRINCIPLES, SUBJECT_METHOD].join('\n\n');
  const fragments = citations
    .map((c, i) => `【引用${i + 1}】《${c.title}》v${c.version} ${c.locatorLabel}：${c.excerpt}`)
    .join('\n');
  const user = [
    `任务：${t.instruction}`,
    instructionExtra ? `补充要求：${instructionExtra}` : '',
    `示例（仅示范风格，不作为内容）：\n${t.goodExample}\n${t.badExample}`,
    citations.length ? `获准材料片段（仅可依据以下内容作为原文）：\n${fragments}` : '（无获准片段：仅可做一般性分析并标注“需教师核实/需材料”）',
    `输出合同 ${t.outputContract}：请仅返回符合以下结构的 JSON：\n${t.contractShape}`
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user, outputContract: t.outputContract, promptVersion: PROMPT_VERSION };
}
