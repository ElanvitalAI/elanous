// ── Shell tool watchdog — A201 ELN-TOOL-STALL-WATCHDOG ──
//
// One place for the shell time limits every shell execution path shares
// (Bash · RunShell legacy argv · RunShell runner), plus a no-output stall
// detector. Design and source comparison (codex · opencode · grok-build ·
// Claude Code): 내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG`.
//
// Observation: `debug.log('tool.watchdog', 'stalled' | 'timeout' | 'snapshot-timeout', …)`
// so `eln logs --category tool.watchdog` shows every intervention.
// Screen: one status line through the active turn's status sink (the Next
// TUI REPL child installs it per streaming turn).
import { debug } from '../debug/log.js';

/** Default shell timeout when the call names none. Claude Code Bash default (2 min) —
 *  see the comparison table in 내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG`. */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
/** Hard cap any shell call can ask for. Claude Code Bash max (10 min). */
export const SHELL_MAX_TIMEOUT_MS = 600_000;
/** Lower clamp for a requested timeout. */
export const SHELL_MIN_TIMEOUT_MS = 1_000;
/** No stdout/stderr and no state change for this long → the command is stalled and is stopped.
 *  codex returns control on an empty-output yield after 5–30 s without killing; eln has no yield
 *  path yet, so the stall line sits well above the default timeout band and only bites calls that
 *  asked for a long timeout and then went silent (내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §A201).
 *  Override: env ELANOUS_SHELL_STALL_MS (same pattern as grok-build GROK_FOREGROUND_BLOCK_BUDGET_MS). */
export const SHELL_STALL_NO_OUTPUT_MS = 180_000;
/** SIGTERM → SIGKILL escalation, and the grace after SIGKILL before the result is forced
 *  even if an escaped grandchild still holds the output pipe open. */
export const SHELL_KILL_GRACE_MS = 2_000;
/** Next TUI host: how long Esc waits for the REPL child to answer a shell-activity snapshot
 *  before treating the child itself as stalled (the 63-minute «Checking shell execution» path). */
export const SHELL_SNAPSHOT_REPLY_TIMEOUT_MS = 5_000;

export const SHELL_STALL_ENV = 'ELANOUS_SHELL_STALL_MS';

/** Effective stall line: explicit option › env override › product constant. Non-positive disables. */
export function resolveShellStallMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const raw = env[SHELL_STALL_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return SHELL_STALL_NO_OUTPUT_MS;
}

export function clampShellTimeoutMs(requested: number | undefined, fallback = SHELL_DEFAULT_TIMEOUT_MS): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : fallback;
  return Math.min(Math.max(SHELL_MIN_TIMEOUT_MS, value), SHELL_MAX_TIMEOUT_MS);
}

export type ShellWatchdogStatus = 'timeout' | 'stalled';

/** Structured result handed back to the model when the watchdog stops a shell call. */
export interface ShellWatchdogResult {
  readonly status: ShellWatchdogStatus;
  readonly tool: 'Bash' | 'RunShell';
  readonly elapsedMs: number;
  readonly lastOutputAgoMs: number;
  readonly limitMs: number;
  readonly text: string;
}

export function shellWatchdogScreenLine(result: Pick<ShellWatchdogResult, 'status' | 'lastOutputAgoMs' | 'elapsedMs'>): string {
  const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));
  return result.status === 'stalled'
    ? `셸 명령 정체 — ${seconds(result.lastOutputAgoMs)}초 출력 없음 → 중단`
    : `셸 명령 시간 초과 — ${seconds(result.elapsedMs)}초 → 중단`;
}

export function shellWatchdogModelText(result: Pick<ShellWatchdogResult, 'status' | 'lastOutputAgoMs' | 'elapsedMs' | 'limitMs'>): string {
  return result.status === 'stalled'
    ? `[stalled: no output for ${result.lastOutputAgoMs}ms (limit ${result.limitMs}ms) — process stopped. Re-run with progress output, a narrower command, or run it in the background.]`
    : `[timed out after ${result.elapsedMs}ms (limit ${result.limitMs}ms) — process stopped.]`;
}

let statusSink: ((line: string) => void) | null = null;

/** The active turn's screen-status channel. Returns the previous sink so callers can restore it. */
export function setShellWatchdogStatusSink(sink: ((line: string) => void) | null): ((line: string) => void) | null {
  const previous = statusSink;
  statusSink = sink;
  return previous;
}

/** Observation event ⊕ one screen line. Never throws. */
export function reportShellWatchdog(result: ShellWatchdogResult, extra: Record<string, unknown> = {}): void {
  try {
    debug.log('tool.watchdog', result.status, {
      tool: result.tool, elapsedMs: result.elapsedMs, lastOutputAgoMs: result.lastOutputAgoMs,
      limitMs: result.limitMs, ...extra,
    });
  } catch { /* observation cannot break the tool */ }
  try { statusSink?.(shellWatchdogScreenLine(result)); } catch { /* display cannot break the tool */ }
}

export interface ShellWatchdog {
  /** Output or a state change arrived. */
  touch(): void;
  /** The process ended; disarm all timers. */
  stop(): void;
  /** Set once the watchdog fired. */
  readonly fired: ShellWatchdogResult | null;
}

/**
 * Arms the wall-clock timeout and the no-output stall line for one shell process.
 * `onFire` runs once with the structured result; the caller kills its exact child.
 */
export function createShellWatchdog(opts: {
  readonly tool: 'Bash' | 'RunShell';
  readonly timeoutMs: number;
  readonly stallMs: number;
  readonly onFire: (result: ShellWatchdogResult) => void;
  readonly now?: () => number;
}): ShellWatchdog {
  const now = opts.now ?? Date.now;
  const started = now();
  let lastOutputAt = started;
  let fired: ShellWatchdogResult | null = null;
  let stopped = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const fire = (status: ShellWatchdogStatus): void => {
    if (fired || stopped) return;
    const at = now();
    const base = { status, elapsedMs: at - started, lastOutputAgoMs: at - lastOutputAt,
      limitMs: status === 'stalled' ? opts.stallMs : opts.timeoutMs };
    fired = { ...base, tool: opts.tool, text: shellWatchdogModelText(base) };
    clearTimeout(timeoutTimer);
    if (stallTimer) clearTimeout(stallTimer);
    try { opts.onFire(fired); } catch { /* the caller's kill path must not throw into the timer */ }
  };
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    // A stall line at or above the timeout can never fire first; leave the timeout in charge.
    if (opts.stallMs > 0 && opts.stallMs < opts.timeoutMs) stallTimer = setTimeout(() => fire('stalled'), opts.stallMs);
  };
  const timeoutTimer = setTimeout(() => fire('timeout'), opts.timeoutMs);
  armStall();

  return {
    touch(): void {
      if (fired || stopped) return;
      lastOutputAt = now();
      armStall();
    },
    stop(): void {
      stopped = true;
      clearTimeout(timeoutTimer);
      if (stallTimer) clearTimeout(stallTimer);
    },
    get fired() { return fired; },
  };
}
