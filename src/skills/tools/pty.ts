// Native tools: pty_shell_{start, poll, send, kill}
//
// Long-running interactive process support for skills that need
// REPLs, watch processes, or any tool that produces output over
// time and accepts mid-stream input. Inspired by codex's
// unified_exec/exec_command + write_stdin pair.
//
// Use Bash for one-shot commands. Use these for:
//   • python / node / bun REPLs the LLM drives turn-by-turn
//   • dev servers (`bun run dev`) where you want to wait for
//     "ready" then send signal-style input
//   • watch processes (`bun test --watch`) — poll until a test
//     fails, react, send 'r' to re-run
//
// Probe-gated on node-pty installability; skill discipline prompt
// hides these tools when the dep is absent.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMToolSpec } from '../../llm.js';
import { ALLOWED_TERM_NAMES, getPty, listPty, ptyAvailable, startPty, unregisterPty } from '../../pty-shell/registry.js';
// listPty is imported above — re-exported here via dispatchPtyShellList so
// callers don't need to reach into pty-shell/registry.ts.
import { truncateOutput } from '../../output-truncation.js';
import { requestConfirmation } from '../../hitl/confirm.js';
import { debug } from '../../debug/log.js';
import { harnessCommandWriteReject, resolveHarnessBoundary } from '../../harness/harness-write-boundary.js';
import { getHarnessSpace } from '../../harness/harness-space.js';
import { writePtyWithOutcome } from '../../pty-shell/pty-write-outcome.js';
import { findSshHost, listSshHosts, type SshHost } from '../../ssh/ssh-hosts.js';

const ptyBoundaryWorkdirs = new Map<string, string>();

/** ⛔ 자연 종료·외부 unregister 경로에는 훅이 없다 — `kill` 로만 지우면 항목이 남는다
 *  (무인 리뷰 should-fix). 레지스트리에서 사라졌거나 죽은 PTY 의 항목을 걷어낸다.
 *  ⚠️ 이벤트가 아니라 **스윕**인 이유: registry 가 종료 훅을 노출하지 않아 구독할 자리가 없다.
 *  start 마다 한 번 도는 O(n) 이고 n 은 살아 있는 PTY 수라 사실상 상수다. */
function pruneBoundaryWorkdirs(): void {
  for (const id of [...ptyBoundaryWorkdirs.keys()]) {
    const handle = getPty(id);
    if (!handle || !handle.isAlive()) ptyBoundaryWorkdirs.delete(id);
  }
}
const DEFAULT_YIELD_MS = 800;
const MAX_YIELD_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

// ─── start ───────────────────────────────────────────────────────

export function buildPtyShellStartTool(): LLMToolSpec {
  return {
    name: 'PtyShellStart',
    description:
      'Spawn a long-running process under a PTY. Returns a process_id you use with PtyShellPoll/PtyShellSend/PtyShellKill. ' +
      'Use for REPLs (python, node, bun), dev servers, or watch processes — anything where Bash\'s one-shot model is wrong. ' +
      'Max 8 concurrent. Auto-killed when the skill returns unless detach:true.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Command to execute. Plain executable path runs directly; anything with shell metacharacters wraps in `sh -c`.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Args passed positionally (only honored when cmd is a plain executable).' },
        workdir: { type: 'string', description: 'cwd for the spawned process.' },
        env: { type: 'object', description: 'Env vars merged into process.env.' },
        shell: { type: 'string', description: 'Override $SHELL when wrapping in sh -c.' },
        cols: { type: 'integer', description: 'PTY column width. Default 80.' },
        rows: { type: 'integer', description: 'PTY row height. Default 24.' },
        detach: { type: 'boolean', description: 'When true, survive past skill return. Default false.' },
        term: { type: 'string', description: `Terminfo name forwarded to node-pty and child $TERM. Defaults to xterm-256color. Use xterm-ghostty when the host terminal is Ghostty. Allowed: ${[...ALLOWED_TERM_NAMES].join(', ')}.` },
        yield_time_ms: { type: 'integer', description: `Wait this long before returning the initial output snapshot. Default ${DEFAULT_YIELD_MS}, capped ${MAX_YIELD_MS}.` },
        // PV3 — advisory visibility. Skill-runner PtyShell sessions are
        // already internal (no UI attachment), so this param is informational
        // here; it becomes load-bearing when a downstream caller promotes
        // the PTY into the terminal-matrix (spec.visibility flows through
        // at that point). Set to 'llm-only' when running a TUI you want
        // to verify without showing the user.
        visibility: {
          type: 'string',
          enum: ['user', 'llm-only', 'both'],
          description: 'PTY visibility: user = rendered; llm-only = invisible (snapshot-only); both = both. Default both. See MANUAL §6 hints to set a session-scope param-default.',
        },
        sshHost: {
          type: 'string',
          description:
            'Optional registered SSH host name (from ssh-hosts). When set, opens the PTY on that fleet node via `ssh -t` instead of locally. Unknown names are rejected with the known host list — they never fall back to local.',
        },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  };
}

