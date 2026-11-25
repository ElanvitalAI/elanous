// TUI-LONG-PASTE-SPIN (대표 11-25 «이렇게 아예 죽는 문제가 나오면 안 됩니다. 크리티컬») — the main-loop watchdog.
//
// S: the live OP seat spun at 90% CPU with a frozen «Thinking 2m 20s» spinner: every frame re-rendered the whole
//    4.9k-row transcript (11–13 s each), keys waited behind it, and nothing noticed — no log after 11:42:53.
// C: a heavy frame must never become a dead seat; the person must not have to kill the pane.
// Q: how does a loop that is busy notice that it is busy, and what does it do about it?
// A: two observers.
//    ① In-loop (this module, main thread): a 1 s heartbeat measures its own drift, and the renderer reports each
//       frame's cost. 3 consecutive samples over 5 s → `tui.loop-stall {ms, phase, consecutive}` and DEGRADE: the
//       caller paints a running turn at most once a second, renders only the transcript tail, and skips
//       decorations (vanish detector). 30 s without a stalled sample → `tui.loop-stall recovered` and full rendering.
//    ② Off-loop (loop-watchdog-worker.ts, a worker thread): it sees the heartbeat through shared memory. A loop that
//       has not beaten for 30 s cannot run any JS of its own, so the worker writes the diagnostic (phase · stalled ms ·
//       session · recent phases) and restarts the TUI in place (execve: same pid, same terminal, `--resume <session>`).
//
// 세 얼굴: 관측 = `tui.loop-stall` (stall · degraded · recovered) ⊕ the hard-stall diagnostic file ·
//          판단 근거 = drift / frame cost samples, never wall-clock guesses inside a frame ·
//          수복과 인계 = degrade → recover in place; a hard stall → diagnostic ⊕ resume restart (generation-capped).

export const LOOP_STALL_CATEGORY = 'tui.loop-stall';
/** A sample over this is a stalled sample. */
export const LOOP_STALL_MS = 5_000;
/** This many stalled samples in a row degrade rendering. */
export const LOOP_STALL_CONSECUTIVE = 3;
/** A degraded loop returns to full rendering after this long without a stalled sample. */
export const LOOP_RECOVER_MS = 30_000;
/** No heartbeat for this long → the worker writes the diagnostic and restarts the TUI. */
export const LOOP_HARD_STALL_MS = 30_000;
const HEARTBEAT_MS = 1_000;

/** Phase names shared with the worker through one Int32 slot (index = code). */
export const LOOP_PHASES = ['idle', 'render', 'render:history', 'render:paint', 'render:vanish', 'keys', 'turn', 'boot'] as const;
export type LoopPhase = typeof LOOP_PHASES[number];

/** Shared slots: [0] heartbeat (ms since `base`) · [1] phase code · [2] armed (1 = restart allowed). */
export const SLOT_BEAT = 0;
export const SLOT_PHASE = 1;
export const SLOT_ARMED = 2;
export const SLOT_COUNT = 3;

interface TimerLike { unref?: () => void }

