// SEAT-ROLE-CARD-AND-SELF-RETRO · device 2 — the built-in retro scheduler.
//
// Every `intervalMin` minutes (default 120) the seat opens a retro turn on the SAME internal-turn door that
// ScheduleWakeup and the idle loops use (`startTurnIfIdle`, origin 'retro'). The door already arbitrates: it opens
// when the seat is idle and refuses while a turn runs or a human is typing, and this scheduler then retries every
// minute inside a defer window instead of dropping the retro. A retro that cannot open inside the window counts as
// missed; the miss count and a "two in a row" flag live in a small per-seat state file for supervision to read.
//
// State is per SEAT (not per session): `seat-state/<SEAT>/retro-state.json`, written temp-then-rename. A damaged
// state file is never overwritten (the scheduler keeps running from memory). No locks: one TUI per seat; two TUIs on
// the same seat is unsupported (last write wins).
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';

export const SEAT_RETRO_DEFAULT_INTERVAL_MIN = 120;
export const SEAT_RETRO_RETRY_MS = 60_000;
/** How long after its due time a retro keeps trying to open before it counts as missed. */
export const SEAT_RETRO_DEFER_MAX_MS = 30 * 60_000;
export const SEAT_RETRO_MISSED_FLAG_AT = 2;
/** Longest interval accepted (seven days): keeps every timer delay far below the 32-bit timer limit. */
export const SEAT_RETRO_MAX_INTERVAL_MIN = 7 * 24 * 60;
export const SEAT_RETRO_MIN_INTERVAL_MIN = 1;
const DEFERRABLE: ReadonlySet<string> = new Set(['NotIdle', 'HumanTyping']);
const SEAT_NAME = /^[A-Z][A-Z0-9_-]{0,63}$/;

export interface SeatRetroState {
  /** When the last retro turn opened (ms), or null if none ever did. */
  lastOpenedAt: number | null;
  /** Retros that could not open inside the defer window, since the last one that did. */
  consecutiveMissed: number;
  /** Retros missed in total (never reset). */
  missedTotal: number;
  /** True once `consecutiveMissed` reached the flag threshold; cleared when a retro opens. Supervision reads this. */
  flagged: boolean;
  /** When the next retro is due (ms), saved so a restart keeps the schedule instead of retrying from an old `lastOpenedAt`. */
  nextDueAt: number | null;
}

export const emptySeatRetroState = (): SeatRetroState =>
  ({ lastOpenedAt: null, consecutiveMissed: 0, missedTotal: 0, flagged: false, nextDueAt: null });

export interface SeatRetroStateStore {
  /** Throws when the file exists but cannot be read as a state (the original is kept). A missing file = the empty state. */
  load(): SeatRetroState;
  /** Throws when the write fails or the stored file was damaged (never overwritten). */
  save(state: SeatRetroState): void;
}

export function seatRetroStateFile(seat: string, hqRoot: string = join(process.env.HOME ?? '', 'elanous-hq')): string {
  const name = seat.trim().toUpperCase();
  if (!SEAT_NAME.test(name)) throw new Error(`invalid retro seat ${JSON.stringify(seat)}`);
  return join(hqRoot, 'seat-state', name, 'retro-state.json');
}

function parseState(value: unknown): SeatRetroState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<SeatRetroState>;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!(v.lastOpenedAt === null || (typeof v.lastOpenedAt === 'number' && Number.isFinite(v.lastOpenedAt)))
    || !count(v.consecutiveMissed) || !count(v.missedTotal) || typeof v.flagged !== 'boolean') return null;
  const nextDueAt = v.nextDueAt ?? null; // files written before this field existed have none
  if (!(nextDueAt === null || (typeof nextDueAt === 'number' && Number.isFinite(nextDueAt)))) return null;
  return { lastOpenedAt: v.lastOpenedAt, consecutiveMissed: v.consecutiveMissed, missedTotal: v.missedTotal, flagged: v.flagged, nextDueAt };
}

