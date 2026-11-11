import { expect, test } from 'bun:test';
import { createLoopScheduler } from './loop-scheduler.js';

test('loop scheduler defers busy ticks and fires once when idle returns', () => {
  let idle = false;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
    schedule: () => ({ unsubscribe() {} }),
  });

  scheduler.start();
  scheduler.tick();
  scheduler.tick();
  expect(scheduler.pendingFireCount()).toBe(1);
  expect(fired).toBe(0);

  idle = true;
  scheduler.tick();
  expect(scheduler.pendingFireCount()).toBe(0);
  expect(fired).toBe(1);
  scheduler.stop();
});

test('loop scheduler stop clears pending work and ignores later ticks', () => {
  let fired = 0;
  let unsubscribed = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => false,
    fire: () => { fired += 1; },
    schedule: () => ({ unsubscribe() { unsubscribed += 1; } }),
  });

  scheduler.start();
  scheduler.tick();
  scheduler.stop();
  scheduler.tick();

  expect(scheduler.isRunning()).toBe(false);
  expect(scheduler.pendingFireCount()).toBe(0);
  expect(unsubscribed).toBe(1);
  expect(fired).toBe(0);
});
