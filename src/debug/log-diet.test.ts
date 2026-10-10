import { describe, expect, it } from 'bun:test';
import { debug, type DebugEvent } from './log.js';
import { LOG_DIET_KEYS, LOG_DIET_WINDOW_MS, LogDietGuard } from './log-diet.js';

const record = (category: string, event: string, data: unknown, extras: Partial<DebugEvent> = {}) =>
  ({ category, event, data, ...extras });

function captureSink(run: (events: DebugEvent[]) => void, guard = new LogDietGuard()): void {
  const events: DebugEvent[] = [];
  const previous = debug.setLogDietGuard(guard);
  const unregister = debug.registerSink({ name: 'log-diet-test', emit: event => events.push(event) });
  try {
    run(events);
  } finally {
    unregister();
    debug.setLogDietGuard(previous);
  }
}

describe('LogDietGuard', () => {
  it('admits the first, suppresses four within the minute, samples and summarizes at 61 seconds', () => {
    let time = 0;
    const guard = new LogDietGuard({ now: () => time });
    const rec = record('input.cursor.claim', 'chat-main', { owner: 'chat' });
    const decisions = Array.from({ length: 5 }, (_, index) => {
      time = index * 1_000;
      return guard.admit(rec);
    });
    time = 61_000;
    decisions.push(guard.admit(rec));
    expect(decisions.map(d => d.pass)).toEqual([true, false, false, false, false, true]);
    expect(decisions.at(-1)!.summaries).toEqual([{
      category: 'input.cursor.claim', event: 'chat-main', count: 4,
      windowMs: LOG_DIET_WINDOW_MS,
      firstSuppressedAt: new Date(1_000).toISOString(),
      lastSuppressedAt: new Date(4_000).toISOString(),
    }]);
    expect(guard.drain()).toEqual([]);
  });

  it('repeat collapses interleaved A/B but consecutive preserves every transition', () => {
    for (const [category, event, expected] of [
      ['tox.loop', 'tick', [true, true, false, false]],
      ['watchdog', 'activity', [true, true, true, true]],
    ] as const) {
      const guard = new LogDietGuard({ now: () => 0 });
      expect(['A', 'B', 'A', 'B'].map(label => guard.admit(record(category, event, { label })).pass)).toEqual([...expected]);
    }
  });

  it('consecutive summarizes before a value transition and before its periodic sample', () => {
    let time = 0;
    const guard = new LogDietGuard({ now: () => time });
    const act = (label: string) => guard.admit(record('watchdog', 'activity', { label }));
    expect(act('alive-1').pass).toBe(true);
    time = 1_000;
    expect(act('alive-1').pass).toBe(false);
    time = 2_000;
    expect(act('alive-0').summaries[0]?.count).toBe(1);
    time = 3_000;
    expect(act('alive-0').pass).toBe(false);
    time = 62_000;
    expect(act('alive-0').summaries[0]?.count).toBe(1);
  });

  it('bypasses explicit errors and separates distinct run and session identities', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    const error = record('tox.loop', 'tick', { active: 1 }, { level: 'error' });
    expect(Array.from({ length: 3 }, () => guard.admit(error).pass)).toEqual([true, true, true]);
    for (const level of ['warn', 'critical'] as const) {
      expect(guard.admit(record('tox.loop', 'tick', { active: 1 }, { level })).pass).toBe(true);
      expect(guard.admit(record('tox.loop', 'tick', { active: 1 }, { level })).pass).toBe(true);
    }
    const first = record('tox.loop', 'tick', { active: 1, runId: 'run-1' });
    const second = record('tox.loop', 'tick', { active: 1, runId: 'run-2' });
    expect([guard.admit(first).pass, guard.admit(first).pass, guard.admit(second).pass]).toEqual([true, false, true]);
    expect(guard.admit(record('tox.loop', 'tick', { active: 1, runId: 'run-1' }, { session_id: 'other' })).pass).toBe(true);
    expect(guard.admit(record('tox.loop', 'tick', { active: 1 }, { runId: 'run-3' })).pass).toBe(true);
  });

  it('preserves session and run attribution in suppressed summaries', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    const rec = record('tox.loop', 'tick', { runId: 'run-1' }, { session_id: 'session-1' });
    guard.admit(rec);
    guard.admit(rec);
    expect(guard.drain()).toMatchObject([{
      runId: 'run-1', sessionId: 'session-1', count: 1,
    }]);
  });

  it('canonicalizes nested payload keys, including enriched run attribution', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    expect(guard.admit(record('tox.loop', 'tick', { b: { z: 1, a: 2 }, a: 0 }, { runId: 'run' })).pass).toBe(true);
    expect(guard.admit(record('tox.loop', 'tick', { a: 0, b: { a: 2, z: 1 } }, { runId: 'run' })).pass).toBe(false);
  });

  it('handles repeated references in payloads without mutating their identity', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    const shared = { v: 1 };
    const rec = record('tox.loop', 'tick', { first: shared, second: shared });
    expect(guard.admit(rec).pass).toBe(true);
    expect(guard.admit(rec).pass).toBe(false);
  });

  it('only the six policy keys are eligible, with log.diet always bypassing', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    expect(Object.keys(LOG_DIET_KEYS)).toHaveLength(6);
    for (const key of ['harness.queue/attributed', 'seat.loop/queue-retryable', 'pod-lease/admit-by-usage', 'pty.manifest/output-bytes-flushed']) {
      const [category, event] = key.split('/');
      expect([guard.admit(record(category, event, {})).pass, guard.admit(record(category, event, {})).pass]).toEqual([true, true]);
    }
    expect([guard.admit(record('log.diet', 'suppressed', {})).pass, guard.admit(record('log.diet', 'suppressed', {})).pass]).toEqual([true, true]);
    expect(guard.drain()).toEqual([]);
  });

  it('off bypasses five identical records and accumulates no summaries', () => {
    const before = process.env.ELANOUS_LOG_DIET;
    try {
      process.env.ELANOUS_LOG_DIET = 'off';
      const guard = new LogDietGuard({ now: () => 0 });
      expect(Array.from({ length: 5 }, () => guard.admit(record('tox.loop', 'tick', {})).pass)).toEqual([true, true, true, true, true]);
      expect(guard.drain()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.ELANOUS_LOG_DIET;
      else process.env.ELANOUS_LOG_DIET = before;
    }
  });

  it('evicts the oldest flow with its suppressed count intact', () => {
    const guard = new LogDietGuard({ now: () => 0, maxStreams: 2 });
    const tick = (label: string) => guard.admit(record('tox.loop', 'tick', { label }));
    tick('A');
    expect(tick('A').pass).toBe(false);
    tick('B');
    expect(tick('C').summaries).toMatchObject([{
      category: 'tox.loop', event: 'tick', count: 1,
      firstSuppressedAt: new Date(0).toISOString(), lastSuppressedAt: new Date(0).toISOString(),
    }]);
    expect(tick('A').pass).toBe(true);
  });

  it('drain returns pending counts once and clears identity state', () => {
    const guard = new LogDietGuard({ now: () => 0 });
    const rec = record('tox.loop', 'tick', { active: 1 });
    guard.admit(rec);
    guard.admit(rec);
    expect(guard.drain()).toMatchObject([{ count: 1 }]);
    expect(guard.drain()).toEqual([]);
    expect(guard.admit(rec).pass).toBe(true);
  });
});

