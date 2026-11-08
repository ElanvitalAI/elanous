import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Skill execution tools ──
//
// A tool bridge for `executeSkill` so Claude Code-style SKILL.md files
// (which document shell invocations in their body: `npx tsx ...`,
// `python3 ...`, `node ...`, etc.) actually run instead of getting
// role-played by the LLM. Before this, `streamLLM` fed the skill body
// as prose to a tool-less provider; the model hallucinated plausible
// "results" instead of executing anything. See HANDOFF session-12
// phase-5 for the architectural context.
//
// Design choices, mirrored against claude-code-fork's BashTool:
//
//   - SINGLE `Bash` tool, no language-specific runners. python/node/
//     tsx/bun all invoke via `bash -c "python3 foo.py"` etc. PATH is
//     inherited from the process (which elanous launched from the user's
//     zsh / bash), so the relevant binaries are reachable.
//
//   - Default 120s timeout, cap 600s — matches claude-code's
//     `DEFAULT_TIMEOUT_MS` / `MAX_TIMEOUT_MS`. Skill frontmatter can
//     override within the cap.
//
//   - Output cap 200KB. If exceeded, keep head + tail with a truncation
//     marker so the model can still reason about shape of output
//     without blowing the context window.
//
//   - Non-zero exit → prepend `[exit N]` so the model notices and
//     doesn't quietly succeed on a failed run.
//
//   - No login shell (`-l`). Login pulls ~/.bash_profile / .profile
//     which can be slow and usually duplicates what process.env already
//     carries. If a user needs login-specific setup they can add
//     `shell: bash -l` in SKILL.md frontmatter later.
//
//   - Abort via AbortSignal → SIGTERM. Intentionally simple; no
//     tree-kill — skills that background-spawn their own children are
//     responsible for cleanup.

import { spawn } from 'node:child_process';

import { harnessCommandWriteReject, notifyHarnessCommandStart } from '../../harness/harness-write-boundary.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from '../../feedback/envelope.js';

/** Per-invocation tuning knobs. Defaults come from SkillManifest
 *  fields (`shell`, `bashTimeoutMs`) so skill authors can tweak
 *  without editing elanous. */
export interface BashToolOpts {
  /** CWD for spawned subprocesses. Almost always the skill directory —
   *  that's where scripts/ lives in a typical claude-code skill. */
  cwd: string;
  /** Interpreter to exec. Default 'bash'. 'zsh' / 'sh' fallbacks when
   *  the author expects that shell. Rejected values fall back to 'bash'. */
  shell?: string;
  /** Default timeout when the model doesn't specify one on the call.
   *  Clamped to [1000, 600000]. */
  defaultTimeoutMs?: number;
  /** Upper bound — even if the model asks for longer, we cap here.
   *  Clamped to [1000, 600000]. Default 600000 (10 min). */
  maxTimeoutMs?: number;
  /** Max chars of combined stdout+stderr we hand back to the model.
   *  Past this we keep head + tail with a truncation marker. Default
   *  200_000. */
  maxOutputChars?: number;
  /** Propagated to the spawned child. When the dashboard aborts the
   *  streaming LLM call, the in-flight bash subprocess is killed. */
  signal?: AbortSignal;
  /** Sandbox mode (Track G — shares runShell's X3 wrapper). Default
   *  'off' keeps existing Bash behaviour; 'auto' wraps the shell
   *  binary in sandbox-exec on macOS; 'strict' errors when the
   *  platform has no sandbox. */
  sandbox?: 'off' | 'auto' | 'strict';
  /** Network policy paired with sandbox. 'inherit' (default) or
   *  'off'. Only enforced when sandbox !== 'off'. */
  network?: 'inherit' | 'off';
  // ── M3 tool.progress envelope wire (PLAN-ios-rich-dev-feedback-hydrate · 2026-05-13) ──
  /** ACP/daemon session id. Required for emit (envelope.sessionId routing). */
  sessionId?: string;
  /** Per-turn emitter wired from `DaemonToolDispatchCtx.emitFeedback`.
   *  When absent the runtime path stays unchanged — pure-skill callers
   *  (Discord/Telegram bots) pay nothing. */
  emitFeedback?: (env: FeedbackEnvelope) => void;
  /** Parent ACP toolCallId — surfaces on envelope for renderer correlation. */
  toolCallId?: string;
}

