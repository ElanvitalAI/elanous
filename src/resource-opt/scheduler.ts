// RESOURCE-OPT-HOURLY (L1) — when the matching table is built and the assignment turn opens.
//
// SCHEDULER-TO-GRAPH-RUNNER (#38363) is not on main, so this is a TUI scheduled system turn on the same internal-turn
// door as the self-retro (seat-retro.ts): every hour at :MM (default :05) and on demand (`eln resource optimize --now`
// writes a trigger file this scheduler watches). The table is built off the turn (gather), then ONE turn opens with
// the table as its prompt; the gate keeps it open until each row is disposed. A busy seat retries every minute for
// up to 20 minutes, then the hour counts as missed (logged).
//
// RESOURCE-OPT-STEWARD (SIM-STEWARD-AB-1125 FU 7) — with a steward the cadence is every 10 min plus a seat-idle event
// (a seat idle ≥ 5 min → run at once): the steward assigns/requests what it can and the turn opens only for its
// exception rows. The steward unavailable (SeatAssign not installed) → the full-table hourly turn as before.
import { formatAssignmentPrompt, type MatchingTable } from './matching-table.js';
import { exceptionsAsTable, formatExceptionPrompt, type Steward } from './steward.js';
import type { AssignmentGate } from './assignment-gate.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';

export const RESOURCE_OPT_MINUTE = 5;
export const RESOURCE_OPT_RETRY_MS = 60_000;
export const RESOURCE_OPT_DEFER_MAX_MS = 20 * 60_000;
const DEFERRABLE: ReadonlySet<string> = new Set(['NotIdle', 'HumanTyping']);
/** Steward cadence (every 10 min) and the seat-idle threshold before a seat-idle event runs it. */
export const RESOURCE_OPT_STEWARD_INTERVAL_MS = 10 * 60_000;
export const RESOURCE_OPT_IDLE_TRIGGER_MS = 5 * 60_000;

/** The next wall-clock «:MM» strictly after `now` (local clock of the host). */
export function nextHourlyDue(now: number, minute = RESOURCE_OPT_MINUTE): number {
  const d = new Date(now);
  d.setMinutes(minute, 0, 0);
  if (d.getTime() <= now) d.setHours(d.getHours() + 1);
  return d.getTime();
}

export interface ResourceOptSchedulerDeps {
  gate: AssignmentGate;
  /** Build the table (no LLM). null = the seat is not the HQ coordinator now, or nothing could be read. */
  gather: () => Promise<MatchingTable | null>;
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  minute?: number;
  notify?: (line: string) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** RESOURCE-OPT-STEWARD — when present: every 10 min ⊕ seat-idle events; only exception rows open a turn. */
  steward?: Steward;
}

export interface ResourceOptScheduler {
  start(): void;
  /** On demand (trigger file · tests): build and open now. */
  runNow(reason: string): Promise<void>;
  /** A seat went idle at `since` (event): once it has been idle {@link RESOURCE_OPT_IDLE_TRIGGER_MS}, run at once. */
  noteSeatIdle(seat: string, since?: number): void;
  nextDueAt(): number | null;
  dispose(): void;
}

export function createResourceOptScheduler(deps: ResourceOptSchedulerDeps): ResourceOptScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  let timer: unknown;
  let due: number | null = null;
  let running = false;
  let disposed = false;
  const idleTimers = new Map<string, unknown>();

  const arm = (): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimer(timer);
    due = deps.steward ? now() + RESOURCE_OPT_STEWARD_INTERVAL_MS : nextHourlyDue(now(), deps.minute ?? RESOURCE_OPT_MINUTE);
    timer = setTimer(() => { timer = undefined; void runNow('hourly').finally(arm); }, Math.max(0, due - now()));
  };

  const tryOpen = (table: MatchingTable, firstAt: number, reason: string, prompt?: string): Promise<void> => new Promise((resolve) => {
    const attempt = (): void => {
      if (disposed) { resolve(); return; }
      let result: StartTurnIfIdleResult;
      try { result = deps.startTurnIfIdle(prompt ?? formatAssignmentPrompt(table), { origin: 'scheduled', reason: `resource optimize (${reason})` }); }
      catch (error) { result = { opened: false, reason: 'NotIdle', detail: `threw:${String(error)}` }; }
      if (result.opened) {
        deps.gate.open(table);
        log('turn-opened', { reason, rows: table.rows.length, turnId: result.turnId });
        resolve();
        return;
      }
      if (DEFERRABLE.has(result.reason) && now() + RESOURCE_OPT_RETRY_MS <= firstAt + RESOURCE_OPT_DEFER_MAX_MS) {
        log('deferred', { reason: result.reason });
        setTimer(attempt, RESOURCE_OPT_RETRY_MS);
        return;
      }
      log('missed', { reason: result.reason, rows: table.rows.length });
      deps.notify?.(`⚙ Resource optimize missed (${result.reason}) — next at :${String(deps.minute ?? RESOURCE_OPT_MINUTE).padStart(2, '0')}`);
      resolve();
    };
    attempt();
  });

  const runNow = async (reason: string): Promise<void> => {
    if (disposed || running) return;
    running = true;
    try {
      deps.gate.expireIfStale();
      if (deps.gate.active()) { log('skipped', { reason: 'table-open', trigger: reason }); return; }
      if (deps.steward) {
        let outcome: Awaited<ReturnType<Steward['run']>> | null = null;
        try { outcome = await deps.steward.run(reason); }
        catch (error) { log('steward-failed', { error: String(error).slice(0, 200), trigger: reason }); }
        if (outcome && !outcome.unavailable) {
          if (!outcome.table) { log('skipped', { reason: 'no-table', trigger: reason }); return; }
          if (outcome.exceptions.length === 0) { log('steward-resolved', { trigger: reason, assigned: outcome.assigned.length, routine: outcome.routine.length }); return; }
          await tryOpen(exceptionsAsTable(outcome.table, outcome.exceptions), now(), reason, formatExceptionPrompt(outcome.table, outcome.exceptions));
          return;
        }
        // Steward unavailable / failed → the #40073 full-table turn (fail-safe: nothing silently dropped).
      }
      let table: MatchingTable | null;
      try { table = await deps.gather(); }
      catch (error) { log('gather-failed', { error: String(error).slice(0, 200), trigger: reason }); return; }
      if (!table) { log('skipped', { reason: 'no-table', trigger: reason }); return; }
      if (table.rows.length === 0) { deps.gate.recordEmpty(table); return; }
      await tryOpen(table, now(), reason);
    } finally { running = false; }
  };

  return {
    start() { if (!disposed && timer === undefined) arm(); },
    runNow,
    noteSeatIdle(seat, since) {
      if (disposed || !deps.steward) return;
      const key = seat.trim().toUpperCase();
      const prior = idleTimers.get(key);
      if (prior !== undefined) clearTimer(prior);
      const wait = Math.max(0, (since ?? now()) + RESOURCE_OPT_IDLE_TRIGGER_MS - now());
      idleTimers.set(key, setTimer(() => { idleTimers.delete(key); void runNow(`seat-idle ${key}`); }, wait));
    },
    nextDueAt: () => due,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      for (const handle of idleTimers.values()) clearTimer(handle);
      idleTimers.clear();
    },
  };
}
