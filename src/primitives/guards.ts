/** Shared guards for untrusted values at input boundaries. */
export type UnknownRecord = Record<string, unknown>;

export function isRecord<T extends UnknownRecord = UnknownRecord>(value: unknown): value is T {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isObject(value: unknown): value is UnknownRecord {
  return isRecord(value);
}

export type AsRecordOptions = {
  fallback?: 'null' | 'undefined' | 'empty';
  allowArrays?: boolean;
  clone?: boolean;
};

export function asRecord(value: unknown, options: AsRecordOptions & { fallback: 'undefined' }): UnknownRecord | undefined;
export function asRecord(value: unknown, options: AsRecordOptions & { fallback: 'empty' }): UnknownRecord;
export function asRecord(value: unknown, options?: AsRecordOptions & { fallback?: 'null' }): UnknownRecord | null;
export function asRecord(value: unknown, options: AsRecordOptions = {}): UnknownRecord | null | undefined {
  const valid = value !== null && typeof value === 'object' && (options.allowArrays === true || !Array.isArray(value));
  if (!valid) {
    if (options.fallback === 'undefined') return undefined;
    if (options.fallback === 'empty') return {};
    return null;
  }
  const record = value as UnknownRecord;
  return options.clone ? { ...record } : record;
}

export function isPlainObject(value: unknown, allowNullPrototype = true, excludeArrays = true): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || (excludeArrays && Array.isArray(value))) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || (allowNullPrototype && prototype === null);
}

export function isNonEmptyString(value: unknown, trim = true): value is string {
  return typeof value === 'string' && (trim ? value.trim().length > 0 : value.length > 0);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
