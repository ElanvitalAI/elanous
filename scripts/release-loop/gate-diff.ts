export interface FailureDiff {
  newFailures: string[];
  fixed: string[];
  common: string[];
}

/** Bun's file header followed by `(fail) name` lines is the identity source. */
export function parseFailures(output: string): string[] {
  const failures = new Set<string>();
  let file: string | undefined;
  for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):(?:\s|$)/.exec(line);
    if (header) { file = header[1]; continue; }
    const failed = /\(fail\)\s+(.+?)(?:\s+\[[\d.]+(?:ms|s)\])?$/.exec(line);
    if (failed && file) failures.add(`${file} > ${failed[1]!.trim()}`);
  }
  return [...failures].sort();
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
