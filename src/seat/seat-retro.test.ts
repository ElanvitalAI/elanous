import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import {
  createFileSeatRetroStateStore,
  createSeatRetroScheduler,
  emptySeatRetroState,
  formatSeatRetroPrompt,
  SEAT_RETRO_DEFAULT_INTERVAL_MIN,
  SEAT_RETRO_DEFER_MAX_MS,
  SEAT_RETRO_MAX_INTERVAL_MIN,
  SEAT_RETRO_MISSED_FLAG_AT,
  SEAT_RETRO_RETRY_MS,
  parseSeatRetroIntervalMin,
  SEAT_RETRO_MIN_INTERVAL_MIN,
  seatRetroStateFile,
  type SeatRetroState,
  type SeatRetroStateStore,
} from './seat-retro.js';
import { createNextTuiWakeup, SEAT_CAP_START_WAIT_MS } from '../tui-client/next-wakeup.js';
import { resolveSeatRetroSeat } from './seat-retro-seat.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'seat-retro-')); roots.push(dir); return dir; };

const INTERVAL_MIN = SEAT_RETRO_DEFAULT_INTERVAL_MIN;
const INTERVAL_MS = INTERVAL_MIN * 60_000;

function fakeClock(start = Date.UTC(2026, 10, 17, 9, 0, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function memoryStore(initial: SeatRetroState = emptySeatRetroState()) {
  const saved: SeatRetroState[] = [];
  const store: SeatRetroStateStore = { load: () => ({ ...initial }), save: state => { saved.push({ ...state }); } };
  return { store, saved };
}

function rig(opts: { initial?: SeatRetroState; store?: SeatRetroStateStore; confirm?: (turnId: string) => Promise<boolean> } = {}) {
  const clock = fakeClock();
  const mem = memoryStore(opts.initial);
  const calls: Array<{ input: string; opts: StartTurnIfIdleOptions }> = [];
  const logs: string[] = [];
  const notices: string[] = [];
  let reply: (n: number) => StartTurnIfIdleResult = n => ({ opened: true, turnId: `retro-${n}` });
  const scheduler = createSeatRetroScheduler({
    seat: 'JUD', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    startTurnIfIdle: (input, o) => { calls.push({ input, opts: o }); return reply(calls.length); },
    ...(opts.confirm ? { confirmStarted: opts.confirm } : {}),
    store: opts.store ?? mem.store, notify: line => notices.push(line), log: event => logs.push(event),
  });
  return { clock, mem, calls, logs, notices, scheduler, setReply: (fn: typeof reply) => { reply = fn; } };
}

describe('seat retro scheduler', () => {
  test('opens a retro turn on the shared door every interval, with the fixed reply format', () => {
    const r = rig();
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS - SEAT_RETRO_RETRY_MS);
    expect(r.calls).toEqual([]);
    r.clock.advance(SEAT_RETRO_RETRY_MS);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.opts.origin).toBe('retro');
    for (const label of ['did:', 'keep:', 'action:']) expect(r.calls[0]!.input).toContain(label);
    expect(r.mem.saved.at(-1)?.lastOpenedAt).toBe(r.clock.now());
    r.clock.advance(INTERVAL_MS);
    expect(r.calls).toHaveLength(2);
    r.scheduler.dispose();
  });

  test('a busy door defers inside the window and opens when it frees: no miss', () => {
    const r = rig();
    r.scheduler.start();
    r.setReply(n => n < 3 ? { opened: false, reason: n === 1 ? 'NotIdle' : 'HumanTyping' } : { opened: true, turnId: 'retro-late' });
    r.clock.advance(INTERVAL_MS + SEAT_RETRO_RETRY_MS + SEAT_RETRO_RETRY_MS);
    expect(r.calls).toHaveLength(3);
    expect(r.scheduler.state().consecutiveMissed).toBe(0);
    expect(r.scheduler.state().missedTotal).toBe(0);
    expect(r.logs.filter(e => e === 'deferred')).toHaveLength(2);
    r.scheduler.dispose();
  });

  test('a retro that cannot open inside the window is missed; two misses in a row flag the seat; opening clears the flag', () => {
    const r = rig();
    r.scheduler.start();
    r.setReply(() => ({ opened: false, reason: 'NotIdle' }));
    r.clock.advance(INTERVAL_MS + SEAT_RETRO_DEFER_MAX_MS + SEAT_RETRO_RETRY_MS);
    expect(r.scheduler.state()).toMatchObject({ consecutiveMissed: 1, missedTotal: 1, flagged: false });
    expect(r.notices.at(-1)).toContain('Retro missed');
    r.clock.advance(INTERVAL_MS + SEAT_RETRO_DEFER_MAX_MS + SEAT_RETRO_RETRY_MS);
    expect(r.scheduler.state().consecutiveMissed).toBe(SEAT_RETRO_MISSED_FLAG_AT);
    expect(r.scheduler.state().flagged).toBe(true);
    expect(r.mem.saved.at(-1)?.flagged).toBe(true);
    r.setReply(() => ({ opened: true, turnId: 'retro-back' }));
    r.clock.advance(INTERVAL_MS);
    expect(r.scheduler.state()).toMatchObject({ consecutiveMissed: 0, flagged: false });
    expect(r.scheduler.state().missedTotal).toBe(SEAT_RETRO_MISSED_FLAG_AT);
    r.scheduler.dispose();
  });

  test('a rejection that waiting cannot fix (disabled, cap) is missed at once', () => {
    const r = rig();
    r.scheduler.start();
    r.setReply(() => ({ opened: false, reason: 'Disabled' }));
    r.clock.advance(INTERVAL_MS);
    expect(r.calls).toHaveLength(1);
    expect(r.scheduler.state().consecutiveMissed).toBe(1);
    r.scheduler.dispose();
  });

  test('a seat that was down past its due time opens as soon as the door allows', () => {
    const clock = fakeClock();
    const long = { ...emptySeatRetroState(), lastOpenedAt: clock.now() - INTERVAL_MS - INTERVAL_MS };
    const r = rig({ initial: long });
    r.scheduler.start();
    r.clock.advance(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.opts.origin).toBe('retro');
    r.scheduler.dispose();
  });

  test('a state store that cannot save never stops the scheduler', () => {
    const r = rig({ store: { load: () => emptySeatRetroState(), save: () => { throw new Error('disk full'); } } });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS + INTERVAL_MS);
    expect(r.calls).toHaveLength(2);
    expect(r.logs).toContain('state-save-failed');
    r.scheduler.dispose();
  });

  test('dispose stops the timer: nothing opens afterwards', () => {
    const r = rig();
    r.scheduler.start();
    r.scheduler.dispose();
    r.clock.advance(INTERVAL_MS + INTERVAL_MS);
    expect(r.calls).toEqual([]);
    expect(r.clock.pending()).toBe(0);
  });

  test('the prompt carries ledger metrics when given', () => {
    expect(formatSeatRetroPrompt({ seat: 'JUD', intervalMin: INTERVAL_MIN, metrics: ['turns: 12'] })).toContain('- turns: 12');
    expect(formatSeatRetroPrompt({ seat: 'JUD', intervalMin: INTERVAL_MIN })).not.toContain('Metrics');
  });
});

