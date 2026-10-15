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
import type { ShellHandle, ShellResult as RunnerResult } from '../../shell-runner/types.js';
import { debug } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';
import {
  globalTaskNotificationQueue,
  type TaskNotificationQueue,
} from '../../agent/task-notification.js';

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
  outcome: ShellResult['outcome'] | 'started';
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

// ── ops-ledger CLI steering (RunShell-0 convergence) ────────────────────────
// The durable mailbox and release-checklist ledgers have in-process native
// tools (MsgList/MsgPost/MsgAck · ChecklistList/Add/Set/Move —
// src/skills/tools/ops-ledger.ts, registered for the same skill+tui hosts as
// RunShell). Shelling out to the `elanous` CLI for exactly those covered ops
// pays 1.3–2s of process startup for work the host process does in <300ms,
// and the CLI's human-oriented stdout amplifies TUI screen defects — so the
// call is steered to the native tool with a structured refusal naming it.
//
// Deliberately NOT a blanket elanous-CLI ban: only the seven covered ops are
// refused, and argv that explicitly scopes another universe (--test /
// --config-dir / --state-dir) is allowed through because the native tools
// always serve THIS process's instance.
const LEDGER_CLI_BIN = /(?:^|[/\\])(?:elanous|elanous\.mjs|elanous\.cjs|eln)$/;
const LEDGER_ENV_BIN = /(?:^|[/\\])env$/;
const LEDGER_CLI_NATIVE_TOOL: Readonly<Record<string, string>> = {
  'msg list': 'MsgList',
  'msg post': 'MsgPost',
  'msg ack': 'MsgAck',
  'release checklist list': 'ChecklistList',
  'release checklist add': 'ChecklistAdd',
  'release checklist set': 'ChecklistSet',
  'release checklist move': 'ChecklistMove',
};

/** The covered ops-ledger CLI op in this argv and its exposed native tool,
 *  or null when the command should run normally. */
export function matchLedgerCli(
  command: readonly string[], availableToolNames: readonly string[] = [],
): { covered: string; tool: string } | null {
  let binIndex = 0;
  // RunShell receives argv, so recognize only argv-preserving env wrappers.
  // An alternate instance must still run its own CLI, never this process's native tool;
  // so must a changed or unset ELANOUS_TRACK — the native tools record THIS process's
  // seat as the actor and route ChecklistMove permissions by it.
  if (LEDGER_ENV_BIN.test(command[0] ?? '')) {
    binIndex = 1;
    while (binIndex < command.length) {
      const arg = command[binIndex]!;
      if (arg === '-i' || arg === '--ignore-environment') return null;
      if (arg === '--') { binIndex += 1; continue; }
      if (arg === '-u' || arg === '--unset') {
        const name = command[binIndex + 1];
        if (!name || /^ELANOUS_(?:STATE_DIR|CONFIG_DIR|TEST_STATE_DIR|TRACK)$/.test(name)) return null;
        binIndex += 2;
        continue;
      }
      if (arg.startsWith('--unset=')) {
        if (/^--unset=ELANOUS_(?:STATE_DIR|CONFIG_DIR|TEST_STATE_DIR|TRACK)$/.test(arg)) return null;
        binIndex += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        if (/^ELANOUS_(?:STATE_DIR|CONFIG_DIR|TEST_STATE_DIR|TRACK)=/.test(arg)) return null;
        binIndex += 1;
        continue;
      }
      break;
    }
  }
  if (command[binIndex] === 'bun' || command[binIndex] === 'bunx' || command[binIndex] === 'node' || command[binIndex] === 'npx') {
    binIndex += 1;
    if (command[binIndex] === '--bun') binIndex += 1;
  }
  if (!LEDGER_CLI_BIN.test(command[binIndex] ?? '')) return null;
  const args = command.slice(binIndex + 1);
  if (args.some((arg) => arg === '--test' || arg === '--config-dir' || arg.startsWith('--config-dir=')
    || arg === '--state-dir' || arg.startsWith('--state-dir=')
    || arg === '--test-state-dir' || arg.startsWith('--test-state-dir='))) return null;
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += 1;
  const sub = args[i];
  const covered = sub === 'msg'
    ? `msg ${args[i + 1]}`
    : sub === 'release' && args[i + 1] === 'checklist'
      ? `release checklist ${args[i + 2]}`
      : '';
  const tool = covered ? LEDGER_CLI_NATIVE_TOOL[covered] : undefined;
  if (!tool || !availableToolNames.includes(tool)) return null;
  return { covered, tool };
}

function ledgerCliSteerOutput(shellTool: string, covered: string, tool: string): string {
  const metadata = covered === 'release checklist set' ? ' — for owner/priority/disposition/kind/… use ChecklistEdit, one field per call' : '';
  return `${shellTool} rejected \`${covered}\`: call the native ${tool} tool instead (same ledger, same permissions and audit, no CLI startup)${metadata}.`;
}

/** Structured refusal steering a covered ops-ledger CLI argv to its native
 *  tool, or null when the command should run normally. Exported so tests
 *  can exercise the matcher without spawning anything. */
