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
//     override within the cap. A201: the values live in
//     src/tool-runtime/shell-watchdog.ts (shared with RunShell) together
//     with the no-output stall line (내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG`).
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

import { debug } from '../../debug/log.js';
import { harnessCommandWriteReject, notifyHarnessCommandStart } from '../../harness/harness-write-boundary.js';
import {
  SHELL_DEFAULT_TIMEOUT_MS, SHELL_KILL_GRACE_MS, SHELL_MAX_TIMEOUT_MS, SHELL_MIN_TIMEOUT_MS,
  createShellWatchdog, reportShellWatchdog, resolveShellStallMs, type ShellWatchdogResult,
} from '../../tool-runtime/shell-watchdog.js';
import { knownLongShellRunner, type CapsulePolicy, type CapsuleStatus } from '../../turn-capsule/contract.js';
import { runShellCapsule, shellCapsulePolicy, type ShellCapsuleDeps } from '../../turn-capsule/shell-capsule.js';
import { terminateTree } from '../../shell-primitive/terminate-tree.js';
import { gateShellCommand } from '../../shell-primitive/runtime.js';
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
  /** A201 — no-output stall line (ms). Default SHELL_STALL_NO_OUTPUT_MS or env
   *  ELANOUS_SHELL_STALL_MS; non-positive disables. */
  stallMs?: number;
  /** Max chars of combined stdout+stderr we hand back to the model.
   *  Past this we keep head + tail with a truncation marker. Default
   *  200_000. */
  maxOutputChars?: number;
  /** Propagated to the spawned child. When the dashboard aborts the
   *  streaming LLM call, the in-flight bash subprocess is killed. */
  signal?: AbortSignal;
  /** Host-only proof: the current command passed a prior human approval prompt. Never sourced from tool args. */
  priorHumanApproval?: boolean;
  /** Capsule clock starts only after the process exists, never during approval. */
  onSpawn?: () => void;
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
  // A201 — the shared shell constants (src/tool-runtime/shell-watchdog.ts) so Bash and RunShell cap alike.
  defaultTimeoutMs: SHELL_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: SHELL_MAX_TIMEOUT_MS,
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
  /** A201 — set when the watchdog stopped the process (timeout or no-output stall). */
  watchdog?: ShellWatchdogResult;
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
        run_in_background: {
          type: 'boolean',
          description: 'true = start in the background now (for a command you know runs for minutes). The turn gets a capsule id at once; continue other work or end the turn — a new turn opens with the output when it finishes. Known long runners (bun run test:deterministic, pregate, els update-all, rail scripts) start in the background on their own.',
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
  const defaultTimeout = clamp(opts.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs, SHELL_MIN_TIMEOUT_MS, DEFAULTS.maxTimeoutMs);
  const maxTimeout = clamp(opts.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs, SHELL_MIN_TIMEOUT_MS, DEFAULTS.maxTimeoutMs);
  const requested = typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : defaultTimeout;
  const timeout = clamp(requested, SHELL_MIN_TIMEOUT_MS, maxTimeout);
  const stallMs = resolveShellStallMs(opts.stallMs);
  const maxOutput = opts.maxOutputChars ?? DEFAULTS.maxOutputChars;
  // Per-call overrides win over opts (LLM-supplied sandbox/network
  // on the tool call take priority over the dashboard-default).
  const sandboxMode = (typeof args.sandbox === 'string' && ['off', 'auto', 'strict'].includes(args.sandbox))
    ? (args.sandbox as 'off' | 'auto' | 'strict')
    : opts.sandbox;
  const networkMode = (typeof args.network === 'string' && ['inherit', 'off'].includes(args.network))
    ? (args.network as 'inherit' | 'off')
    : opts.network;

  const gate = await gateShellCommand({
    command: [shell, '-c', command], cwd: opts.cwd,
    approval: 'none', signal: opts.signal, network: networkMode,
  }, opts.priorHumanApproval === true);
  if (gate) return rejectedResult(gate.outcome === 'aborted' ? 'shell command aborted before execution' : 'shell command denied by approval');

  // Sandbox wrapping (Track G). Reuses the same applySandbox the
  // shell-primitive uses — keeps one canonical SBPL profile across
  // Bash and RunShell.
  let sandboxed = false;
  let sandboxTool: BashResult['sandboxTool'] = 'none';
  // ELN-BASH-BG-DETACH — a command that explicitly backgrounds work
  // (`nohup` / `setsid` / a trailing `&`) must not stay in the shell's
  // process group. The watchdog kills that group on timeout, and bash
  // waits for an undisowned `&` job, so the background child died with
  // the tool return (MVP-B `nohup … &` lasted ~1s). A python setsid
  // grandchild leaves only that child in a new session (macOS has no
  // `setsid` binary); the shell stays killable.
  const launched = detachExplicitBackground(command);
  // r5 — the rewritten single simple command setsids out of the group before
  // the shell exits, so its pipes close with the shell and 'close' settles the
  // tool (the detached job surviving IS the feature). A verbatim `&` job
  // instead stays in the tool's process group and inherits the pipes, so
  // 'close' can only fire once that job itself ends — settle on the shell's
  // exit instead (listener wired at the child events below).
  const strayJob = launched === command && hasBackgroundJob(command);
  let sandboxedArgv: string[] = [shell, '-c', launched];
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
    try { opts.onSpawn?.(); } catch { /* the capsule clock is advisory */ }

    // Stop the exact child's own process group via the shared terminateTree (KILL-TREE-ONE):
    // SIGTERM → grace → SIGKILL while the group is still present. Each signal that is actually
    // sent is a tool.watchdog event, in order. If an escaped grandchild (setsid/daemon) still
    // holds the output pipe, 'close' never comes — force the result after a second grace so
    // the tool cannot hang past its limit (A201).
    const stopChild = (): void => {
      void terminateTree(child, {
        group: true,
        graceMs: SHELL_KILL_GRACE_MS,
        sendSignal: (addr, sig) => {
          if (sig === 'SIGTERM' || sig === 'SIGKILL') debug.log('tool.watchdog', 'kill', { tool: 'Bash', signal: sig, pid: child.pid ?? null });
          process.kill(addr, sig);
        },
      });
      setTimeout(() => {
        if (settled) return;
        debug.log('tool.watchdog', 'forced-close', { tool: 'Bash', pid: child.pid ?? null });
        try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
        finish(null);
      }, SHELL_KILL_GRACE_MS * 2).unref();
    };

    // A201 — wall-clock timeout ⊕ no-output stall line, one watchdog per process.
    const watchdog = createShellWatchdog({
      tool: 'Bash',
      timeoutMs: timeout,
      stallMs,
      onFire: (result) => {
        if (settled) return;
        if (result.status === 'timeout') timedOut = true;
        reportShellWatchdog(result, { pid: child.pid ?? null });
        stopChild();
      },
    });

    const onAbort = () => {
      aborted = true;
      watchdog.stop();
      stopChild();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (c: Buffer) => {
      watchdog.touch();
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
      watchdog.touch();
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
      watchdog.stop();
      const fired = watchdog.fired;
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
        if (fired) tailSummary.push(fired.text);
        else if (timedOut) tailSummary.push(`[timed out after ${timeout}ms]`);
        else if (aborted) tailSummary.push('[aborted]');
        else tailSummary.push(`[exit ${exitCode ?? '?'}]`);
        emitProgress('end', endStream, tailSummary, exitCode);
      }

      const durationMs = Date.now() - started;
      const combined = joinStreams(stdout, stderr);
      const { text: truncated, wasTruncated } = truncate(combined, maxOutput);
      let output = truncated;
      if (fired) output = `${fired.text}\n${output}`;
      else if (timedOut) output = `[timed out after ${timeout}ms]\n${output}`;
      else if (aborted) output = `[aborted]\n${output}`;
      else if (exitCode !== 0 && exitCode !== null) output = `[exit ${exitCode}]\n${output}`;
      if (wasTruncated) output += `\n[... output truncated at ${maxOutput} chars ...]`;

      resolve({ stdout, stderr, output, exitCode, timedOut, aborted, durationMs, sandboxed, sandboxTool,
        ...(fired ? { watchdog: fired } : {}) });
    };

    child.on('error', (err) => {
      // Most common case: shell binary not found. Surface as stderr
      // so the model can react ("zsh not installed, falling back...").
      stderr += `spawn error: ${err.message}\n`;
      finish(127);
    });
    child.on('close', (code) => finish(code));
    // ELN-BASH-BG-DETACH r5 — a verbatim `&` job holds the output pipes past
    // the shell's exit, so 'close' would stall the tool until that job ends
    // (or the watchdog fires). The shell exiting completed every foreground
    // command, so drain one grace of pipe tail — the foreground's last
    // writes — then stop the process group the tool owns (the exited shell
    // leaves its strays to us; only a deliberate setsid detach outlives the
    // result) and settle with the shell's own exit code.
    child.on('exit', (code) => {
      if (!strayJob || settled) return;
      setTimeout(() => {
        if (settled) return;
        debug.log('tool.watchdog', 'bg-settle', { tool: 'Bash', pid: child.pid ?? null });
        stopChild();
        finish(code ?? null);
      }, SHELL_BG_EXIT_DRAIN_MS).unref();
    });
  });
}

