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
import { debug, redactSecretText, redactSecrets } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { getUserConfig } from '../../user-config.js';
import { SCHEDULE_WAKEUP_TOOL_NAME } from './schedule-wakeup.js';
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
  const argsTrace = boundedShellArgsText(rawArgs);
  if (command[0] === 'cd') {
    logShellDispatch('cd.rejected', { reason: 'argv-state-does-not-persist' }, argsTrace);
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
    const result = await dispatchViaRunner({
      command, cwd, timeoutMs, mode, description,
      signal: opts.signal,
      deps,
    });
    logShellDispatch(`runner.${result.outcome}`, { cwd: effectiveCwd, cwdSource }, argsTrace);
    return withLongSleepWarning(result, longSleep, bgAvailable, resumeHint);
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

  logShellDispatch(`legacy.${result.outcome}`, { cwd: effectiveCwd, cwdSource }, argsTrace);
  const summary = formatSummary(result);
  return withLongSleepWarning({
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
