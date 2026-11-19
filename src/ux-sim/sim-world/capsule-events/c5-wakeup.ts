// Product stage C5, partial axis: the real wakeup scheduler and its real session-file persistence; the turn gate
// and the clock are the fake. A one-shot due during a busy turn must defer (never drop) and open at the next idle,
// and one restart must not discard a past-due one-shot. The gate-declined (D6) and pty axes are not measured here.
import { join } from 'node:path';
import {
  WAKEUP_MIN_DELAY_MS,
  WAKEUP_RETRY_DELAY_MS,
  createFileWakeupPersistence,
  createWakeupScheduler,
  type WakeupSchedulerDeps,
} from '../../../skills/tools/schedule-wakeup.js';
import type { SimWorldScenario } from '../types.js';

interface ManualTimer { readonly handle: number; readonly fn: () => void; readonly at: number }

const c5: SimWorldScenario = {
  id: 'C5',
  title: 'a one-shot wakeup survives a busy turn and one restart',
  async run(ctx) {
    let clock = 1_000_000;
    let phase: 'busy' | 'restart' = 'busy';
    const pending = new Map<number, ManualTimer>();
    let timerSeq = 0;
    const setTimer = (fn: () => void, ms: number): number => {
      const handle = ++timerSeq;
      pending.set(handle, { handle, fn, at: clock + Math.max(0, ms) });
      return handle;
    };
    const clearTimer = (handle: unknown): void => { if (typeof handle === 'number') pending.delete(handle); };
    const fireDueTimers = (): void => {
      for (;;) {
        let due: ManualTimer | undefined;
        for (const row of pending.values()) if (row.at <= clock && (due === undefined || row.at < due.at)) due = row;
        if (due === undefined) return;
        pending.delete(due.handle);
        due.fn();
      }
    };
    const logRows: Array<Record<string, unknown>> = [];
    const gateCalls: Array<{ phase: string; origin: unknown; opened: boolean }> = [];
    let busyTurn = false;
    const gate: WakeupSchedulerDeps['startTurnIfIdle'] = (_input, opts) => {
      const opened = !busyTurn;
      gateCalls.push({ phase, origin: (opts as { origin?: unknown }).origin, opened });
      return opened ? { opened: true, turnId: `c5-${phase}-${gateCalls.length}` } : { opened: false, reason: 'NotIdle' };
    };
    const schedulerDeps = (): WakeupSchedulerDeps => ({
      startTurnIfIdle: gate,
      now: () => clock,
      setTimer,
      clearTimer,
      log: (_category, event, data) => { logRows.push({ event, ...data }); },
      notify: () => {},
      turnLifeLog: () => {},
    });

    // Axis 1 — the one-shot is due while a person turn runs: defer, never drop, open at the next idle.
    const busyFile = join(ctx.universeRoot, 'wakeups-c5-busy.json');
    const busyScheduler = createWakeupScheduler({ ...schedulerDeps(), persist: createFileWakeupPersistence(busyFile) });
    busyTurn = true;
    const scheduled = busyScheduler.schedule({ reason: 'C5 one-shot during a busy turn', delaySeconds: WAKEUP_MIN_DELAY_MS / 1000 });
    if (!scheduled.ok) return { ok: false, reason: 'C5 wakeup scheduling was refused', diff: `schedule refused: ${scheduled.error}` };
    clock += WAKEUP_MIN_DELAY_MS;
    fireDueTimers(); // due arrives — the gate refuses (NotIdle) and the scheduler defers this fire
    busyTurn = false;
    clock += WAKEUP_RETRY_DELAY_MS;
    fireDueTimers(); // the turn ended — the deferred retry opens the gate (≤ 1 turn of delay)
    busyScheduler.dispose();
    const busyOpened = gateCalls.filter(call => call.phase === 'busy' && call.opened).length;
    const busyDropped = logRows.some(row => row.event === 'skipped' && row.next === 'dropped');
    if (busyDropped) {
      ctx.recorder.event('c5-wakeup-restart', { busyDropped: 1, busyOpened, restartDiscarded: [], restartOpened: 0, restartPending: [] });
      return { ok: false, reason: 'busy turn drops the one-shot wakeup', diff: 'a skipped/dropped row appeared while the person turn ran' };
    }
    if (busyOpened !== 1) {
      ctx.recorder.event('c5-wakeup-restart', { busyDropped: 0, busyOpened, restartDiscarded: [], restartOpened: 0, restartPending: [] });
      return { ok: false, reason: 'busy turn never opens the deferred one-shot wakeup', diff: `gate opened ${busyOpened} times for the due wakeup` };
    }

    // Axis 2 — the TUI exits before the due time; the seat restarts only after it passed. The
    // restore path must NOT discard the past-due one-shot (that would be data loss — the seat
    // would silently miss its own scheduled turn); per C4 (schedule-wakeup restoreFromPersist)
    // it logs restored-late and re-arms it, so the late wakeup fires on the next tick and opens
    // one restart turn. A restored-discarded row is a loss signal: the scenario fails on it.
    phase = 'restart';
    const restartFile = join(ctx.universeRoot, 'wakeups-c5-restart.json');
    const firstLife = createWakeupScheduler({ ...schedulerDeps(), persist: createFileWakeupPersistence(restartFile) });
    const across = firstLife.schedule({ reason: 'C5 one-shot across a restart', delaySeconds: WAKEUP_MIN_DELAY_MS / 1000 });
    if (!across.ok) return { ok: false, reason: 'C5 wakeup scheduling was refused', diff: `schedule refused: ${across.error}` };
    firstLife.dispose(); // the process exits; its timers die with it
    clock += WAKEUP_MIN_DELAY_MS + WAKEUP_RETRY_DELAY_MS; // the due time passes while the TUI is down
    const secondLife = createWakeupScheduler({ ...schedulerDeps(), persist: createFileWakeupPersistence(restartFile) });
    fireDueTimers(); // the restore re-arms the past-due one-shot as a late wakeup — it fires now
    const restartOpened = gateCalls.filter(call => call.phase === 'restart' && call.opened).length;
    const restartDiscarded = logRows.filter(row => row.event === 'restored-discarded').map(row => String(row.id));
    const restartLate = logRows.filter(row => row.event === 'restored-late').length;
    const restartPending = secondLife.list().map(entry => entry.id);
    ctx.recorder.event('c5-wakeup-restart', { busyDropped: 0, busyOpened, restartDiscarded, restartLate, restartOpened, restartPending });
    if (restartDiscarded.length !== 0)
      return { ok: false, reason: 'restart discards the past-due one-shot (data loss)',
        diff: `restored-discarded ${JSON.stringify(restartDiscarded)} — the seat would silently miss the scheduled turn` };
    if (restartOpened !== 1 || restartLate !== 1 || restartPending.length > 0)
      return { ok: false, reason: 'restart mishandles the late one-shot wakeup',
        diff: `restart opened ${restartOpened} turns; restored-late ${restartLate}; pending ${JSON.stringify(restartPending)}` };
    secondLife.dispose();
    return { ok: false, reason: 'C5 gate-declined and pty axes unmeasured',
      diff: 'busy-turn and restart axes held; the takePending decline (D6) and the pty wiring remain unmeasured' };
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [c5];