/** CAPSULE-A2 — the Bash result's capsule status: a watchdog stop is a timeout, an Esc/stop is cancelled. */
export function bashCapsuleStatus(result: BashResult): CapsuleStatus {
  if (result.timedOut || result.watchdog) return 'timeout';
  if (result.aborted) return 'cancelled';
  return result.exitCode === 0 ? 'ok' : 'failed';
}

/** CAPSULE-A2 — what the turn reads when its Bash call moved to the background. Wording is the model contract (A5 owns
 *  the tool descriptions): do not poll, continue other work or end the turn — the completion wakes a new turn. */
export function bashCapsuleStartedResult(capsuleId: string, syncCapMs: number): BashResult {
  const output = `[capsule shell ${capsuleId} started] Running in background · will wake on completion — still running after `
    + `${Math.round(syncCapMs / 1000)}s (same process, same timeout). If this turn has other work, continue it; otherwise `
    + 'end the turn with one line saying you are waiting for it — a new turn opens with its output '
    + `(capsule-done ${capsuleId}) when it finishes. Do not poll or sleep for it.`;
  return { stdout: '', stderr: '', output, exitCode: null, timedOut: false, aborted: false, durationMs: syncCapMs };
}

/** CAPSULE-A2-BASH-DETACH — `dispatchBash` under the capsule policy: past `syncCapMs` (shell: 60s) the same process continues
 *  as a shell capsule (no switch since CAPSULE-FLAGS-REMOVE-DEFAULT). */
