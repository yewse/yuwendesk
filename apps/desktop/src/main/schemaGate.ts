// G02-T01 起步：声明式 IPC 载荷 Schema 门（受限 IPC + Schema 门，对应规范 9.1 结构校验）。
// 无第三方依赖的最小校验器；在 handle() 分发前对写操作的 payload 做统一结构校验，
// 拒绝类型错误、超长、缺字段与多余字段（additionalProperties:false）。结构合规不代表语义正确，
// 语义仍由各处理函数继续检查。

import type { OperationName } from '../shared/ipc';

export type FieldSchema =
  | { type: 'string'; maxLength?: number; minLength?: number; encoding?: 'base64' }
  | { type: 'integer'; min?: number; nonNegative?: boolean }
  | { type: 'boolean' }
  | { type: 'object' }
  // 浅校验数组：仅检查是否数组与条目上限；条目结构由处理函数进一步校验。
  | { type: 'array'; maxItems?: number }
  | { type: 'number'; min?: number; max?: number };

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required: string[];
  additionalProperties: false;
}

// null 表示该操作不接受 payload（若携带非空 payload 视为非法）。
export type PayloadSchema = ObjectSchema | null;

const DRAFT_CONTENT_MAX = 200_000;

// 已实现操作的载荷 Schema 门。读操作无 payload；写操作声明结构。
const PAYLOAD_SCHEMAS: Record<OperationName, PayloadSchema> = {
  'app.bootstrap': null,
  'app.health': null,
  'app.getStatus': null,
  'ui.loadDraft': null,
  'ui.saveDraft': {
    type: 'object',
    properties: { content: { type: 'string', maxLength: DRAFT_CONTENT_MAX } },
    required: ['content'],
    additionalProperties: false
  },
  'sources.import': {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      format: { type: 'string', maxLength: 16 },
      content: { type: 'string', maxLength: 6_000_000 },
      classification: { type: 'string', maxLength: 32 },
      relation: { type: 'string', maxLength: 16 },
      targetDocumentId: { type: 'string', maxLength: 64 }
    },
    required: ['title', 'format', 'content'],
    additionalProperties: false
  },
  'sources.importFile': {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      format: { type: 'string', maxLength: 16 },
      base64: { type: 'string', minLength: 1, maxLength: 60_000_000, encoding: 'base64' },
      classification: { type: 'string', maxLength: 32 },
      relation: { type: 'string', maxLength: 16 },
      targetDocumentId: { type: 'string', maxLength: 64 },
      jobId: { type: 'string', maxLength: 64 }
    },
    required: ['title', 'format', 'base64'],
    additionalProperties: false
  },
  'sources.cancelImport': {
    type: 'object',
    properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['jobId'],
    additionalProperties: false
  },
  'sources.list': null,
  'sources.search': {
    type: 'object',
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
    additionalProperties: false
  },
  'sources.read': {
    type: 'object',
    properties: {
      versionId: { type: 'string', minLength: 1, maxLength: 64 },
      charStart: { type: 'integer', nonNegative: true },
      charEnd: { type: 'integer', nonNegative: true }
    },
    required: ['versionId'],
    additionalProperties: false
  },
  'sources.retire': {
    type: 'object',
    properties: { documentId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['documentId'],
    additionalProperties: false
  },
  'sources.versions': {
    type: 'object',
    properties: { documentId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['documentId'],
    additionalProperties: false
  },
  'sources.readOriginal': {
    type: 'object',
    properties: { versionId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['versionId'],
    additionalProperties: false
  },
  'model.providers': null,
  'model.getConfig': null,
  'model.probe': null,
  'model.configure': {
    type: 'object',
    properties: {
      provider: { type: 'string', minLength: 1, maxLength: 32 },
      model: { type: 'string', maxLength: 64 },
      temperature: { type: 'number', min: 0, max: 2 },
      maxTokens: { type: 'integer', min: 1 },
      budgetCapCents: { type: 'integer', nonNegative: true },
      allowRealNetwork: { type: 'boolean' },
      apiKey: { type: 'string', maxLength: 400 }
    },
    required: ['provider'],
    additionalProperties: false
  },
  'model.run': {
    type: 'object',
    properties: {
      task: { type: 'string', minLength: 1, maxLength: 64 },
      instructionExtra: { type: 'string', maxLength: 2000 },
      fragments: { type: 'array', maxItems: 50 }
    },
    required: ['task'],
    additionalProperties: false
  },
  'model.cancel': {
    type: 'object',
    properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['jobId'],
    additionalProperties: false
  },
  'model.listJobs': {
    type: 'object',
    properties: { limit: { type: 'integer', min: 1 } },
    required: [],
    additionalProperties: false
  },
  'lesson.buildDemo': null,
  'lesson.list': null,
  'lesson.get': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['planId'],
    additionalProperties: false
  },
  'sources.reclassify': {
    type: 'object',
    properties: {
      documentId: { type: 'string', minLength: 1, maxLength: 64 },
      targetClassification: { type: 'string', minLength: 1, maxLength: 32 }
    },
    required: ['documentId', 'targetClassification'],
    additionalProperties: false
  },
  'sources.prepareDelete': {
    type: 'object',
    properties: { documentId: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['documentId'],
    additionalProperties: false
  },
  'sources.delete': {
    type: 'object',
    properties: {
      documentId: { type: 'string', minLength: 1, maxLength: 64 },
      confirmationToken: { type: 'string', minLength: 1, maxLength: 256 },
      managedBackupIds: { type: 'array', maxItems: 100 },
      policy: { type: 'string', minLength: 1, maxLength: 64 }
    },
    required: ['documentId', 'confirmationToken', 'managedBackupIds', 'policy'],
    additionalProperties: false
  },
  'plans.recordTeaching': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      planRevisionId: { type: 'string', minLength: 1, maxLength: 128 },
      taughtAt: { type: 'string', minLength: 1, maxLength: 64 },
      actualDurationSec: { type: 'integer', min: 60 },
      implementationState: { type: 'string', minLength: 1, maxLength: 16 },
      adjustmentSummary: { type: 'string', maxLength: 4000 }
    },
    required: ['planId', 'planRevisionId', 'taughtAt', 'actualDurationSec', 'implementationState', 'adjustmentSummary'],
    additionalProperties: false
  },
  'feedback.history': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['planId'],
    additionalProperties: false
  },
  'feedback.analyze': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      teachingEventId: { type: 'string', minLength: 1, maxLength: 128 },
      observationIds: { type: 'array', maxItems: 100 },
      dispatchConsent: { type: 'boolean' }
    },
    required: ['planId', 'teachingEventId', 'observationIds', 'dispatchConsent'],
    additionalProperties: false
  },
  'corrections.decide': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      proposalId: { type: 'string', minLength: 1, maxLength: 128 },
      decision: { type: 'string', minLength: 1, maxLength: 16 },
      reason: { type: 'string', minLength: 1, maxLength: 2000 },
      expectedProposalRevision: { type: 'integer', nonNegative: true },
      preference: { type: 'object' },
      effect: { type: 'object' }
    },
    required: ['planId', 'proposalId', 'decision', 'reason', 'expectedProposalRevision'],
    additionalProperties: false
  },
  'corrections.revert': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      proposalId: { type: 'string', minLength: 1, maxLength: 128 },
      reason: { type: 'string', minLength: 1, maxLength: 2000 },
      expectedProposalRevision: { type: 'integer', nonNegative: true }
    },
    required: ['planId', 'proposalId', 'reason', 'expectedProposalRevision'],
    additionalProperties: false
  },
  'observations.add': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      planRevisionId: { type: 'string', minLength: 1, maxLength: 128 },
      teachingEventId: { type: 'string', minLength: 1, maxLength: 128 },
      taskId: { type: 'string', minLength: 1, maxLength: 128 },
      sourceKind: { type: 'string', minLength: 1, maxLength: 32 },
      observedAt: { type: 'string', minLength: 1, maxLength: 64 },
      outcome: { type: 'string', minLength: 1, maxLength: 32 },
      supportLevel: { type: 'string', minLength: 1, maxLength: 32 },
      materialRelation: { type: 'string', minLength: 1, maxLength: 32 },
      delayDays: { type: 'integer', nonNegative: true },
      sampleCount: { type: 'integer', nonNegative: true },
      populationCount: { type: 'integer', nonNegative: true },
      selection: { type: 'string', minLength: 1, maxLength: 32 },
      coverageCaveat: { type: 'string', minLength: 1, maxLength: 4000 },
      summary: { type: 'string', maxLength: 4000 }
    },
    required: [
      'planId', 'planRevisionId', 'teachingEventId', 'taskId', 'sourceKind', 'observedAt', 'outcome',
      'supportLevel', 'materialRelation', 'delayDays', 'sampleCount', 'populationCount', 'selection',
      'coverageCaveat', 'summary'
    ],
    additionalProperties: false
  },
  'observations.list': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['planId'],
    additionalProperties: false
  },
  'observations.prepareDelete': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      observationId: { type: 'string', minLength: 1, maxLength: 128 }
    },
    required: ['planId', 'observationId'],
    additionalProperties: false
  },
  'observations.delete': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 128 },
      observationId: { type: 'string', minLength: 1, maxLength: 128 },
      confirmationToken: { type: 'string', minLength: 1, maxLength: 256 }
    },
    required: ['planId', 'observationId', 'confirmationToken'],
    additionalProperties: false
  },
  'review.run': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 80 },
      revisionId: { type: 'string', minLength: 1, maxLength: 80 }
    },
    required: ['planId'],
    additionalProperties: false
  },
  'change.preview': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 80 },
      baseRevisionId: { type: 'string', minLength: 1, maxLength: 80 },
      change: { type: 'object' }
    },
    required: ['planId', 'baseRevisionId', 'change'],
    additionalProperties: false
  },
  'change.apply': {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, maxLength: 80 },
      baseRevisionId: { type: 'string', minLength: 1, maxLength: 80 },
      change: { type: 'object' }
    },
    required: ['planId', 'baseRevisionId', 'change'],
    additionalProperties: false
  },
  'change.history': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['planId'],
    additionalProperties: false
  },
  'materials.generate': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['planId'],
    additionalProperties: false
  },
  'materials.list': {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['planId'],
    additionalProperties: false
  },
  'backup.create': {
    type: 'object',
    properties: {
      mode: { type: 'string', minLength: 1, maxLength: 16 },
      passphrase: { type: 'string', maxLength: 1024 }
    },
    required: ['mode'],
    additionalProperties: false
  },
  'backup.restore': {
    type: 'object',
    properties: {
      action: { type: 'string', minLength: 1, maxLength: 32 },
      passphrase: { type: 'string', maxLength: 1024 },
      restoreJobId: { type: 'string', maxLength: 128 },
      previewHash: { type: 'string', maxLength: 64 },
      confirmationToken: { type: 'string', maxLength: 256 }
    },
    required: ['action'],
    additionalProperties: false
  },
  'backups.list': null,
  'backups.delete': {
    type: 'object',
    properties: {
      action: { type: 'string', minLength: 1, maxLength: 16 },
      backupId: { type: 'string', minLength: 1, maxLength: 128 },
      confirmationToken: { type: 'string', maxLength: 256 }
    },
    required: ['action', 'backupId'],
    additionalProperties: false
  },
  'diagnostics.export': {
    type: 'object',
    properties: {
      action: { type: 'string', minLength: 1, maxLength: 16 },
      previewHash: { type: 'string', maxLength: 64 }
    },
    required: ['action'],
    additionalProperties: false
  }
};

