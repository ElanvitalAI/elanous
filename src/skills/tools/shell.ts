// ── RunShell LLM tool ──
//
// Codex PTY port Phase X1 follow-up: surfaces `runShell` to LLMs as a
// native tool. Distinct from the Bash tool:
//
//   • Bash — LLM writes a shell string, executed via `bash -c`.
//     Convenient for pipes/heredocs but opaque (single blob arg).
//   • RunShell — LLM writes an argv array. No shell interpretation,
//     so quoting never lies. Ships approval cache + audit trail.
//
// The tool is deliberately named `RunShell` (not ExecArgv or similar)
// to nudge LLMs toward it for anything where the command shape is
// known up-front. The description guides toward "use RunShell for
// `rg/fd/git/bun/python3`-style argv commands; use Bash only when
// you need pipes or shell builtins."
//
// Output shape mirrors BashResult loosely but carries the X1
// taxonomy (outcome) and audit key so the LLM can reference runs in
// multi-turn follow-ups.

import type { LLMToolSpec } from '../../llm.js';
import { harnessCommandWriteReject } from '../../harness/harness-write-boundary.js';
import {
  runShell,
  type ShellRequest,
  type ShellResult,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '../../shell-primitive/index.js';
import {
  runShell as runnerDispatch,
  getShellRunnerDeps,
} from '../../shell-runner/dispatch.js';
import type { ShellResult as RunnerResult } from '../../shell-runner/types.js';
import { debug } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';

/** LLMToolSpec — the shape surfaced to the model. Kept narrow so
 *  accidental misuse is hard: no env override, no cwd outside the
 *  workspace (caller's runtime can enforce this). */
export function buildRunShellTool(): LLMToolSpec {
  return {
    name: 'RunShell',
    description:
      'Execute an argv-style command (no shell interpretation). ' +
      'Prefer this over `Bash` when the command shape is known — no quoting pitfalls. ' +
      'Returns exit code, stdout, stderr, elapsed time, and an outcome tag. ' +
      'Approval policy controls user-prompt behaviour: ' +
      "'none' runs immediately, 'first-time' prompts once per (cwd,argv) then caches, 'always' prompts every call. " +
      'Every invocation is written to ~/.monad-agent/audit/shell-YYYY-MM-DD.ndjson.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'argv array. [0] is the binary (or path), [1..] are flags and positional args. No shell metacharacters get interpreted.',
          minItems: 1,
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to the current session working directory.',
        },
        timeoutMs: {
          type: 'integer',
          description: `Hard timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, capped ${MAX_TIMEOUT_MS}.`,
        },
        approval: {
          type: 'string',
          enum: ['none', 'first-time', 'always'],
          description: "Approval policy. Default 'none'.",
        },
        sandbox: {
          type: 'string',
          enum: ['off', 'auto', 'strict'],
          description: "Sandbox policy. 'off' (default) runs directly; 'auto' wraps via platform sandbox (macOS sandbox-exec) when available; 'strict' fails when no sandbox is available. Network blocked when sandbox != off AND network='off'.",
        },
        network: {
          type: 'string',
          enum: ['inherit', 'off'],
          description: "Network policy. Only enforced when sandbox != 'off'. Default 'inherit'.",
        },
        mode: {
          type: 'string',
          enum: ['inline', 'bg'],
          description: "Shell-runner mode. Omit for the legacy argv-only path. 'inline' captures command output; 'bg' registers it for later ShellPoll.",
        },
        description: {
          type: 'string',
          description: 'Free-form label shown in shell logs and status.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  };
}

export interface RunShellDispatchArgs {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
  approval?: ShellRequest['approval'];
  sandbox?: ShellRequest['sandbox'];
  network?: ShellRequest['network'];
  mode?: 'inline' | 'bg';
  description?: string;
}

export interface RunShellDispatchResult extends Record<string, unknown> {
  /** The human-readable summary string the LLM sees first. Kept short
   *  (one line) so it fits in tool_result previews; full stdout/stderr
   *  follow in the structured fields below. */
  output: string;
  exitCode: number | null;
  outcome: ShellResult['outcome'];
  elapsedMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  approvalKey: string;
  sandboxed: boolean;
  sandboxTool: ShellResult['sandboxTool'];
}

function asCommand(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("'command' must be a non-empty array of strings");
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') throw new Error("'command' entries must be strings");
    out.push(v);
  }
  return out;
}

function asApproval(raw: unknown): ShellRequest['approval'] {
  if (raw === undefined) return 'none';
  if (raw === 'none' || raw === 'first-time' || raw === 'always') return raw;
  throw new Error(`invalid approval value: ${JSON.stringify(raw)}`);
}

function asSandbox(raw: unknown): ShellRequest['sandbox'] {
  if (raw === undefined) return undefined;
  if (raw === 'off' || raw === 'auto' || raw === 'strict') return raw;
  throw new Error(`invalid sandbox value: ${JSON.stringify(raw)}`);
}

function asNetwork(raw: unknown): ShellRequest['network'] {
  if (raw === undefined) return undefined;
  if (raw === 'inherit' || raw === 'off') return raw;
  throw new Error(`invalid network value: ${JSON.stringify(raw)}`);
}

function asMode(raw: unknown): 'inline' | 'bg' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'inline' || raw === 'bg') return raw;
  throw new Error(`invalid mode value: ${JSON.stringify(raw)}`);
}