const DEFAULTS = {
  shell: 'bash',
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputChars: 200_000,
};

/** Allowed interpreters. Anything outside this falls back to bash for
 *  safety — otherwise a typo in frontmatter could spawn an unintended
 *  binary. */
const ALLOWED_SHELLS = new Set(['bash', 'zsh', 'sh']);

/** Public shape of what dispatchBash returns — also used by tests. */
export interface BashResult {
  stdout: string;
  stderr: string;
  /** Combined output after truncation, ready for tool_result. When
   *  the exit code is non-zero we prepend `[exit N]` so the model
   *  notices. */
  output: string;
  exitCode: number | null;
  /** True when we killed the process for running past the timeout. */
  timedOut: boolean;
  /** True when the user-supplied AbortSignal fired (dashboard Esc). */
  aborted: boolean;
  durationMs: number;
  /** Track G: mirrors ShellResult.sandboxed — true when argv went
   *  through sandbox-exec (or equivalent) wrapper. False when
   *  opts.sandbox was 'off' or the platform has no wrapper. */
  sandboxed?: boolean;
  /** Which sandbox tool was used; omitted when sandboxed=false. */
  sandboxTool?: 'sandbox-exec' | 'bwrap' | 'none';
}

/** The tool spec LLMs see. Schema deliberately narrow: just `command`
 *  and an optional `timeout`. No `run_in_background` (skills are
 *  request-response, and background processes complicate cleanup).
 *  No `description` field — the model's natural language around the
 *  call serves that purpose. */
export function buildBashTool(): LLMToolSpec {
  return {
    name: 'Bash',
    description:
      'Execute a ONE-SHOT shell command inside the skill directory (runs, captures output, exits — no session state persists between calls, no live screen). ' +
      'Use for scripts (python3, node, tsx, bun), file inspection (cat, ls, head), and quick fire-and-forget shell work. ' +
      'DO NOT use Bash when the user EXPLICITLY names a shell/terminal — any of: ' +
      '"PtyShell", "헤드리스 쉘", "쉘로", "셸로", "쉘에서", "터미널로", "터미널에서", "터미널 세션", "shell", "terminal", ' +
      '"interactive/persistent shell" — or when the task needs a live REPL, a dev-server/watch process, mid-run input, ' +
      'or observing the terminal SCREEN. For ALL of those use PtyShellStart (then PtyShellSnapshot / PtyShellSend / ' +
      'PtyShellScreenshot to observe and drive it). Rule of thumb: if the user said "shell/terminal/쉘/터미널", use PtyShell, not Bash. ' +
      'Output is captured and returned as a string. ' +
      // AU3 — explicit ask-first guidance on destructive patterns. Mirrors ' +
      // claude-code-fork/src/tools/BashTool/prompt.ts:82-94 pattern.
      'If the command you plan to run is destructive or privileged (rm -rf, ' +
      'git push --force, DROP TABLE, mkfs, sudo, schema drops) AND the user ' +
      'did not explicitly request that exact action, call AskUserQuestion FIRST ' +
      'to confirm. The runtime also has a Guardian that will force an approval ' +
      'modal for these patterns, but the user experience is better when you ask ' +
      'up front rather than after the modal fires.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. Can be a pipeline or multi-statement; runs via `bash -c` (or the skill-configured shell).',
        },
        timeout: {
          type: 'number',
          description: 'Optional per-call timeout in milliseconds. Capped by the skill runner\'s max (default 600000).',
        },
        sandbox: {
          type: 'string',
          enum: ['off', 'auto', 'strict'],
          description: "Sandbox mode. 'off' (default) runs the shell unwrapped; 'auto' wraps via platform sandbox (macOS sandbox-exec) when available; 'strict' errors when no sandbox exists.",
        },
        network: {
          type: 'string',
          enum: ['inherit', 'off'],
          description: "Network policy when sandbox is active. 'inherit' (default) or 'off' to block network syscalls.",
        },
      },
      required: ['command'],
    },
  };
}

