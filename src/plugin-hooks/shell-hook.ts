// ── PX-3 P3: shell-command hook adapter ──
//
// Wraps an arbitrary shell command as a HookHandler. Input is piped in
// as JSON on stdin; stdout is parsed as JSON and becomes the hook's
// output. stderr is logged but does not affect the output. exit != 0
// surfaces as `{abort: {reason: 'exit N'}}` so the dispatcher stops
// the chain (same behaviour as an in-process hook returning abort).
//
// Security scope (DD-PX3-7):
//   • Only contributions from builtin / user-global plugins should
//     use shell hooks in this release — workspace plugins go through
//     a tighter trust-check pipeline (deferred to PX-6).
//   • Dispatcher runs the command via /bin/sh -c, passing stdin as
//     serialized JSON. The command author is responsible for quoting —
//     we do NOT rebuild the command string from user-supplied values.
//
// I/O contract:
//   stdin  : JSON(hook input)\n
//   stdout : JSON(hook output) — empty = {}
//   stderr : log only
//   exit 0 : OK
//   exit N : treated as abort('exit N')

import { requirePosixShellCommand } from '../platform/default-shell.js';
import { spawn } from 'node:child_process';
import {
  DEFAULT_TIMEOUT_MS,
  type HookHandler,
} from './types.js';
import type { HookEvent, HookEventMap } from './events.js';

export interface ShellHookOpts {
  id: string;
  event: HookEvent;
  priority: number;
  /** Shell command string — executed via `/bin/sh -c`. The author is
   *  responsible for any argument quoting. Parametrized inputs travel
   *  via stdin (JSON), not the command line, so injection surface is
   *  limited to the command itself as written in plugin.json. */
  command: string;
  timeoutMs?: number;
  matcher?: string | readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function createShellHookHandler<E extends HookEvent>(opts: ShellHookOpts): HookHandler<E> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: opts.id,
    event: opts.event as E,
    priority: opts.priority,
    timeoutMs,
    ...(opts.matcher ? { matcher: opts.matcher } : {}),
    async invoke(input, ctx): Promise<HookEventMap[E]['output']> {
      const { stdout, exitCode, error } = await runShell({
        command: opts.command,
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs,
        abortSignal: ctx.abortSignal,
        stdin: JSON.stringify(input) + '\n',
        onStderr: (line) => ctx.logger.warn(`[shell-hook ${opts.id}] ${line}`),
      });
      if (exitCode !== 0) {
        return { abort: { reason: error ?? `exit ${exitCode}` } } as HookEventMap[E]['output'];
      }
      const trimmed = stdout.trim();
      if (!trimmed) return {} as HookEventMap[E]['output'];
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          ctx.logger.warn(`[shell-hook ${opts.id}] stdout not a JSON object — treating as {}`);
          return {} as HookEventMap[E]['output'];
        }
        return parsed as HookEventMap[E]['output'];
      } catch {
        ctx.logger.warn(`[shell-hook ${opts.id}] malformed JSON on stdout — treating as {}`);
        return {} as HookEventMap[E]['output'];
      }
    },
  };
}

// ── Process runner ──────────────────────────────────────────────────

interface RunShellOpts {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  abortSignal: AbortSignal;
  stdin: string;
  onStderr: (line: string) => void;
}

interface RunShellResult {
  stdout: string;
  exitCode: number;
  error?: string;
}

function runShell(opts: RunShellOpts): Promise<RunShellResult> {
  return new Promise((resolve) => {
    let shell: string;
    try { shell = requirePosixShellCommand('/bin/sh'); }
    catch (error) {
      opts.onStderr((error as Error).message);
      resolve({ stdout: '', exitCode: 127, error: (error as Error).message });
      return;
    }
    const child = spawn(shell, ['-c', opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderrBuffer = '';
    let killed = false;
    let stdinError: string | undefined;
    const onAbort = () => {
      if (!killed) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        // Hard kill after 200ms grace.
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 200);
      }
    };
    const timer = setTimeout(onAbort, opts.timeoutMs);
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    // A short-lived command can close its read end before end() finishes.
    // EPIPE says only that stdin was unread; stdout and exit status still
    // determine the hook result. Other pipe errors are real I/O failures.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      stdinError = `stdin error: ${err.message}`;
      opts.onStderr(stdinError);
    });
    child.stderr?.on('data', (chunk) => {
      stderrBuffer += String(chunk);
      let idx;
      while ((idx = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, idx);
        stderrBuffer = stderrBuffer.slice(idx + 1);
        if (line.trim()) opts.onStderr(line);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stderrBuffer.trim()) opts.onStderr(stderrBuffer.trim());
      // killed => treat as a non-zero exit so dispatcher abort.
      resolve({ stdout, exitCode: killed ? 124 : stdinError ? 127 : (code ?? 1), error: stdinError });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.onStderr(`spawn error: ${err.message}`);
      resolve({ stdout, exitCode: 127 });
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