function rejectedCdResult(): RunShellDispatchResult {
  return {
    output: 'RunShell rejected direct `cd`: this tool executes argv commands, so directory changes do not persist to later calls. Set the `cwd` argument on the command that should run there.',
    exitCode: null,
    outcome: 'spawn-error',
    elapsedMs: 0,
    stdout: '',
    stderr: 'direct `cd` is not supported by RunShell; use the `cwd` argument instead',
    truncated: false,
    approvalKey: 'rejected:cd',
    sandboxed: false,
    sandboxTool: 'none',
  };
}

function logShellDispatch(event: string, data: Record<string, unknown>): void {
  debug.log('shell.dispatch', event, data);
}

export async function dispatchRunShell(
  rawArgs: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<RunShellDispatchResult> {
  const command = asCommand(rawArgs.command);
  const cwd = typeof rawArgs.cwd === 'string' ? rawArgs.cwd : undefined;
  const timeoutMs = typeof rawArgs.timeoutMs === 'number' && Number.isFinite(rawArgs.timeoutMs)
    ? rawArgs.timeoutMs : undefined;
  const approval = asApproval(rawArgs.approval);
  const sandbox = asSandbox(rawArgs.sandbox);
  const network = asNetwork(rawArgs.network);
  const mode = asMode(rawArgs.mode);
  const description = typeof rawArgs.description === 'string' ? rawArgs.description : undefined;
  if (command[0] === 'cd') {
    logShellDispatch('cd.rejected', { reason: 'argv-state-does-not-persist' });
    return rejectedCdResult();
  }
  const effectiveCwd = cwd ?? getSessionCwd();
  const cwdSource = cwd === undefined ? 'session' : 'argument';
  const boundaryReject = harnessCommandWriteReject(command, effectiveCwd, 'run-shell');
  if (boundaryReject) throw new Error(boundaryReject);

  // Explicit inline/bg uses the file-backed runner when its deps are installed;
  // omitted mode and uninitialized hosts keep the legacy argv path.
  const deps = mode ? getShellRunnerDeps() : null;
  if (mode && deps) {
    const result = await dispatchViaRunner({
      command, cwd, timeoutMs, mode, description,
      signal: opts.signal,
      deps,
    });
    logShellDispatch(`runner.${result.outcome}`, { cwd: effectiveCwd, cwdSource });
    return result;
  }

  const result = await runShell({
    command,
    cwd,
    timeoutMs,
    approval,
    sandbox,
    network,
    signal: opts.signal,
  });

  logShellDispatch(`legacy.${result.outcome}`, { cwd: effectiveCwd, cwdSource });
  const summary = formatSummary(result);
  return {
    output: summary,
    exitCode: result.exitCode,
    outcome: result.outcome,
    elapsedMs: result.elapsedMs,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    approvalKey: result.approvalKey,
    sandboxed: result.sandboxed,
    sandboxTool: result.sandboxTool,
  };
}

/** Route a request through the file-backed shell-runner and project its
 *  ShellResult back into the legacy RunShell response shape so
 *  callers keep the same output fields (exitCode/stdout/stderr/…). */
async function dispatchViaRunner(args: {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
  mode: 'inline' | 'bg';
  description?: string;
  signal?: AbortSignal;
  deps: NonNullable<ReturnType<typeof getShellRunnerDeps>>;
}): Promise<RunShellDispatchResult> {
  const req: Parameters<typeof runnerDispatch>[0] = {
    command: args.command,
    mode: args.mode,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  const handle = runnerDispatch(req, args.deps);
  const result = await handle.result;
  return runnerToLegacyResult(handle.id, result);
}

function runnerToLegacyResult(
  handleId: string,
  r: RunnerResult,
): RunShellDispatchResult {
  const outcome: ShellResult['outcome'] = r.outcome;
  const summary = [
    `RunShell outcome=${outcome}`,
    `exitCode=${r.exitCode === undefined ? 'null' : r.exitCode}`,
    `elapsed=${r.durationMs}ms`,
    `handle=${handleId}`,
    ...(r.truncated ? ['truncated'] : []),
    ...(r.backgroundTaskId ? [`bg=${r.backgroundTaskId}`] : []),
  ].join(' ');
  return {
    output: summary,
    exitCode: r.exitCode ?? null,
    outcome,
    elapsedMs: r.durationMs,
    stdout: r.stdout.text,
    stderr: r.stderr.text,
    truncated: r.truncated,
    // Legacy fields kept for backward-compat; the runner doesn't
    // compute approval/sandbox, so we report neutral values.
    approvalKey: `runner:${handleId}`,
    sandboxed: false,
    sandboxTool: 'none',
  };
}

/** One-line summary: `RunShell outcome=exit exitCode=0 elapsed=87ms`.
 *  Exported so tests can lock in wording. */
export function formatSummary(r: ShellResult): string {
  const parts = [
    `RunShell outcome=${r.outcome}`,
    `exitCode=${r.exitCode === null ? 'null' : r.exitCode}`,
    `elapsed=${r.elapsedMs}ms`,
  ];
  if (r.truncated) parts.push('truncated');
  if (r.sandboxed) parts.push(`sandbox=${r.sandboxTool}`);
  if (r.spawnError) parts.push(`spawn_error="${r.spawnError}"`);
  return parts.join(' ');
}