export interface LoopWatchdogOptions {
  log: (category: string, event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  stallMs?: number;
  consecutive?: number;
  recoverMs?: number;
  heartbeatMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => TimerLike;
  clearIntervalFn?: (timer: TimerLike) => void;
  /** Shared heartbeat for the off-loop worker (absent in tests and when no worker could start). */
  shared?: Int32Array;
  /** Wall clock base of `shared[SLOT_BEAT]` (Date.now() at start). */
  sharedBase?: number;
  wallNow?: () => number;
  onDegrade?: () => void;
  onRecover?: () => void;
}

export interface LoopWatchdog {
  /** What the loop is doing now — named in stall lines and in the hard-stall diagnostic. */
  phase(name: LoopPhase): void;
  /** In-band sample: one frame took `ms` (a loop that never yields still reports its frames). */
  frame(ms: number): void;
  /** One drift sample (the heartbeat calls this; exposed for tests). */
  sample(ms: number): void;
  degraded(): boolean;
  /** Share the heartbeat with the off-loop worker once it has started. */
  attach(shared: Int32Array, base: number): void;
  dispose(): void;
}

export function createLoopWatchdog(opts: LoopWatchdogOptions): LoopWatchdog {
  const now = opts.now ?? (() => performance.now());
  const wallNow = opts.wallNow ?? Date.now;
  const stallMs = opts.stallMs ?? LOOP_STALL_MS;
  const consecutiveLimit = opts.consecutive ?? LOOP_STALL_CONSECUTIVE;
  const recoverMs = opts.recoverMs ?? LOOP_RECOVER_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  let current: LoopPhase = 'boot';
  let stalledPhase: LoopPhase = 'boot';
  let consecutive = 0;
  let isDegraded = false;
  let lastStallAt = -Infinity;
  let disposed = false;
  let shared = opts.shared;
  let sharedBase = opts.sharedBase ?? 0;

  const beatShared = (): void => {
    if (!shared) return;
    Atomics.store(shared, SLOT_BEAT, Math.max(0, Math.min(0x7fffffff, wallNow() - sharedBase)));
  };
  const safeLog = (event: string, data: Record<string, unknown>): void => {
    try { opts.log(LOOP_STALL_CATEGORY, event, data); } catch { /* observability is fail-open */ }
  };

  const sample = (ms: number): void => {
    if (disposed) return;
    const t = now();
    if (ms > stallMs) {
      consecutive += 1;
      lastStallAt = t;
      safeLog('stall', { ms: Math.round(ms), phase: stalledPhase, consecutive, degraded: isDegraded });
      if (!isDegraded && consecutive >= consecutiveLimit) {
        isDegraded = true;
        safeLog('degraded', { ms: Math.round(ms), phase: stalledPhase, consecutive });
        try { opts.onDegrade?.(); } catch { /* the degrade hook must not break the loop */ }
      }
      return;
    }
    consecutive = 0;
    if (isDegraded && t - lastStallAt >= recoverMs) {
      isDegraded = false;
      safeLog('recovered', { quietMs: Math.round(t - lastStallAt) });
      try { opts.onRecover?.(); } catch { /* ditto */ }
    }
  };

  let lastBeat = now();
  beatShared();
  const timer = setIntervalFn(() => {
    const t = now();
    const drift = t - lastBeat - heartbeatMs;
    lastBeat = t;
    beatShared();
    sample(Math.max(0, drift));
  }, heartbeatMs);
  timer.unref?.();

  return {
    phase(name) {
      current = name;
      if (name !== 'idle') stalledPhase = name;
      if (shared) Atomics.store(shared, SLOT_PHASE, Math.max(0, LOOP_PHASES.indexOf(name)));
    },
    frame(ms) {
      // A frame is the loop's own report: it also proves the loop is alive for the off-loop worker.
      beatShared();
      if (ms > stallMs) sample(ms);
    },
    sample,
    degraded: () => isDegraded,
    dispose() {
      disposed = true;
      clearIntervalFn(timer);
      if (shared) Atomics.store(shared, SLOT_ARMED, 0);
    },
    attach(next, base) {
      shared = next;
      sharedBase = base;
      beatShared();
    },
  };
}

/** The off-loop judgement (pure): has the loop missed its heartbeat for `limitMs`? */
export function judgeHardStall(input: { readonly wallNow: number; readonly base: number; readonly beat: number; readonly limitMs: number }): { stalled: boolean; stalledMs: number } {
  const stalledMs = Math.max(0, input.wallNow - (input.base + input.beat));
  return { stalled: stalledMs >= input.limitMs, stalledMs };
}

/** The argv a hard-stall restart execs: the launch argv without any earlier resume/continue, plus `--resume <id>`. */
export function planStallRestartArgv(input: { readonly execPath: string; readonly scriptPath: string; readonly args: readonly string[]; readonly sessionId: string }): string[] {
  const kept: string[] = [];
  for (let i = 0; i < input.args.length; i += 1) {
    const arg = input.args[i]!;
    if (arg === '--resume' || arg === '--continue' || arg === '-c' || arg === '-r') {
      const next = input.args[i + 1];
      if (arg !== '--continue' && arg !== '-c' && next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    if (arg.startsWith('--resume=') || arg.startsWith('--continue=')) continue;
    kept.push(arg);
  }
  return [input.execPath, input.scriptPath, ...kept, '--resume', input.sessionId];
}

/** Restart generations inside one minute stop at this many (a TUI that stalls right after boot is not looped). */
export const LOOP_STALL_RESTART_MAX_GENERATION = 3;

/** Env for the restarted TUI: generation counted within a 60 s window, reason recorded. */
export function stallRestartEnv(env: Readonly<Record<string, string | undefined>>, wallNow: number): { allowed: boolean; env: Record<string, string> } {
  const at = Number.parseInt(env.ELANOUS_TUI_RESTART_AT ?? '', 10);
  const previous = Number.isFinite(at) && wallNow - at <= 60_000 ? Number.parseInt(env.ELANOUS_TUI_RESTART_GEN ?? '0', 10) || 0 : 0;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) next[key] = value;
  next.ELANOUS_TUI_RESTART_GEN = String(previous + 1);
  next.ELANOUS_TUI_RESTART_AT = String(wallNow);
  next.ELANOUS_TUI_RESTART_REASON = 'loop-stall';
  return { allowed: previous < LOOP_STALL_RESTART_MAX_GENERATION, env: next };
}

export interface LoopWatchdogWorkerHandle {
  readonly shared: Int32Array;
  readonly base: number;
  /** The session a hard-stall restart resumes (null = diagnostic only). */
  setRestart(plan: { readonly argv: readonly string[]; readonly sessionId: string } | null): void;
  /** Restart allowed only while armed (the TUI owns the terminal). */
  arm(on: boolean): void;
  onDiagnostic(fn: (diagnostic: Record<string, unknown>) => void): void;
  dispose(): void;
}

/** Start the off-loop watcher thread. Null when a worker cannot start (the in-loop half still works). */
export async function startLoopWatchdogWorker(input: { readonly diagDir: string; readonly limitMs?: number; readonly checkMs?: number }): Promise<LoopWatchdogWorkerHandle | null> {
  try {
    const { Worker } = await import('node:worker_threads');
    const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOT_COUNT);
    const shared = new Int32Array(buffer);
    const base = Date.now();
    const worker = new Worker(new URL('./loop-watchdog-worker.ts', import.meta.url), {
      workerData: { shared: buffer, base, limitMs: input.limitMs ?? LOOP_HARD_STALL_MS, diagDir: input.diagDir, pid: process.pid, checkMs: input.checkMs },
    });
    worker.unref();
    const listeners: Array<(diagnostic: Record<string, unknown>) => void> = [];
    worker.on('message', (message: { diagnostic?: Record<string, unknown> }) => {
      if (message.diagnostic) for (const fn of listeners) { try { fn(message.diagnostic); } catch { /* fail-open */ } }
    });
    worker.on('error', () => { /* a watcher failure never reaches the TUI */ });
    return {
      shared, base,
      setRestart(plan) { worker.postMessage({ restart: plan }); },
      arm(on) { Atomics.store(shared, SLOT_ARMED, on ? 1 : 0); },
      onDiagnostic(fn) { listeners.push(fn); },
      dispose() { Atomics.store(shared, SLOT_ARMED, 0); void worker.terminate(); },
    };
  } catch {
    return null;
  }
}
