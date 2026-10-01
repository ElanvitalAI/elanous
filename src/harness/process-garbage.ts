export interface GarbageProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly elapsedSeconds: number;
  readonly command: string;
  readonly launchd?: 'managed' | 'no-evidence' | 'unqueried';
}

export interface GarbageProcess extends Pick<GarbageProcessRow, 'pid' | 'ppid' | 'elapsedSeconds' | 'command'> {
  readonly reason: 'orphan-test-daemon' | 'orphan-test-runner' | 'orphan-elanous';
}

const TEST_PATH = /elanous|repo\.worktrees|self-impl|\.elanous-test|gate-baseline/i;
const TEST_DAEMON = /(?:^|[\s/])daemon\.ts(?:\s|$)/;
const TEST_RUNNER = /\bbun\s+test\b|\bgate(?:[-\s]baseline|\b)/i;
const NEXUS_RUN = /\bnexus\s+run\b/;
const TEST_MARKER = /\.elanous-test|(?:^|\s)--test(?:\s|$)/;

/** A candidate for inspection only; this module never signals or removes a process. */
export function isGarbageProcessTarget(command: string): boolean {
  return command.includes('elanous.mjs')
    || (TEST_DAEMON.test(command) && /elanous-nexus-|\.elanous-test/.test(command))
    || (TEST_RUNNER.test(command) && TEST_PATH.test(command));
}

export function classifyGarbage(
  rows: readonly GarbageProcessRow[],
  options: { nowMs?: number; minOrphanSeconds?: number } = {},
): { garbage: GarbageProcess[] } {
  const minOrphanSeconds = options.minOrphanSeconds ?? 3 * 60 * 60;
  const garbage: GarbageProcess[] = [];
  for (const row of rows) {
    if (row.ppid !== 1 || row.elapsedSeconds < minOrphanSeconds || row.launchd === 'managed') continue;
    if (!isGarbageProcessTarget(row.command)) continue;
    if (NEXUS_RUN.test(row.command) && !TEST_MARKER.test(row.command)) continue;
    const reason: GarbageProcess['reason'] = TEST_DAEMON.test(row.command)
      && /elanous-nexus-|\.elanous-test/.test(row.command)
      ? 'orphan-test-daemon'
      : TEST_RUNNER.test(row.command) && TEST_PATH.test(row.command)
        ? 'orphan-test-runner'
        : 'orphan-elanous';
    garbage.push({ pid: row.pid, ppid: row.ppid, elapsedSeconds: row.elapsedSeconds, command: row.command, reason });
  }
  return { garbage };
}