describe('DebugLog sink wiring', () => {
  it('sends one original and one count-four summary to sinks on flush', () => {
    captureSink(events => {
      for (let i = 0; i < 5; i++) debug.log('input.cursor.claim', 'chat-main', { owner: 'chat' });
      debug.flush();
      expect(events.filter(e => e.category === 'input.cursor.claim' && e.event === 'chat-main')).toHaveLength(1);
      expect(events.filter(e => e.category === 'log.diet' && e.event === 'suppressed'))
        .toMatchObject([{ data: { count: 4, category: 'input.cursor.claim', event: 'chat-main' } }]);
    });
  });

  it('keeps the same-value minute window across flushes while emitting each pending count once', () => {
    let time = 0;
    captureSink(events => {
      const log = () => debug.log('input.cursor.claim', 'chat-main', { owner: 'chat' });
      log();
      debug.flush();
      time = 1_000;
      log();
      expect(events.filter(e => e.category === 'input.cursor.claim' && e.event === 'chat-main')).toHaveLength(1);
      debug.flush();
      expect(events.filter(e => e.category === 'log.diet' && e.event === 'suppressed'))
        .toMatchObject([{ data: { count: 1 } }]);
      debug.flush();
      expect(events.filter(e => e.category === 'log.diet' && e.event === 'suppressed')).toHaveLength(1);
      time = 2_000;
      log();
      debug.flush();
      expect(events.filter(e => e.category === 'input.cursor.claim' && e.event === 'chat-main')).toHaveLength(1);
      expect(events.filter(e => e.category === 'log.diet' && e.event === 'suppressed'))
        .toMatchObject([{ data: { count: 1 } }, { data: { count: 1 } }]);
      time = 61_000;
      log();
      expect(events.filter(e => e.category === 'input.cursor.claim' && e.event === 'chat-main')).toHaveLength(2);
    }, new LogDietGuard({ now: () => time }));
  });

  it('emits the summary before the next admitted original record', () => {
    let time = 0;
    captureSink(events => {
      debug.log('input.cursor.claim', 'chat-main', { owner: 'chat' });
      time = 1_000;
      debug.log('input.cursor.claim', 'chat-main', { owner: 'chat' });
      time = 61_000;
      debug.log('input.cursor.claim', 'chat-main', { owner: 'chat' });
      expect(events.map(e => `${e.category}/${e.event}`)).toEqual([
        'input.cursor.claim/chat-main', 'log.diet/suppressed', 'input.cursor.claim/chat-main',
      ]);
      debug.flush();
      expect(events.filter(e => e.category === 'log.diet')).toHaveLength(1);
    }, new LogDietGuard({ now: () => time }));
  });

  it('preserves all five sink records for an outside key and emits no diet summaries', () => {
    captureSink(events => {
      for (let i = 0; i < 5; i++) debug.log('test.diet', 'outside', { owner: 'chat' });
      debug.flush();
      expect(events.filter(e => e.category === 'test.diet' && e.event === 'outside')).toHaveLength(5);
      expect(events.filter(e => e.category === 'log.diet')).toHaveLength(0);
    });
  });
});
