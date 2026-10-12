// ── PX-4 P3: mission evaluator shell runner ──
//
// Spawns the evaluator command via `/bin/sh -c`, pipes JSON input on
// stdin, parses JSON from stdout, enforces a hard timeout, and maps
// every failure path to a MissionResult with the right `error` field.
// The runtime (MissionRegistry.tick) catches the returned Result and
// routes it through keepPolicy.
//
// This mirrors src/plugin-hooks/shell-hook.ts but with mission-shaped
// output (MissionResult, not ChainOutcome) and longer default timeouts.
// The low-level spawn/pipe/kill logic is intentionally duplicated — the
// two systems diverge in how they handle non-zero exits (hook: abort
// chain ; mission: record error), and keeping them separate makes each
// easier to reason about.

import { requirePosixShellCommand } from '../platform/default-shell.js';
import { spawn } from 'node:child_process';
import type {
  MissionDefinition,
  MissionResult,
} from './types.js';

export interface EvaluatorRunInput {
  missionId: string;
  iteration: number;
  lastResult?: MissionResult;
  /** Resolved cwd — either mission.evaluator.cwd or the plugin dir. */
  workDir: string;
  /** Contents of mission.md read by the caller (so the runner does not
   *  need fs access to the plugin dir beyond the spawn cwd). */
  goalContent: string;
  sandboxContent: string;
}

export interface EvaluatorRunOpts {
  /** Forwarded to the child process as abort signal. When the caller's
   *  parent context cancels (e.g. plugin deactivate) the child dies. */
  abortSignal?: AbortSignal;
  /** Optional logger — receives stderr line-by-line. Defaults to
   *  stderr pass-through via console.warn. */
  onStderr?: (line: string) => void;
}

/** Execute the evaluator and return a MissionResult. Never throws;
 *  all failure paths become a typed error result so the caller never
 *  needs a try/catch. */
export async function runMissionEvaluator(
  def: MissionDefinition,
  input: EvaluatorRunInput,
  opts: EvaluatorRunOpts = {},
): Promise<MissionResult> {
  const timeoutMs = def.evaluator.timeoutMs ?? 300_000;
  const stdin = JSON.stringify(input) + '\n';
  const onStderr = opts.onStderr ?? ((line) => console.warn(`[mission:${def.id}] ${line}`));
  const { stdout, exitCode, timedOut, error } = await runShell({
    command: def.evaluator.command,
    cwd: def.evaluator.cwd ?? input.workDir,
    timeoutMs,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    stdin,
    onStderr,
  });
  if (timedOut) {
    return { done: false, keep: false, error: 'timeout' };
  }
  if (error) return { done: false, keep: false, error };
  if (exitCode !== 0) {
    return { done: false, keep: false, error: `exit ${exitCode}` };
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { done: false, keep: false, error: 'empty-stdout' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { done: false, keep: false, error: 'malformed-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { done: false, keep: false, error: 'not-an-object' };
  }
  return normalizeResult(parsed as Record<string, unknown>);
}

function normalizeResult(raw: Record<string, unknown>): MissionResult {
  const done = typeof raw.done === 'boolean' ? raw.done : false;
  const result: MissionResult = { done };
  if (typeof raw.score === 'number' && Number.isFinite(raw.score)) {
    result.score = raw.score;
  }
  if (typeof raw.reason === 'string' && raw.reason.trim()) {
    result.reason = raw.reason.trim();
  }
  if (typeof raw.keep === 'boolean') {
    result.keep = raw.keep;
  }
  if (typeof raw.error === 'string' && raw.error.trim()) {
    result.error = raw.error.trim();
  }
  return result;
}

// ── Low-level runner ───────────────────────────────────────────────────

interface RunShellOpts {
  command: string;
  cwd?: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
  stdin: string;
  onStderr: (line: string) => void;
}

interface RunShellResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
  error?: string;
}

function runShell(opts: RunShellOpts): Promise<RunShellResult> {
  return new Promise((resolve) => {
    let shell: string;
    try { shell = requirePosixShellCommand('/bin/sh'); }
    catch (error) {
      opts.onStderr((error as Error).message);
      resolve({ stdout: '', exitCode: 127, timedOut: false, error: (error as Error).message });
      return;
    }
    const child = spawn(shell, ['-c', opts.command], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderrBuf = '';
    let killed = false;
    let timedOut = false;
    let stdinError: string | undefined;
    const kill = (timeout: boolean) => {
      if (killed) return;
      killed = true;
      timedOut = timeout;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 250);
    };
    const timer = setTimeout(() => kill(true), opts.timeoutMs);
    opts.abortSignal.addEventListener('abort', () => kill(false), { once: true });

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    // Early exit may close stdin before end() finishes. A broken pipe must
    // not replace the child's stdout/exit result; other write errors must
    // surface as evaluator errors.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      stdinError = `stdin error: ${err.message}`;
      opts.onStderr(stdinError);
    });
    child.stderr?.on('data', (chunk) => {
      stderrBuf += String(chunk);
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim()) opts.onStderr(line);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stderrBuf.trim()) opts.onStderr(stderrBuf.trim());
      resolve({
        stdout,
        exitCode: timedOut ? 124 : stdinError ? 127 : (code ?? 1),
        timedOut,
        error: stdinError,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.onStderr(`spawn error: ${err.message}`);
      resolve({ stdout, exitCode: 127, timedOut: false });
    });
    try { child.stdin?.end(opts.stdin); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        stdinError = `stdin error: ${(err as Error).message}`;
        opts.onStderr(stdinError);
      }
    }
  });
}