/** The dispatch half: takes the args the LLM handed to the `Bash` tool
 *  call, actually runs it, returns a stringified result suitable for
 *  feeding back via tool_result. */
export async function dispatchBash(
  args: Record<string, unknown>,
  opts: BashToolOpts,
): Promise<BashResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) {
    return emptyResult('(no command supplied)');
  }
  const boundaryReject = harnessCommandWriteReject(command, opts.cwd, 'bash');
  if (boundaryReject) return rejectedResult(boundaryReject);

  const shell = opts.shell && ALLOWED_SHELLS.has(opts.shell) ? opts.shell : DEFAULTS.shell;
  const defaultTimeout = clamp(opts.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs, 1000, DEFAULTS.maxTimeoutMs);
  const maxTimeout = clamp(opts.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs, 1000, DEFAULTS.maxTimeoutMs);
  const requested = typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : defaultTimeout;
  const timeout = clamp(requested, 1000, maxTimeout);
  const maxOutput = opts.maxOutputChars ?? DEFAULTS.maxOutputChars;
  // Per-call overrides win over opts (LLM-supplied sandbox/network
  // on the tool call take priority over the dashboard-default).
  const sandboxMode = (typeof args.sandbox === 'string' && ['off', 'auto', 'strict'].includes(args.sandbox))
    ? (args.sandbox as 'off' | 'auto' | 'strict')
    : opts.sandbox;
  const networkMode = (typeof args.network === 'string' && ['inherit', 'off'].includes(args.network))
    ? (args.network as 'inherit' | 'off')
    : opts.network;

  // Sandbox wrapping (Track G). Reuses the same applySandbox the
  // shell-primitive uses — keeps one canonical SBPL profile across
  // Bash and RunShell.
  let sandboxed = false;
  let sandboxTool: BashResult['sandboxTool'] = 'none';
  let sandboxedArgv: string[] = [shell, '-c', command];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { applySandbox, SandboxUnavailableError } = require('../../shell-primitive/sandbox.js');
    const d = applySandbox({
      command: sandboxedArgv,
      cwd: opts.cwd,
      network: networkMode,
      sandbox: sandboxMode,
    });
    sandboxedArgv = d.command;
    sandboxed = d.sandboxed;
    sandboxTool = d.tool;
    // If strict mode threw above we'd be in the catch — normal
    // early return with [spawn-error] style output.
    void SandboxUnavailableError;
  } catch (err) {
    if (err instanceof Error && err.name === 'SandboxUnavailableError') {
      const msg = `[sandbox unavailable: ${err.message}]`;
      return Promise.resolve({
        stdout: '', stderr: msg, output: msg, exitCode: 127,
        timedOut: false, aborted: false, durationMs: 0,
        sandboxed: false, sandboxTool: 'none',
      });
    }
    // Any other error: leave sandboxedArgv unchanged; direct spawn below.
  }

  const started = Date.now();

  // ── M3 tool.progress envelope emit (#XX · PLAN-ios-rich-dev-feedback-hydrate) ──
  // Wire is opt-in: only fires when caller supplies sessionId + emitFeedback
  // (daemon-tools/index.ts:dispatchChatTool path). Pure-skill callers
  // (Discord/Telegram bots) leave both fields undefined → fast path skip.
  const emitEnabled = !!(opts.sessionId && opts.emitFeedback);
  const seqTracker = emitEnabled ? createSeqTracker() : null;
  const bashBlockId = emitEnabled
    ? `${opts.sessionId}:bash:${opts.toolCallId ?? Date.now().toString(36)}`
    : '';
  let bytesSoFar = 0;
  const emitProgress = (
    phase: 'start' | 'delta' | 'end',
    stream: 'stdout' | 'stderr' | 'generic',
    lines: readonly string[],
    exitCode?: number | null,
  ): void => {
    if (!emitEnabled || !opts.emitFeedback || !seqTracker || !opts.sessionId) return;
    let env: FeedbackEnvelope;
    try {
      env = makeEnvelope(
        {
          kind: 'tool.progress',
          sessionId: opts.sessionId,
          blockId: bashBlockId,
          phase,
          payload: {
            stream,
            lines: [...lines],
            ...(bytesSoFar > 0 ? { bytesSoFar } : {}),
            ...(phase === 'end' && exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
          },
          asciiFallback: lines.slice(-3).map((l) => `[${stream}] ${l}`),
          ...(opts.toolCallId ? { parentToolCallId: opts.toolCallId } : {}),
        },
        seqTracker,
      );
    } catch {
      return;
    }
    try { opts.emitFeedback(env); }
    catch { /* swallow — emit must not break the turn */ }
  };

  // start envelope — command preview (truncated to 200 chars) so user
  // sees what's about to run before output streams.
  if (emitEnabled) {
    const commandPreview = command.length > 200 ? command.slice(0, 200) + '…' : command;
    emitProgress('start', 'generic', [`$ ${commandPreview}`]);
  }

  return new Promise<BashResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    // Pending lines buffer for coalesced delta emits (80ms tick).
    let pendingOut: string[] = [];
    let pendingErr: string[] = [];
    let stdoutLeftover = '';
    let stderrLeftover = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = (): void => {
      flushTimer = null;
      if (pendingOut.length > 0) {
        const lines = pendingOut; pendingOut = [];
        emitProgress('delta', 'stdout', lines);
      }
      if (pendingErr.length > 0) {
        const lines = pendingErr; pendingErr = [];
        emitProgress('delta', 'stderr', lines);
      }
    };
    const scheduleFlush = (): void => {
      if (flushTimer || !emitEnabled) return;
      flushTimer = setTimeout(flushDelta, 80);
    };

    void notifyHarnessCommandStart(command, opts.cwd, 'bash');
    const child = spawn(sandboxedArgv[0]!, sandboxedArgv.slice(1), {
      cwd: opts.cwd,
      // `detached` makes the child a process-GROUP leader so a timeout /
      // `/cancel` abort can kill the WHOLE tree (the shell AND any
      // grandchildren it spawned — e.g. `sleep`, a python loop). Without it,
      // SIGTERM hits only the shell and an orphaned grandchild keeps the
      // stdout pipe open, so the tool hangs until it finishes on its own.
      detached: true,
      env: {
        ...process.env,
        // Mirrors claude-code-fork's env override — some skills check
        // this flag to adjust output format when run under an agent.
        CLAUDECODE: '1',
      },
    });

    // Kill the child's whole process group (negative pid). Falls back to a
    // direct child kill if the group signal fails (e.g. child already gone).
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // Escalate if SIGTERM doesn't land within 2s — skills that
      // swallow SIGTERM get SIGKILLed.
      setTimeout(() => killTree('SIGKILL'), 2000).unref();
    }, timeout);

    const onAbort = () => {
      aborted = true;
      killTree('SIGTERM');
      // Escalate to SIGKILL for the whole group if SIGTERM is swallowed.
      setTimeout(() => killTree('SIGKILL'), 2000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stdout += s;
      if (emitEnabled) {
        bytesSoFar += Buffer.byteLength(s, 'utf8');
        stdoutLeftover += s;
        const parts = stdoutLeftover.split('\n');
        stdoutLeftover = parts.pop() ?? '';
        // Push completed lines (cap each at 1KB to avoid envelope bloat).
        for (const line of parts) {
          pendingOut.push(line.length > 1024 ? line.slice(0, 1024) + '…' : line);
        }
        // Hard cap on pending buffer (a runaway loop shouldn't queue 1000s).
        if (pendingOut.length > 50) pendingOut = pendingOut.slice(-50);
        scheduleFlush();
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stderr += s;
      if (emitEnabled) {
        bytesSoFar += Buffer.byteLength(s, 'utf8');
        stderrLeftover += s;
        const parts = stderrLeftover.split('\n');
        stderrLeftover = parts.pop() ?? '';
        for (const line of parts) {
          pendingErr.push(line.length > 1024 ? line.slice(0, 1024) + '…' : line);
        }
        if (pendingErr.length > 50) pendingErr = pendingErr.slice(-50);
        scheduleFlush();
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

      // Flush any pending coalesced lines + leftover (no trailing \n).
      if (emitEnabled) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (stdoutLeftover.length > 0) {
          pendingOut.push(stdoutLeftover.length > 1024 ? stdoutLeftover.slice(0, 1024) + '…' : stdoutLeftover);
          stdoutLeftover = '';
        }
        if (stderrLeftover.length > 0) {
          pendingErr.push(stderrLeftover.length > 1024 ? stderrLeftover.slice(0, 1024) + '…' : stderrLeftover);
          stderrLeftover = '';
        }
        flushDelta();
        // Pick dominant stream for the end envelope's `stream` field —
        // stderr wins when present (errors are louder UX-wise).
        const endStream: 'stdout' | 'stderr' | 'generic' = stderr.length > 0 ? 'stderr' : 'stdout';
        const tailSummary: string[] = [];
        if (timedOut) tailSummary.push(`[timed out after ${timeout}ms]`);
        else if (aborted) tailSummary.push('[aborted]');
        else tailSummary.push(`[exit ${exitCode ?? '?'}]`);
        emitProgress('end', endStream, tailSummary, exitCode);
      }

      const durationMs = Date.now() - started;
      const combined = joinStreams(stdout, stderr);
      const { text: truncated, wasTruncated } = truncate(combined, maxOutput);
      let output = truncated;
      if (timedOut) output = `[timed out after ${timeout}ms]\n${output}`;
      else if (aborted) output = `[aborted]\n${output}`;
      else if (exitCode !== 0 && exitCode !== null) output = `[exit ${exitCode}]\n${output}`;
      if (wasTruncated) output += `\n[... output truncated at ${maxOutput} chars ...]`;

      resolve({ stdout, stderr, output, exitCode, timedOut, aborted, durationMs, sandboxed, sandboxTool });
    };

    child.on('error', (err) => {
      // Most common case: shell binary not found. Surface as stderr
      // so the model can react ("zsh not installed, falling back...").
      stderr += `spawn error: ${err.message}\n`;
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}

// ── internals ──

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function emptyResult(msg: string): BashResult {
  return {
    stdout: '', stderr: msg, output: msg, exitCode: 0,
    timedOut: false, aborted: false, durationMs: 0,
    sandboxed: false, sandboxTool: 'none',
  };
}

function rejectedResult(msg: string): BashResult {
  return {
    stdout: '', stderr: msg, output: `[exit 1]\n${msg}`, exitCode: 1,
    timedOut: false, aborted: false, durationMs: 0,
    sandboxed: false, sandboxTool: 'none',
  };
}

function joinStreams(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}--- stderr ---\n${stderr}`;
}

/** Keep head + tail when output exceeds the cap. The model generally
 *  cares about (a) the start (context, command echo) and (b) the
 *  tail (final result, error message) — the middle is usually
 *  progress spam. */
function truncate(text: string, maxChars: number): { text: string; wasTruncated: boolean } {
  if (text.length <= maxChars) return { text, wasTruncated: false };
  const headSize = Math.floor(maxChars * 0.4);
  const tailSize = maxChars - headSize - 32;   // 32-char buffer for the marker
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  return {
    text: `${head}\n\n[... ${text.length - headSize - tailSize} chars elided ...]\n\n${tail}`,
    wasTruncated: true,
  };
}
