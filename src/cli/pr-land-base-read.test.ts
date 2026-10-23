import { expect, test } from 'bun:test';
import { PR_LAND_BASE_READ_RETRY_DELAY_CAP_MS, prLandBaseReadRetryDelayMs, readPrBaseNameWithRetry } from './pr-land-base-read.js';

test('retry delays grow then stay at the fixed cap', () => {
  expect(prLandBaseReadRetryDelayMs(1)).toBe(1_000);
  expect(prLandBaseReadRetryDelayMs(2)).toBe(3_000);
  expect(prLandBaseReadRetryDelayMs(3)).toBe(PR_LAND_BASE_READ_RETRY_DELAY_CAP_MS);
  expect(prLandBaseReadRetryDelayMs(9)).toBe(PR_LAND_BASE_READ_RETRY_DELAY_CAP_MS);
});

test('a transient unreadable PR base recovers after a one second backoff', async () => {
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
  expect(waits).toEqual([1_000]);
  expect(unreadable).toEqual([[1, 'transient gh failure']]);
});

test('two unreadable PR bases back off increasingly and recover on the third read', async () => {
  let reads = 0;
  const waits: number[] = [];
  const unreadable: Array<[number, string | undefined]> = [];
  const result = await readPrBaseNameWithRetry({
    pr: '42', cwd: '/repo',
    run: () => {
      reads += 1;
      return reads <= 2 ? { ok: false, out: '', err: `gh failure ${reads}` }
        : { ok: true, out: JSON.stringify({ baseRefName: 'main' }), err: '' };
    },
    sleep: async (ms) => { waits.push(ms); },
    onUnreadable: (attempt, stderr) => { unreadable.push([attempt, stderr]); },
  });

  expect(result).toEqual({ baseRefName: 'main', attempts: 3 });
  expect(reads).toBe(3);
  expect(waits).toEqual([1_000, 3_000]);
  expect(unreadable).toEqual([[1, 'gh failure 1'], [2, 'gh failure 2']]);
});

test('repeated unreadable PR base remains unreadable after the bounded retries', async () => {
  let reads = 0;
  const waits: number[] = [];
  const result = await readPrBaseNameWithRetry({
    pr: '42', cwd: '/repo',
    run: () => { reads += 1; return { ok: true, out: '{"baseRefName":""}', err: '' }; },
    sleep: async (ms) => { waits.push(ms); },
  });

  expect(result).toEqual({ baseRefName: null, attempts: 3 });
  expect(reads).toBe(3);
  expect(waits).toEqual([1_000, 3_000]);
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
