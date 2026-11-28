import { describe, expect, test } from 'bun:test';
import { wireBusWake } from './bus-wake.js';
import type { BusItem } from '../op-context-bus/bus.js';

const item = (id: string, refs: string[] = ['prio:P0'], owner = 'TC'): BusItem => ({
  id, at: '2026-11-29T00:00:00.000Z', type: 'handoff', from: 'OP', body: 'do it', refs, owner, alsoFrom: [],
});

describe('busy P0 bus steer', () => {
  test('steers addressed P0 once, never P1 or another seat; idle P0 retains wake', () => {
    let onItems!: (items: BusItem[]) => void;
    let busy = true;
    const steers: string[] = [];
    const wakes: boolean[] = [];
    const wire = wireBusWake({ seat: 'TC', subscribe: (f) => { onItems = f; return () => {}; },
      steerP0: (i) => { if (!busy) return false; steers.push(i.id); return true; },
      wake: (_, urgent) => wakes.push(urgent), now: () => 1,
      setTimer: () => ({ cancel() {} }),
    });
    onItems([item('1'), item('foreign', ['prio:P0'], 'UX')]);
    onItems([item('1')]);
    expect(steers).toEqual(['1']);
    expect(wakes).toEqual([]);
    onItems([item('2', ['prio:P1'])]);
    expect(wakes).toEqual([false]);
    busy = false;
    onItems([item('3')]);
    expect(wakes).toEqual([false, true]);
    wire.stop();
  });
  test('steer failure preserves the existing urgent idle wake without duplicates', () => {
    let onItems!: (items: BusItem[]) => void;
    let wakes = 0;
    wireBusWake({ seat: 'TC', subscribe: (f) => { onItems = f; return () => {}; },
      steerP0: () => { throw new Error('offline'); }, wake: () => { wakes++; }, now: () => 1 });
    onItems([item('x')]); onItems([item('x')]);
    expect(wakes).toBe(1);
  });
});
