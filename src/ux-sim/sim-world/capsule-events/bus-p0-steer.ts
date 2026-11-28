import { wireBusWake } from '../../../tui/bus-wake.js';
import type { BusItem } from '../../../op-context-bus/bus.js';
import type { SimWorldScenario } from '../types.js';

const item = (id: string, priority: string, owner = 'TC'): BusItem => ({ id, at: '2026-11-29T00:00:00.000Z', type: 'handoff', from: 'OP', body: id, refs: [`prio:${priority}`], owner, alsoFrom: [] });

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'BUS-P0-BUSY-ONCE', title: 'addressed busy P0 steers once at a simulated tool boundary', async run(ctx) {
    let receive!: (items: BusItem[]) => void;
    const queue: string[] = []; const model: string[] = []; const wakes: boolean[] = [];
    const wire = wireBusWake({ seat: 'TC', subscribe: f => { receive = f; return () => {}; },
      steerP0: i => { queue.push(i.id); return true; }, wake: (_, urgent) => wakes.push(urgent), now: () => 1 });
    receive([item('p0', 'P0'), item('foreign', 'P0', 'UX')]); receive([item('p0', 'P0')]);
    // Simulated tool boundary only; this does not exercise the production child transport.
    model.push(...queue.splice(0)); wire.applied(model.map(id => `bus-p0:${id}`)); wire.delivered();
    const ok = model.join(',') === 'p0' && wakes.length === 0;
    ctx.recorder.event('bus-p0-busy', { model, wakes, ok, boundary: 'simulated' }); wire.stop();
    return ok ? { ok: true } : { ok: false, diff: JSON.stringify({ model, wakes }) };
  } },
  { id: 'BUS-P0-FALLBACK-IDLE', title: 'unapplied busy steer falls back and P1/P2 keep idle wake', async run(ctx) {
    let receive!: (items: BusItem[]) => void; let busy = true;
    const steers: string[] = []; const wakes: boolean[] = [];
    const wire = wireBusWake({ seat: 'TC', subscribe: f => { receive = f; return () => {}; },
      steerP0: i => { if (!busy) return false; steers.push(i.id); return true; },
      wake: (_, urgent) => wakes.push(urgent), now: () => 1, setTimer: () => ({ cancel() {} }) });
    receive([item('lost', 'P0')]); wire.delivered(); busy = false;
    receive([item('idle-p0', 'P0')]); receive([item('p1', 'P1'), item('p2', 'P2')]);
    const ok = steers.join(',') === 'lost' && wakes.join(',') === 'true,true';
    ctx.recorder.event('bus-p0-fallback', { steers, wakes, ok, p1p2: 'existing throttle' }); wire.stop();
    return ok ? { ok: true } : { ok: false, diff: JSON.stringify({ steers, wakes }) };
  } },
];
