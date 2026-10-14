import { expect, test } from 'bun:test';
import { defaultResyncRun, probeReleaseRun, releaseWindowState, resyncTickWithReleaseProbe, stewardResyncRepoRoot } from './resync-tick.js';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('resync tick passes the measured result to the steward log', async () => {
  const rows: unknown[] = [];
  const summary = { candidates: 1, tried: 1, saved: 1, savedRatio: 1 };
  const dir = mkdtempSync(join(tmpdir(), 'resync-tick-'));
  try {
    const pendingPath = join(dir, 'steward', 'resync-pending.json');
    expect(await resyncTickWithReleaseProbe(async () => summary, (event, data) => rows.push({ event, data }), pendingPath, () => 'idle', () => 'outside')).toEqual({ decision: 'ran', summary });
    expect(Date.parse((JSON.parse(readFileSync(pendingPath, 'utf8')) as { savedAt: string }).savedAt)).toBeGreaterThan(0);
    expect(rows).toEqual([{ event: 'resync-tick', data: { decision: 'ran', summary } }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resync failure is observed while the graph can continue to rejudge', async () => {
  const rows: unknown[] = [];
  expect(await resyncTickWithReleaseProbe(async () => { throw new Error('ownership unavailable'); }, (event, data) => rows.push({ event, data }), resyncPendingPathForTest(), () => 'idle', () => 'outside'))
    .toEqual({ decision: 'failed', reason: 'ownership unavailable' });
  expect(rows).toEqual([{ event: 'resync-tick', data: { decision: 'failed', reason: 'ownership unavailable' } }]);
});

test('logging failure reports a failed tick after resync instead of a success result', async () => {
  const old = console.error;
  const errors: string[] = [];
  console.error = text => { errors.push(String(text)); };
  try {
    expect(await resyncTickWithReleaseProbe(async () => ({ candidates: 0, tried: 0, saved: 0, savedRatio: null }),
      () => { throw new Error('store unavailable'); }, resyncPendingPathForTest(), () => 'idle', () => 'outside')).toEqual({ decision: 'failed', reason: 'log failed: store unavailable' });
    expect(errors).toEqual(['steward resync: log failed: store unavailable']);
  } finally { console.error = old; }
});

function resyncPendingPathForTest(): string { return join(tmpdir(), 'resync-tick-test-pending-unused.json'); }

test('installed-style non-git cwd still passes the registered OP seat to live resync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resync-non-git-cwd-'));
  const before = process.cwd();
  try {
    process.chdir(dir);
    const repo = stewardResyncRepoRoot((role, home) => {
      expect([role, home]).toEqual(['OP', '/state']);
      return '/registered/op-seat';
    }, () => '/state');
    expect(repo).toBe('/registered/op-seat');
    const summary = { candidates: 0, tried: 0, saved: 0, savedRatio: null };
    expect(await defaultResyncRun(repo, async (max, deps, mode) => {
      expect([max, deps?.repoRoot, mode]).toEqual([3, '/registered/op-seat', 'live']);
      return summary;
    })).toEqual(summary);
  } finally { process.chdir(before); rmSync(dir, { recursive: true, force: true }); }
});