export function dispatchBashCapsule(
  args: Record<string, unknown>,
  opts: BashToolOpts,
  deps: Omit<ShellCapsuleDeps, 'policy'> & { readonly policy?: CapsulePolicy } = {},
): Promise<BashResult> {
  const policy = deps.policy ?? shellCapsulePolicy(deps.correlation);
  const { signal, ...rest } = opts;
  return runShellCapsule<BashResult>({
    tool: 'Bash',
    command: typeof args.command === 'string' ? args.command : '',
    // RUNSHELL-BG-ENDS-TURN ② — explicit request or a known long runner (executable + subcommand) starts detached.
    ...(args.run_in_background === true || knownLongShellRunner(typeof args.command === 'string' ? args.command : '') !== null
      ? { requestedBackground: true } : {}),
    ...(signal ? { turnSignal: signal } : {}),
    clockFromSpawn: true,
    start: (own, spawned) => dispatchBash(args, own ? { ...rest, signal: own, onSpawn: spawned } : { ...rest, onSpawn: spawned }),
    describe: (result) => ({ status: bashCapsuleStatus(result), output: result.output }),
    started: bashCapsuleStartedResult,
  }, { ...deps, policy });
}

// ── internals ──

/** ELN-BASH-BG-DETACH r5 — pipe-tail drain window after the shell exits
 * (before the tool stops its own process group) for a verbatim `&` job. */
const SHELL_BG_EXIT_DRAIN_MS = 50;

/**
 * ELN-BASH-BG-DETACH r6 — strip here-document bodies from `command`.
 * A body is data: quotes, escapes, comments, and operators inside it are literal text, so an
 * unquoted `&` in a body is content, never a job terminator. The operator line itself is kept —
 * its own `&` is real command text (`cat <<EOF &` backgrounds the heredoc command). The body runs
 * from the line after the operator line to the line equal to the delimiter (tab-stripped for
 * `<<-`). An unterminated body consumes the rest of the text, so no body `&` is ever seen.
 *
 * ELN-BASH-BG-DETACH r9 (JUD #123951): one operator line may open several here-documents
 * (`cat <<A; cat <<B`) — every delimiter on it is opened and each body runs to its own
 * terminator, in order, the first body ending first. A delimiter word is read after any run of
 * blanks (`cat << EOF`, `cat << -EOF` are valid bash); the tab-strip flag is only `<<-`.
 *
 * ELN-BASH-BG-DETACH r10 (JUD #124088): an operator we cannot positively parse is never
 * SKIPPED — a skipped body resurfaces as command text and its data `&` is misread as a job
 * (a false early settle). Unconfirmed syntax (unreadable or partial delimiter) returns null
 * and the caller detects no job at all: the command settles normally.
 */
