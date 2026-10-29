export interface FailureDiff {
  newFailures: string[];
  fixed: string[];
  common: string[];
}

/** One failure identity may be printed more than once when a host retries or concatenates a test run. */
export function collapseGateFailureAttempts(ids: readonly string[]): { failures: string[]; observed: number; collapsed: number } {
  const failures = [...new Set(ids)].sort();
  return { failures, observed: ids.length, collapsed: ids.length - failures.length };
}

export class GateFailureAttributionMismatch extends Error {
  constructor(readonly label: string, readonly summary: number, readonly observed: number,
    readonly identified: number, readonly collapsed: number, readonly failures: readonly string[]) {
    super(`${label} incomplete (failure attribution mismatch: summary=${summary}, observed=${observed}, identified=${identified})`);
    this.name = 'GateFailureAttributionMismatch';
  }
}

/** Bun's file header followed by `(fail) name` lines is the identity source. */
export function parseFailures(output: string): string[] {
  return [...new Set(parseFailureAttempts(output))].sort();
}

/** Raw reporter rows, retaining repeated identities so gate attribution can distinguish retries from missing names. */
export function parseFailureAttempts(output: string): string[] {
  const failures: string[] = [];
  let file: string | undefined;
  for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
    if (header) { file = header[1]; continue; }
    // Line-start only: a title/body `(fail)` is not a reporter row. Trailing CR is still a real Bun fail row.
    const failed = /^\(fail\)[ \t]+(.+?)(?:[ \t]+\[[\d.]+(?:ms|s)\])?[ \t]*\r?$/.exec(raw);
    if (failed && file) failures.push(`${file} > ${failed[1]!.trim()}`);
  }
  return failures;
}

/** GATE-INTRO-RECHECK (0.2.19) — the failures that are bun's «timed out» shape: a `(fail) name` line whose next line is
 *  `^ this test timed out after <n>ms.` An assertion failure prints its error above the `(fail)` line, never this. */
export function parseTimedOutFailures(output: string): string[] {
  const timedOut = new Set<string>();
  let file: string | undefined;
  let pending: string | undefined;
  for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (pending && /^\^ this test timed out after \d+(?:\.\d+)?ms\.?$/.test(line)) timedOut.add(pending);
    pending = undefined;
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
    if (header) { file = header[1]; continue; }
    const failed = /\(fail\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/.exec(line);
    if (failed && file) pending = `${file} > ${failed[1]!.trim()}`;
  }
  return [...timedOut].sort();
}

const xmlText = (value: string): string => value
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))).replace(/&amp;/g, '&');

/** Failed test names from a bun junit report, in the same `<file> > <describe> > <name>` shape as {@link parseFailures}.
 *  Used when the console summary counts a failure but prints no `(fail)` line for it (09-30 0.2.6 gate: `--dots`). */
export function junitFailures(xml: string): string[] {
  const failures = new Set<string>();
  const suites: string[] = [];
  let file: string | undefined;
  let open: string | undefined;
  for (const match of xml.matchAll(/<(\/?)(testsuite|testcase|failure)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = match;
    const attr = (name: string) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs!); return m ? xmlText(m[1]!) : undefined; };
    if (tag === 'testsuite') {
      if (closing) { suites.pop(); continue; }
      suites.push(attr('name') ?? '');
      if (suites.length === 1) file = attr('file') ?? attr('name');
    } else if (tag === 'testcase') {
      if (closing) { open = undefined; continue; }
      const name = [...suites.slice(1), attr('name') ?? ''].join(' > ');
      open = selfClosing ? undefined : `${attr('file') ?? file} > ${name}`;
    } else if (tag === 'failure' && !closing && open) {
      failures.add(open);
    }
  }
  return [...failures].sort();
}

export function diffFailures(cut: Iterable<string>, baseline: Iterable<string>): FailureDiff {
  const c = new Set(cut);
  const b = new Set(baseline);
  return {
    newFailures: [...c].filter((id) => !b.has(id)).sort(),
    fixed: [...b].filter((id) => !c.has(id)).sort(),
    common: [...c].filter((id) => b.has(id)).sort(),
  };
}