export function rejectedLedgerCliResult(
  command: readonly string[], availableToolNames: readonly string[] = [],
): RunShellDispatchResult | null {
  const match = matchLedgerCli(command, availableToolNames);
  if (!match) return null;
  const { covered, tool } = match;
  return {
    output: ledgerCliSteerOutput('RunShell', covered, tool),
    exitCode: null,
    outcome: 'spawn-error',
    elapsedMs: 0,
    stdout: '',
    stderr: `use the native ${tool} tool instead of the ${covered} CLI`,
    truncated: false,
    approvalKey: 'rejected:ops-ledger-cli',
    sandboxed: false,
    sandboxTool: 'none',
  };
}

function logShellDispatch(event: string, data: Record<string, unknown>): void {
  debug.log('shell.dispatch', event, data);
}

// ── bg completion → turn notification queue (TUI-BG-SHELL) ───────────
// When a bg-mode shell handle settles, its result is no longer awaited
// by anyone — the spawn already returned the `outcome=started` stub.
// To surface the eventual result we enqueue one task-notification into
// the existing turn notification queue (injected at turn-start by
// chat/skill-runner). One notice per handle; opening an idle turn from
// the wake signal is deliberately NOT wired here (TUI-EVENT-TURN-QUEUE).

export interface ShellCompletionNoticeInput {
  handle: ShellHandle;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Set when ok === false — the runner's failure reason. */
  errorMessage?: string;
  /** Caller-supplied free-form label (RunShell's `description` arg). */
  label?: string;
}

/** Per-handle dedup guard — module-local, keyed by the handle OBJECT.
 *  A registry replacement may mint a NEW handle that reuses an id; the
 *  shell layer must not swallow that fresh completion as a duplicate
 *  settle (an id-keyed record here would). */
const notifiedHandles = new WeakSet<ShellHandle>();
let nextShellCompletionNoticeId = 0;

/** Enqueue one bg shell-handle completion notice. Returns true when this
 *  handle had not notified before (the notice was handed to `queue`),
 *  false on a duplicate settle of the same handle. The queue's own
 *  The shared queue deduplicates by taskId even after drain, so each
 *  completed handle gets its own notification id. The original handle id
 *  remains in the output for ShellPoll and human follow-up.
 *  `queue` defaults to the global turn notification queue; injectable
 *  so tests can isolate. */
export function enqueueShellCompletionNotice(
  input: ShellCompletionNoticeInput,
  queue: TaskNotificationQueue = globalTaskNotificationQueue,
): boolean {
  if (notifiedHandles.has(input.handle)) return false;
  notifiedHandles.add(input.handle);
  const header = `RunShell bg handle=${input.handle.id} ${input.ok ? 'completed' : 'failed'}`;
  const output = `${header}${input.ok || input.exitCode !== null ? ` exitCode=${input.exitCode ?? 'null'}` : ''} elapsed=${input.durationMs}ms${input.errorMessage ? ` error=${input.errorMessage}` : ''}`;
  queue.enqueue({
    taskId: `shell:${input.handle.id}:${++nextShellCompletionNoticeId}`,
    agentName: 'RunShell',
    ...(input.label ? { label: input.label } : {}),
    state: input.ok ? 'done' : 'error',
    output,
    truncated: false,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    durationMs: input.durationMs,
    finishedAt: Date.now(),
  });
  return true;
}

export async function dispatchRunShell(
  rawArgs: Record<string, unknown>,
  opts: { signal?: AbortSignal; availableToolNames?: readonly string[] } = {},
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
  const ledgerCliMatch = matchLedgerCli(command, opts.availableToolNames);
  if (ledgerCliMatch) {
    // covered op ⊕ tool only — the argv can carry a message body.
    logShellDispatch('ledger-cli.steered', { shell: 'run-shell', ...ledgerCliMatch });
    return rejectedLedgerCliResult(command, opts.availableToolNames)!;
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
  if (args.mode === 'bg') {
    const bgStartedAt = Date.now();
    void handle.result.then(
      (result) => {
        debug.log('skill-tool.shell', 'bg-finished', {
          handle: handle.id,
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
        });
        const ok = result.outcome === 'exit' && result.exitCode === 0;
        enqueueShellCompletionNotice({
          handle,
          ok,
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          ...(!ok ? { errorMessage: result.exitCode !== undefined
            ? `exitCode=${result.exitCode}` : `outcome=${result.outcome}` } : {}),
          ...(args.description !== undefined ? { label: args.description } : {}),
        });
      },
      (err: unknown) => {
        debug.log('skill-tool.shell', 'bg-finished', {
          handle: handle.id,
          exitCode: null,
          durationMs: Date.now() - bgStartedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        enqueueShellCompletionNotice({
          handle,
          ok: false,
          exitCode: null,
          durationMs: Date.now() - bgStartedAt,
          errorMessage: err instanceof Error ? err.message : String(err),
          ...(args.description !== undefined ? { label: args.description } : {}),
        });
      },
    );
    return {
      output: `RunShell outcome=started handle=${handle.id} bg=${handle.id}`,
      exitCode: null,
      outcome: 'started',
      elapsedMs: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      approvalKey: `runner:${handle.id}`,
      sandboxed: false,
      sandboxTool: 'none',
    };
  }
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
