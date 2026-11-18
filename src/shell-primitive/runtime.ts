// ── Ephemeral shell runtime — X1 ──
//
// runShell(req): Promise<ShellResult>.  argv-exec, captured output,
// timeout, abort signal composition, and (when approval !== 'none')
// a prompt hook that consults/updates the session cache.
//
// Intentionally thin layer over node's child_process.spawn:
//   • No shell interpretation (argv[0] is the binary path).
//   • No PATH magic — we do a conservative PATH lookup only when
//     argv[0] contains no slash. Otherwise pass straight through.
//   • stdout/stderr captured as utf8 strings with a combined
//     truncation budget (head + tail).
//   • approval: first-time → consults approval cache, falls back to
//     the approver DI (caller supplies; fail-closed when missing).
//
// Design ref: DESIGN-codex-pty-port.md §3 Phase X1.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  commandKey,
  getCachedDecision,
  rememberDecision,
} from './approval-cache.js';
import { recordAudit } from './audit-log.js';
import { applySandbox, SandboxUnavailableError } from './sandbox.js';
import { getSessionCwd } from '../session/working-dir.js';
import { classifyDestructive, type GuardianFinding } from '../ask-user-question/guardian.js';
import { detectSandboxFailure } from './escalation-prompt.js';
import {
  SHELL_KILL_GRACE_MS, SHELL_MIN_TIMEOUT_MS, createShellWatchdog, reportShellWatchdog, resolveShellStallMs,
} from '../tool-runtime/shell-watchdog.js';
import {
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, SHELL_MAX_OUTPUT,
  type ShellRequest, type ShellResult, type ShellApprover,
  type ApprovalDecision,
} from './types.js';

let approverRef: ShellApprover | null = null;

/** Wire the approver (typically createShellApprover() from the
 *  dashboard) at boot. Passing null un-sets — tests use this to
 *  flip between auto-approve and reject. */
export function setShellApprover(a: ShellApprover | null): void {
  approverRef = a;
}

/** Test-only inspection. */
export function _getShellApproverForTesting(): ShellApprover | null {
  return approverRef;
}

const KILL_ESCALATE_MS = SHELL_KILL_GRACE_MS;