describe('a parked turn that the input loop never takes', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < Object.keys({ a: 1, b: 2, c: 3 }).length; i++) await Promise.resolve(); };

  test('opened-then-withdrawn is not a retro: nothing is recorded, it retries inside the window, then counts one miss', async () => {
    const r = rig({ confirm: () => Promise.resolve(false) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    await settle();
    expect(r.scheduler.state().lastOpenedAt).toBeNull();
    expect(r.mem.saved.filter(s => s.lastOpenedAt !== null)).toEqual([]);
    for (let i = 0; i < SEAT_RETRO_DEFER_MAX_MS / SEAT_RETRO_RETRY_MS + 1; i++) { r.clock.advance(SEAT_RETRO_RETRY_MS); await settle(); }
    expect(r.scheduler.state().lastOpenedAt).toBeNull();
    expect(r.scheduler.state().consecutiveMissed).toBe(SEAT_RETRO_MISSED_FLAG_AT - 1);
    expect(r.logs).toContain('missed');
    r.scheduler.dispose();
  });

  test('taken by the input loop: recorded as a retro and the miss streak resets', async () => {
    const r = rig({ initial: { ...emptySeatRetroState(), consecutiveMissed: SEAT_RETRO_MISSED_FLAG_AT - 1, flagged: false }, confirm: () => Promise.resolve(true) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    await settle();
    expect(r.scheduler.state().lastOpenedAt).not.toBeNull();
    expect(r.scheduler.state().consecutiveMissed).toBe(0);
    r.scheduler.dispose();
  });

  test('withdrawn once, then taken on the retry: no miss', async () => {
    let answers = 0;
    const r = rig({ confirm: () => Promise.resolve(++answers > 1) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    await settle();
    r.clock.advance(SEAT_RETRO_RETRY_MS);
    await settle();
    expect(r.scheduler.state().lastOpenedAt).not.toBeNull();
    expect(r.scheduler.state().missedTotal).toBe(0);
    r.scheduler.dispose();
  });

  test('a confirmation that throws counts like a busy door, never as a retro', async () => {
    const r = rig({ confirm: () => Promise.reject(new Error('watch broke')) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    await settle();
    expect(r.scheduler.state().lastOpenedAt).toBeNull();
    r.scheduler.dispose();
  });

  test('disposed while waiting for the confirmation: nothing is recorded afterwards', async () => {
    let release: (started: boolean) => void = () => {};
    const r = rig({ confirm: () => new Promise<boolean>(resolve => { release = resolve; }) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    r.scheduler.dispose();
    release(true);
    await settle();
    expect(r.scheduler.state().lastOpenedAt).toBeNull();
  });
});

describe('restart and clamping', () => {
  test('after a long downtime the door gets the full defer window from the restart (not a miss at the first busy answer)', () => {
    const clock = fakeClock();
    const old = { ...emptySeatRetroState(), lastOpenedAt: clock.now() - INTERVAL_MS - INTERVAL_MS - INTERVAL_MS };
    const r = rig({ initial: old });
    r.scheduler.start();
    r.setReply(n => n < 4 ? { opened: false, reason: 'NotIdle' } : { opened: true, turnId: 'retro-after-downtime' });
    r.clock.advance(SEAT_RETRO_RETRY_MS * 4);
    expect(r.scheduler.state().missedTotal).toBe(0);
    expect(r.scheduler.state().lastOpenedAt).not.toBeNull();
    r.scheduler.dispose();
  });

  test('a miss saves the next due time: a restart keeps the schedule instead of retrying at once or double-counting', () => {
    const r = rig();
    r.scheduler.start();
    r.setReply(() => ({ opened: false, reason: 'NotIdle' }));
    r.clock.advance(INTERVAL_MS + SEAT_RETRO_DEFER_MAX_MS + SEAT_RETRO_RETRY_MS);
    const saved = r.mem.saved.at(-1)!;
    expect(saved.consecutiveMissed).toBe(SEAT_RETRO_MISSED_FLAG_AT - 1);
    expect(saved.nextDueAt).not.toBeNull();
    r.scheduler.dispose();
    // A new process starts from the saved state at the same wall-clock moment.
    const clock = fakeClock(r.clock.now());
    const calls: string[] = [];
    const again = createSeatRetroScheduler({
      seat: 'JUD', now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      startTurnIfIdle: input => { calls.push(input); return { opened: true, turnId: 'retro-restart' }; },
      store: { load: () => saved, save: () => {} }, log: () => {},
    });
    again.start();
    clock.advance(SEAT_RETRO_RETRY_MS);
    expect(calls).toEqual([]);
    clock.advance(saved.nextDueAt! - clock.now());
    expect(calls).toHaveLength(1);
    expect(again.state().consecutiveMissed).toBe(0);
    again.dispose();
  });

  test('an interval outside the safe range is clamped, so no timer delay can overflow', () => {
    const delays: number[] = [];
    const make = (intervalMin: number) => createSeatRetroScheduler({
      seat: 'JUD', intervalMin, now: () => Date.UTC(2026, 10, 17), setTimer: (_fn, ms) => { delays.push(ms); return delays.length; },
      clearTimer: () => {}, startTurnIfIdle: () => ({ opened: true, turnId: 'x' }),
      store: { load: () => emptySeatRetroState(), save: () => {} }, log: () => {},
    });
    make(Number.MAX_SAFE_INTEGER).start();
    make(Number.NaN).start();
    make(Number.NEGATIVE_INFINITY).start();
    expect(delays[0]).toBe(SEAT_RETRO_MAX_INTERVAL_MIN * 60_000);
    expect(delays[1]).toBe(INTERVAL_MS);
    expect(delays[2]).toBe(INTERVAL_MS);
    expect(Math.max(...delays)).toBe(SEAT_RETRO_MAX_INTERVAL_MIN * 60_000);
  });
});

describe('retro state file', () => {
  test('round trip; a missing file is the empty state; the path is per seat', () => {
    const dir = tmp();
    const file = seatRetroStateFile('jud', dir);
    expect(file).toBe(join(dir, 'seat-state', 'JUD', 'retro-state.json'));
    const store = createFileSeatRetroStateStore(file);
    expect(store.load()).toEqual(emptySeatRetroState());
    const state: SeatRetroState = { lastOpenedAt: Date.UTC(2026, 10, 17), consecutiveMissed: SEAT_RETRO_MISSED_FLAG_AT, missedTotal: SEAT_RETRO_MISSED_FLAG_AT, flagged: true, nextDueAt: Date.UTC(2026, 10, 18) };
    store.save(state);
    expect(createFileSeatRetroStateStore(file).load()).toEqual(state);
    expect(() => seatRetroStateFile('../x', dir)).toThrow();
  });

  test('a damaged state file is never overwritten: load fails, save refuses, bytes stay', () => {
    const dir = tmp();
    const file = join(dir, 'retro-state.json');
    writeFileSync(file, '{"lastOpenedAt":"yesterday"}');
    const store = createFileSeatRetroStateStore(file);
    expect(() => store.load()).toThrow();
    expect(() => store.save(emptySeatRetroState())).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"lastOpenedAt":"yesterday"}');
  });

  test('a write that cannot complete keeps the original and leaves no temp file', () => {
    const dir = tmp();
    const file = join(dir, 'retro-state.json');
    mkdirSync(join(file, 'keep'), { recursive: true }); // the target is a non-empty directory: rename must fail
    expect(() => createFileSeatRetroStateStore(file).save(emptySeatRetroState())).toThrow();
    expect(readdirSync(dir)).toEqual(['retro-state.json']);
  });

  test('a fresh store instance never writes over a file that is damaged now, even without a prior load', () => {
    const dir = tmp();
    const file = join(dir, 'retro-state.json');
    createFileSeatRetroStateStore(file).save(emptySeatRetroState());
    writeFileSync(file, 'damaged after the first save');
    expect(() => createFileSeatRetroStateStore(file).save(emptySeatRetroState())).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('damaged after the first save');
  });

  test('the scheduler runs from memory over a damaged file and leaves it untouched', () => {
    const dir = tmp();
    const file = join(dir, 'retro-state.json');
    writeFileSync(file, 'not json');
    const r = rig({ store: createFileSeatRetroStateStore(file) });
    r.scheduler.start();
    r.clock.advance(INTERVAL_MS);
    expect(r.calls).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe('not json');
    expect(r.logs).toContain('state-load-failed');
    r.scheduler.dispose();
  });
});

describe('next TUI factory', () => {
  const base = (env: NodeJS.ProcessEnv, clock = fakeClock(), intervalMin = INTERVAL_MIN) => createNextTuiWakeup({
    isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0, requestYield: () => true,
    notify: () => {}, env, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    lastHumanKeyAt: () => 0, pendingKeyCount: () => 0, log: () => {},
    retro: { seat: 'JUD', intervalMin, store: memoryStore().store },
  });

  test('the factory opens an origin-retro request on the real internal-turn gate', () => {
    const clock = fakeClock();
    const wake = base({}, clock);
    expect(wake.retro).not.toBeNull();
    clock.advance(INTERVAL_MS);
    const request = wake.gate.takePending();
    expect(request?.origin).toBe('retro');
    expect(request?.input).toContain('[retro] JUD');
    expect(wake.banner(request!)).toContain('retro');
    wake.dispose();
  });

  test('through the real gate the retro counts only when the input loop takes the turn', async () => {
    const clock = fakeClock();
    const wake = base({}, clock);
    clock.advance(INTERVAL_MS);
    expect(wake.retro!.state().lastOpenedAt).toBeNull(); // parked, not started
    const request = wake.takePendingIfIdle();
    expect(request?.origin).toBe('retro');
    await Promise.resolve();
    await Promise.resolve();
    expect(wake.retro!.state().lastOpenedAt).toBe(clock.now());
    wake.dispose();
  });

  test('a harness child or an interval of zero gets no retro', () => {
    expect(base({ ELANOUS_HARNESS_ROLE: 'child' }).retro).toBeNull();
    expect(base({}, fakeClock(), 0).retro).toBeNull();
  });
});

describe('which TUI may run a retro', () => {
  const noFolder = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  const folder = () => ({ isDirectory: () => true });
  const seatCwd = '/Users/x/elanous-hq/seats/JUD';

  test('a seat TUI with its state directory qualifies; the seat comes from the working directory', () => {
    expect(resolveSeatRetroSeat(seatCwd, {}, { instanceKind: () => 'prod', stat: folder })).toBe('JUD');
  });

  test('a bare COORD_ID without a state directory does not make a human TUI a seat (and nothing creates the directory)', () => {
    expect(resolveSeatRetroSeat('/Users/x/work', { COORD_ID: 'JUD' }, { instanceKind: () => 'prod', stat: noFolder })).toBeNull();
    expect(resolveSeatRetroSeat(seatCwd, {}, { instanceKind: () => 'prod', stat: noFolder })).toBeNull();
  });

  test('a test-universe run never uses the production HQ state', () => {
    expect(resolveSeatRetroSeat(seatCwd, {}, { instanceKind: () => 'test', stat: folder })).toBeNull();
  });

  test('a lookup failure (permission) or a non-directory means no retro', () => {
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(resolveSeatRetroSeat(seatCwd, {}, { instanceKind: () => 'prod', stat: denied })).toBeNull();
    expect(resolveSeatRetroSeat(seatCwd, {}, { instanceKind: () => 'prod', stat: () => ({ isDirectory: () => false }) })).toBeNull();
  });
});

describe('interval setting', () => {
  test('unset or blank = default; zero or negative = off; unreadable = default; below the minimum = the minimum', () => {
    expect(parseSeatRetroIntervalMin(undefined)).toBe(INTERVAL_MIN);
    expect(parseSeatRetroIntervalMin('  ')).toBe(INTERVAL_MIN);
    expect(parseSeatRetroIntervalMin('abc')).toBe(INTERVAL_MIN);
    expect(parseSeatRetroIntervalMin('0')).toBe(0);
    expect(parseSeatRetroIntervalMin('-5')).toBe(0);
    expect(parseSeatRetroIntervalMin(String(SEAT_RETRO_MIN_INTERVAL_MIN / 2))).toBe(SEAT_RETRO_MIN_INTERVAL_MIN);
    expect(parseSeatRetroIntervalMin(String(SEAT_RETRO_MAX_INTERVAL_MIN * 2))).toBe(SEAT_RETRO_MAX_INTERVAL_MIN);
  });

  test('the scheduler applies the same floor: a half-minute request is the minimum, not the default', () => {
    const delays: number[] = [];
    createSeatRetroScheduler({
      seat: 'JUD', intervalMin: SEAT_RETRO_MIN_INTERVAL_MIN / 2, now: () => Date.UTC(2026, 10, 17),
      setTimer: (_fn, ms) => { delays.push(ms); return delays.length; }, clearTimer: () => {},
      startTurnIfIdle: () => ({ opened: true, turnId: 'x' }), store: { load: () => emptySeatRetroState(), save: () => {} }, log: () => {},
    }).start();
    expect(delays).toEqual([SEAT_RETRO_MIN_INTERVAL_MIN * 60_000]);
  });
});

describe('the start-confirmation wait uses the injected clock', () => {
  test('a parked retro that the loop never takes is withdrawn when the FAKE clock passes the wait (no real wait)', async () => {
    const clock = fakeClock();
    const wake = createNextTuiWakeup({
      isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0, requestYield: () => true,
      notify: () => {}, env: {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      lastHumanKeyAt: () => 0, pendingKeyCount: () => 0, log: () => {},
      retro: { seat: 'JUD', intervalMin: INTERVAL_MIN, store: memoryStore().store },
    });
    clock.advance(INTERVAL_MS); // retro parked on the gate; nobody takes it
    expect(wake.gate.pendingTurnId()).not.toBeNull();
    clock.advance(SEAT_CAP_START_WAIT_MS);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(wake.gate.pendingTurnId()).toBeNull(); // withdrawn by the confirmation wait
    expect(wake.retro!.state().lastOpenedAt).toBeNull();
    wake.dispose();
  });
});