function stripHeredocBodies(command: string): string | null {
  const kept: string[] = [];
  const open: Array<{ delim: string; stripTabs: boolean }> = [];
  for (const line of command.split('\n')) {
    if (open.length > 0) {
      const front = open[0]!;
      const candidate = front.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === front.delim) open.shift(); // the terminator line ends this body
      continue; // body line: content, never command text
    }
    kept.push(line);
    const starts = heredocStarts(line);
    if (starts === null) return null; // JUD #124088: unconfirmed syntax — no job is detected at all
    open.push(...starts);
  }
  return kept.join('\n');
}

/** Every here-document start on `line`: `<<[-]WORD`, with WORD bare or quoted, read after any run
 *  of blanks (`<< EOF`, `<< -EOF` are valid bash; the tab-strip flag stays `<<-`). `<<<`
 *  (here-string) is operator text, not a start.
 *
 * ELN-BASH-BG-DETACH r10 (JUD #124088): the scan keeps only syntax it can positively confirm.
 * The delimiter is the FULL word (a prefix would close the body early and expose its data `&`
 * as a job), and an unreadable delimiter — end of line, a metacharacter, a comment, an escape or
 * a command substitution, an unterminated quote, or a word glued after one (`<<"EOF"x`) —
 * returns null: the whole command is unconfirmed and no job is detected at all. */
function heredocStarts(line: string): Array<{ delim: string; stripTabs: boolean }> | null {
  const starts: Array<{ delim: string; stripTabs: boolean }> = [];
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = undefined; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') { i += 2; continue; } // here-string: operator text, not a body start
      let j = i + 2;
      const stripTabs = line[j] === '-';
      if (stripTabs) j += 1;
      while (line[j] === ' ' || line[j] === '\t') j += 1; // a spaced word is still the delimiter
      const q = line[j];
      if (q === '"' || q === "'") {
        const end = line.indexOf(q, j + 1);
        if (end < 0) return null; // unterminated quote: unconfirmed syntax, no job detection
        // a word glued after the closing quote (`<<"EOF"x`) needs quote removal we do not model
        const next = line.slice(end + 1).charAt(0);
        if (next !== '' && next !== ' ' && next !== '\t' && !/[;&|()<>]/.test(next)) return null;
        starts.push({ delim: line.slice(j + 1, end), stripTabs });
        i = end;
        continue;
      }
      // no delimiter word here — end of line, a metacharacter, or a comment/escape/substitution
      // start — is syntax we cannot confirm: the scan stops and no job is detected.
      if (q === '#' || q === '`' || q === '\\') return null;
      const word = /^[^\s;&|()<>`'"\\]+/.exec(line.slice(j));
      if (!word) return null;
      // the word must be whole: quoting glued to its end (`<<EOF"x`) is not modeled — unconfirmed
      const after = line.slice(j + word[0].length).charAt(0);
      if (after === '"' || after === "'" || after === '`' || after === '\\') return null;
      starts.push({ delim: word[0], stripTabs });
      i = j + word[0].length - 1;
      continue;
    }
  }
  return starts;
}

/**
 * Whether `command` — as a shell parses it — really backgrounds a job: an
 * `&` outside quotes, escapes, comments, and here-document bodies that is
 * neither the `&&` list operator nor the `&>` / `>&` redirects. Bash makes
 * such an `&` a command terminator (also after `;`, `&&`, or `|`), so the job
 * runs in the tool's process group and inherits its output pipes.
 *
 * ELN-BASH-BG-DETACH r6 (JUD hold-39412-0e006d8a9f88 mustFix): an unquoted
 * `&` inside a here-document body is content, not a job terminator, so the
 * bodies are stripped before the scan. A form we cannot positively parse
 * (here-string `<<<`, malformed or unterminated heredoc) keeps normal
 * settlement: a missed early settle is safe, a false one is not.
 */
