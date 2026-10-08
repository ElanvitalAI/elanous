import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestSiblingCutDir, planDurations } from './shard-plan';

// GATE-PLAN-TIMINGS: the gate passes `<ledger>/release/<baseline>/gate-logs/cut`; when that cut left no reports the
// planner reads the most recent sibling cut instead of planning every file as «unknown».
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ledger = () => { const dir = mkdtempSync(join(tmpdir(), 'shard-fallback-')); scratch.push(dir); return join(dir, 'release'); };
const cut = (release: string, version: string) => { const dir = join(release, version, 'gate-logs', 'cut'); mkdirSync(dir, { recursive: true }); return dir; };
const junit = (dir: string, name: string, entries: Array<[string, number]>, mtimeSec: number) => {
  const path = join(dir, `${name}.junit.xml`);
  writeFileSync(path, `<testsuites>${entries.map(([file, time]) => `<testsuite file="${file}" time="${time}"/>`).join('')}</testsuites>`);
  utimesSync(path, mtimeSec, mtimeSec);
};

test('empty baseline cut falls back to the sibling cut with the newest junit, not the highest version name', () => {
  const release = ledger();
  const baseline = cut(release, '0.2.19');
  junit(cut(release, '0.2.18'), 'pod-0', [['a.test.ts', 7]], 2_000_000_000);
  junit(cut(release, '0.3.0'), 'pod-0', [['a.test.ts', 99]], 1_000_000_000); // older run despite the larger name
  mkdirSync(join(release, '0.3.1'), { recursive: true }); // no gate-logs at all
  expect(latestSiblingCutDir(baseline)).toBe(join(release, '0.2.18', 'gate-logs', 'cut'));
  const plan = planDurations(baseline);
  expect(plan.fallback).toBe(join(release, '0.2.18', 'gate-logs', 'cut'));
  expect(plan.durations).toEqual(new Map([['a.test.ts', 7]]));
});

test('fallback keeps the wall-time scaling of the sibling cut', () => {
  const release = ledger();
  const sibling = cut(release, '0.2.18');
  junit(sibling, 'pod-0', [['a.test.ts', 1], ['b.test.ts', 3]], 2_000_000_000);
  writeFileSync(join(sibling, 'pod-0.json'), JSON.stringify({ durationMs: 400_000, files: ['a.test.ts', 'b.test.ts'] }));
  const plan = planDurations(join(release, '0.2.19', 'gate-logs', 'cut')); // baseline directory does not even exist
  expect(plan.wall).toEqual({ shards: 1, scaledFiles: 2 });
  expect(plan.durations.get('a.test.ts')).toBe(100);
  expect(plan.durations.get('b.test.ts')).toBe(300);
});

test('a baseline with its own reports never falls back (behaviour unchanged)', () => {
  const release = ledger();
  junit(cut(release, '0.2.19'), 'pod-0', [['a.test.ts', 2]], 1_000_000_000);
  junit(cut(release, '0.2.18'), 'pod-0', [['a.test.ts', 9]], 2_000_000_000);
  expect(planDurations(join(release, '0.2.19', 'gate-logs', 'cut'))).toEqual({ durations: new Map([['a.test.ts', 2]]) });
});

test('no sibling junit anywhere leaves the plan empty — the caller keeps its unknown-duration path', () => {
  const release = ledger();
  const baseline = cut(release, '0.2.19');
  cut(release, '0.2.18'); // directory without reports
  expect(latestSiblingCutDir(baseline)).toBeUndefined();
  expect(planDurations(baseline)).toEqual({ durations: new Map() });
});
