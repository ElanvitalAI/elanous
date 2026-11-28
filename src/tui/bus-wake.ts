// BUS-SEAT-TURN ② — a new bus item addressed to this seat wakes it through the same idle door seat mail uses, at most
// once per item and once per 30 min (prio:P0 now · raw CEO words never). The wake is only a doorbell: the turn it starts
// carries the bus digest (repl turn path · seat-turn.ts). Deferred wakes fire at the window's end if nothing delivered.
import type { BusItem } from '../op-context-bus/bus.js';
import { busWakeKind, createBusWakeGate, type BusWakeAction, type BusWakeGate } from '../op-context-bus/seat-turn.js';

export interface BusWakeDeps {
  readonly seat: string;
  /** Subscribe to new bus items (watchBus) — returns stop. */
  readonly subscribe: (onItems: (items: BusItem[]) => void) => () => void;
  /** Queue the doorbell notice and knock the idle door. */
  readonly wake: (text: string, urgent: boolean) => void;
  readonly steerP0?: (item: BusItem) => boolean;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  readonly windowMs?: number;
}

export const busWakeNotice = (seat: string, reason: string): string =>
  `OP context bus: new work for ${seat} (${reason}) — the bus digest rides this turn (할 일 = 소화된 항목만)`;

export function wireBusWake(deps: BusWakeDeps): { gate: BusWakeGate; applied(ids: readonly string[]): void; delivered(): void; stop(): void } {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return { cancel: () => clearTimeout(t) }; });
  const gate = createBusWakeGate(deps.seat, deps.windowMs);
  const steered = new Set<string>();
  // IPC acceptance is not delivery: the child can finish before another model request.
  const pending = new Map<string, BusItem>();
  let timer: { cancel(): void } | null = null;
  const act = (a: BusWakeAction): void => {
    if (a.action === 'wake') { timer?.cancel(); timer = null; deps.wake(busWakeNotice(deps.seat, a.reason), a.reason === 'urgent'); return; }
    if (a.action === 'defer' && !timer) timer = setTimer(() => { timer = null; act(gate.due(now())); }, Math.max(0, a.dueAt - now()));
  };
  const stop = deps.subscribe((items) => { try {
    const remaining = items.filter((item) => {
      if (steered.has(item.id)) return false;
      if (busWakeKind(item, deps.seat) !== 'urgent' || !item.refs.some((ref) => ref.toLowerCase() === 'prio:p0') || !deps.steerP0) return true;
      try { if (deps.steerP0(item)) { steered.add(item.id); pending.set(item.id, item); return false; } } catch { /* preserve idle delivery */ }
      return true;
    });
    act(gate.offer(remaining, now()));
  } catch { /* fail-open */ } });
  return {
    gate,
    applied(ids) { for (const id of ids) if (id.startsWith('bus-p0:')) pending.delete(id.slice('bus-p0:'.length)); },
    delivered() {
      gate.delivered(); timer?.cancel(); timer = null;
      const undelivered = [...pending.values()]; pending.clear();
      if (undelivered.length) act(gate.offer(undelivered, now()));
    },
    stop() { timer?.cancel(); stop(); },
  };
}