export interface PtyStartArgs {
  cmd: string;
  args?: string[];
  workdir?: string;
  env?: Record<string, string>;
  shell?: string;
  cols?: number;
  rows?: number;
  detach?: boolean;
  term?: string;
  yield_time_ms?: number;
  /** PV3 — advisory for this layer (see tool description). */
  visibility?: 'user' | 'llm-only' | 'both';
  /** Registered ssh-hosts.ts name. When set, spawn is `ssh -t <resolved-target>`. */
  sshHost?: string;
}

/** Extra options for dispatch — used by the dashboard wiring to
 *  gate PTY spawning behind an HITL prompt. Skill-runner does NOT
 *  pass these: back-compat path is "no approval required". */
export interface PtyDispatchOpts {
  /** When true, call the approver before actually spawning. Default
   *  false so skill-runner behavior is unchanged. */
  requireApproval?: boolean;
  /** DI for tests + for routing approval through a non-default HITL
   *  channel set. Defaults to requestConfirmation() with registered
   *  channels from src/hitl/confirm.ts. Must return true to proceed. */
  approver?: (req: { cmd: string; args?: string[]; cwd?: string }) => Promise<boolean>;
  /** L1 self-dev — fail-OPEN the approval when no responder answers
   *  (headless/autonomous coding context). PTY is a coding tool, so this
   *  never leaks to the trade path. Forwarded to `requestConfirmation`;
   *  ignored when a custom `approver` is supplied. Default false. */
  failOpen?: boolean;
}

async function defaultApprover(
  req: { cmd: string; args?: string[]; cwd?: string },
  policy?: { failOpen?: boolean },
): Promise<boolean> {
  const detail = [
    req.cmd + (req.args && req.args.length ? ' ' + req.args.join(' ') : ''),
    req.cwd ? `(cwd: ${req.cwd})` : null,
  ].filter(Boolean).join('\n');
  const res = await requestConfirmation({
    prompt: 'Allow dashboard to spawn PTY shell?',
    detail,
    yesLabel: 'Allow',
    noLabel: 'Deny',
    ...(policy?.failOpen ? { failOpen: true } : {}),
  });
  return res.answer;
}

