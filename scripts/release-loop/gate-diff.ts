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

export function diffFailures(cut: Iterable<string>, baseline: Iterable<string>): FailureDiff {
  const c = new Set(cut);
  const b = new Set(baseline);
  return {
    newFailures: [...c].filter((id) => !b.has(id)).sort(),
    fixed: [...b].filter((id) => !c.has(id)).sort(),
    common: [...c].filter((id) => b.has(id)).sort(),
  };
}
