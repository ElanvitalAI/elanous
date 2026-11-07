export type ReleaseEventRecord = Readonly<Record<string, unknown>> & { readonly event: string };
export type ReleaseEventExpectation = ReleaseEventRecord | { readonly concurrent: readonly ReleaseEventRecord[] };

export interface ReleaseEventTraceCheck {
  pass: boolean;
  matched: number;
  missing: Array<{ expectationIndex: number; event: ReleaseEventRecord }>;
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => matchesSubset(actual[index], value));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    Object.hasOwn(actual, key) && matchesSubset((actual as Record<string, unknown>)[key], value));
}

function isConcurrent(item: ReleaseEventExpectation): item is { readonly concurrent: readonly ReleaseEventRecord[] } {
  return !Object.hasOwn(item, 'event');
}

/** Match declared event data as an ordered subsequence; only explicit concurrent groups relax member order. */
export function checkReleaseEventTrace(actual: readonly ReleaseEventRecord[], expected: readonly ReleaseEventExpectation[]): ReleaseEventTraceCheck {
  let cursor = 0;
  let matched = 0;
  const missing: ReleaseEventTraceCheck['missing'] = [];
  for (let expectationIndex = 0; expectationIndex < expected.length; expectationIndex++) {
    const item = expected[expectationIndex]!;
    if (isConcurrent(item)) {
      const candidates = item.concurrent.map((event) => actual.flatMap((candidate, index) =>
        index >= cursor && matchesSubset(candidate, event) ? [index] : []));
      const matchPrefix = (endExclusive: number) => {
        const eventByActual = new Map<number, number>();
        const available = candidates.map((indexes) => indexes.filter((index) => index < endExclusive));
        const order = item.concurrent.map((_, index) => index).sort((left, right) =>
          available[left]!.length - available[right]!.length);
        const assign = (eventIndex: number, seen: Set<number>): boolean => {
          for (const actualIndex of available[eventIndex]!) {
            if (seen.has(actualIndex)) continue;
            seen.add(actualIndex);
            const previous = eventByActual.get(actualIndex);
            if (previous === undefined || assign(previous, seen)) {
              eventByActual.set(actualIndex, eventIndex);
              return true;
            }
          }
          return false;
        };
        const assigned = new Set<number>();
        for (const eventIndex of order) if (assign(eventIndex, new Set())) assigned.add(eventIndex);
        return { eventByActual, assigned };
      };
      let selected = matchPrefix(actual.length);
      for (let endExclusive = cursor + 1; endExclusive <= actual.length; endExclusive++) {
        const candidate = matchPrefix(endExclusive);
        if (candidate.assigned.size === item.concurrent.length) {
          selected = candidate;
          break;
        }
      }
      const { eventByActual, assigned } = selected;
      let groupEnd = cursor;
      for (let eventIndex = 0; eventIndex < item.concurrent.length; eventIndex++) {
        if (!assigned.has(eventIndex)) missing.push({ expectationIndex, event: item.concurrent[eventIndex]! });
        else matched++;
      }
      for (const actualIndex of eventByActual.keys()) groupEnd = Math.max(groupEnd, actualIndex + 1);
      cursor = groupEnd;
      continue;
    }
    const found = actual.findIndex((candidate, index) => index >= cursor && matchesSubset(candidate, item));
    if (found < 0) missing.push({ expectationIndex, event: item });
    else { cursor = found + 1; matched++; }
  }
  return { pass: missing.length === 0, matched, missing };
}
