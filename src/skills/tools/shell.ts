import { a5Wordings } from '../../turn-capsule/a5-wording.js';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
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


import { harnessCommandWriteReject } from '../../harness/harness-write-boundary.js';
import {
  runShell,
  gateShellCommand,
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
import { debug, redactSecretText, redactSecrets } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { clampShellTimeoutMs } from '../../tool-runtime/shell-watchdog.js';
import { getUserConfig } from '../../user-config/reader.js';
import type { CapsulePolicy, CapsuleStatus } from '../../turn-capsule/contract.js';
import { runShellCapsule, shellCapsulePolicy, type ShellCapsuleDeps } from '../../turn-capsule/shell-capsule.js';
import { triageShellIsolation } from '../../shell-runner/isolation-triage.js';
import { prepareRunnerRunShell } from '../../shell-runner/prepare-runshell.js';
import { resolve } from 'node:path';
import { scriptCommandPolicy, runShellScript } from './run-shell-script.js';
import { dispatchSignedRecipe } from './run-shell-recipe-dispatch.js';
import { defaultCheckScript } from './run-shell-default-checks.js';
export { scriptCommandPolicy } from './run-shell-script.js';
import { SCHEDULE_WAKEUP_TOOL_NAME } from './schedule-wakeup.js';
import {
  globalTaskNotificationQueue,
  type TaskNotificationQueue,
} from '../../agent/task-notification.js';
import {
  shellLineWatchSpecFromArgs,
  startShellLineWatch,
  type ShellLineWatchSpec,
} from './shell-line-watch.js';

/** LLMToolSpec — the shape surfaced to the model. Kept narrow so
 *  accidental misuse is hard: no env override, no cwd outside the
 *  workspace (caller's runtime can enforce this). */
export function buildRunShellTool(): LLMToolSpec {
  const w = a5Wordings();
  return {
    name: 'RunShell',
    description:
      'Execute an argv-style command (no shell interpretation). ' +
      'Prefer this over `Bash` when the command shape is known — no quoting pitfalls. ' +
      'Returns exit code, stdout, stderr, elapsed time, and an outcome tag. ' +
      'Commands outside the local-read policy require a human-approved, single-use execution grant; ' +
      "the approval parameter and previously cached decisions do not bypass that execution gate. " +
      'Use script for up to eight ordered eln, git, gh, kubectl or host read CLI calls. Exact local read argv needs no prompt; network reads and unlisted eln argv require human approval. Unlisted git, gh, kubectl and host argv are refused. For the OP 30-minute check use check=30-minute with checkSeat, checkVersion and checkPreviousGreen. The model receives a bounded summary. ' +
      'Every invocation is written to ~/.monad-agent/audit/shell-YYYY-MM-DD.ndjson.',
    parameters: {
      type: 'object',
      properties: {
        recipeId: {
          type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$',
          description: 'Execute an operator-installed, signed exact recipe; its epoch is checked immediately before spawn.',
        },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'argv array. [0] is the binary (or path), [1..] are flags and positional args. No shell metacharacters get interpreted.',
          minItems: 1,
        },
        script: {
          type: 'array', minItems: 1, maxItems: 8,
          description: 'Ordered eln, git, gh, kubectl or host read CLI argv. Exact local reads need no prompt; network reads require human approval. Each id may be referenced later as $ref:id.field after selecting a JSON scalar.',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'command'],
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
              command: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
              select: { type: 'array', items: { type: 'string' }, maxItems: 18 },
              headLines: { type: 'integer', minimum: 0, maximum: 4 },
            },
          },
        },
        check: { type: 'string', enum: ['30-minute'], description: 'One RunShell script call for the standard seat check.' },
        checkSeat: { type: 'string', enum: ['OP'] },
        checkVersion: { type: 'string', description: 'Exact release version, such as 0.3.33.' },
        checkPreviousGreen: { type: 'integer', minimum: 0, maximum: 9999, description: 'OP 30-minute check: green count from the preceding check.' },
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
          description: "Legacy approval policy. Default 'none'; it cannot bypass the single-use execution grant.",
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
          description: w.runShellMode,
        },
        description: {
          type: 'string',
          description: 'Free-form label shown in shell logs and status.',
        },
        watchPattern: {
          type: 'string',
          description:
            "Requires mode='bg'. JS regex source: each complete output line matching it enqueues a <task-notification> (taskId prefix 'shell-watch:') — agent-wake opens the next turn on an idle seat TUI and the turn preamble drains it. Mid-run line events, not just completion.",
        },
        watchMinLines: {
          type: 'integer',
          minimum: 1,
          description:
            "Requires mode='bg'. Enqueue one <task-notification> once this many complete output lines have been seen.",
        },
      },
      oneOf: [{ required: ['command'] }, { required: ['script'] }, { required: ['recipeId'] }, { required: ['check', 'checkSeat', 'checkVersion', 'checkPreviousGreen'] }],
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
  /** Parsed bg line-watch request (watchPattern/watchMinLines). mode='bg' only. */
  watch?: ShellLineWatchSpec;
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
// and the CLI's human-oriented stdout amplifies TUI screen defects — so covered
// calls are steered to the native tool. The explicitly requested read-only msg list
// command stays on the CLI path so the caller's named interface is honored.
//
// Deliberately NOT a blanket elanous-CLI ban: only covered write/list operations are
// refused, and argv that explicitly scopes another universe (--test /
// --config-dir / --state-dir) is allowed through because the native tools
// always serve THIS process's instance.
const LEDGER_CLI_BIN = /(?:^|[/\\])(?:elanous|elanous\.mjs|elanous\.cjs|eln)$/;
const LEDGER_ENV_BIN = /(?:^|[/\\])env$/;
export const LEDGER_CLI_NATIVE_TOOL: Readonly<Record<string, string>> = {
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
  // RunShell argv is itself an explicit CLI request. Preserve read-only msg list;
  // its native MsgList alternative remains available as a direct tool call.
  if (!tool || covered === 'msg list' || !availableToolNames.includes(tool)) return null;
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

// ── long sleep inside a turn (TUI-RUNSHELL-LONG-SLEEP · #38) ──────────────
// A seat agent told "check again at 22:45" held its turn inside RunShell with
// a long sleep, so the TUI stayed busy for 8+ minutes and the human could not
// type. The command still runs unchanged (blocking it would break legitimate
// waits); the result gains one warning line and `shell.run long-sleep` is
// logged BEFORE the wait starts, so the hold is visible while it happens.
// Static argv/script inspection only — no shell is spawned to analyse.

export const DEFAULT_LONG_SLEEP_WARN_SECONDS = 60;

export type LongSleepPattern = 'sleep' | 'shell-sleep' | 'poll-loop' | 'python-sleep' | 'computed-sleep';

export interface LongSleepFinding {
  pattern: LongSleepPattern;
  /** Estimated total wait in seconds; null when unbounded or not literal. */
  seconds: number | null;
  /** Per-iteration sleep of a poll loop (poll-loop only; null when not literal). */
  perIterationSeconds?: number | null;
  limitSeconds: number;
}

/** `tools.runShell.longSleepWarnSeconds` from a raw config root (positive number) or the default. */
export function longSleepWarnSecondsFrom(raw: Record<string, unknown> | undefined): number {
  const tools = raw?.tools as { runShell?: { longSleepWarnSeconds?: unknown } } | undefined;
  const v = tools?.runShell?.longSleepWarnSeconds;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_LONG_SLEEP_WARN_SECONDS;
}

function longSleepWarnSeconds(): number {
  try {
    return longSleepWarnSecondsFrom(getUserConfig().raw);
  } catch { /* config unreadable → default */ }
  return DEFAULT_LONG_SLEEP_WARN_SECONDS;
}

const SLEEP_UNIT_SECONDS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** coreutils `sleep` operand → seconds (`480`, `5m`, `1.5h`, `infinity`), null when not literal. */
function parseSleepOperand(token: string): number | null {
  if (/^inf(?:inity)?$/i.test(token)) return Infinity;
  const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(token);
  return m ? Number(m[1]) * SLEEP_UNIT_SECONDS[m[2]!]! : null;
}

function binName(arg: string | undefined): string {
  return (arg ?? '').split(/[/\\]/).pop() ?? '';
}

/** Strip argv-preserving wrappers (env/timeout/nice/nohup/command/exec/time).
 *  `timeout D …` caps the wait, so its duration is returned as `capSeconds`. */
function unwrapArgv(command: readonly string[]): { argv: readonly string[]; capSeconds: number } {
  let argv = command;
  let capSeconds = Infinity;
  for (let guard = 0; guard < 8 && argv.length > 0; guard += 1) {
    const bin = binName(argv[0]);
    let i = 1;
    if (bin === 'env') {
      while (i < argv.length && (argv[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!))) {
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(argv[i]!)) i += 1;
        i += 1;
      }
    } else if (bin === 'timeout' || bin === 'gtimeout') {
      while (i < argv.length && argv[i]!.startsWith('-')) {
        if (['-s', '--signal', '-k', '--kill-after'].includes(argv[i]!)) i += 1;
        i += 1;
      }
      const cap = parseSleepOperand(argv[i] ?? '');
      if (cap !== null) capSeconds = Math.min(capSeconds, cap);
      i += 1;
    } else if (bin === 'nice') {
      if (argv[1] === '-n') i = 3;
      else if ((argv[1] ?? '').startsWith('-')) i = 2;
    } else if (!['nohup', 'command', 'exec', 'time'].includes(bin)) {
      break;
    }
    argv = argv.slice(i);
  }
  return { argv, capSeconds };
}

