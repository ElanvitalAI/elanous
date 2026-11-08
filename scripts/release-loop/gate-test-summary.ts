// A test may spawn a nested `bun test` whose own summary lines land earlier in the same output
// (09-29 0.2.4 gate: «0 fail · Ran 2 tests across 1 file» at line 6765 of a 60064-test sweep) —
// the sweep's own summary is always the «last» one, so read the last match, never the first.
export const lastMatch = (output: string, pattern: RegExp): RegExpExecArray | null => {
  let last: RegExpExecArray | null = null;
  for (const m of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) last = m as RegExpExecArray;
  return last;
};
export const summaryCount = (output: string, label: string) => Number(lastMatch(output, new RegExp(`(?:^|\\n)\\s*(\\d+) ${label}s?\\s*(?=\\n|$)`))?.[1] ?? NaN);
/** Removes bun's own summary lines so one summary over several runs can follow (same rule as the sweep's merge). */
export const stripSummary = (output: string) => output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, '');
