import { describe, expect, test } from 'bun:test';
import {
  createDashboardStreamingStage,
  createStageClock,
  runDashboardStreamingScenario,
} from './dashboard-event-loop-stall-monitor-device.js';

describe('TUI-TYPING-LAG ux-sim device: worker log burst + key input through production StoreSink ⊕ stall monitor', () => {
  test('stage clock only moves on explicit advance; an iteration runs only tasks due at its start', () => {
    const clock = createStageClock(500);
    const ran: string[] = [];
    clock.schedule(() => { ran.push('b'); clock.schedule(() => ran.push('chained'), 0); }, 5);
    clock.schedule(() => ran.push('a'), 5);
    clock.schedule(() => ran.push('later'), 50);
    expect(clock.now()).toBe(500);
    expect(clock.runIteration()).toBe(0);
    clock.advance(5);
    expect(clock.runIteration()).toBe(2);
    expect(ran).toEqual(['b', 'a']); // chained task waits for the next iteration
    expect(clock.runIteration()).toBe(1);
    expect(ran).toEqual(['b', 'a', 'chained']);
    clock.advance(45);
    expect(clock.runDue()).toBe(1);
    expect(ran).toEqual(['b', 'a', 'chained', 'later']);
  });

  test('batched (chunked StoreSink drain): stall (>250ms) count 0 and max typing lag < 100ms', () => {
    const result = runDashboardStreamingScenario({ mode: 'batched' });
    expect(result.samples.length).toBe(12);
    expect(result.workerEvents).toBe(12 * 800);
    expect(result.stallCount).toBe(0);
    expect(result.maxLagMs).toBeLessThan(100);
    expect(result.insertBatches).toBeGreaterThan(12);
  });

  test('inline (pre-fix single-tick drain) reproduces the stall — the thresholds discriminate', () => {
    const result = runDashboardStreamingScenario({ mode: 'inline' });
    expect(result.maxLagMs).toBeGreaterThanOrEqual(250);
    expect(result.stallCount).toBeGreaterThan(0);
    expect(Math.min(...result.stallLagsMs)).toBeGreaterThanOrEqual(250);
  });

  test('chunked drain preserves FIFO order and loses nothing', () => {
    const result = runDashboardStreamingScenario({ mode: 'batched' });
    expect(result.insertedRows).toBe(result.workerEvents);
    expect(result.pendingEvents).toBe(0);
    expect(result.insertedSeqOrder).toEqual(Array.from({ length: result.workerEvents }, (_, index) => index));
  });

  test('per-keypress samples are exposed', () => {
    const stage = createDashboardStreamingStage({ mode: 'batched', keypresses: 3, workerEventsPerKey: 100 });
    const first = stage.pressKey('k');
    const second = stage.pressKey('j');
    const result = stage.run();
    stage.dispose();
    expect(first.key).toBe('k');
    expect(second.index).toBe(1);
    expect(result.samples.length).toBe(5);
    expect(result.samples[0]?.lagMs).toBeLessThan(100);
    expect(result.stallCount).toBe(0);
  });
});
