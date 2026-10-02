import { expect, test } from 'bun:test';
import type { RunningRunsResult } from '../../self-implement/running-runs.js';
import { childProcessRunner, createRunningRunsBackground } from './running-runs-background.js';

const fake = (n: number) => ({ count: n } as unknown as RunningRunsResult);
const flush = () => new Promise((r) => setTimeout(r, 0));

test('snapshot never waits for the query: first call is empty and starts one refresh; later calls reuse it until stale', async () => {
  let clock = 1_000;
  const calls: boolean[] = [];
  let release!: (r: RunningRunsResult) => void;
  const bg = createRunningRunsBackground((includeTest) => { calls.push(includeTest); return new Promise((resolve) => { release = resolve; }); }, () => clock, 15_000);

  expect(bg.snapshot({})).toEqual({ result: null, ageMs: null });
  expect(bg.snapshot({})).toEqual({ result: null, ageMs: null });
  expect(calls).toEqual([false]); // one in flight, not two

  release(fake(3));
  await flush();
  clock += 5_000;
  expect(bg.snapshot({})).toEqual({ result: fake(3), ageMs: 5_000 });
  expect(calls).toEqual([false]);

  clock += 15_000;
  expect(bg.snapshot({}).result).toEqual(fake(3)); // stale result still served at once
  expect(calls).toEqual([false, false]); // and one refresh started
});

test('includeTest has its own slot, and a failed refresh keeps the previous snapshot', async () => {
  let clock = 0;
  let fail = false;
  const bg = createRunningRunsBackground(async (includeTest) => { if (fail) throw new Error('boom'); return fake(includeTest ? 2 : 1); }, () => clock, 10);
  bg.snapshot({}); bg.snapshot({ includeTest: true });
  await flush();
  expect(bg.snapshot({}).result).toEqual(fake(1));
  expect(bg.snapshot({ includeTest: true }).result).toEqual(fake(2));
  fail = true; clock += 20;
  bg.snapshot({});
  await flush();
  expect(bg.snapshot({}).result).toEqual(fake(1));
});

test('the child process runs the real query and returns parseable JSON', async () => {
  const result = await childProcessRunner(false);
  expect(typeof result).toBe('object');
  expect(result).toHaveProperty('ledger');
}, 60_000);