export async function dispatchPtyShellStart(
  rawArgs: Record<string, unknown>,
  opts: PtyDispatchOpts = {},
): Promise<{ output: string }> {
  const args = validateStart(rawArgs);
  // Keep the self-nest guard at the shared production boundary: the daemon
  // tool surface and the skills runner both reach this dispatcher.
  const { decideTuiSelfNest } = await import('../../agent/terminal-surface.js');
  const selfNest = decideTuiSelfNest([args.cmd, ...(args.args ?? [])]);
  if (selfNest.reject) return { output: selfNest.output ?? '' };
  const boundaryReject = harnessCommandWriteReject([args.cmd, ...(args.args ?? [])], args.workdir ?? process.cwd(), 'pty-start');
  if (boundaryReject) return { output: boundaryReject };
  if (!ptyAvailable()) {
    throw new Error('PtyShell tools unavailable — node-pty not installed');
  }
  const spawn = resolvePtyStartSpawn(args);
  if (opts.requireApproval) {
    const approver = opts.approver
      ?? ((req) => defaultApprover(req, { failOpen: opts.failOpen }));
    const approved = await approver({
      cmd: spawn.cmd, args: spawn.args, cwd: args.workdir,
    });
    if (!approved) {
      return { output: `PtyShellStart denied by user (cmd=${spawn.cmd})` };
    }
  }
  const handle = startPty({
    cmd: spawn.cmd,
    args: spawn.args,
    workdir: args.workdir,
    env: args.env,
    shell: args.shell,
    cols: args.cols,
    rows: args.rows,
    detach: args.detach,
    term: args.term,
    accessMode: 'auto',
  });
  const yieldMs = Math.min(args.yield_time_ms ?? DEFAULT_YIELD_MS, MAX_YIELD_MS);
  await sleep(yieldMs);
  const initial = handle.drainDelta(DEFAULT_MAX_BYTES);
  const status = handle.isAlive() ? 'running' : `exited ${handle.exitCode}`;
  pruneBoundaryWorkdirs();   // 죽은 PTY 항목 회수(위 주석) — 새로 심기 전에 한 번.
  if (resolveHarnessBoundary(process.env, args.workdir ?? process.cwd())) {
    ptyBoundaryWorkdirs.set(handle.id, args.workdir ?? process.cwd());
  }
  const visTag = args.visibility && args.visibility !== 'both' ? ` visibility=${args.visibility}` : '';
  return {
    output: `PtyShellStart process_id=${handle.id} status=${status}${visTag}\n${initial}`,
  };
}

// ─── poll ────────────────────────────────────────────────────────

