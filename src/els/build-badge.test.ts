import { expect, test } from 'bun:test';
import { buildAge, createGitAncestor, desiredSha, gitAncestor } from './build-badge.js';

const old = 'a'.repeat(40), desired = 'b'.repeat(40);
test('only known ancestors are older; missing or unrelated builds stay distinct', () => {
  expect(buildAge(old, desired, () => true)).toBe('older');
  expect(buildAge(old, desired, () => false)).toBe('different');
  expect(buildAge(old, desired, () => undefined)).toBe('unknown');
  expect(buildAge(undefined, desired, () => true)).toBe('unknown');
  expect(buildAge(old, undefined, () => true)).toBe('unknown');
  expect(buildAge(desired, desired, () => false)).toBe('current');
  expect(desiredSha('/no/such/desired.json')).toBeUndefined();
});

// ELS-SERVER-MAINLOOP-STARVATION — the listing asks git off the request path: unknown at once, the async answer memoized.
test('createGitAncestor: unknown pair → undefined at once, runner starts after the call returns, answer memoized forever', async () => {
  const calls: string[] = [];
  let inCall = false;
  const ancestor = createGitAncestor((a, b) => { calls.push(`${a}:${b}:${inCall ? 'sync' : 'async'}`); return Promise.resolve(0); });
  inCall = true;
  expect(ancestor('a1', 'b1')).toBeUndefined();
  expect(ancestor('a1', 'b1')).toBeUndefined(); // in flight: not asked twice
  inCall = false;
  expect(calls).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toEqual(['a1:b1:async']);
  expect(ancestor('a1', 'b1')).toBe(true);
  expect(ancestor('a1', 'b1')).toBe(true);
  expect(calls.length).toBe(1);
});

test('createGitAncestor: status 1 → false; a git that cannot answer stays unknown and is asked again only after 30 s', async () => {
  let clock = 0;
  let calls = 0;
  const statuses: Array<number | null> = [null, 1];
  const ancestor = createGitAncestor(() => { calls += 1; return Promise.resolve(statuses.shift() ?? null); }, () => clock);
  expect(ancestor('x', 'y')).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ancestor('x', 'y')).toBeUndefined();
  expect(calls).toBe(1);
  clock += 29_000;
  expect(ancestor('x', 'y')).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toBe(1);
  clock += 2_000;
  expect(ancestor('x', 'y')).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toBe(2);
  expect(ancestor('x', 'y')).toBe(false);
});

test('default gitAncestor never blocks: 18 fresh pairs answer within 5 ms total (a synchronous git spawn costs more per call)', () => {
  const started = performance.now();
  for (let i = 0; i < 18; i += 1) expect(gitAncestor(`${i}`.padStart(40, 'c'), 'd'.repeat(40))).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(5);
});

test('desiredSha: re-read only when the DESIRED.json stamp changes', () => {
  const { mkdtempSync, writeFileSync, utimesSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/els-desired-`);
  const file = `${dir}/DESIRED.json`;
  try {
    writeFileSync(file, JSON.stringify({ sha: 'e'.repeat(40) }));
    utimesSync(file, 1_000, 1_000);
    expect(desiredSha(file)).toBe('e'.repeat(40));
    writeFileSync(file, JSON.stringify({ sha: 'f'.repeat(40) }));
    utimesSync(file, 2_000, 2_000);
    expect(desiredSha(file)).toBe('f'.repeat(40));
    // same size, same inode, mtime put back: the stamp is unchanged → the cached value, no re-read
    writeFileSync(file, JSON.stringify({ sha: '1'.repeat(40) }));
    utimesSync(file, 2_000, 2_000);
    expect(desiredSha(file)).toBe('f'.repeat(40));
    rmSync(file);
    expect(desiredSha(file)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
