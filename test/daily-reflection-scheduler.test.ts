// R6 v2 — daily reflection scheduler contract.
//
// Cross-ref:
//   src/notes/daily-reflection-scheduler.ts
//   src/notes/daily-reflection.ts
//   src/web-push/notify-daily-reflection.ts

import { describe, expect, test } from 'bun:test';

import {
  startDailyReflectionScheduler,
} from '../src/notes/daily-reflection-scheduler.js';
import type { DailyReflectionSnapshot } from '../src/notes/daily-reflection.js';

interface FakeTimer {
  ticks: Array<() => void>;
  intervals: number[];
}

function makeFakeTimer(): {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  invokeAll(): void;
  count(): number;
} {
  const state: FakeTimer = { ticks: [], intervals: [] };
  return {
    setInterval(fn, ms) {
      state.ticks.push(fn);
      state.intervals.push(ms);
      return state.ticks.length - 1;
    },
    clearInterval(handle) {
      if (typeof handle === 'number') {
        state.ticks[handle] = () => { /* cleared */ };
      }
    },
    invokeAll() {
      for (const t of state.ticks) t();
    },
    count() { return state.ticks.length; },
  };
}

describe('startDailyReflectionScheduler · tick gating', () => {
  test('tick at 21:00 fires once per day', async () => {
    const timer = makeFakeTimer();
    const calls: Array<{ snapshot: DailyReflectionSnapshot; hanseiText?: string }> = [];
    // Pin local time to 2026-01-15 21:00:00.
    let nowMs = new Date('2026-01-15T12:00:00').getTime();
    const baseHour = new Date(nowMs).getHours(); // local hour
    void baseHour;
    const scheduler = startDailyReflectionScheduler({
      hour: new Date('2026-01-15T21:00:00').getHours(),
      minute: 0,
      now: () => nowMs,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      notify: async (input) => {
        const entry: { snapshot: DailyReflectionSnapshot; hanseiText?: string } = {
          snapshot: input.snapshot,
        };
        if (input.hanseiText !== undefined) entry.hanseiText = input.hanseiText;
        calls.push(entry);
      },
    });
    // First tick BEFORE 21:00 — no fire.
    nowMs = new Date('2026-01-15T20:59:00').getTime();
    timer.invokeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(0);
    // Tick AT 21:00 — fires once.
    nowMs = new Date('2026-01-15T21:00:00').getTime();
    timer.invokeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(1);
    // Tick again at 21:00:00 same day — does NOT re-fire.
    timer.invokeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(1);
    // Tick next day at 21:00 — fires again.
    nowMs = new Date('2026-01-16T21:00:00').getTime();
    timer.invokeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(2);
    scheduler.stop();
  });

  test('stop is idempotent', () => {
    const timer = makeFakeTimer();
    const scheduler = startDailyReflectionScheduler({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    scheduler.stop();
    scheduler.stop(); // no throw
    expect(scheduler.lastFiredDate()).toBeNull();
  });
});

describe('startDailyReflectionScheduler · fireNow + polish', () => {
  test('fireNow with polish wired → notify receives hanseiText', async () => {
    const timer = makeFakeTimer();
    const calls: Array<{ hanseiText?: string }> = [];
    const scheduler = startDailyReflectionScheduler({
      now: () => new Date('2026-02-01T10:00:00Z').getTime(),
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      polish: async () => '오늘 노트 5개 저장 · 좋은 하루였음.',
      notify: async (input) => {
        const entry: { hanseiText?: string } = {};
        if (input.hanseiText !== undefined) entry.hanseiText = input.hanseiText;
        calls.push(entry);
      },
    });
    const snap = await scheduler.fireNow();
    expect(snap.date).toBe('2026-02-01');
    expect(calls.length).toBe(1);
    expect(calls[0]!.hanseiText).toContain('오늘 노트');
    scheduler.stop();
  });

  test('fireNow with polish that throws → notify still fires (no hanseiText)', async () => {
    const timer = makeFakeTimer();
    const calls: Array<{ hanseiText?: string }> = [];
    const scheduler = startDailyReflectionScheduler({
      now: () => new Date('2026-02-01T10:00:00Z').getTime(),
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      polish: async () => { throw new Error('LLM unreachable'); },
      notify: async (input) => {
        const entry: { hanseiText?: string } = {};
        if (input.hanseiText !== undefined) entry.hanseiText = input.hanseiText;
        calls.push(entry);
      },
    });
    await scheduler.fireNow();
    expect(calls.length).toBe(1);
    expect(calls[0]!.hanseiText).toBeUndefined();
    scheduler.stop();
  });

  test('fireNow with polish that returns empty → notify falls back (no hanseiText)', async () => {
    const timer = makeFakeTimer();
    const calls: Array<{ hanseiText?: string }> = [];
    const scheduler = startDailyReflectionScheduler({
      now: () => new Date('2026-02-01T10:00:00Z').getTime(),
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      polish: async () => '   \n  ',
      notify: async (input) => {
        const entry: { hanseiText?: string } = {};
        if (input.hanseiText !== undefined) entry.hanseiText = input.hanseiText;
        calls.push(entry);
      },
    });
    await scheduler.fireNow();
    expect(calls.length).toBe(1);
    expect(calls[0]!.hanseiText).toBeUndefined();
    scheduler.stop();
  });
});

describe('startDailyReflectionScheduler · clamp', () => {
  test('hour > 23 clamps to 23', () => {
    const timer = makeFakeTimer();
    const events: Array<Record<string, unknown> | undefined> = [];
    const scheduler = startDailyReflectionScheduler({
      hour: 99,
      minute: 99,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      log: (event, payload) => { if (event === 'boot') events.push(payload); },
    });
    expect(events[0]).toMatchObject({ hour: 23, minute: 59 });
    scheduler.stop();
  });
});

describe('startDailyReflectionScheduler · boot log (dogfood visibility)', () => {
  test('logs boot event with hour/minute/intervalMs/hasPolish', () => {
    const timer = makeFakeTimer();
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const scheduler = startDailyReflectionScheduler({
      hour: 7,
      minute: 30,
      intervalMs: 12_000,
      polish: async () => 'unused',
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      log: (event, payload) => {
        const entry: { event: string; payload?: Record<string, unknown> } = { event };
        if (payload !== undefined) entry.payload = payload;
        events.push(entry);
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.event).toBe('boot');
    expect(events[0]!.payload).toEqual({
      hour: 7,
      minute: 30,
      intervalMs: 12_000,
      hasPolish: true,
    });
    scheduler.stop();
  });

  test('boot log reports hasPolish=false when polish callable absent', () => {
    const timer = makeFakeTimer();
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const scheduler = startDailyReflectionScheduler({
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      log: (event, payload) => {
        const entry: { event: string; payload?: Record<string, unknown> } = { event };
        if (payload !== undefined) entry.payload = payload;
        events.push(entry);
      },
    });
    const bootEvt = events.find((e) => e.event === 'boot');
    expect(bootEvt).toBeDefined();
    expect(bootEvt!.payload!.hasPolish).toBe(false);
    scheduler.stop();
  });
});
