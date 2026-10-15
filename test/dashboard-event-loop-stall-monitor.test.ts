import { describe, expect, test } from 'bun:test';
import { startEventLoopStallMonitor, thinkingVerbFromFooter, type EventLoopStallTimer } from '../src/dashboard/event-loop-stall-monitor.js';

describe('thinkingVerbFromFooter', () => {
  test('extracts the first supported verb after stripping ANSI formatting', () => {
    expect(thinkingVerbFromFooter('\x1b[38;5;208m✢\x1b[0m \x1b[2mStreaming…\x1b[0m  \x1b[2m(8s · esc 중단)\x1b[0m')).toBe('Streaming');
    expect(thinkingVerbFromFooter('Routing… then Thinking…')).toBe('Routing');
  });

  test('extracts each supported verb', () => {
    expect(thinkingVerbFromFooter('Routing…')).toBe('Routing');
    expect(thinkingVerbFromFooter('Thinking…')).toBe('Thinking');
    expect(thinkingVerbFromFooter('Streaming…')).toBe('Streaming');
  });

  test('returns null for absent or unmatched footer text', () => {
    expect(thinkingVerbFromFooter(null)).toBeNull();
    expect(thinkingVerbFromFooter('❯ hello')).toBeNull();
  });
});

describe('startEventLoopStallMonitor', () => {
  test('logs a stall with the current context when a tick exceeds the threshold', () => {
    let now = 1_000;
    let tick: (() => void) | undefined;
    const timer: EventLoopStallTimer = { unref: () => { unrefCalls += 1; } };
    let unrefCalls = 0;
    const logs: Array<[string, string, Record<string, unknown>]> = [];

    const dispose = startEventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => now,
      setIntervalFn: (callback) => {
        tick = callback;
        return timer;
      },
      clearIntervalFn: () => {},
      getContext: () => ({ streamingInFlight: true, thinkingMessage: 'Thinking… (5s)' }),
      log: (category, event, data) => logs.push([category, event, data]),
    });

    now += 2_600;
    tick?.();

    expect(unrefCalls).toBe(1);
    expect(logs).toEqual([
      ['tui.event-loop', 'monitor-started', { intervalMs: 100, thresholdMs: 250 }],
      ['tui.event-loop', 'stall', { lagMs: 2_500, streamingInFlight: true, thinkingMessage: 'Thinking… (5s)' }],
      // 2초 넘는 정지는 실패 지문(결함 #1·#14)으로도 센다.
      ['tui.failure-signature', 'matched', { id: 'event-loop-stall', surface: 'event-loop' }],
    ]);
    dispose();
  });

  test('does not log a stall below the threshold', () => {
    let now = 1_000;
    let tick: (() => void) | undefined;
    const logs: Array<[string, string, Record<string, unknown>]> = [];

    startEventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => now,
      setIntervalFn: (callback) => {
        tick = callback;
        return {};
      },
      clearIntervalFn: () => {},
      getContext: () => ({ streamingInFlight: false, thinkingMessage: null }),
      log: (category, event, data) => logs.push([category, event, data]),
    });

    now += 150;
    tick?.();

    expect(logs).toEqual([
      ['tui.event-loop', 'monitor-started', { intervalMs: 100, thresholdMs: 250 }],
    ]);
  });

  test('clears its timer exactly once when disposed repeatedly', () => {
    let timer: EventLoopStallTimer | undefined;
    let clearCalls = 0;
    const dispose = startEventLoopStallMonitor({
      setIntervalFn: () => {
        timer = {};
        return timer;
      },
      clearIntervalFn: (received) => {
        expect(received).toBe(timer!);
        clearCalls += 1;
      },
      getContext: () => ({ streamingInFlight: false, thinkingMessage: null }),
      log: () => {},
    });

    dispose();
    dispose();

    expect(clearCalls).toBe(1);
  });
});
