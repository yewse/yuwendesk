export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extraKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const keys = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !keys.has(key))
    .map((key) => `extra:${key}`);
}

export function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}