function readStateFile(filePath: string): SeatRetroState {
  let text: string;
  try { text = readFileSync(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySeatRetroState();
    throw error;
  }
  let parsed: SeatRetroState | null = null;
  try { parsed = parseState(JSON.parse(text)); } catch { parsed = null; }
  if (!parsed) throw new Error(`retro state unreadable: ${filePath}`);
  return parsed;
}

export function createFileSeatRetroStateStore(filePath: string): SeatRetroStateStore {
  return {
    load: () => readStateFile(filePath),
    save(state) {
      // Check the file as it is NOW (another store instance or a later edit may have damaged it): never write over what cannot be read.
      readStateFile(filePath);
      const tmp = `${filePath}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmp, JSON.stringify(state));
        renameSync(tmp, filePath);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* the temp was never written, or was renamed */ }
        throw error;
      }
    },
  };
}

/** The retro turn input. `metrics` are ledger-computed lines (slice 3); the reply format is fixed here. */
export function formatSeatRetroPrompt(input: { seat: string; intervalMin: number; metrics?: readonly string[] }): string {
  return [
    `[retro] ${input.seat} — scheduled self-retro (every ${input.intervalMin} minutes).`,
    ...(input.metrics?.length ? ['Metrics for this period:', ...input.metrics.map(line => `- ${line}`)] : []),
    'Look back over this period with your role card in mind. Answer briefly, in these labelled lines:',
    '- did: what you finished and what stayed open',
    '- keep: one line per thing to do again next time (a fact and its reason); none if nothing',
    '- action: what you will change in the next period, with a deadline; none if nothing',
    'Then carry on with your work.',
  ].join('\n');
}

export interface SeatRetroDeps {
  seat: string;
  intervalMin?: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  /** The door only parks an opened turn; the input loop may still decline it (a key, a detach). When given, a retro counts as
   *  started only once this resolves true; false is handled like a rejection, so a withdrawn turn is never reported as a retro. */
  confirmStarted?: (turnId: string) => Promise<boolean>;
  store: SeatRetroStateStore;
  metrics?: () => readonly string[];
  notify?: (line: string) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface SeatRetroScheduler {
  start(): void;
  state(): SeatRetroState;
  dispose(): void;
}

export function createSeatRetroScheduler(deps: SeatRetroDeps): SeatRetroScheduler {
  const requested = deps.intervalMin ?? SEAT_RETRO_DEFAULT_INTERVAL_MIN;
  const intervalMin = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(requested, SEAT_RETRO_MIN_INTERVAL_MIN), SEAT_RETRO_MAX_INTERVAL_MIN) : SEAT_RETRO_DEFAULT_INTERVAL_MIN;
  const intervalMs = intervalMin * 60_000;
  const log = deps.log ?? ((event, data) => debug.log('tui.retro', event, data));
  let state = emptySeatRetroState();
  let timer: unknown;
  let started = false;
  let dueAt = 0;
  let disposed = false;

  const persist = (): void => {
    try { deps.store.save(state); }
    catch (error) { log('state-save-failed', { error: String(error) }); } // never stops the scheduler
  };
  const arm = (ms: number): void => {
    if (disposed) return;
    if (timer !== undefined) deps.clearTimer(timer);
    timer = deps.setTimer(fire, Math.max(0, ms));
  };
  const scheduleNext = (): void => {
    dueAt = deps.now() + intervalMs;
    state = { ...state, nextDueAt: dueAt };
    persist(); // keep the schedule across a restart
    arm(intervalMs);
  };
  const onOpened = (turnId: string): void => {
    const t = deps.now();
    state = { ...state, lastOpenedAt: t, consecutiveMissed: 0, flagged: false };
    log('opened', { seat: deps.seat, turnId });
    scheduleNext();
  };
  /** A retro that did not start: wait and retry inside the window while the cause can pass, else count a miss. */
  const onNotStarted = (reason: string): void => {
    const t = deps.now();
    if (DEFERRABLE.has(reason) && t + SEAT_RETRO_RETRY_MS <= dueAt + SEAT_RETRO_DEFER_MAX_MS) {
      log('deferred', { seat: deps.seat, reason });
      arm(SEAT_RETRO_RETRY_MS);
      return;
    }
    const consecutiveMissed = state.consecutiveMissed + 1;
    const flagged = consecutiveMissed >= SEAT_RETRO_MISSED_FLAG_AT;
    state = { ...state, consecutiveMissed, missedTotal: state.missedTotal + 1, flagged };
    log('missed', { seat: deps.seat, reason, consecutiveMissed, flagged });
    deps.notify?.(`Retro missed (${reason})${flagged ? ' — flagged for supervision' : ''}`);
    scheduleNext();
  };
  const fire = (): void => {
    timer = undefined;
    if (disposed) return;
    const t = deps.now();
    if (t < dueAt) { arm(dueAt - t); return; } // a timer that fired early (clock step): wait out the rest
    let result: StartTurnIfIdleResult;
    try {
      result = deps.startTurnIfIdle(
        formatSeatRetroPrompt({ seat: deps.seat, intervalMin, ...(deps.metrics ? { metrics: deps.metrics() } : {}) }),
        { origin: 'retro', reason: 'scheduled self-retro' });
    } catch (error) { result = { opened: false, reason: 'NotIdle', detail: `threw:${String(error)}` }; }
    if (!result.opened) { onNotStarted(result.reason); return; }
    if (!deps.confirmStarted) { onOpened(result.turnId); return; }
    // Parked, not started: nothing is recorded until the input loop really takes the turn.
    const turnId = result.turnId;
    deps.confirmStarted(turnId).then(
      started => { if (disposed) return; if (started) onOpened(turnId); else onNotStarted('HumanTyping'); },
      () => { if (!disposed) onNotStarted('NotIdle'); },
    );
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      try { state = deps.store.load(); }
      catch (error) { log('state-load-failed', { error: String(error) }); state = emptySeatRetroState(); }
      const t = deps.now();
      // Saved schedule first; else one interval after the last retro that opened; else one interval from now.
      // An overdue time (the seat was down) becomes "now": the door gets the full defer window from the restart.
      dueAt = Math.max(t, state.nextDueAt ?? (state.lastOpenedAt ?? t) + intervalMs);
      arm(dueAt - t);
    },
    state: () => ({ ...state }),
    dispose() {
      disposed = true;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
    },
  };
}

/** `ELANOUS_SEAT_RETRO_INTERVAL_MIN`: unset/blank = default; zero or negative = off (0); an unreadable value = default;
 *  anything between zero and the minimum becomes the minimum. The scheduler clamps the upper end. */
export function parseSeatRetroIntervalMin(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return SEAT_RETRO_DEFAULT_INTERVAL_MIN;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SEAT_RETRO_DEFAULT_INTERVAL_MIN;
  if (value <= 0) return 0;
  return Math.min(Math.max(value, SEAT_RETRO_MIN_INTERVAL_MIN), SEAT_RETRO_MAX_INTERVAL_MIN);
}
