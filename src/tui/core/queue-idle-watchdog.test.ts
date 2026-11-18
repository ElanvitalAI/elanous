import { describe, expect, test } from 'bun:test';
import { createQueueIdleWatchdog } from './queue-idle-watchdog.js';

/** A world the test owns: clock, busy flag, queue length, whether the terminal takes a key. */
function world(options: { stallMs?: number; accepted?: boolean } = {}) {
  const state = { now: 0, busy: false, queued: 0, accepted: options.accepted ?? true, wakes: 0 };
  const events: Array<[string, Record<string, unknown>]> = [];
  const dog = createQueueIdleWatchdog({
    now: () => state.now,
    idle: () => !state.busy,
    queued: () => state.queued,
    wake: () => { state.wakes += 1; return state.accepted; },
    log: (event, data) => { events.push([event, data]); },
    stallMs: options.stallMs ?? 5_000,
  });
  const at = (ms: number) => { state.now = ms; return dog.tick(); };
  return { state, events, dog, at };
}

describe('ELN-SEAT-IDLE-QUEUE-STALL watchdog', () => {
  test('idle with one queued item: no wake before 5000 ms, exactly one recorded wake at 5000 ms', () => {
    const { state, events, at } = world();
    state.queued = 1;
    expect(at(0).kind).toBe('waiting');
    expect(at(4_999).kind).toBe('waiting');
    expect(state.wakes).toBe(0);
    expect(at(5_000)).toEqual({ kind: 'woke', idleMs: 5_000, queued: 1 });
    expect(state.wakes).toBe(1);
    expect(events).toEqual([['idle-stall-wake', { queued: 1, idleMs: 5_000, stallMs: 5_000 }]]);
  });

  test('a queue that stays stuck is woken again one window later, not on every tick', () => {
    const { state, at } = world();
    state.queued = 2;
    at(0); at(5_000);
    expect(state.wakes).toBe(1);
    at(5_500); at(9_999);
    expect(state.wakes).toBe(1);
    at(10_000);
    expect(state.wakes).toBe(2);
  });

  test('a running turn never gets a wake, and the idle clock starts only when it ends', () => {
    const { state, events, at } = world();
    state.queued = 3;
    state.busy = true;
    expect(at(0).kind).toBe('clear');
    expect(at(60_000).kind).toBe('clear');
    state.busy = false;
    expect(at(60_001).kind).toBe('waiting');
    expect(at(65_000).kind).toBe('waiting');
    expect(at(65_001).kind).toBe('woke');
    expect(events.map(([event]) => event)).toEqual(['idle-stall-wake']);
  });

  test('an empty queue is clear: idle alone is not a stall', () => {
    const { state, events, at } = world();
    expect(at(0).kind).toBe('clear');
    expect(at(600_000).kind).toBe('clear');
    expect(state.wakes).toBe(0);
    expect(events).toEqual([]);
  });

  test('a dispatch attempt restarts the window (no double dispatch while the notice turn opens)', () => {
    const { state, dog, at } = world();
    state.queued = 1;
    at(0); at(4_000);
    dog.noteDispatch();
    at(4_100); at(9_000);
    expect(state.wakes).toBe(0);
    at(9_100);
    expect(state.wakes).toBe(1);
  });

  test('the terminal refuses the key: a refused event, and the next window tries again', () => {
    const { state, events, at } = world({ accepted: false });
    state.queued = 1;
    at(0);
    expect(at(5_000)).toEqual({ kind: 'wake-refused', idleMs: 5_000, queued: 1 });
    expect(events).toEqual([['idle-stall-wake-refused', { queued: 1, idleMs: 5_000, stallMs: 5_000 }]]);
    state.accepted = true;
    at(10_000);
    expect(events.at(-1)).toEqual(['idle-stall-wake', { queued: 1, idleMs: 5_000, stallMs: 5_000 }]);
  });

  test('boot kick: an item restored before the loop reads wakes at once, with a boot event', () => {
    const { state, events, dog } = world();
    state.queued = 1;
    expect(dog.kick('boot')).toBe(true);
    expect(state.wakes).toBe(1);
    expect(events).toEqual([['boot-wake', { queued: 1, idleMs: 0, reason: 'boot' }]]);
  });

  test('boot kick with nothing queued or a turn already running sends nothing', () => {
    const empty = world();
    expect(empty.dog.kick('boot')).toBe(false);
    const running = world();
    running.state.queued = 1;
    running.state.busy = true;
    expect(running.dog.kick('boot')).toBe(false);
    expect(empty.state.wakes + running.state.wakes).toBe(0);
    expect([...empty.events, ...running.events]).toEqual([]);
  });

  test('two items arriving at the same instant: one wake key (the loop takes one per dispatch)', () => {
    const { state, at } = world();
    state.queued = 2;
    at(0); at(5_000);
    expect(state.wakes).toBe(1);
  });

  // ── #38510 r1 must-fixes (remote-terra-38510-38510-e1f428139305.json) ──

  test('r1 MF1: a turn that starts and ends between two ticks voids the old window — no wake before 5000 ms after the turn end', () => {
    const { state, at, dog } = world();
    state.queued = 1;
    at(0); // window opens at 0
    state.now = 1_000; state.busy = true; dog.noteTurnBoundary(); // a typed turn starts (no tick sees it)
    state.now = 1_400; state.busy = false; dog.noteTurnBoundary(); // and ends before the next tick
    expect(at(5_000).kind).toBe('waiting'); // the old window (0 → 5000) would have fired here
    expect(state.wakes).toBe(0);
    expect(at(6_400)).toEqual({ kind: 'woke', idleMs: 5_000, queued: 1 });
  });

  test('r1 MF2: the clock starts at the enqueue itself, not at the next tick — the wake lands exactly 5000 ms after it', () => {
    const { state, at, dog } = world();
    at(0); // empty: clear
    state.now = 250; state.queued = 1; dog.noteQueued(); // item enters between ticks (at 250, ticks at 0/500/…)
    expect(at(500).kind).toBe('waiting');
    expect(at(5_000).kind).toBe('waiting');
    expect(at(5_250)).toEqual({ kind: 'woke', idleMs: 5_000, queued: 1 });
  });

  test('r1 MF2: an enqueue while a turn runs does not open a window; the turn end does', () => {
    const { state, at, dog } = world();
    state.busy = true; state.queued = 1; state.now = 100; dog.noteQueued();
    expect(at(3_000).kind).toBe('clear');
    state.now = 3_200; state.busy = false; dog.noteTurnBoundary();
    expect(at(8_199).kind).toBe('waiting');
    expect(at(8_200).kind).toBe('woke');
  });
});