export function buildPtyShellPollTool(): LLMToolSpec {
  return {
    name: 'PtyShellPoll',
    description: 'Read newly accumulated output from a PTY shell. Bounded by yield_time_ms (waits before reading) + max_bytes.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
        yield_time_ms: { type: 'integer', description: `Wait this long before reading. Default ${DEFAULT_YIELD_MS}, capped ${MAX_YIELD_MS}.` },
        max_bytes: { type: 'integer', description: `Read cap. Default ${DEFAULT_MAX_BYTES}.` },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPtyShellPoll(rawArgs: Record<string, unknown>): Promise<{ output: string }> {
  const args = validatePoll(rawArgs);
  const handle = getPty(args.process_id);
  if (!handle) throw new Error(`unknown process_id ${args.process_id}`);
  const yieldMs = Math.min(args.yield_time_ms ?? DEFAULT_YIELD_MS, MAX_YIELD_MS);
  await sleep(yieldMs);
  const delta = handle.drainDelta(args.max_bytes ?? DEFAULT_MAX_BYTES);
  const status = handle.isAlive() ? 'running' : `exited ${handle.exitCode}`;
  // P15: spill large poll output to /tmp/elanous-output so a noisy
  // watch process doesn't dump 64KB of test logs into model context.
  const trimmed = truncateOutput(delta, { toolName: 'pty_shell_poll', ext: 'log' });
  return {
    output: `PtyShellPoll process_id=${handle.id} status=${status} bytes=${delta.length}\n${trimmed.output}`,
  };
}

// ─── send ────────────────────────────────────────────────────────

export function buildPtyShellSendTool(): LLMToolSpec {
  return {
    name: 'PtyShellSend',
    description: 'Send characters to a PTY shell\'s stdin (e.g. REPL input, signal keys like ^C as "\\u0003"). Returns output that arrives within yield_time_ms.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
        input: { type: 'string', description: 'Bytes to write. Add a trailing "\\n" for line input.' },
        yield_time_ms: { type: 'integer', description: `Wait this long after writing before reading the response. Default ${DEFAULT_YIELD_MS}, capped ${MAX_YIELD_MS}.` },
      },
      required: ['process_id', 'input'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPtyShellSend(rawArgs: Record<string, unknown>): Promise<{ output: string; submitNormalized: boolean }> {
  const args = validateSend(rawArgs);
  const handle = getPty(args.process_id);
  if (!handle) throw new Error(`unknown process_id ${args.process_id}`);
  if (!handle.isAlive()) throw new Error(`process ${handle.id} already exited (${handle.exitCode})`);
  const workdir = ptyBoundaryWorkdirs.get(handle.id);
  // ⛔ start 와 **대칭**이어야 한다(무인 리뷰 must-fix). start 는 경계를 못 구하면 메타데이터를
  //    안 심고 그대로 **허용**하는데, send 가 `getHarnessSpace()` 만 보고 거부하면 같은 상황에서
  //    start 는 되고 send 는 안 되는 비대칭이 생긴다 — 불변식 *"경계 미상이면 개입하지 않는다"*
  //    위반이기도 하다. ⇒ **지금 경계를 구할 수 있을 때만** 메타데이터 부재를 거부 사유로 쓴다.
  if (getHarnessSpace() && !workdir && resolveHarnessBoundary(process.env, process.cwd())) {
    throw new Error('격리 경계 쓰기 판정 거부: 경계 메타데이터가 없는 기존 PTY에는 명령을 주입할 수 없다. 격리 worktree 내부에서 새 PTY를 시작하라.');
  }
  if (workdir) {
    const boundaryReject = harnessCommandWriteReject(args.input, workdir, 'pty-send');
    if (boundaryReject) return { output: boundaryReject, submitNormalized: false };
  }
  const { input, trailingNewline, submitNormalized } = normalizePtySubmit(args.input);
  const outcome = writePtyWithOutcome(handle, input, 'agent');
  debug.log('pty.arbiter', 'control-settled', {
    id: handle.id,
    action: 'input-text',
    actor: 'agent',
    outcome,
  });
  if (outcome === 'denied') {
    return {
      output: `PtyShellSend 쓰기 거부 process_id=${handle.id}: 이 PTY 는 사람이 쓰기 소유(human write ownership)를 가졌거나 자율 모드가 아니라 에이전트 쓰기가 막혔다. 사람에게 \`elanous pty release ${handle.id}\` 로 자율에 돌려 달라고 요청하라.`,
      submitNormalized: false,
    };
  }
  if (outcome === 'write-failed') {
    return {
      output: `PtyShellSend 쓰기 실패 process_id=${handle.id}: PTY 입력을 전달하지 못했다.`,
      submitNormalized: false,
    };
  }
  debug.log('pty.shell-send', 'submit-normalized', {
    trailingNewline,
    submitNormalized,
    inputLength: args.input.length,
  });
  const yieldMs = Math.min(args.yield_time_ms ?? DEFAULT_YIELD_MS, MAX_YIELD_MS);
  await sleep(yieldMs);
  const delta = handle.drainDelta(DEFAULT_MAX_BYTES);
  const status = handle.isAlive() ? 'running' : `exited ${handle.exitCode}`;
  return {
    output: `PtyShellSend process_id=${handle.id} status=${status} bytes=${delta.length} submitNormalized=${submitNormalized}\n${delta}`,
    submitNormalized,
  };
}

// ─── kill ────────────────────────────────────────────────────────

export function buildPtyShellKillTool(): LLMToolSpec {
  return {
    name: 'PtyShellKill',
    description: 'Terminate a PTY shell. Default SIGTERM; pass signal:"SIGKILL" to force. Returns final output snapshot.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
        signal: { type: 'string', description: 'Signal name. Default SIGTERM.' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPtyShellKill(rawArgs: Record<string, unknown>): Promise<{ output: string }> {
  const args = validateKill(rawArgs);
  const handle = getPty(args.process_id);
  if (!handle) throw new Error(`unknown process_id ${args.process_id}`);
  const wasAlive = handle.isAlive();
  if (wasAlive) handle.kill(args.signal as NodeJS.Signals);
  // Give the process a moment to flush.
  await sleep(150);
  const finalSnapshot = handle.snapshot();
  unregisterPty(args.process_id);
  ptyBoundaryWorkdirs.delete(args.process_id);
  return {
    output: `PtyShellKill process_id=${handle.id} killed=${wasAlive} exit=${handle.exitCode}\n${finalSnapshot}`,
  };
}

// ─── list ────────────────────────────────────────────────────────
// S3: visibility into what the dashboard has spawned. Read-only,
// no approval, no side-effects — safe to expose at any surface.

export function buildPtyShellListTool(): LLMToolSpec {
  return {
    name: 'PtyShellList',
    description: 'List active PTY processes (dashboard + skill scope combined). Returns one line per process with id, cmd, detach flag, alive state, and age. Use before Kill/Send when you don\'t have the process_id handy.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export function dispatchPtyShellList(): { output: string } {
  const entries = listPty();
  if (entries.length === 0) {
    return { output: 'PtyShellList — no active processes' };
  }
  const now = Date.now();
  const lines = entries.map(h => {
    const ageMs = now - h.startedAt;
    const ageSec = Math.floor(ageMs / 1000);
    const age = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m${ageSec % 60}s`;
    const alive = h.isAlive() ? 'running' : `exited ${h.exitCode}`;
    const detach = h.detach ? 'detach' : 'auto-kill';
    const cmd = h.cmd.length > 40 ? h.cmd.slice(0, 39) + '…' : h.cmd;
    return `  ${h.id}  ${alive.padEnd(12)} ${detach.padEnd(10)} age=${age.padEnd(8)} cmd="${cmd}"`;
  });
  return {
    output: `PtyShellList — ${entries.length} process(es)\n${lines.join('\n')}`,
  };
}

// ─── snapshot ────────────────────────────────────────────────────
// Renders the CURRENT terminal screen (emulator grid) as text — what a
// human would see right now. Use for full-screen TUIs (vim, htop, less,
// git log pager) whose redraws are unreadable as a concatenated byte
// delta. PtyShellPoll stays the tool for streaming line-oriented output.

export function buildPtyShellSnapshotTool(): LLMToolSpec {
  return {
    name: 'PtyShellSnapshot',
    description:
      'Render the CURRENT screen of a PTY process as text (the live terminal grid — cursor position included). ' +
      'Use for full-screen TUIs (vim · htop · less · pagers) where PtyShellPoll\'s raw byte delta is unreadable. ' +
      'Use PtyShellPoll for streaming line output; use this to "look at the screen" of an interactive app.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPtyShellSnapshot(rawArgs: Record<string, unknown>): Promise<{ output: string }> {
  if (typeof rawArgs.process_id !== 'string') throw new Error(`'process_id' is required`);
  const handle = getPty(rawArgs.process_id);
  if (!handle) throw new Error(`unknown process_id ${rawArgs.process_id}`);
  const status = handle.isAlive() ? 'running' : `exited ${handle.exitCode}`;
  const screen = await handle.renderScreen();
  return { output: `PtyShellSnapshot process_id=${handle.id} status=${status}\n${screen}` };
}

// ─── resize ──────────────────────────────────────────────────────
// Change the PTY size (cols × rows). Sends SIGWINCH so full-screen apps
// re-layout, and resizes the screen emulator so PtyShellSnapshot matches.

export function buildPtyShellResizeTool(): LLMToolSpec {
  return {
    name: 'PtyShellResize',
    description:
      'Resize a PTY process to cols × rows (sends SIGWINCH so full-screen TUIs re-layout). ' +
      'The default spawn size is 80×24; enlarge before running apps that need more room (e.g. a wide git log or a full-screen editor).',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
        cols: { type: 'integer', description: 'New column count (min 2).' },
        rows: { type: 'integer', description: 'New row count (min 2).' },
      },
      required: ['process_id', 'cols', 'rows'],
      additionalProperties: false,
    },
  };
}

export function dispatchPtyShellResize(rawArgs: Record<string, unknown>): { output: string } {
  if (typeof rawArgs.process_id !== 'string') throw new Error(`'process_id' is required`);
  if (typeof rawArgs.cols !== 'number' || typeof rawArgs.rows !== 'number') {
    throw new Error(`'cols' and 'rows' must be numbers`);
  }
  const handle = getPty(rawArgs.process_id);
  if (!handle) throw new Error(`unknown process_id ${rawArgs.process_id}`);
  const cols = Math.max(2, Math.floor(rawArgs.cols));
  const rows = Math.max(2, Math.floor(rawArgs.rows));
  handle.resize(cols, rows);
  return { output: `PtyShellResize process_id=${handle.id} → ${cols}x${rows}` };
}

// ─── screenshot ──────────────────────────────────────────────────
// Renders the CURRENT screen (emulator grid) to a PNG and returns a
// pointer to it (_imageFile). A surface that can deliver inline images
// (Telegram) picks that up and attaches it; text-only surfaces just show
// the `output` line. Use when the user asks to SEE the screen ("show" /
// "캡처화면" / "화면 보여줘") OR when the model judges a picture conveys a
// full-screen layout better than text.

/** Result carries an optional image pointer. The delivering surface
 *  (e.g. telegram-agent's dispatch wrapper) reads `_imageFile`, attaches
 *  it, and strips these fields before the LLM sees the result. */
export interface PtyScreenshotResult {
  output: string;
  _imageFile?: string;
  _imageCaption?: string;
}

export function buildPtyShellScreenshotTool(): LLMToolSpec {
  return {
    name: 'PtyShellScreenshot',
    description:
      'Render the CURRENT screen of a PTY process as a PNG IMAGE and attach it to the reply (on surfaces that support inline images, e.g. Telegram). ' +
      'Use when the user asks to SEE / show / capture the screen ("화면 보여줘", "캡처화면", "show image"), OR when you judge a picture conveys a full-screen layout (a TUI, a chart, colored output) better than text. ' +
      'For reading/parsing screen CONTENT prefer PtyShellSnapshot (text); use this when a visual is wanted.',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string' },
      },
      required: ['process_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchPtyShellScreenshot(rawArgs: Record<string, unknown>): Promise<PtyScreenshotResult> {
  if (typeof rawArgs.process_id !== 'string') throw new Error(`'process_id' is required`);
  const handle = getPty(rawArgs.process_id);
  if (!handle) throw new Error(`unknown process_id ${rawArgs.process_id}`);
  const png = await handle.renderScreenPng();
  if (!png) {
    return { output: `PtyShellScreenshot process_id=${handle.id} — image unavailable (emulator/renderer missing). Use PtyShellSnapshot for the screen as text.` };
  }
  const file = join(tmpdir(), `elanous-pty-${handle.id}-${Date.now()}.png`);
  try {
    writeFileSync(file, png);
  } catch (err) {
    return { output: `PtyShellScreenshot process_id=${handle.id} — render ok (${png.length}B) but write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const cmd = handle.cmd.length > 30 ? handle.cmd.slice(0, 29) + '…' : handle.cmd;
  return {
    output: `PtyShellScreenshot process_id=${handle.id} — rendered current screen (${png.length}B PNG), attached as image.`,
    _imageFile: file,
    _imageCaption: `PtyShell: ${cmd}`,
  };
}

// ─── helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

type PtyTrailingNewline = 'lf' | 'crlf' | 'cr' | 'none';

function normalizePtySubmit(input: string): { input: string; trailingNewline: PtyTrailingNewline; submitNormalized: boolean } {
  if (input.endsWith('\r\n')) {
    return { input: input.slice(0, -2) + '\r', trailingNewline: 'crlf', submitNormalized: true };
  }
  if (input.endsWith('\n')) {
    return { input: input.slice(0, -1) + '\r', trailingNewline: 'lf', submitNormalized: true };
  }
  if (input.endsWith('\r')) {
    return { input, trailingNewline: 'cr', submitNormalized: false };
  }
  return { input, trailingNewline: 'none', submitNormalized: false };
}

/** Keep unknown-sshHost errors one physical line even when the input or a
 *  registry name carries Unicode Cc (C0/DEL/C1, including NEL U+0085) or
 *  line/paragraph separators. Each control becomes a visible escape. */
function oneLineSshToken(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, (ch) => {
    switch (ch) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: {
        const code = ch.charCodeAt(0);
        return code > 0xff
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : `\\x${code.toString(16).padStart(2, '0')}`;
      }
    }
  });
}

function knownSshHostNames(): string {
  return listSshHosts().map(h => oneLineSshToken(h.name)).join(', ');
}

function unknownSshHostError(name: string): Error {
  return new Error(`unknown sshHost '${oneLineSshToken(name)}' — known: ${knownSshHostNames()}`);
}

/** D22: `ssh -t <user@host|host>` only. ~/.ssh/config + agent forwarding stay in charge. */
function resolveSshTarget(host: SshHost): string {
  return host.user ? `${host.user}@${host.host}` : host.host;
}

function resolvePtyStartSpawn(args: PtyStartArgs): { cmd: string; args?: string[] } {
  if (args.sshHost === undefined) {
    return { cmd: args.cmd, args: args.args };
  }
  const host = findSshHost(args.sshHost);
  if (!host) throw unknownSshHostError(args.sshHost);
  return { cmd: 'ssh', args: ['-t', resolveSshTarget(host)] };
}

function validateStart(raw: Record<string, unknown>): PtyStartArgs {
  const cmd = raw.cmd;
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    throw new Error(`'cmd' is required`);
  }
  const args = raw.args;
  if (args !== undefined && (!Array.isArray(args) || !args.every(s => typeof s === 'string'))) {
    throw new Error(`'args' must be string[]`);
  }
  const vis = raw.visibility;
  if (vis !== undefined && vis !== 'user' && vis !== 'llm-only' && vis !== 'both') {
    throw new Error(`'visibility' must be one of 'user' | 'llm-only' | 'both'`);
  }
  const sshHost = raw.sshHost;
  if (sshHost !== undefined) {
    if (typeof sshHost !== 'string' || sshHost.trim().length === 0) {
      throw new Error(`'sshHost' must be a non-empty string`);
    }
    if (!findSshHost(sshHost)) throw unknownSshHostError(sshHost);
  }
  return {
    cmd,
    args: args as string[] | undefined,
    workdir: raw.workdir as string | undefined,
    env: raw.env as Record<string, string> | undefined,
    shell: raw.shell as string | undefined,
    cols: raw.cols as number | undefined,
    rows: raw.rows as number | undefined,
    detach: raw.detach as boolean | undefined,
    term: raw.term as string | undefined,
    yield_time_ms: raw.yield_time_ms as number | undefined,
    visibility: vis as PtyStartArgs['visibility'],
    sshHost: sshHost as string | undefined,
  };
}

function validatePoll(raw: Record<string, unknown>): { process_id: string; yield_time_ms?: number; max_bytes?: number } {
  if (typeof raw.process_id !== 'string') throw new Error(`'process_id' is required`);
  return {
    process_id: raw.process_id,
    yield_time_ms: raw.yield_time_ms as number | undefined,
    max_bytes: raw.max_bytes as number | undefined,
  };
}

function validateSend(raw: Record<string, unknown>): { process_id: string; input: string; yield_time_ms?: number } {
  if (typeof raw.process_id !== 'string') throw new Error(`'process_id' is required`);
  if (typeof raw.input !== 'string') throw new Error(`'input' must be a string`);
  return {
    process_id: raw.process_id,
    input: raw.input,
    yield_time_ms: raw.yield_time_ms as number | undefined,
  };
}

function validateKill(raw: Record<string, unknown>): { process_id: string; signal?: string } {
  if (typeof raw.process_id !== 'string') throw new Error(`'process_id' is required`);
  return {
    process_id: raw.process_id,
    signal: raw.signal as string | undefined,
  };
}