interface ScriptSleep { index: number; seconds: number | null }
interface ScriptScan { sleeps: ScriptSleep[]; loopBodyStart: number; loopIterations: number | null }

function scanShellScript(script: string): ScriptScan {
  const sleeps: ScriptSleep[] = [];
  // Command position only — `echo sleep 480` is an argument, not a wait.
  const sleepRe = /(?:^|[;&|(`{\n]|\b(?:do|then|else)\b)[ \t]*sleep[ \t]+([^;&|)\n`}]+)/g;
  for (let m = sleepRe.exec(script); m; m = sleepRe.exec(script)) {
    const operands = m[1]!.trim().split(/\s+/).filter((t) => !t.startsWith('-'));
    let total = 0;
    for (const op of operands) {
      const s = parseSleepOperand(op.replace(/^['"]|['"]$/g, ''));
      if (s === null) { total = NaN; break; }
      total += s;
    }
    sleeps.push({ index: m.index + m[0].indexOf('sleep'), seconds: operands.length > 0 && !Number.isNaN(total) ? total : null });
  }
  const loopRe = /(?:^|[;&|\n({]|\b(?:then|do|else)\b)\s*(while|until|for)\b([\s\S]*?)(?:;|\n)\s*do\b/;
  const loop = loopRe.exec(script);
  if (!loop) return { sleeps, loopBodyStart: -1, loopIterations: null };
  let loopIterations: number | null = null;
  if (loop[1] === 'for') {
    const header = loop[2]!;
    const brace = /\{(\d+)\.\.(\d+)\}/.exec(header);
    const seq = /\$\(\s*seq\s+(\d+)(?:\s+(\d+))?\s*\)/.exec(header);
    const words = /\bin\s+([^`$(){}]*)$/.exec(header.trim());
    if (brace) loopIterations = Math.abs(Number(brace[2]) - Number(brace[1])) + 1;
    else if (seq) loopIterations = seq[2] === undefined ? Number(seq[1]) : Math.max(0, Number(seq[2]) - Number(seq[1]) + 1);
    else if (words) loopIterations = words[1]!.trim().split(/\s+/).filter(Boolean).length;
  }
  return { sleeps, loopBodyStart: loop.index + loop[0].length, loopIterations };
}

function scanPythonCode(code: string): ScriptScan {
  const sleeps: ScriptSleep[] = [];
  const sleepRe = /\b(?:time\.)?sleep\s*\(\s*([^)]*)\)/g;
  for (let m = sleepRe.exec(code); m; m = sleepRe.exec(code)) {
    const arg = m[1]!.trim();
    sleeps.push({ index: m.index, seconds: /^(\d+(?:\.\d+)?|\.\d+)$/.test(arg) ? Number(arg) : null });
  }
  const loop = /(?:^|[;\n])\s*(while|for)\b([^:\n]*):/.exec(code);
  if (!loop) return { sleeps, loopBodyStart: -1, loopIterations: null };
  let loopIterations: number | null = null;
  if (loop[1] === 'for') {
    const range = /\brange\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(loop[2]!);
    if (range) loopIterations = range[2] === undefined ? Number(range[1]) : Math.max(0, Number(range[2]) - Number(range[1]));
  }
  return { sleeps, loopBodyStart: loop.index + loop[0].length, loopIterations };
}

function evaluateScan(
  scan: ScriptScan, sleepPattern: LongSleepPattern, capSeconds: number, limitSeconds: number,
): LongSleepFinding | null {
  if (scan.sleeps.length === 0) return null;
  const inLoop = scan.loopBodyStart >= 0 ? scan.sleeps.filter((s) => s.index >= scan.loopBodyStart) : [];
  const outside = scan.sleeps.filter((s) => !inLoop.includes(s));
  let total = outside.reduce((acc, s) => acc + (s.seconds ?? 0), 0);
  if (inLoop.length > 0) {
    const perIteration = inLoop.some((s) => s.seconds === null)
      ? null : inLoop.reduce((acc, s) => acc + s.seconds!, 0);
    const loopTotal = scan.loopIterations === null || perIteration === null
      ? Infinity : perIteration * scan.loopIterations;
    total = Math.min(total + loopTotal, capSeconds);
    if (total > limitSeconds) {
      return { pattern: 'poll-loop', seconds: Number.isFinite(total) ? total : null, perIterationSeconds: perIteration, limitSeconds };
    }
    return null;
  }
  total = Math.min(total, capSeconds);
  if (total > limitSeconds) return { pattern: sleepPattern, seconds: Number.isFinite(total) ? total : null, limitSeconds };
  if (outside.some((s) => s.seconds === null) && capSeconds > limitSeconds) {
    return { pattern: 'computed-sleep', seconds: null, limitSeconds };
  }
  return null;
}

/** Long in-turn wait in a RunShell argv, or null. Exported for tests. */
export function detectLongSleep(
  command: readonly string[], limitSeconds: number = DEFAULT_LONG_SLEEP_WARN_SECONDS,
): LongSleepFinding | null {
  const { argv, capSeconds } = unwrapArgv(command);
  const bin = binName(argv[0]);
  if (bin === 'sleep') {
    const operands = argv.slice(1).filter((t) => !t.startsWith('-'));
    let total = 0;
    for (const op of operands) {
      const s = parseSleepOperand(op);
      if (s === null) return null; // sleep itself rejects it — no wait happens
      total += s;
    }
    total = Math.min(total, capSeconds);
    return total > limitSeconds
      ? { pattern: 'sleep', seconds: Number.isFinite(total) ? total : null, limitSeconds }
      : null;
  }
  const scriptFlag = argv.findIndex((a, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  const script = scriptFlag > 0 ? argv[scriptFlag + 1] : undefined;
  if (script === undefined) return null;
  if (/^(?:ba|z|da|k)?sh$/.test(bin)) {
    return evaluateScan(scanShellScript(script), 'shell-sleep', capSeconds, limitSeconds);
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(bin) && argv[scriptFlag] === '-c') {
    return evaluateScan(scanPythonCode(script), 'python-sleep', capSeconds, limitSeconds);
  }
  return null;
}

/**
 * Which resume path the warning names (TUI-RUNSHELL-LONG-SLEEP follow-up):
 * `schedule-wakeup` when the turn was offered the ScheduleWakeup host tool
 * (seat TUI · dashboard host tool), `generic` elsewhere (harness children,
 * MCP, CLI agents) where that tool does not exist.
 */
export type LongSleepResumeHint = 'schedule-wakeup' | 'generic';

/** `ScheduleWakeup` in this turn's tool list → name it; otherwise the generic resume advice. */
export function longSleepResumeHint(availableToolNames: readonly string[] | undefined): LongSleepResumeHint {
  return availableToolNames?.includes(SCHEDULE_WAKEUP_TOOL_NAME) ? 'schedule-wakeup' : 'generic';
}

/** The one warning line prefixed to a RunShell result. Exported for tests. */
export function formatLongSleepWarning(
  finding: LongSleepFinding, bgAvailable: boolean, resumeHint: LongSleepResumeHint = 'generic',
): string {
  const wait = finding.pattern === 'poll-loop'
    ? `a poll loop sleeping ${finding.perIterationSeconds ?? '?'}s per iteration (total ${finding.seconds === null ? 'unbounded' : `~${finding.seconds}s`})`
    : finding.pattern === 'computed-sleep'
      ? 'a sleep of computed length'
      : `a sleep of ${finding.seconds === null ? 'unbounded length' : `~${finding.seconds}s`}`;
  const resume = resumeHint === 'schedule-wakeup'
    ? `end the turn and call ${SCHEDULE_WAKEUP_TOOL_NAME} (delaySeconds ≥60, at "HH:MM", or repeatMinutes) so a wakeup turn resumes the work`
    : 'end the turn and let the next turn or a mail wake resume the work';
  return `⚠ RunShell long-sleep: this command waited inside the turn with ${wait} (limit ${finding.limitSeconds}s) — `
    + `the turn stays busy and the human cannot type meanwhile. Do not hold the turn to wait: ${resume}`
    + (bgAvailable ? ", or start long-running work with mode:'bg' (its completion arrives as a notification)." : '.');
}

function withLongSleepWarning(
  result: RunShellDispatchResult, finding: LongSleepFinding | null, bgAvailable: boolean,
  resumeHint: LongSleepResumeHint,
): RunShellDispatchResult {
  if (!finding) return result;
  return { ...result, output: `${formatLongSleepWarning(finding, bgAvailable, resumeHint)}\n${result.output}` };
}

/** The per-event cap holds for the whole recorded args text, including the
 *  truncation marker. Source: TUI-OBS-TRACE-PERSIST GOAL STEPS (2048 chars). */
export const SHELL_DISPATCH_ARGS_TEXT_LIMIT = 2048;

interface BoundedShellArgsText {
  /** Redacted JSON text of the arguments received by dispatchRunShell. */
  argsText: string;
  /** True when argsText was cut to the cap. */
  argsTextTruncated: boolean;
  /** Length of the full redacted JSON text before bounding. */
  argsTextChars: number;
  /** Short scalar remains readable even if argsText itself is compacted. */
  argsTextMarker?: string;
}

function stringifyShellArgs(rawArgs: unknown): string {
  try {
    const json = JSON.stringify(redactSecrets(rawArgs));
    if (json !== undefined) return json;
  } catch { /* circular / BigInt args — redact fallback text too */ }
  try {
    return redactSecretText(String(rawArgs));
  } catch {
    return '[unserializable shell args]';
  }
}

/** Bounded, secret-redacted serialization for one RunShell dispatch record. */
export function boundedShellArgsText(
  rawArgs: unknown,
): BoundedShellArgsText {
  const full = stringifyShellArgs(rawArgs);
  if (full.length <= SHELL_DISPATCH_ARGS_TEXT_LIMIT) {
    return { argsText: full, argsTextTruncated: false, argsTextChars: full.length };
  }
  const argsTextMarker = '[truncated]';
  const prefixLen = SHELL_DISPATCH_ARGS_TEXT_LIMIT - argsTextMarker.length - 1;
  return {
    argsText: `${full.slice(0, prefixLen)} ${argsTextMarker}`,
    argsTextTruncated: true,
    argsTextChars: full.length,
    argsTextMarker,
  };
}

function logShellDispatch(
  event: string,
  data: Record<string, unknown>,
  argsTrace?: BoundedShellArgsText,
): void {
  debug.log(
    'shell.dispatch',
    event,
    argsTrace ? { ...data, ...argsTrace } : data,
    { compact: { stringMax: SHELL_DISPATCH_ARGS_TEXT_LIMIT } },
  );
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
  /** Full bounded runner result, when the runner resolved normally. */
  result?: RunnerResult;
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
const SHELL_NOTICE_STREAM_TAIL_CHARS = 64;

function shellNoticeTail(output: RunnerResult['stdout'] | undefined): { text: string; truncated: boolean } {
  if (!output) return { text: '', truncated: false };
  const source = output.tail ?? output.text;
  const safe = redactSecretText(source);
  const chars = Array.from(safe);
  return {
    text: shellNoticeJsonField(chars.slice(-SHELL_NOTICE_STREAM_TAIL_CHARS).join('')),
    truncated: chars.length > SHELL_NOTICE_STREAM_TAIL_CHARS,
  };
}

function shellNoticeReason(value: string): string {
  return redactSecretText(value);
}

function shellNoticeJsonField(value: string): string {
  return JSON.stringify(redactSecretText(value)).replace(/\p{White_Space}/gu, (char) => {
    const hex = char.codePointAt(0)!.toString(16).padStart(4, '0');
    return `\\u${hex}`;
  });
}

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
  const taskId = `shell:${input.handle.id}:${++nextShellCompletionNoticeId}`;
  const result = input.result;
  const reason = input.errorMessage ?? result?.failureReason;
  const reportedExitCode = result?.exitCode ?? input.exitCode;
  const stdoutTail = shellNoticeTail(result?.stdout);
  const stderrTail = shellNoticeTail(result?.stderr);
  const truncated = (result?.truncated ?? false) || stdoutTail.truncated || stderrTail.truncated;
  const output = [
    header,
    `taskId=${taskId}`,
    `outcome=${result?.outcome ?? 'unknown'}`,
    ...(result ? [`exitCode=${reportedExitCode ?? 'null'}`]
      : reportedExitCode !== null ? [`exitCode=${reportedExitCode}`] : []),
    `elapsed=${input.durationMs}ms`,
    ...(result ? [`stdoutTail=${stdoutTail.text}`, `stderrTail=${stderrTail.text}`] : []),
    ...(stdoutTail.truncated ? ['stdoutTailTruncated=true'] : []),
    ...(stderrTail.truncated ? ['stderrTailTruncated=true'] : []),
    ...(truncated ? ['truncated=true'] : []),
    ...(result?.outputFilePath ? [`outputFile=${shellNoticeJsonField(result.outputFilePath)}`] : []),
    ...(reason ? [`failureReason=${shellNoticeJsonField(reason)}`] : []),
  ].join(' ');
  queue.enqueue({
    taskId,
    agentName: 'RunShell',
    ...(input.label ? { label: input.label } : {}),
    state: input.ok ? 'done' : 'error',
    output,
    truncated,
    ...(reason ? { errorMessage: shellNoticeReason(reason) } : {}),
    durationMs: input.durationMs,
    finishedAt: Date.now(),
  });
  return true;
}

export async function dispatchRunShell(
  rawArgs: Record<string, unknown>,
  opts: { signal?: AbortSignal; availableToolNames?: readonly string[]; sessionId?: string; onSpawn?: () => void; priorHumanApproval?: boolean; scriptGitRead?: boolean;
    scriptApproval?: (command: string[], signal?: AbortSignal) => Promise<{ allowed: boolean; priorHumanApproval: boolean }>;
    /** RSEM-RAW-RECEIPT (OP #126921 · MOB-1 #126930) — 내부 script-step 재귀 호출임을 표시.
     * 마스킹 출구를 건너뛰어 runShellScript 가 원문 stdout로 지문·bytes·JSON.parse 하게 한다.
     * 모델 경계 마스킹은 외측 script 결과 반환 시 단일 출구(script 결과 반환 직후)에서 1회. */
    rawInternal?: boolean; tolerateCheckInboxFailure?: boolean } = {},
): Promise<RunShellDispatchResult> {
  if (rawArgs.recipeId !== undefined) {
    if (typeof rawArgs.recipeId !== 'string' || Object.keys(rawArgs).some(key => !['recipeId', 'timeoutMs'].includes(key)))
      throw new Error('RunShell recipe accepts only recipeId and timeoutMs');
    const timeoutMs = typeof rawArgs.timeoutMs === 'number' && Number.isFinite(rawArgs.timeoutMs)
      ? clampShellTimeoutMs(rawArgs.timeoutMs) : DEFAULT_TIMEOUT_MS;
    return maskRunShellEgress(await dispatchSignedRecipe(rawArgs.recipeId, timeoutMs, opts.signal, opts.sessionId));
  }
  if (rawArgs.check !== undefined) {
    if (rawArgs.command !== undefined || rawArgs.script !== undefined) throw new Error('RunShell accepts one of command, script or check');
    const result = await dispatchRunShell({ ...rawArgs, check: undefined, script: defaultCheckScript(rawArgs) }, { ...opts, tolerateCheckInboxFailure: true });
    const summary = JSON.parse(result.stdout) as { steps?: Array<{ id: string; outcome: string; exitCode: number | null; selected?: Record<string, unknown> }> };
    const receipt = summary.steps?.find((step) => step.id === 'inbox');
    const selected = receipt?.selected;
    const count = selected?.count;
    const known = receipt?.outcome === 'exit' && receipt.exitCode === 0 && selected?.status === 'ok'
      && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
    const inbox = known ? { status: 'ok', count, complete: true } : { status: 'unknown', count: null, complete: false };
    return { ...result, stdout: JSON.stringify({ ...summary, inbox }) };
  }
  if (rawArgs.script !== undefined) {
    if (rawArgs.command !== undefined) throw new Error('RunShell accepts command or script, not both');
    const timeoutMs = typeof rawArgs.timeoutMs === 'number' && Number.isFinite(rawArgs.timeoutMs)
      ? clampShellTimeoutMs(rawArgs.timeoutMs) : DEFAULT_TIMEOUT_MS;
    // RSEM-RAW-RECEIPT — step 결과는 원문으로 전달(지문·bytes·parse 원문 기준), 모델 가는 최종 결과만 출구 마스킹.
    const scriptResult = await runShellScript(rawArgs.script, opts.signal, timeoutMs, async (command, description, signal) => {
      // A policy receipt may deny a step, but an allow boolean is not a
      // signed spawn authorization for a non-local command.
      const policyReceipt = opts.scriptApproval ? await opts.scriptApproval(command, signal) : null;
      if (!policyReceipt?.allowed) return {
        output: 'RunShell script step denied by the policy gate', exitCode: null, outcome: 'denied',
        elapsedMs: 0, stdout: '', stderr: '', truncated: false, approvalKey: 'script:denied',
        sandboxed: false, sandboxTool: 'none',
      };
      // Object-only Git reads can still invoke configured signature or textconv helpers.
      // Worktree reads and ls-remote use the prior-human-approval path instead.
      const guardedCommand = command[0] === 'git' && scriptCommandPolicy(command) === 'read-local'
        ? ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
          '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'log.showSignature=false',
          command[1]!, ...(['log', 'show'].includes(command[1]!) ? ['--no-show-signature'] : []),
          ...(command[1] === 'show' ? ['--no-ext-diff', '--no-textconv'] : []), ...command.slice(2)]
        : command;
      return dispatchRunShell({ command: guardedCommand, description, approval: rawArgs.approval, sandbox: rawArgs.sandbox,
        network: rawArgs.network, timeoutMs: rawArgs.timeoutMs, cwd: rawArgs.cwd },
      { ...opts, signal, priorHumanApproval: policyReceipt.priorHumanApproval, scriptGitRead: guardedCommand !== command, rawInternal: true });
    }, opts.tolerateCheckInboxFailure === true);
    return maskRunShellEgress(scriptResult);
  }
  const command = asCommand(rawArgs.command);
  const cwd = typeof rawArgs.cwd === 'string' ? rawArgs.cwd : undefined;
  // A201 — every shell path shares one cap; the runner path used to pass the model's value unclamped.
  const timeoutMs = typeof rawArgs.timeoutMs === 'number' && Number.isFinite(rawArgs.timeoutMs)
    ? clampShellTimeoutMs(rawArgs.timeoutMs) : undefined;
  const approval = asApproval(rawArgs.approval);
  const sandbox = asSandbox(rawArgs.sandbox);
  const network = asNetwork(rawArgs.network);
  const mode = asMode(rawArgs.mode);
  const description = typeof rawArgs.description === 'string' ? rawArgs.description : undefined;
  const watch = shellLineWatchSpecFromArgs(rawArgs);
  if (watch && mode !== 'bg') {
    debug.log('shell.run', 'line-watch-ignored-non-bg', { mode: mode ?? 'inline' });
  }
  const argsTrace = boundedShellArgsText(rawArgs);
  if (command[0] === 'cd') {
    logShellDispatch('cd.rejected', { reason: 'argv-state-does-not-persist' }, argsTrace);
    return rejectedCdResult();
  }
  // §6-4 triage: pure decider; only an unknown explicit `isolation` is refused, everything else is unchanged.
  const triage = triageShellIsolation({ mode, sandbox, network, isolation: rawArgs.isolation }, process.env);
  if (!triage.allowed) {
    logShellDispatch('isolation.rejected', { reason: triage.reason }, argsTrace);
    throw new Error(`RunShell rejected: ${triage.reason}`);
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
  // A bg handle returns immediately, so only blocking paths can hold the turn.
  // Note `mode:'bg'` without runner deps falls through to the blocking legacy path.
  const longSleep = mode === 'bg' && deps ? null : detectLongSleep(command, longSleepWarnSeconds());
  const resumeHint = longSleepResumeHint(opts.availableToolNames);
  if (longSleep) {
    debug.log('shell.run', 'long-sleep', {
      seconds: longSleep.seconds,
      pattern: longSleep.pattern,
      ...(longSleep.perIterationSeconds !== undefined ? { perIterationSeconds: longSleep.perIterationSeconds } : {}),
      limitSeconds: longSleep.limitSeconds,
      path: mode && deps ? 'runner' : 'legacy',
      resumeHint,
    });
  }
  const bgAvailable = getShellRunnerDeps() !== null;
  if (mode && deps) {
    let prepared: Awaited<ReturnType<typeof prepareRunnerRunShell>>;
    try {
      prepared = await prepareRunnerRunShell({ command, cwd: effectiveCwd, sessionId: opts.sessionId,
        signal: opts.signal, sandbox, network });
    } catch { prepared = null; }
    if (!prepared) {
      return { output: 'RunShell approval denied or unavailable', exitCode: null,
        outcome: opts.signal?.aborted ? 'aborted' : 'denied', elapsedMs: 0, stdout: '', stderr: '',
        truncated: false, approvalKey: 'runner:denied', sandboxed: false, sandboxTool: 'none' };
    }
    if (!prepared.grant) {
      const gated = await gateShellCommand({ command, cwd, approval, network, signal: opts.signal }, opts.priorHumanApproval);
      if (gated) return {
        output: formatSummary(gated), exitCode: gated.exitCode, outcome: gated.outcome,
        elapsedMs: gated.elapsedMs, stdout: gated.stdout, stderr: gated.stderr,
        truncated: gated.truncated, approvalKey: gated.approvalKey,
        sandboxed: gated.sandboxed, sandboxTool: gated.sandboxTool,
      };
    }
    const result = await dispatchViaRunner({
      command: prepared.command, cwd: resolve(effectiveCwd), timeoutMs, mode, description,
      grant: prepared.grant, sandboxed: prepared.sandboxed, sandboxTool: prepared.sandboxTool,
      ...(watch ? { watch } : {}), signal: opts.signal, ownerSessionId: opts.sessionId,
      deps, rawInternal: opts.rawInternal === true,
      ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
    });
    logShellDispatch(`runner.${result.outcome}`, { cwd: effectiveCwd, cwdSource }, argsTrace);
    // RSEM-RAW-RECEIPT — 내부 script-step 재귀는 원문 반환(외측 단일 출구에서 1회 마스킹).
    if (opts.rawInternal) return result;
    return withLongSleepWarning(result, longSleep, bgAvailable, resumeHint);
  }

  const result = await runShell({
    command,
    cwd,
    timeoutMs,
    ...(opts.scriptGitRead ? { env: { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } } : {}),
    approval,
    sandbox,
    network,
    envPolicy: 'allowlist',
    signal: opts.signal,
    runShellSessionId: opts.sessionId,
    ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
  }, opts.priorHumanApproval === true);

  logShellDispatch(`legacy.${result.outcome}`, { cwd: effectiveCwd, cwdSource }, argsTrace);
  const summary = result.watchdog ? `${result.watchdog.text}\n${formatSummary(result)}` : formatSummary(result);
  // RUNSHELL-OUTPUT-EGRESS-MASK — 모델로 나가는 결과 텍스트의 단일 출구(legacy 경로).
  // RSEM-RAW-RECEIPT — 내부 script-step 재귀 호출은 원문을 그대로 돌려준다(외측에서 1회 마스킹).
  if (opts.rawInternal) return withLongSleepWarning({
    ...(result.watchdog ? { watchdog: result.watchdog } : {}),
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
  }, longSleep, bgAvailable, resumeHint);
  return maskRunShellEgress(withLongSleepWarning({
    ...(result.watchdog ? { watchdog: result.watchdog } : {}),
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
  }, longSleep, bgAvailable, resumeHint));
}

/** RUNSHELL-OUTPUT-EGRESS-MASK (ROSTER-0333-60 · #39491과 같은 출구 원칙) — RunShell 결과의
 * 모델 가는 텍스트(output 요약·stdout·stderr)에 기존 공용 redactSecretText
 * (src/debug/secret-redaction.ts · gitleaks 이식 룰셋 · 새 정규식 0)를 1회 적용한다.
 * 파일 저장(outputFilePath)·감사 로그·shell-primitive 원문은 무변경 — 어디까지나 egress 경계다.
 *
 * RSEM-JSONFIX — 값 클래스가 백슬래시를 삼켜 escaped-quote(`\"`)의 이스케이프를 벗겨
 * JSON stdout 을 파손하는 회귀(redactSecretText 직접 적용 → parse fail). stdout 이
 * JSON.parse 에 성공하면 구조 보존 경로로 바꾼다: parse 는 유효성 판정만 — 마스킹은
 * 원문 텍스트 위 위치 기반 치환(maskJsonStringLiteralsInPlace · R2/R3). parse 실패 시(비-JSON stdout)는 기존 텍스트 축 폴백.
 * stderr/output 요약은 텍스트 축 그대로(stdout 만 구조 보존 경로).
 *
 * RSEM-JSONFIX-R2 (OP #128225 · JUD-B #128222) — 1차의 parse→재직렬화 경로가
 * `__proto__` own 키 삭제·2^53 초과 정수 변형을 일으켰다. 구조 재직렬화를 금지하고
 * 원문 텍스트 위에서 비밀이 든 문자열 리터럴(«값»·«키» 모두)을 위치 기반 치환한다.
 * RSEM-KEYFIX-R3 (jud-39537-6eb6a2057b8d · OP #128535) — 키도 같은 축으로 가린다:
 * 비밀이 객체 키(중첩 포함)에 들어가면 값만 가릴 때 모델 출력에 그대로 남는다. */
function redactSecretJsonText(value: string): string {
  return redactSecretText(value);
}

/** RSEM-JSONFIX-R2 · KEYFIX-R3 — 위치 기반 문자열 리터럴 치환(값·키 모두).
 * parse→객체 재구성→stringify 는 `__proto__` own 키를 지우고(out[k] = … 할당이
 * 프로토타입 설정으로 바뀜) 2^53 초과 정수를 Number 로 변형한다. 구조 재직렬화 금지:
 * 원문 stdout 을 그대로 두고 비밀 패턴이 든 문자열 리터럴(값·키 포함)의 그 위치 바이트를
 * redact 된 값의 JSON 인코딩으로 교체한다 — 숫자·원문 이스케이프·키 순서는 불변. */
function maskJsonStringLiteralsInPlace(stdout: string): string {
  const n = stdout.length;
  let out = '';
  let segStart = 0;
  let i = 0;
  while (i < n) {
    if (stdout.charCodeAt(i) !== 0x22 /* " */) { i++; continue; }
    // 문자열 리터럴 스캔 — 백슬래시 이스케이프 존중
    let j = i + 1;
    let closed = -1;
    while (j < n) {
      const c = stdout[j]!;
      if (c === '\\') { j += 2; continue; }
      if (c === '"') { closed = j; break; }
      j++;
    }
    if (closed < 0) return stdout; // 유효 JSON 에는 없는 짝 안 맞음 — 원문 그대로(fail-safe)
    const literal = stdout.slice(i, closed + 1);
    // KEYFIX-R3 — 키 리터럴도 값과 같은 축으로 가린다: 비밀이 키에 들어가면 값만
    // 가릴 때 모델 출력에 남는다(jud-39537-6eb6a2057b8d mustFix). 위치 기반 치환이므로
    // 키가 중복돼도(충돌) 출력은 그대로 유효 JSON — 비밀은 어느 쪽에도 없다.
    let replacement: string | null = null;
    try {
      const decoded = JSON.parse(literal) as string;
      const safe = redactSecretJsonText(decoded);
      if (safe !== decoded) replacement = JSON.stringify(safe);
    } catch { /* 리터럴 디코드 실패 — 원문 유지 */ }
    if (replacement !== null) {
      out += stdout.slice(segStart, i) + replacement;
      segStart = closed + 1;
    }
    i = closed + 1;
  }
  return segStart === 0 ? stdout : out + stdout.slice(segStart);
}

function maskJsonStdoutPreservingStructure(stdout: string): string {
  if (stdout.includes('"')) {
    try {
      JSON.parse(stdout); // 유효 JSON 판정만 — 재구성 없음
      return maskJsonStringLiteralsInPlace(stdout);
    } catch { /* 비-JSON stdout — 아래 텍스트 축 폴백 */ }
  }
  return redactSecretText(stdout); // 폴백: 리터럴 0·비-JSON 모두 텍스트 축 마스킹
}

export function maskRunShellEgress(result: RunShellDispatchResult, opts?: { rawInternal?: boolean }): RunShellDispatchResult {
  if (opts?.rawInternal) return result;
  return {
    ...result,
    output: redactSecretText(result.output),
    stdout: maskJsonStdoutPreservingStructure(result.stdout),
    stderr: redactSecretText(result.stderr),
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
  watch?: ShellLineWatchSpec;
  signal?: AbortSignal;
  deps: NonNullable<ReturnType<typeof getShellRunnerDeps>>;
  ownerSessionId?: string;
  onSpawn?: () => void;
  rawInternal?: boolean;
  grant?: import('../../shell-primitive/spawn-gateway.js').RunShellGatewayGrant;
  sandboxed: boolean;
  sandboxTool: ShellResult['sandboxTool'];
}): Promise<RunShellDispatchResult> {
  const req: Parameters<typeof runnerDispatch>[0] = {
    command: args.command,
    mode: args.mode,
    ...(args.grant ? { runShellGrant: args.grant } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
  let handle: ShellHandle;
  try {
    handle = runnerDispatch(req, args.deps, { ownerSessionId: args.ownerSessionId });
  } catch (error) {
    return { output: 'RunShell spawn failed', exitCode: null, outcome: 'spawn-error', elapsedMs: 0,
      stdout: '', stderr: error instanceof Error ? error.message : String(error), truncated: false,
      approvalKey: 'runner:spawn-error', sandboxed: args.sandboxed, sandboxTool: args.sandboxTool };
  }
  try { args.onSpawn?.(); } catch { /* the capsule clock is advisory */ }
  if (args.mode === 'bg') {
    if (args.watch) {
      startShellLineWatch({
        handle,
        spec: args.watch,
        ...(args.description !== undefined ? { label: args.description } : {}),
      });
    }
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
          result,
          ...(!ok ? { errorMessage: result.exitCode !== undefined
            ? `exitCode=${result.exitCode}` : result.failureReason ?? `outcome=${result.outcome}` } : {}),
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
      sandboxed: args.sandboxed,
      sandboxTool: args.sandboxTool,
    };
  }
  const result = await handle.result;
  // RSEM-RAW-RECEIPT — 내부 script-step 재귀는 원문 반환(외측 단일 출구에서 1회 마스킹).
  return maskRunShellEgress({ ...runnerToLegacyResult(handle.id, result), sandboxed: args.sandboxed, sandboxTool: args.sandboxTool }, { rawInternal: args.rawInternal === true });
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

/** CAPSULE-A2 — the RunShell result's capsule status (a watchdog stop is a timeout, an Esc/stop is cancelled). */
export function runShellCapsuleStatus(result: RunShellDispatchResult): CapsuleStatus {
  if (result.outcome === 'timeout' || result.watchdog) return 'timeout';
  if (result.outcome === 'aborted') return 'cancelled';
  return result.outcome === 'exit' && result.exitCode === 0 ? 'ok' : 'failed';
}

/** CAPSULE-A2 (JUD #38592 must ⓑ) — the detached call's completion text: the command's stdout, then its stderr, then the
 *  one-line summary last. RunShell keeps the streams outside `output`, so the summary alone would drop what the command
 *  printed; the notice keeps the tail (bounded · redacted in shell-capsule), so the summary and the output's end survive. */
export function runShellCapsuleNoticeText(result: RunShellDispatchResult): string {
  return [result.stdout.trimEnd(), result.stderr.trim() ? `--- stderr ---\n${result.stderr.trimEnd()}` : '', result.output]
    .filter(Boolean).join('\n');
}

/** CAPSULE-A2 — what the turn reads when its RunShell call moved to the background (model contract · A5 owns wording). */
export function runShellCapsuleStartedResult(capsuleId: string, syncCapMs: number): RunShellDispatchResult {
  return {
    output: `RunShell outcome=started capsule=${capsuleId} — still running after ${Math.round(syncCapMs / 1000)}s, so it moved `
      + 'to the background (same process, same timeout). Do not wait or poll for it: finish this turn. Its result arrives '
      + `as a new turn event (capsule-done ${capsuleId}).`,
    exitCode: null, outcome: 'started', elapsedMs: syncCapMs, stdout: '', stderr: '', truncated: false,
    approvalKey: `capsule:${capsuleId}`, sandboxed: false, sandboxTool: 'none',
  };
}

/** CAPSULE-A2-BASH-DETACH (RunShell) — `dispatchRunShell` under the capsule policy. `mode:'bg'` already returns at once
 *  and stays as is. The sync clock starts at spawn, so an approval wait never detaches a call. No switch (R3). */
export function dispatchRunShellCapsule(
  rawArgs: Record<string, unknown>,
  opts: { signal?: AbortSignal; availableToolNames?: readonly string[]; sessionId?: string; priorHumanApproval?: boolean;
    scriptApproval?: (command: string[], signal?: AbortSignal) => Promise<{ allowed: boolean; priorHumanApproval: boolean }> } = {},
  deps: Omit<ShellCapsuleDeps, 'policy'> & { readonly policy?: CapsulePolicy } = {},
): Promise<RunShellDispatchResult> {
  if (rawArgs.mode === 'bg') return dispatchRunShell(rawArgs, opts);
  const policy = deps.policy ?? shellCapsulePolicy(deps.correlation);
  const { signal, ...rest } = opts;
  const command = Array.isArray(rawArgs.command) ? rawArgs.command.filter((part) => typeof part === 'string').join(' ') : '';
  return runShellCapsule<RunShellDispatchResult>({
    tool: 'RunShell', command, clockFromSpawn: true,
    ...(signal ? { turnSignal: signal } : {}),
    start: (own, spawned) => dispatchRunShell(rawArgs, { ...rest, ...(own ? { signal: own } : {}), onSpawn: spawned }),
    describe: (result) => ({ status: runShellCapsuleStatus(result), output: runShellCapsuleNoticeText(result) }),
    started: runShellCapsuleStartedResult,
  }, { ...deps, policy });
}
