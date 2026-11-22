// ── Ephemeral shell runtime — X1 ──
//
// runShell(req): Promise<ShellResult>. argv execution, captured output,
// timeout and abort signal composition. Executions outside the local-read
// policy require a parent-issued, single-use grant at the spawn gateway.
//
// Intentionally thin layer over node's child_process.spawn:
//   • No shell interpretation (argv[0] is the binary path).
//   • No PATH magic — we do a conservative PATH lookup only when
//     argv[0] contains no slash. Otherwise pass straight through.
//   • stdout/stderr captured as utf8 strings with a combined
//     truncation budget (head + tail).
//   • The legacy approval cache is not execution authority; the gateway
//     verifies and consumes the signed grant immediately before spawn.
//
// Design ref: DESIGN-codex-pty-port.md §3 Phase X1.

import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, resolve } from 'node:path';
import { requestRunShellApproval, RUNSHELL_PUBLIC_KEY_ENV } from '../tui-client/next-runshell-approval.js';
import type { SignedRunShellApproval } from './runshell-approval.js';
import { isLocalRead, spawnGateway } from './spawn-gateway.js';
import {
  commandKey,
  getCachedDecision,
  rememberDecision,
} from './approval-cache.js';
import { recordAudit } from './audit-log.js';
import { terminateTree } from './terminate-tree.js';
import { applySandbox, SandboxUnavailableError } from './sandbox.js';
import { getSessionCwd } from '../session/working-dir.js';
import { runtimeProcessIdentity } from '../els/seat-runtime.js';
import { shellChildEnv } from '../shell-runner/child-env.js';
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

// The parent supplies this once at child boot; individual requests cannot choose a verifier.
const trustedRunShellPublicKey = process.env[RUNSHELL_PUBLIC_KEY_ENV];
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

/** Approval boundary shared by the argv runtime and the runner/Bash tool paths. */
export async function gateShellCommand(req: ShellRequest, priorHumanApproval = false): Promise<ShellResult | null> {
  const cwd = req.cwd ?? getSessionCwd();
  const key = commandKey({ command: req.command, cwd });
  const guardian = classifyDestructive(req.command);
  const withGuardian = (result: ShellResult): ShellResult => guardian ? { ...result, guardian } : result;
  const policy = guardian ? 'always' : (req.approval ?? 'none');
  const audit = (result: ShellResult): ShellResult => {
    recordAudit({
      type: 'run', ts: new Date().toISOString(), approvalKey: key,
      command: req.command, cwd, outcome: result.outcome,
      exitCode: result.exitCode, elapsedMs: result.elapsedMs, truncated: result.truncated,
    });
    return withGuardian(result);
  };
  if (priorHumanApproval) return req.signal?.aborted ? audit(aborted(key)) : null;
  if (policy !== 'none') {
    const decision = await resolveApproval(policy, key, req, cwd);
    if (req.signal?.aborted) return audit(aborted(key));
    if (decision === 'deny-once' || decision === 'deny-session') return audit(denied(key));
  }
  if (req.signal?.aborted) return audit(aborted(key));
  return null;
}

export async function runShell(req: ShellRequest, priorHumanApproval = false): Promise<ShellResult> {
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
  const cwd = resolve(req.cwd ?? getSessionCwd());
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

  // A boolean/cache is not authority for an argv execution.  The product
  // approval below is always per invocation and is verified at spawn.
  let originalExecutable: string;
  try { originalExecutable = resolveExecutable(req.command[0]!, cwd); }
  catch (err) {
    if (req.signal?.aborted) return withG(aborted(key));
    return withG({
      exitCode: null, stdout: '', stderr: '', elapsedMs: 0, approvalKey: key,
      outcome: 'spawn-error', truncated: false,
      spawnError: err instanceof Error ? err.message : String(err),
      sandboxed: false, sandboxTool: 'none',
    });
  }
  const originalCommand = [originalExecutable, ...req.command.slice(1)];

  // ─── Sandbox wrapping (X3) ───────────────────────────────────
  // Wrap before requesting the one-use approval so its argv binds the
  // exact process invocation. Audit records retain the original request;
  // the result also reports whether isolation was applied.
  let sandboxedCommand: string[];
  let sandboxed = false;
  let sandboxTool: ShellResult['sandboxTool'] = 'none';
  try {
    const decision = applySandbox({
      command: originalCommand,
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

  // OP #121854 — the last look before spawn: the abort may have landed at any await above
  // (or the call may have started already aborted). An aborted turn spawns nothing — no
  // prompt answer, no cache write, and no process get to run past this point.
  if (req.signal?.aborted) {
    const abortResult = aborted(key);
    recordAudit({
      type: 'run',
      ts: new Date().toISOString(),
      approvalKey: key,
      command: req.command,
      cwd,
      outcome: abortResult.outcome,
      exitCode: abortResult.exitCode,
      elapsedMs: abortResult.elapsedMs,
      truncated: abortResult.truncated,
    });
    return withG(abortResult);
  }

  const localRead = isLocalRead(sandboxedCommand[0]!, sandboxedCommand.slice(1), cwd);
  // Local reads retain the ordinary approval policy (including explicit
  // 'always'); non-local executions still require the signed spawn grant.
  if (localRead) {
    const gateResult = await gateShellCommand(req, priorHumanApproval);
    if (gateResult) return gateResult;
  }
  let approval: SignedRunShellApproval | null = null;
  const publicKeyPem = trustedRunShellPublicKey;
  const callerSeat = process.env.ELANOUS_TRACK;
  const sessionId = req.runShellSessionId;
  if (!localRead) {
    if (!publicKeyPem || !callerSeat || !sessionId) return withG(denied(key));
    try {
      const bytesSha256 = createHash('sha256').update(readFileSync(originalExecutable)).digest('hex');
      approval = await requestRunShellApproval(process, { argv: sandboxedCommand, cwd, bytesSha256, callerSeat, sessionId }, req.signal);
    } catch { return withG(denied(key)); }
    if (!approval) return withG(req.signal?.aborted ? aborted(key) : denied(key));
  }
  const child = spawnSafely(sandboxedCommand, cwd, req.env, req.envPolicy,
    approval ? { approval, publicKeyPem: publicKeyPem!, callerSeat: callerSeat!, sessionId: sessionId!, executablePath: originalExecutable, signal: req.signal } : undefined);
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

  try { req.onSpawn?.(); } catch { /* the capsule clock is advisory */ }
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
    // OP #121854 — hand the caller's abort to the prompt so it can cancel with the turn.
    signal: req.signal,
  });
  // OP #121854 — an allow/deny that lands after the caller's abort is a late answer to a
  // cancelled question: it must not poison the session cache (the run never spawns either —
  // the pre-spawn check below answers 'aborted').
  if (!req.signal?.aborted) rememberDecision(key, decision);
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

/** OP #121854 — the caller's signal fired before spawn: no process, answer 'aborted'. */
function aborted(key: string): ShellResult {
  return {
    exitCode: null, stdout: '', stderr: '',
    elapsedMs: 0, approvalKey: key,
    outcome: 'aborted', truncated: false,
    sandboxed: false, sandboxTool: 'none',
  };
}

function resolveExecutable(command: string, cwd: string): string {
  const candidates = command.includes('/') ? [resolve(cwd, command)]
    : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir || '.', command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next PATH entry */ }
  }
  throw new Error('RunShell executable unavailable');
}