test('default resyncTick from a non-git cwd passes the registered OP seat to its executor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resync-default-non-git-'));
  try {
    const repo = resolve(import.meta.dir, '../..');
    const seatsPath = join(repo, 'src/hq/seats.ts');
    const shadowPath = join(repo, 'src/loops/orchestrator/resync-shadow.ts');
    const tickPath = join(repo, 'src/steward/resync-tick.ts');
    const script = join(dir, 'default-tick.ts');
    const pgrep = join(dir, 'pgrep');
    writeFileSync(pgrep, '#!/bin/sh\nexit 1\n');
    chmodSync(pgrep, 0o755);
    writeFileSync(script, `import { mock } from 'bun:test';
const seats = await import(${JSON.stringify(seatsPath)});
mock.module(${JSON.stringify(seatsPath)}, () => ({ ...seats, resolveHqLaunchSeat: (role) => {
  if (role !== 'OP') throw new Error('wrong seat role: ' + role);
  return '/registered/op-seat';
} }));
mock.module(${JSON.stringify(shadowPath)}, () => ({ runResyncShadow: async (max, deps, mode) => {
  console.log('OBSERVED:' + JSON.stringify({ max, repoRoot: deps.repoRoot, mode }));
  return { candidates: 0, tried: 0, saved: 0, savedRatio: null };
} }));
mock.module(${JSON.stringify(join(repo, 'src/release-loop/release-schedule.ts'))}, () => ({ listSchedules: () => [{ cutAt: new Date(Date.now() + 3_600_000).toISOString(), publishAt: new Date(Date.now() + 7_200_000).toISOString() }] }));
const { resyncTick } = await import(${JSON.stringify(tickPath)});
console.log('RESULT:' + JSON.stringify(await resyncTick()));
`);
    const child = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, ELANOUS_STATE_DIR: dir, PATH: `${dir}:${process.env.PATH ?? ''}` }, timeout: 30_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('OBSERVED:{"max":3,"repoRoot":"/registered/op-seat","mode":"live"}');
    expect(child.stdout).toContain('RESULT:{"decision":"ran"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release run or an unreadable process list skips resync and records one decision', async () => {
  for (const [state, reason] of [['active', 'release run active'], ['unknown', 'release process probe unavailable']] as const) {
    const rows: unknown[] = [];
    const result = await resyncTickWithReleaseProbe(async () => { throw new Error('must not run'); },
      (event, data) => rows.push({ event, data }), resyncPendingPathForTest(), () => state);
    expect(result).toEqual({ decision: 'skipped-release', reason });
    expect(rows).toEqual([{ event: 'resync-tick', data: result }]);
  }
  expect(probeReleaseRun(() => ({ status: 0, stdout: '123\n' }), () => '/Users/a/.bun/bin/bun bin/elanous.mjs release run --version 0.2.28')).toBe('active');
  expect(probeReleaseRun(() => ({ status: 0, stdout: '123\n' }), () => '/bin/zsh -c echo release run')).toBe('unknown');
  expect(probeReleaseRun(() => ({ status: 0, stdout: '123\n' }), () => '/bin/zsh -c "bun bin/elanous.mjs release run"')).toBe('unknown');
  expect(probeReleaseRun(() => ({ status: 0, stdout: '123\n456\n' }), pid => pid === '123'
    ? '/bin/zsh -c "bun bin/elanous.mjs release run"' : '/Users/a/.bun/bin/bun bin/elanous.mjs release run')).toBe('active');
  expect(probeReleaseRun(() => ({ status: 0, stdout: '123\n' }), () => '/Users/a/.bun/bin/bun bin/elanous.mjs release resume --version 0.2.28')).toBe('active');
  expect(probeReleaseRun(() => ({ status: 1 }))).toBe('idle');
  expect(probeReleaseRun(() => ({ status: 2 }))).toBe('unknown');
});

test('scheduled cut minus 40 minutes through publish plus 60 minutes skips resync', async () => {
  const rows = [
    { version: '0.2.28', cutAt: '2026-10-13T20:00:00.000Z', publishAt: '2026-10-13T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: 'test' },
    { version: '0.2.29', cutAt: '2026-10-15T20:00:00.000Z', publishAt: '2026-10-15T21:00:00.000Z', landBy: null, updatedAt: '', updatedBy: 'test' },
  ];
  const read = () => rows;
  expect(releaseWindowState(Date.parse('2026-10-13T19:19:59Z'), read)).toBe('outside');
  expect(releaseWindowState(Date.parse('2026-10-13T19:20:00Z'), read)).toBe('inside');
  expect(releaseWindowState(Date.parse('2026-10-13T22:00:00Z'), read)).toBe('inside');
  expect(releaseWindowState(Date.parse('2026-10-13T22:00:01Z'), read)).toBe('outside');
  expect(releaseWindowState(Date.parse('2026-10-13T19:00:00Z'), () => [])).toBe('unknown');
  expect(releaseWindowState(Date.parse('2026-10-13T19:00:00Z'), () => { throw new Error('ledger unavailable'); })).toBe('unknown');
  expect(releaseWindowState(Date.parse('2026-10-13T19:00:00Z'), () => [{ ...rows[0]!, publishAt: null }])).toBe('unknown');
  for (const [window, reason] of [['inside', 'scheduled release window'], ['unknown', 'release schedule unavailable']] as const) {
    const events: unknown[] = [];
    const result = await resyncTickWithReleaseProbe(async () => { throw new Error('must not run'); },
      (event, data) => events.push({ event, data }), resyncPendingPathForTest(), () => 'idle', () => window);
    expect(result).toEqual({ decision: 'skipped-release-window', reason });
    expect(events).toEqual([{ event: 'resync-tick', data: result }]);
  }
});
