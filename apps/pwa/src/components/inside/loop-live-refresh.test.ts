import { afterEach, expect, test } from 'bun:test';
import { _setEventSourceFactoryForTest, openSharedEventSourceCount } from '@/lib/shared-event-source';
import { LOOP_EDGE_TRIGGER_CATEGORIES, loopEdgeTriggerUrl, subscribeLoopEdgeRefresh, type LoopRefreshMode, type LoopRefreshTimers } from './loop-live-refresh';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  close() { this.closed = true; }
}

/** 손으로 돌리는 시계 — 디바운스·폴링을 실제로 기다리지 않고 잰다. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const timers: LoopRefreshTimers = {
    setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timeouts.delete(id as number); },
    setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { every: ms, next: now + ms, fn }); return id; },
    clearInterval: (id) => { intervals.delete(id as number); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...[...timeouts].map(([id, t]) => ({ id, at: t.at, kind: 't' as const })),
        ...[...intervals].map(([id, t]) => ({ id, at: t.next, kind: 'i' as const }))].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.kind === 't') { const t = timeouts.get(due.id)!; timeouts.delete(due.id); t.fn(); }
      else { const t = intervals.get(due.id)!; t.next += t.every; t.fn(); }
    }
    now = end;
  };
  return { timers, advance, pending: () => timeouts.size + intervals.size };
}

const client = { logsStreamUrl: (params: Record<string, string>) => `/v1/logs/stream?${new URLSearchParams(params)}` };
const useFake = () => _setEventSourceFactoryForTest((url) => new FakeEventSource(url) as unknown as EventSource);
afterEach(() => {
  _setEventSourceFactoryForTest(null);
  FakeEventSource.instances = [];
});

test('subscribes the existing log stream filtered to the edge-source categories — no new stream', () => {
  expect(loopEdgeTriggerUrl(client)).toBe(`/v1/logs/stream?category=${encodeURIComponent(LOOP_EDGE_TRIGGER_CATEGORIES.join(','))}`);
  expect(LOOP_EDGE_TRIGGER_CATEGORIES).toEqual(['loop.', 'task-agent', 'harness.queue', 'self-implement.pod']);
});

test('a burst of log frames becomes one debounced re-read; no frames means no re-read until the safety tick', () => {
  useFake();
  const clock = fakeTimers();
  let reads = 0;
  const modes: LoopRefreshMode[] = [];
  const dispose = subscribeLoopEdgeRefresh(client, () => { reads += 1; }, { timers: clock.timers, debounceMs: 800, safetyMs: 30_000, onMode: m => modes.push(m) });
  const source = FakeEventSource.instances[0]!;
  expect(source.url).toContain('/v1/logs/stream?category=');
  expect(modes).toEqual(['stream']);
  clock.advance(10_000);
  expect(reads).toBe(0);
  for (let i = 0; i < 5; i += 1) { source.emit('log', { data: '{}' }); clock.advance(100); }
  expect(reads).toBe(0);
  clock.advance(800);
  expect(reads).toBe(1);
  clock.advance(20_000);
  expect(reads).toBe(2); // 30초 안전망 한 번
  dispose();
  expect(source.closed).toBe(true);
  expect(clock.pending()).toBe(0);
  source.emit('log', { data: '{}' });
  clock.advance(60_000);
  expect(reads).toBe(2);
});

test('stream error falls back to 5s polling; a frame after reconnect returns to signal mode', () => {
  useFake();
  const clock = fakeTimers();
  let reads = 0;
  const modes: LoopRefreshMode[] = [];
  const dispose = subscribeLoopEdgeRefresh(client, () => { reads += 1; }, { timers: clock.timers, onMode: m => modes.push(m) });
  const source = FakeEventSource.instances[0]!;
  source.onerror?.({});
  source.onerror?.({}); // 두 번 와도 폴링은 하나
  expect(modes).toEqual(['stream', 'poll']);
  clock.advance(15_000);
  expect(reads).toBe(3);
  source.emit('log', { data: '{}' });
  expect(modes).toEqual(['stream', 'poll', 'stream']);
  clock.advance(5_000);
  expect(reads).toBe(4); // 디바운스 한 번 · 폴링은 멈췄다
  dispose();
  expect(clock.pending()).toBe(0);
  expect(openSharedEventSourceCount()).toBe(0);
});

test('no stream URL or a constructor failure polls every 5s from the start', () => {
  const clock = fakeTimers();
  let reads = 0;
  const dispose = subscribeLoopEdgeRefresh({ logsStreamUrl: () => null }, () => { reads += 1; }, { timers: clock.timers });
  clock.advance(10_000);
  expect(reads).toBe(2);
  dispose();
  _setEventSourceFactoryForTest(() => { throw new Error('blocked'); });
  const clock2 = fakeTimers();
  let reads2 = 0;
  const modes: LoopRefreshMode[] = [];
  const dispose2 = subscribeLoopEdgeRefresh(client, () => { reads2 += 1; }, { timers: clock2.timers, onMode: m => modes.push(m) });
  expect(modes).toEqual(['poll']);
  clock2.advance(5_000);
  expect(reads2).toBe(1);
  dispose2();
  expect(clock2.pending()).toBe(0);
});