export async function runShell(req: ShellRequest): Promise<ShellResult> {
  if (!Array.isArray(req.command) || req.command.length === 0) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      elapsedMs: 0,
      approvalKey: commandKey({ command: [], cwd: req.cwd }),
      outcome: 'spawn-error',
      truncated: false,
      spawnError: 'empty command',
      sandboxed: false,
      sandboxTool: 'none',
    };
  }

  // WD5 — default to the session working directory so a user who
  // Ctrl+W'd into /some/project has shells spawn there without every
  // caller threading cwd explicitly.
  const cwd = req.cwd ?? getSessionCwd();
  const key = commandKey({ command: req.command, cwd });

  // ─── AU3 — Guardian pre-check ────────────────────────────────
  // Run BEFORE approval resolution so a flagged command forces an
  // approval prompt even under `approval: 'none'`. Conservative: a
  // null finding means "clean or guardian off", the runtime behaves
  // identically to pre-AU3 in that case.
  const guardian: GuardianFinding | null = classifyDestructive(req.command);
  const withG = (r: ShellResult): ShellResult => (
    guardian ? { ...r, guardian } : r
  );

  // ─── Approval ────────────────────────────────────────────────
  // AU3 — when Guardian flags a command, we upgrade the approval
  // policy from 'none' / 'first-time' → 'always' so the user sees
  // the prompt regardless of prior session approval decisions. The
  // `approval !== 'none'` branch handles the cache consultation as
  // before, but we overwrite the effective mode.
  const approvalPolicy = guardian ? 'always' : (req.approval ?? 'none');
  if (approvalPolicy !== 'none') {
    const decision = await resolveApproval(approvalPolicy, key, req, cwd);
    if (decision === 'deny-once' || decision === 'deny-session') {
      const denyResult = denied(key);
      recordAudit({
        type: 'run',
        ts: new Date().toISOString(),
        approvalKey: key,
        command: req.command,
        cwd,
        outcome: denyResult.outcome,
        exitCode: denyResult.exitCode,
        elapsedMs: denyResult.elapsedMs,
        truncated: denyResult.truncated,
      });
      return withG(denyResult);
    }
    // allow-once / allow-session fall through to execution.
  }

  // ─── Sandbox wrapping (X3) ───────────────────────────────────
  // Happens after approval so the audit trail shows the user's
  // un-wrapped argv (what the LLM/skill asked for), not the
  // sandbox-exec frame. The sandboxed flag on the result still
  // surfaces whether isolation was in effect.
  let sandboxedCommand: string[];
  let sandboxed = false;
  let sandboxTool: ShellResult['sandboxTool'] = 'none';
  try {
    const decision = applySandbox({
      command: req.command,
      cwd,
      network: req.network,
      sandbox: req.sandbox,
    });
    sandboxedCommand = decision.command;
    sandboxed = decision.sandboxed;
    sandboxTool = decision.tool;
  } catch (err) {
    if (err instanceof SandboxUnavailableError) {
      // strict mode on an unsupported platform — surface as a
      // dedicated spawn-error with the reason so callers can fall
      // back (or hard-fail, their call).
      return withG({
        exitCode: null, stdout: '', stderr: '',
        elapsedMs: 0, approvalKey: key,
        outcome: 'spawn-error', truncated: false,
        spawnError: err.message,
        sandboxed: false, sandboxTool: 'none',
      });
    }
    throw err;
  }

  // ─── Spawn ──────────────────────────────────────────────────
  const started = Date.now();
  const timeoutMs = Math.min(
    Math.max(SHELL_MIN_TIMEOUT_MS, req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const maxOutput = req.maxOutputChars ?? SHELL_MAX_OUTPUT;

  const child = spawnSafely(sandboxedCommand, cwd, req.env);
  if (child instanceof Error) {
    const result: ShellResult = {
      exitCode: null, stdout: '', stderr: '',
      elapsedMs: Date.now() - started,
      approvalKey: key,
      outcome: 'spawn-error', truncated: false,
      spawnError: child.message,
      sandboxed, sandboxTool,
    };
    recordAudit({
      type: 'run',
      ts: new Date().toISOString(),
      approvalKey: key, command: req.command, cwd,
      outcome: result.outcome, exitCode: result.exitCode,
      elapsedMs: result.elapsedMs, truncated: result.truncated,
    });
    return withG(result);
  }

  const result = await collectOutput(child, started, key, timeoutMs, maxOutput, req.signal, sandboxed, sandboxTool);
  // AU6 — flag sandbox-rejection when the kernel blocked the op.
  // Heuristic; false positives are OK because the LLM is instructed
  // to ask the user before re-running without the sandbox.
  if (detectSandboxFailure({
    sandboxed: result.sandboxed,
    exitCode: result.exitCode,
    stderr: result.stderr,
  })) {
    result.sandboxFailure = true;
  }
  recordAudit({
    type: 'run',
    ts: new Date().toISOString(),
    approvalKey: key,
    command: req.command,
    cwd,
    outcome: result.outcome,
    exitCode: result.exitCode,
    elapsedMs: result.elapsedMs,
    truncated: result.truncated,
  });
  return withG(result);
}

async function resolveApproval(
  policy: 'first-time' | 'always',
  key: string,
  req: ShellRequest,
  cwd: string,
): Promise<ApprovalDecision> {
  // first-time: consult the cache. Cached decision wins without
  // re-prompting the user.
  if (policy === 'first-time') {
    const cached = getCachedDecision(key);
    if (cached) {
      recordAudit({
        type: 'approval', ts: new Date().toISOString(),
        approvalKey: key, decision: cached, source: 'cache',
        command: req.command, cwd,
      });
      return cached;
    }
  }
  // Need the approver to resolve this call.
  if (!approverRef) {
    recordAudit({
      type: 'approval', ts: new Date().toISOString(),
      approvalKey: key, decision: 'deny-once', source: 'fail-closed',
      command: req.command, cwd,
    });
    return 'deny-once';
  }
  const decision = await approverRef({
    command: req.command,
    cwd,
    approvalKey: key,
    context: req.network === 'off' ? 'network: off' : undefined,
  });
  rememberDecision(key, decision);
  recordAudit({
    type: 'approval', ts: new Date().toISOString(),
    approvalKey: key, decision, source: 'approver',
    command: req.command, cwd,
  });
  return decision;
}

function denied(key: string): ShellResult {
  return {
    exitCode: null, stdout: '', stderr: '',
    elapsedMs: 0, approvalKey: key,
    outcome: 'denied', truncated: false,
    sandboxed: false, sandboxTool: 'none',
  };
}

function spawnSafely(
  command: string[],
  cwd: string,
  env: Record<string, string> | undefined,
): ChildProcess | Error {
  try {
    return spawn(command[0]!, command.slice(1), {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: false,
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function collectOutput(
  child: ChildProcess,
  started: number,
  key: string,
  timeoutMs: number,
  maxOutput: number,
  outerSignal: AbortSignal | undefined,
  sandboxed: boolean,
  sandboxTool: ShellResult['sandboxTool'],
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let outcome: ShellResult['outcome'] = 'exit';
    let settled = false;
    let spawnErrorMsg: string | undefined;

    const append = (dst: 'stdout' | 'stderr', chunk: string) => {
      const current = dst === 'stdout' ? stdout : stderr;
      const budgetLeft = maxOutput - current.length;
      if (budgetLeft <= 0) { truncated = true; return; }
      if (chunk.length <= budgetLeft) {
        if (dst === 'stdout') stdout += chunk; else stderr += chunk;
      } else {
        if (dst === 'stdout') stdout += chunk.slice(0, budgetLeft);
        else stderr += chunk.slice(0, budgetLeft);
        truncated = true;
      }
    };

    // A201 — wall-clock timeout ⊕ no-output stall line. Kills the exact child; a stall
    // reports outcome 'timeout' (existing union) with the structured `watchdog` field.
    const watchdog = createShellWatchdog({
      tool: 'RunShell',
      timeoutMs,
      stallMs: resolveShellStallMs(),
      onFire: (fired) => {
        if (settled) return;
        outcome = 'timeout';
        reportShellWatchdog(fired, { pid: child.pid ?? null });
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, KILL_ESCALATE_MS).unref();
        // An escaped grandchild can hold the pipe open past the kill; force the result.
        setTimeout(() => {
          if (settled) return;
          try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* closed */ }
          finish(null);
        }, KILL_ESCALATE_MS * 2).unref();
      },
    });
    child.stdout?.on('data', (c: Buffer) => { watchdog.touch(); append('stdout', c.toString('utf8')); });
    child.stderr?.on('data', (c: Buffer) => { watchdog.touch(); append('stderr', c.toString('utf8')); });

    const onAbort = () => {
      if (outcome === 'exit') outcome = 'aborted';
      try { child.kill('SIGTERM'); } catch { /* ok */ }
    };
    let outerDisposer: (() => void) | null = null;
    if (outerSignal) {
      if (outerSignal.aborted) onAbort();
      else {
        outerSignal.addEventListener('abort', onAbort, { once: true });
        outerDisposer = () => outerSignal.removeEventListener('abort', onAbort);
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      // spawn/exec-time error (ENOENT, EACCES, …). Preempt the exit
      // path so the result carries outcome: 'spawn-error'.
      outcome = 'spawn-error';
      spawnErrorMsg = err.message;
      // Some platforms still fire 'close' after error; let that path
      // land as the actual resolver to keep the logic in one place.
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      outerDisposer?.();
      resolve({
        ...(watchdog.fired ? { watchdog: watchdog.fired } : {}),
        exitCode,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
        approvalKey: key,
        outcome,
        truncated,
        spawnError: spawnErrorMsg,
        sandboxed,
        sandboxTool,
      });
    };

    child.on('close', (code) => finish(code));
    child.on('exit',  (code) => finish(code));
  });
}
