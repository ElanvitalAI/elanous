import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDurations, planShards, readFileWallWeights } from './shard-plan';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const cutDir = () => { const dir = mkdtempSync(join(tmpdir(), 'shard-wall-')); scratch.push(dir); return dir; };
const junitXml = (entries: Array<[string, number]>) => `<testsuites>${entries.map(([file, time]) => `<testsuite file="${file}" time="${time}"/>`).join('')}</testsuites>`;
const record = (dir: string, name: string, durationMs: number, files: string[]) => writeFileSync(join(dir, `${name}.json`), JSON.stringify({ durationMs, rc: 0, files }));

test('junit seconds scale so each shard sums to its measured wall time; files without junit take the shard average', () => {
  const dir = cutDir();
  record(dir, 'pod-0', 400_000, ['a', 'b']);
  record(dir, 'pod-1', 300_000, ['c', 'd', 'e']);
  const wall = readFileWallWeights(dir, new Map([['a', 1], ['b', 3]]))!;
  expect(wall.shards).toBe(2);
  expect(wall.scaledFiles).toBe(5);
  expect(wall.weights.get('a')).toBe(100);
  expect(wall.weights.get('b')).toBe(300);
  expect(['c', 'd', 'e'].map((file) => wall.weights.get(file))).toEqual([100, 100, 100]);
});

test('mixed shard: unknown files take the average, known files share the remainder, first pass beats descent children', () => {
  const dir = cutDir();
  record(dir, 'pod-0', 600_000, ['a', 'b', 'x']); // average 200 → x=200, a:b share 400 by 1:3
  record(dir, 'pod-0-c0', 50_000, ['b']); // descent child: ignored for `b` (first pass wins)
  record(dir, 'pod-1-c0-file-0', 40_000, ['only-child']); // only measured by a child → used
  const wall = readFileWallWeights(dir, new Map([['a', 1], ['b', 3], ['new', 2]]))!;
  expect(wall.weights.get('x')).toBe(200);
  expect(wall.weights.get('a')).toBe(100);
  expect(wall.weights.get('b')).toBe(300);
  expect(wall.weights.get('only-child')).toBe(40);
  // `new` is in no record: overall scale = (100+300)/(1+3) = 100 per junit second.
  expect(wall.weights.get('new')).toBe(200);
});

test('falls back to junit durations when no usable pod-*.json record exists or the directory is missing', () => {
  const dir = cutDir();
  writeFileSync(join(dir, 'pod-0.junit.xml'), junitXml([['a', 2]]));
  writeFileSync(join(dir, 'pod-1.json'), '{broken');
  record(dir, 'pod-2', 0, ['a']);
  expect(readFileWallWeights(dir, new Map([['a', 2]]))).toBeUndefined();
  expect(planDurations(dir)).toEqual({ durations: new Map([['a', 2]]) });
  expect(planDurations(join(dir, 'missing')).durations.size).toBe(0);
  expect(planDurations(undefined).durations.size).toBe(0);
  expect(readFileWallWeights(join(dir, 'missing'), new Map())).toBeUndefined();
});

test('wall scaling excludes nested suite durations even after CDATA contains a closing tag', () => {
  const dir = cutDir();
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuites><testsuite file="a" time="1"><system-out><![CDATA[</testsuite>]]></system-out><testsuite file="nested" time="100"/></testsuite><testsuite file="b" time="3"/></testsuites>');
  record(dir, 'pod-0', 400_000, ['a', 'b']);
  const { durations, wall } = planDurations(dir);
  expect(wall).toEqual({ shards: 1, scaledFiles: 2 });
  expect(durations).toEqual(new Map([['a', 100], ['b', 300]]));
});

test('pod-23-shaped fixture: wall weights spread the slow shard so the max planned shard drops', () => {
  const dir = cutDir();
  // Previous cut: one file with a large junit time ran alone (100 s wall); 20 files with tiny junit times (0.5 s each)
  // looked light to junit, landed together and ran 1000 s — the «pod-23» shape (planned 2.7 min, measured 33 min).
  const big = 'test/big.test.ts';
  const many = Array.from({ length: 20 }, (_, i) => `test/many-${String(i).padStart(2, '0')}.test.ts`);
  const junit = new Map<string, number>([[big, 10], ...many.map((file) => [file, 0.5] as [string, number])]);
  writeFileSync(join(dir, 'pod-all.junit.xml'), junitXml([...junit]));
  record(dir, 'pod-0', 100_000, [big]);
  record(dir, 'pod-1', 1_000_000, many);
  const all = [big, ...many];
  const realWall = (files: string[]) => files.reduce((sum, file) => sum + (file === big ? 100 : 50), 0);
  const junitPlan = planShards(all, junit, 2);
  const junitMax = Math.max(...junitPlan.map((shard) => realWall(shard.files)));
  expect(junitMax).toBe(1_000); // junit-only planning reproduces the slow shard
  const { durations, wall } = planDurations(dir);
  expect(wall).toEqual({ shards: 2, scaledFiles: 21 });
  const wallPlan = planShards(all, durations, 2);
  const wallMax = Math.max(...wallPlan.map((shard) => realWall(shard.files)));
  expect(wallMax).toBe(550);
  // Planned totals speak the measured wall unit, not junit seconds.
  expect(Math.max(...wallPlan.map((shard) => shard.plannedSeconds))).toBeCloseTo(550, 6);
  expect(wallPlan.flatMap((shard) => shard.files).sort()).toEqual([...all].sort());
});
