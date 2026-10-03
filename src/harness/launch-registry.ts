/** Host-wide run → process binding for `harness stop`, independent of the launching worktree and its universe.
 *  A run launched from another worktree writes `pid.json` and its ledger under that tree's state dir, so a stop from
 *  any other tree found «no pid.json · goal path 0» while the launcher was alive (10-03 · 09-29). The binding below lives
 *  in a per-user directory under the OS temp dir — it only has to outlive the process it names, not a reboot. */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';

export interface LaunchBinding {
  readonly pid: number;
  /** Same approximation as `pid.json` (`Date.now() − uptime`) — compared with `ps` start time before any signal. */
  readonly startedAt: number;
  readonly argv0?: string;
  /** The launching process's working directory (absolute). */
  readonly cwd: string;
  /** Absolute goal document path when the launcher was given one (`--goal-file`/`--ask`/`--goal`). */
  readonly goalPath?: string;
  /** The `self-dev-runs` directory that holds this run's `pid.json` — tells a stop which universe launched it. */
  readonly runsDir?: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** One directory per OS user: `$TMPDIR` is per-user on macOS, `/tmp` is shared on Linux. */
export function launchRegistryDir(): string {
  let uid: string;
  try { uid = String(userInfo().uid); } catch { uid = 'unknown'; }
  return join(tmpdir(), `elanous-harness-launches-${uid}`);
}

/** The goal document named in an argv, resolved against `cwd` — the same option set `harness stop` already matches. */
export function goalPathFromArgv(argv: readonly string[], cwd: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    for (const flag of ['--goal-file', '--ask', '--goal']) {
      if (arg === flag) value = argv[i + 1];
      else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
    }
    if (value?.trim()) return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  }
  return undefined;
}

export function writeLaunchBinding(runId: string, binding: LaunchBinding, dir = launchRegistryDir()): string | null {
  if (!RUN_ID.test(runId)) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${runId}.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(binding)); } finally { closeSync(fd); }
    renameSync(temporary, path);
    debug.log('harness.launch-registry', 'bound', { runId, pid: binding.pid, goalPath: binding.goalPath ?? null });
    return path;
  } catch (error) {
    debug.log('harness.launch-registry', 'bind-failed', { runId, error: String(error) }, { level: 'warn' });
    return null;
  }
}

export function readLaunchBinding(runId: string, dir = launchRegistryDir()): LaunchBinding | null {
  if (!RUN_ID.test(runId)) return null;
  try {
    const value = JSON.parse(readFileSync(join(dir, `${runId}.json`), 'utf8')) as Partial<LaunchBinding>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || !Number.isFinite(value.startedAt)) return null;
    if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return null;
    return {
      pid: value.pid as number, startedAt: value.startedAt as number, cwd: value.cwd,
      ...(typeof value.argv0 === 'string' ? { argv0: value.argv0 } : {}),
      ...(typeof value.goalPath === 'string' && isAbsolute(value.goalPath) ? { goalPath: value.goalPath } : {}),
      ...(typeof value.runsDir === 'string' && isAbsolute(value.runsDir) ? { runsDir: value.runsDir } : {}),
    };
  } catch { return null; }
}

export function removeLaunchBinding(runId: string, dir = launchRegistryDir()): void {
  if (!RUN_ID.test(runId)) return;
  try { unlinkSync(join(dir, `${runId}.json`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') debug.log('harness.launch-registry', 'unbind-failed', { runId, error: String(error) }, { level: 'warn' });
  }
}

/** Run IDs with a live-looking binding — used for stop's prefix resolution next to ledgers and `pid.json` names. */
export function launchBindingRunIds(dir = launchRegistryDir()): string[] {
  try { return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter((id) => RUN_ID.test(id)); }
  catch { return []; }
}