function spawnSafely(
  command: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  envPolicy: ShellRequest['envPolicy'],
  grant?: { approval: SignedRunShellApproval; publicKeyPem: string; callerSeat: string; sessionId: string; executablePath: string; signal?: AbortSignal },
): ChildProcess | Error {
  try {
    const childEnv = envPolicy === 'allowlist'
      ? shellChildEnv(process.env, env)
      : { ...process.env, ...(env ?? {}) };
    // The child claims this live runtime, not a possibly inherited stale claim.
    const runtime = runtimeProcessIdentity(process.pid);
    if (runtime) childEnv.ELN_SEAT_RUNTIME = JSON.stringify({ pid: runtime.pid, start: runtime.start });
    else delete childEnv.ELN_SEAT_RUNTIME;
    return spawnGateway(command[0]!, command.slice(1), {
      cwd,
      // The project augments ProcessEnv with a required NODE_ENV; the allowlist deliberately omits it.
      env: childEnv as unknown as NodeJS.ProcessEnv,
      shell: false,
      // own process group → terminateTree kills the whole tree (and only it).
      detached: process.platform !== 'win32',
    }, undefined, grant);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** The capture budget is bytes across both streams, including malformed UTF-8 replacement bytes. */
function decodeWithinByteBudget(chunks: Buffer[], budget: number): string {
  const text = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  const encoded = Buffer.from(text, 'utf8');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.min(budget, encoded.length); end >= Math.max(0, budget - 3); end--) {
    try { return decoder.decode(encoded.subarray(0, end)); }
    catch { /* one incomplete UTF-8 code point at the byte edge */ }
  }
  return '';
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
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let outcome: ShellResult['outcome'] = 'exit';
    let settled = false;
    let spawnErrorMsg: string | undefined;

    const append = (dst: 'stdout' | 'stderr', chunk: Buffer) => {
      const budgetLeft = maxOutput - stdoutBytes - stderrBytes;
      if (budgetLeft <= 0) { truncated = true; return; }
      const retained = Buffer.from(chunk.subarray(0, budgetLeft));
      if (dst === 'stdout') { stdoutChunks.push(retained); stdoutBytes += retained.length; }
      else { stderrChunks.push(retained); stderrBytes += retained.length; }
      if (retained.length < chunk.length) truncated = true;
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
        void terminateTree(child, { group: true, graceMs: KILL_ESCALATE_MS });
        // An escaped grandchild can hold the pipe open past the kill; force the result.
        setTimeout(() => {
          if (settled) return;
          try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* closed */ }
          finish(null);
        }, KILL_ESCALATE_MS * 2).unref();
      },
    });
    child.stdout?.on('data', (c: Buffer) => { watchdog.touch(); append('stdout', c); });
    child.stderr?.on('data', (c: Buffer) => { watchdog.touch(); append('stderr', c); });

    const onAbort = () => {
      if (outcome === 'exit') outcome = 'aborted';
      void terminateTree(child, { group: true, graceMs: KILL_ESCALATE_MS });
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
        stdout: decodeWithinByteBudget(stdoutChunks, stdoutBytes),
        stderr: decodeWithinByteBudget(stderrChunks, stderrBytes),
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
