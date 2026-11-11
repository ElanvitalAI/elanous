import { expect, test } from 'bun:test';
import { startMissionWatch } from './mission-watch.js';

test('mission watcher reports progress then invokes completion once', async () => {
  const updates: string[] = [];
  let polls = 0;
  let completed = 0;
  const watcher = startMissionWatch({
    poll: async () => ({ message: `state-${++polls}`, outcome: polls === 2 ? 'complete' : 'pending' }),
    onUpdate: (message) => updates.push(message),
    onComplete: async () => { completed += 1; },
    onError: (message) => { throw new Error(message); },
    intervalMs: 0,
  });
  await watcher.done;
  expect(updates).toEqual(['state-1', 'state-2']);
  expect(completed).toBe(1);
});

test('mission watcher preserves errors and cancellation prevents post-exit rendering', async () => {
  const updates: string[] = [];
  const errors: string[] = [];
  let release!: (value: { message: string; outcome: 'pending' | 'complete' | 'error' }) => void;
  const watcher = startMissionWatch({
    poll: () => new Promise((resolve) => { release = resolve; }),
    onUpdate: (message) => updates.push(message),
    onComplete: async () => { throw new Error('should not complete'); },
    onError: (message) => errors.push(message),
  });
  watcher.cancel();
  release({ message: 'stopped', outcome: 'complete' });
  await watcher.done;
  expect(updates).toEqual([]);
  expect(errors).toEqual([]);
});

test('mission watcher routes trace failures to onError, never to completion', async () => {
  const errors: string[] = [];
  let completed = 0;
  const watcher = startMissionWatch({
    poll: async () => ({ message: 'trace unavailable', outcome: 'error' }),
    onUpdate: () => {},
    onComplete: async () => { completed += 1; },
    onError: (message) => errors.push(message),
  });
  await watcher.done;
  expect(errors).toEqual(['trace unavailable']);
  expect(completed).toBe(0);
});

test('mission watcher exposes cancellation to an async completion callback', async () => {
  let entered!: () => void;
  let release!: () => void;
  let postCompletionEffects = 0;
  const onCompleteEntered = new Promise<void>((resolve) => { entered = resolve; });
  const completionGate = new Promise<void>((resolve) => { release = resolve; });
  const watcher = startMissionWatch({
    poll: async () => ({ message: 'ready', outcome: 'complete' }),
    onUpdate: () => {},
    onComplete: async (isActive) => {
      entered();
      await completionGate;
      if (isActive()) postCompletionEffects += 1;
    },
    onError: (message) => { throw new Error(message); },
  });
  await onCompleteEntered;
  watcher.cancel();
  release();
  await watcher.done;
  expect(postCompletionEffects).toBe(0);
});
