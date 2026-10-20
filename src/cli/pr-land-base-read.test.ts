import { expect, test } from 'bun:test';
import { readPrBaseNameWithRetry } from './pr-land-base-read.js';

test('a transient unreadable PR base recovers on a short retry', async () => {
  let reads = 0;
  const waits: number[] = [];
  const unreadable: Array<[number, string | undefined]> = [];
  const result = await readPrBaseNameWithRetry({
    pr: '42', cwd: '/repo',
    run: () => {
      reads += 1;
      return reads === 1 ? { ok: false, out: '', err: 'transient gh failure' }
        : { ok: true, out: JSON.stringify({ baseRefName: 'main' }), err: '' };
    },
    sleep: async (ms) => { waits.push(ms); },
    onUnreadable: (attempt, stderr) => { unreadable.push([attempt, stderr]); },
  });

  expect(result).toEqual({ baseRefName: 'main', attempts: 2 });
  expect(reads).toBe(2);
  expect(waits).toEqual([100]);
  expect(unreadable).toEqual([[1, 'transient gh failure']]);
});

test('repeated unreadable PR base remains unreadable after the bounded retries', async () => {
  let reads = 0;
  let waits = 0;
  const result = await readPrBaseNameWithRetry({
    pr: '42', cwd: '/repo',
    run: () => { reads += 1; return { ok: true, out: '{"baseRefName":""}', err: '' }; },
    sleep: async () => { waits += 1; },
  });

  expect(result).toEqual({ baseRefName: null, attempts: 3 });
  expect(reads).toBe(3);
  expect(waits).toBe(2);
});

test('a readable non-main base is returned immediately without retry', async () => {
  let reads = 0;
  let waits = 0;
  const result = await readPrBaseNameWithRetry({
    pr: '42', cwd: '/repo',
    run: () => { reads += 1; return { ok: true, out: '{"baseRefName":"release/next"}', err: '' }; },
    sleep: async () => { waits += 1; },
  });

  expect(result).toEqual({ baseRefName: 'release/next', attempts: 1 });
  expect(reads).toBe(1);
  expect(waits).toBe(0);
});
