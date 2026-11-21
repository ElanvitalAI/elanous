import { SHELL_MAX_TIMEOUT_MS, type ShellWatchdogResult } from '../tool-runtime/shell-watchdog.js';
// ── Ephemeral shell primitive — types ──
//
// Codex PTY port X1 (DESIGN-codex-pty-port.md §3). Defines the
// request/result/approval shapes shared between runtime, approval
// cache, and the skill-tool surface.
//
// Scope: one-shot argv execution for skills + internal agents. NOT
// a Bash tool replacement:
//
//   • Bash (LLM-facing)  — `bash -c "<string>"`, models reason about
//     shells + pipes; caller is an external LLM API.
//   • runShell (internal) — argv[] direct exec, no shell involvement,
//     internal callers (skill runner, routers, diagnostics).
//
// argv[0] is the binary (or relative path); argv[1..] are flags and
// positional args. This mirrors codex's ShellRequest exactly.

export interface ShellRequest {
  /** Executable + args. spawn(argv[0], argv.slice(1)) — no shell
   *  involvement, so no quoting rules to worry about. */
  command: string[];
  /** Working directory. Defaults to getSessionCwd() when unset (WD5). */
  cwd?: string;
  /** Hard timeout. Default DEFAULT_TIMEOUT_MS; capped at MAX_TIMEOUT_MS.
   *  Reaches child via SIGTERM; escalates to SIGKILL after 2s if the
   *  child swallows SIGTERM. */
  timeoutMs?: number;
  /** Env vars MERGED into process.env for the child (child copies the
   *  parent env; keys here override). */
  env?: Record<string, string>;
  /** Approval policy.
   *   'none'         — run unconditionally (skill author trusted).
   *   'first-time'   — prompt on first instance of this commandKey,
   *                    cache the decision for the session.
   *   'always'       — prompt every single time.
   *  Default 'none' so existing callers (skill-runner routines that
   *  already gate via the manifest) don't suddenly pop modals. */
  approval?: 'none' | 'first-time' | 'always';
  /** Network policy. Enforcement via X3 sandbox wrapper when
   *  `sandbox !== 'off'`. With sandbox off the field is recorded on
   *  the result for audit purposes but no runtime block happens. */
  network?: 'inherit' | 'off';
  /** Sandbox mode (X3).
   *    'off'    — run argv directly (default, back-compat)
   *    'auto'   — wrap via platform sandbox if available, fall back
   *               to direct exec silently when not
   *    'strict' — wrap; throw SandboxUnavailableError if platform
   *               has no implementation */
  sandbox?: 'off' | 'auto' | 'strict';
  /** Caller-supplied AbortSignal for cancellation. Composes with the
   *  timeout — either source kills the child. */
  signal?: AbortSignal;
  /** CAPSULE-A2 — called once the process is spawned (after any approval wait): the capsule sync clock starts here. */
  onSpawn?: () => void;
  /** Max bytes captured per stream (stdout + stderr). Past this,
   *  head+tail with truncation marker. Default SHELL_MAX_OUTPUT. */
  maxOutputChars?: number;
}

export interface ShellResult {
  /** Process exit code. null when the child was killed before exit
   *  (timeout / abort / missing binary). */
  exitCode: number | null;
  /** Full captured stdout (may be truncated — see `truncated`). */
  stdout: string;
  /** Full captured stderr (may be truncated). */
  stderr: string;
  /** Wall clock from runShell() call to child exit. */
  elapsedMs: number;
  /** Synthetic key identifying this command (cwd + argv). Same
   *  request → same key, even across sessions. Used by the approval
   *  cache (X2). */
  approvalKey: string;
  /** Reason the run ended the way it did. Helps the audit log
   *  distinguish timeout from user-abort from natural exit. */
  outcome: 'exit' | 'timeout' | 'aborted' | 'denied' | 'spawn-error';
  /** True when stdout or stderr got truncated at maxOutputChars. */
  truncated: boolean;
  /** Set when outcome === 'spawn-error' — e.g. binary not found. */
  spawnError?: string;
  /** True when the child was launched through a sandbox wrapper.
   *  See `sandboxTool` for which one. */
  sandboxed: boolean;
  /** Sandbox tool used — 'none' when sandbox=off or the platform
   *  had no implementation. Exposed on the result so audit logs +
   *  caller branching (e.g. retry-without-sandbox) can inspect. */
  sandboxTool: 'sandbox-exec' | 'bwrap' | 'none';
  /** AU3 — populated when the Guardian flagged the command as
   *  destructive / escalated BEFORE it ran. Null on clean commands
   *  and whenever `ELANOUS_GUARDIAN=off`. The runtime always forces
   *  an approval upgrade when a finding is present; the field is
   *  retained on the result so the chat log can surface the reason
   *  regardless of the outcome. */
  guardian?: {
    severity: 'destructive' | 'escalated';
    reason: string;
    matched: string;
  } | null;
  /** AU6 — populated when the command was sandboxed AND the child's
   *  exit code + stderr look like a sandbox-rejection (macOS
   *  "operation not permitted", bwrap denial, etc.). Heuristic — no
   *  false-positive guarantees, so the LLM gets a hint + the sandbox
   *  escalation prompt to decide: retry with sandbox:'off' (when the
   *  op is clearly needed) or call AskUserQuestion to confirm. */
  sandboxFailure?: boolean;
  /** A201 — set when the watchdog stopped the process (timeout or no-output stall). */
  watchdog?: ShellWatchdogResult;
}

/** Decision the approval modal (or cache) returns. Outer runtime
 *  interprets these to either run-and-cache, run-without-cache, or
 *  refuse. */
export type ApprovalDecision =
  | 'allow-once'
  | 'allow-session'
  | 'deny-once'
  | 'deny-session';

export interface ApprovalRequest {
  command: string[];
  cwd: string;
  approvalKey: string;
  /** Optional summary the UI shows under the primary prompt. */
  context?: string;
  /** OP #121854 — the caller's abort signal, so a prompt can cancel with the turn.
   *  A decision that lands after this fired is a late answer to a cancelled question:
   *  the runtime neither caches it nor spawns. */
  signal?: AbortSignal;
}

export type ShellApprover = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export const DEFAULT_TIMEOUT_MS = 30_000;
/** A201 — the same cap as Bash (src/tool-runtime/shell-watchdog.ts). */
export const MAX_TIMEOUT_MS = SHELL_MAX_TIMEOUT_MS;
export const SHELL_MAX_OUTPUT = 200_000;
