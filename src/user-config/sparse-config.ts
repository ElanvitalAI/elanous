import { isObject } from '../primitives/guards.js';

const OMIT = Symbol('omit-config-default');

type ConfigObject = Record<string, unknown>;

function hasKey(value: unknown, key: string): value is ConfigObject {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

/** Remove generated values that equal defaults while retaining explicit raw keys. */
export function sparseUserConfig(
  value: unknown,
  defaults: unknown,
  explicit: unknown,
): unknown {
  const visit = (current: unknown, fallback: unknown, raw: unknown): unknown | typeof OMIT => {
    if (Array.isArray(current)) {
      if (Array.isArray(fallback) && sameValue(current, fallback) && raw === undefined) return OMIT;
      return current;
    }
    if (isObject(current)) {
      if (Object.keys(current).length === 0) {
        const defaultIsEmptyObject = isObject(fallback) && Object.keys(fallback).length === 0;
        return defaultIsEmptyObject && raw === undefined ? OMIT : current;
      }
      const fallbackObject = isObject(fallback) ? fallback : {};
      const out = Object.create(null) as ConfigObject;
      for (const [key, child] of Object.entries(current)) {
        const childRaw = hasKey(raw, key) ? raw[key] : undefined;
        const childFallback = hasKey(fallbackObject, key) ? fallbackObject[key] : undefined;
        const next = visit(child, childFallback, childRaw);
        if (next !== OMIT) out[key] = next;
      }
      return Object.keys(out).length > 0 ? out : OMIT;
    }
    if (fallback !== undefined && Object.is(current, fallback) && raw === undefined) return OMIT;
    return current;
  };
  const result = visit(value, defaults, explicit);
  return result === OMIT ? {} : result;
}
