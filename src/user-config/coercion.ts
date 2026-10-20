export function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function positiveIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function strArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : fallback;
}

export function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0 && typeof val === 'string' && val.length > 0) {
      out[k] = val;
    }
  }
  return out;
}

export function numArray(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}
