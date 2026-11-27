// BUS-SEAT-TURN ② — a new bus item addressed to this seat wakes it through the same idle door seat mail uses, at most
// once per item and once per 30 min (prio:P0 now · raw CEO words never). The wake is only a doorbell: the turn it starts
// carries the bus digest (repl turn path · seat-turn.ts). Deferred wakes fire at the window's end if nothing delivered.
import type { BusItem } from '../op-context-bus/bus.js';
import { createBusWakeGate, type BusWakeAction, type BusWakeGate } from '../op-context-bus/seat-turn.js';

export interface BusWakeDeps {
  readonly seat: string;
  /** Subscribe to new bus items (watchBus) — returns stop. */
  readonly subscribe: (onItems: (items: BusItem[]) => void) => () => void;
  /** Queue the doorbell notice and knock the idle door. */
  readonly wake: (text: string, urgent: boolean) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  readonly windowMs?: number;
}

export const busWakeNotice = (seat: string, reason: string): string =>
  `OP context bus: new work for ${seat} (${reason}) — the bus digest rides this turn (할 일 = 소화된 항목만)`;

export function wireBusWake(deps: BusWakeDeps): { gate: BusWakeGate; delivered(): void; stop(): void } {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return { cancel: () => clearTimeout(t) }; });
  const gate = createBusWakeGate(deps.seat, deps.windowMs);
  let timer: { cancel(): void } | null = null;
  const act = (a: BusWakeAction): void => {
    if (a.action === 'wake') { timer?.cancel(); timer = null; deps.wake(busWakeNotice(deps.seat, a.reason), a.reason === 'urgent'); return; }
    if (a.action === 'defer' && !timer) timer = setTimer(() => { timer = null; act(gate.due(now())); }, Math.max(0, a.dueAt - now()));
  };
  const stop = deps.subscribe((items) => { try { act(gate.offer(items, now())); } catch { /* fail-open */ } });
  return {
    gate,
    delivered() { gate.delivered(); timer?.cancel(); timer = null; },
    stop() { timer?.cancel(); stop(); },
  };
}