export function getPayloadSchema(op: OperationName): PayloadSchema {
  return PAYLOAD_SCHEMAS[op] ?? null;
}

function validateField(name: string, schema: FieldSchema, value: unknown, errors: string[]): void {
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`字段 ${name} 应为字符串`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`字段 ${name} 过短`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`字段 ${name} 过长`);
    if (schema.encoding === 'base64' &&
        (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))) {
      errors.push(`字段 ${name} 编码无效`);
    }
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      errors.push(`字段 ${name} 应为整数`);
      return;
    }
    if (schema.nonNegative && value < 0) errors.push(`字段 ${name} 不可为负`);
    if (schema.min !== undefined && value < schema.min) errors.push(`字段 ${name} 小于下限`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`字段 ${name} 应为布尔值`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`字段 ${name} 应为数值`);
      return;
    }
    if (schema.min !== undefined && value < schema.min) errors.push(`字段 ${name} 小于下限`);
    if (schema.max !== undefined && value > schema.max) errors.push(`字段 ${name} 大于上限`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`字段 ${name} 应为数组`);
      return;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`字段 ${name} 条目过多`);
  } else if (schema.type === 'object') {
    if (!isPlainRecord(value)) errors.push(`字段 ${name} 应为普通对象`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface SchemaCheckResult {
  ok: boolean;
  errors: string[];
}

// 校验某操作的 payload 是否符合其 Schema 门。
export function checkPayload(op: OperationName, payload: unknown): SchemaCheckResult {
  const schema = getPayloadSchema(op);
  const errors: string[] = [];
  if (schema === null) {
    // 无 payload 操作：允许缺省/undefined；携带非空对象视为非法（避免夹带未预期字段）。
    if (payload !== undefined && payload !== null) {
      if (!isPlainRecord(payload) || Object.keys(payload).length > 0) {
        errors.push(`操作 ${op} 不接受载荷`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  if (!isPlainRecord(payload)) {
    errors.push(`操作 ${op} 需要对象载荷`);
    return { ok: false, errors };
  }
  const obj = payload as Record<string, unknown>;
  // 用 hasOwnProperty 判断，避免 `in` 命中原型链导致 constructor/toString/__proto__ 等继承属性误判为已声明字段。
  const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  for (const key of Object.keys(obj)) {
    if (!hasOwn(schema.properties, key)) errors.push(`不允许的字段 ${key}`);
  }
  for (const req of schema.required) {
    // 必填字段须存在且非 undefined（显式 undefined 视为缺失）。
    if (!hasOwn(obj, req) || obj[req] === undefined) errors.push(`缺少必填字段 ${req}`);
  }
  for (const [key, fieldSchema] of Object.entries(schema.properties)) {
    // 可选字段值为 undefined 时视为未提供，跳过校验（便于渲染层传可选参数）。
    if (hasOwn(obj, key) && obj[key] !== undefined) validateField(key, fieldSchema, obj[key], errors);
  }
  return { ok: errors.length === 0, errors };
}
