// KILL-TREE-ONE (WORKER-UNIFY §6-4 / §7) — one shared "kill this process tree" routine.
//
// Contract: kill ONLY the exact process group (or exact pid) the caller spawned.
//   - never a pattern, never pid <= 1, never a group the caller did not create:
//     `group: true` is valid only for a child spawned with `detached: true`
//     (it is its own group leader, so -pid is exactly its tree).
//   - SIGTERM → wait up to graceMs for the target to disappear → SIGKILL if still alive.
//     `firstSignal: 'SIGKILL'` skips the grace and kills the whole group at once.
//   - After SIGKILL we wait up to killWaitMs for the target to disappear; `terminated: true`
//     is returned ONLY when an existence probe (kill(addr,0)) confirmed it is gone.
//   - Windows (and a missing/unsafe pid): there is no process-group addressing and no
//     existence probe here — only child.kill() on the root runs, descendants are NOT
//     reached and the result cannot confirm death (terminated stays false). Unmeasured on
//     Windows in this repo; treat as a known limit.
//   - already dead (ESRCH) is success; EPERM is reported in `errors`, never thrown.
import type { ChildProcess } from 'node:child_process';

export const TERMINATE_TREE_GRACE_MS = 2_000;
export const TERMINATE_TREE_KILL_WAIT_MS = 1_000;
const POLL_MS = 25;

export interface TerminateTreeTarget {
  readonly pid?: number | undefined;
  /** Fallback single-process kill (used when no usable pid, e.g. a fake child). */
  kill?: ChildProcess['kill'];
}

export interface TerminateTreeOptions {
  /** true = the child is its own process-group leader (spawned `detached: true`). */
  readonly group: boolean;
  readonly graceMs?: number;
  /** Signal sent first. Default SIGTERM (grace then SIGKILL); SIGKILL = kill the group at once. */
  readonly firstSignal?: 'SIGTERM' | 'SIGKILL';
  /** How long to wait for existence-probe confirmation after SIGKILL. */
  readonly killWaitMs?: number;
  /**
   * With `group: true`: when the group address is gone (ESRCH) retry the exact pid itself, for callers
   * that cannot prove the target is a group leader (e.g. a pid found by pgrep). Same pid, never a pattern.
   */
  readonly pidFallback?: boolean;
  /** Injection seam for tests; defaults to process.kill. */
  readonly sendSignal?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export interface TerminateTreeResult {
  /** The target is gone (or was already gone) when we returned. */
  terminated: boolean;
  /** SIGKILL was needed. */
  escalated: boolean;
  errors: string[];
}

function isSafePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function terminateTree(
  target: TerminateTreeTarget,
  opts: TerminateTreeOptions,
): Promise<TerminateTreeResult> {
  const rawSend = opts.sendSignal ?? ((p, s) => { process.kill(p, s); });
  const send: typeof rawSend = (p, s) => {
    try { rawSend(p, s); } catch (err) {
      if (opts.pidFallback && p < 0 && (err as NodeJS.ErrnoException)?.code === 'ESRCH') { rawSend(-p, s); return; }
      throw err;
    }
  };
  const graceMs = opts.graceMs ?? TERMINATE_TREE_GRACE_MS;
  const result: TerminateTreeResult = { terminated: false, escalated: false, errors: [] };
  const usePid = isSafePid(target.pid) && process.platform !== 'win32';
  // Negative pid = the whole group; only ever -<validated pid>.
  const addr = usePid ? (opts.group ? -(target.pid as number) : (target.pid as number)) : 0;

  // true = delivered, false = target already gone.
  const signal = (sig: NodeJS.Signals): boolean => {
    try {
      if (usePid) send(addr, sig);
      else if (target.kill) target.kill(sig);
      else { result.errors.push('no usable pid and no kill()'); return false; }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') return false;
      result.errors.push(`${sig}: ${code ?? String(err)}`);
      return false;
    }
  };
  // Existence probe: ONLY ESRCH means gone; EPERM means alive; any other error is
  // "cannot confirm" — kept alive-for-escalation but remembered so we never claim gone.
  let probeErr: string | null = null;
  const alive = (): boolean => {
    if (!usePid) return true; // cannot observe → assume alive, escalate after grace
    try { send(addr, 0); return true; } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') return false;
      if (code !== 'EPERM') probeErr = code ?? String(err);
      return true;
    }
  };

  const confirmGone = async (waitMs: number): Promise<boolean> => {
    const end = Date.now() + waitMs;
    for (;;) {
      if (!alive()) return true;
      if (Date.now() >= end) return false;
      await sleep(Math.min(POLL_MS, Math.max(1, end - Date.now())));
    }
  };

  const first = opts.firstSignal ?? 'SIGTERM';
  if (!signal(first)) {
    if (result.errors.length > 0) return result;
    if (!usePid) {
      // ESRCH from a pid-less child.kill() is not an existence probe: cannot confirm.
      result.errors.push('cannot confirm exit: no pid probe');
      return result;
    }
    result.terminated = true; // pid path: ESRCH on the group send = already gone
    return result;
  }
  if (first === 'SIGTERM') {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (usePid && !alive()) { result.terminated = true; return result; }
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }
    if (usePid && !alive()) { result.terminated = true; return result; }
    result.escalated = true;
    signal('SIGKILL');
  }
  if (!usePid) {
    // No existence probe available (win32 / fake child): cannot confirm.
    result.errors.push('cannot confirm exit: no pid probe');
    return result;
  }
  if (await confirmGone(opts.killWaitMs ?? TERMINATE_TREE_KILL_WAIT_MS)) {
    result.terminated = true;
    return result;
  }
  result.errors.push(probeErr ? `cannot confirm exit: probe ${probeErr}` : 'SIGKILL: target still present');
  return result;
}
