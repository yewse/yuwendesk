// G02-T01 起步：声明式 IPC 载荷 Schema 门（受限 IPC + Schema 门，对应规范 9.1 结构校验）。
// 无第三方依赖的最小校验器；在 handle() 分发前对写操作的 payload 做统一结构校验，
// 拒绝类型错误、超长、缺字段与多余字段（additionalProperties:false）。结构合规不代表语义正确，
// 语义仍由各处理函数继续检查。

import type { OperationName } from '../shared/ipc';

export type FieldSchema =
  | { type: 'string'; maxLength?: number; minLength?: number }
  | { type: 'integer'; min?: number; nonNegative?: boolean }
  | { type: 'boolean' };

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
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      errors.push(`字段 ${name} 应为整数`);
      return;
    }
    if (schema.nonNegative && value < 0) errors.push(`字段 ${name} 不可为负`);
    if (schema.min !== undefined && value < schema.min) errors.push(`字段 ${name} 小于下限`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`字段 ${name} 应为布尔值`);
  }
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
      if (typeof payload !== 'object' || Object.keys(payload as object).length > 0) {
        errors.push(`操作 ${op} 不接受载荷`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
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
    if (!hasOwn(obj, req)) errors.push(`缺少必填字段 ${req}`);
  }
  for (const [key, fieldSchema] of Object.entries(schema.properties)) {
    if (hasOwn(obj, key)) validateField(key, fieldSchema, obj[key], errors);
  }
  return { ok: errors.length === 0, errors };
}
