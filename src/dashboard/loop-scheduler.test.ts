// TUI-LOOP-COMMAND — /loop 칸 문면의 판정선 시험.
//   idle 발사 1 · busy 미룸 · stop 0 (src/dashboard/loop-scheduler.ts)
import { expect, test } from 'bun:test';
import { createLoopScheduler } from './loop-scheduler.js';

test('idle 발사 1 — 쉬고 있는 틱마다 프롬프트를 정확히 한 번 발사한다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.tick();
  expect(fired).toBe(2);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.stop();
});

test('idle 발사 1 — 바쁜 틱 사이로 돌아온 쉼 틱에서도 틱당 발사는 한 번이다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  idle = false;
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  idle = true;
  scheduler.tick();
  expect(fired).toBe(1);
  scheduler.tick();
  expect(fired).toBe(2);
  scheduler.stop();
});

test('busy 미룸 — 바쁜 틱은 발사를 버리지 않고 «한 개»로 미룬다(적체 없음)', () => {
  let idle = false;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  idle = true;
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.stop();
});

test('stop 0 — stop 이후에는 어떤 틱도 발사하지 않는다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(1);
  scheduler.stop();
  expect(scheduler.isRunning()).toBe(false);
  scheduler.tick();
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
});

test('start 은 타이머를 스케줄하고 stop 은 그 타이머를 푼다 — 늦게 도착한 틱도 발사하지 않는다', () => {
  const scheduled: Array<{ callback: () => void; unsubscribe: () => void }> = [];
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 50,
    isIdle: () => idle,
    fire: () => { fired += 1; },
    schedule: (callback) => {
      const entry: { callback: () => void; unsubscribe: () => void } = {
        callback,
        unsubscribe: () => {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
        },
      };
      scheduled.push(entry);
      return entry;
    },
  });
  scheduler.start();
  expect(scheduled).toHaveLength(1);
  scheduled[0]!.callback();
  expect(fired).toBe(1);
  scheduler.stop();
  expect(scheduled).toHaveLength(0);
  scheduler.tick();
  expect(fired).toBe(1);
});

test('start 을 두 번 불러도 타이머는 하나다', () => {
  const scheduled: Array<{ callback: () => void; unsubscribe: () => void }> = [];
  const scheduler = createLoopScheduler({
    intervalMs: 50,
    isIdle: () => true,
    fire: () => {},
    schedule: (callback) => {
      const entry: { callback: () => void; unsubscribe: () => void } = {
        callback,
        unsubscribe: () => {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
        },
      };
      scheduled.push(entry);
      return entry;
    },
  });
  scheduler.start();
  scheduler.start();
  expect(scheduled).toHaveLength(1);
  scheduler.stop();
  expect(scheduled).toHaveLength(0);
});