export function hasBackgroundJob(command: string): boolean {
  const stripped = stripHeredocBodies(command);
  // JUD #124088 (10th HOLD): syntax the scan cannot positively confirm — an unreadable or a
  // partial delimiter — stops job detection entirely: the command settles normally.
  return stripped === null ? false : hasBackgroundJobText(stripped);
}

/** ELN-BASH-BG-DETACH r6 — the operator scanner itself, run on heredoc-stripped text. */
function hasBackgroundJobText(command: string): boolean {
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let comment = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (comment) {
      if (ch === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = quote !== "'";
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    // `#` opens a comment only at a word start; a mid-word `#` is literal.
    if (ch === '#' && (i === 0 || /\s/.test(command[i - 1]!))) { comment = true; continue; }
    if (ch === '&') {
      if (command[i + 1] === '&' || command[i + 1] === '>') continue;
      if (command[i - 1] === '&' || command[i - 1] === '>') continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether `whole` — the text before the trailing background `&` — is one
 * simple command: a single word list whose only shell syntax is quoting,
 * escapes, and output redirects. Quotes hide their content and an escape
 * hides the next character. Anything that would make this more than one
 * command — a `;` or newline separator, a `|` pipeline, another `&` job
 * (`>&1` is a redirect, not a job), a `()`/`{}` group, a `#` comment, `<`
 * input redirection, or a `<<` here-document — or an unbalanced quote
 * returns false, and the caller keeps the original text (fail-safe default).
 */
function isOneSimpleCommand(whole: string): boolean {
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  const masked = whole.split('');
  for (let i = 0; i < whole.length; i += 1) {
    const ch = whole[i]!;
    if (quote) {
      masked[i] = ' ';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = quote !== "'";
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (escaped) { masked[i] = ' '; escaped = false; continue; }
    if (ch === '\\') { masked[i] = ' '; escaped = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; masked[i] = ' '; continue; }
    // More than one command, or syntax we do not model, keeps the original.
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '<' || ch === '#'
      || ch === '(' || ch === ')' || ch === '{' || ch === '}') return false;
    if (ch === '&' && whole[i - 1] !== '>') return false;
    masked[i] = ch;
  }
  if (quote !== undefined || escaped) return false;
  const text = masked.join('');
  if (!text.trim()) return false;
  // A loop, a conditional, or a case block is not a simple command either.
  return !/\b(?:while|until|for|select|if|case|do|done|fi|esac)\b/.test(text);
}

/** A bash single-quoted literal. The outer shell must not expand `$`, backticks, or newlines. */
function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Rewrite an explicitly-backgrounded command so its child leaves the
 * shell process group before the tool returns.
 *
 * Only one simple command with a trailing `&` is rewritten, and it detaches
 * verbatim — `nohup` kept, quotes and redirect scope intact. Every other
 * shape — a separator, a newline, a pipeline, an and-list, a loop, a group,
 * a comment, a here-document — keeps the original text, so timeout and abort
 * still stop the whole group the shell started, and no fresh bash runs the
 * job without the leading foreground's shell state (JUD #120509).
 */
export function detachExplicitBackground(command: string): string {
  const body = command.trim();
  if (!body || /(?:^|&&|\|\||;|\n)\s*setsid(?:\s|$)/.test(body)) return command;
  // `&>` / `>&` is a foreground redirect, not a background job. Only a real
  // trailing `&` — nothing after it, and not `&&` — marks the job.
  const job = body.match(/^([\s\S]*\S)\s+&(?!>)(?!&)$/);
  if (!job) return command;
  // ELN-BASH-BG-DETACH r4 — only one simple command detaches, whole. Every
  // other shape keeps the original text (fail-safe default).
  const whole = job[1]!;
  if (!isOneSimpleCommand(whole)) return command;
  // The job detaches verbatim — redirects inside it — so the redirect scope is
  // preserved. `nohup` is part of the command, not noise to peel: stripping it
  // changes the command's own signal behavior (JUD #120509 mustFix).
  // macOS has no `setsid` binary. python3 calls setsid(2), then replaces
  // itself with the original command. The command is a single-quoted argv
  // so the outer shell does not expand `$`, backticks, or newlines first.
  const quoted = bashSingleQuote(whole);
  return `python3 -c 'import os,sys; os.setsid(); os.execvp("bash",["bash","-c",sys.argv[1]])' ${quoted} >/dev/null 2>&1 </dev/null &`;
}

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
