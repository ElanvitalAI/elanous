import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { planShards, readFileDurations } from './shard-plan';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const files = Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.test.ts`);

test('LPT isolates a 100-second file and balances the remaining 29 seconds across three shards', () => {
  const durations = new Map(files.map((file) => [file, file === files[0] ? 100 : 1]));
  const shards = planShards([...files].reverse(), durations, 4);
  expect(shards).toHaveLength(4);
  expect(shards.find((shard) => shard.files.includes(files[0]!))).toEqual({ files: [files[0]], plannedSeconds: 100 });
  const light = shards.filter((shard) => !shard.files.includes(files[0]!));
  expect(Math.max(...light.map((shard) => shard.plannedSeconds)) - Math.min(...light.map((shard) => shard.plannedSeconds))).toBeLessThanOrEqual(1);
  expect(shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  expect(planShards([...files].reverse(), durations, 4)).toEqual(shards);
});

test('unknown files use the median, empty histories balance file counts, and excessive shard counts leave no empty shards', () => {
  const withUnknown = planShards(['z', 'd', 'c', 'b', 'a'], new Map([['a', 3], ['b', 9], ['c', 5]]), 2);
  expect(withUnknown.flatMap((shard) => shard.files).sort()).toEqual(['a', 'b', 'c', 'd', 'z']);
  expect(withUnknown.reduce((sum, shard) => sum + shard.plannedSeconds, 0)).toBe(27);
  const balanced = planShards(files, new Map(), 8);
  expect(Math.max(...balanced.map((shard) => shard.files.length)) - Math.min(...balanced.map((shard) => shard.files.length))).toBe(1);
  expect(balanced.flatMap((shard) => shard.files).sort()).toEqual(files);
  expect(planShards(files.slice(0, 3), new Map(), 24)).toHaveLength(3);
  expect(planShards(files.slice(0, 4), new Map(), 4).flatMap((shard) => shard.files)).toEqual(files.slice(0, 4));
  const zeros = planShards(files.slice(0, 7), new Map(files.slice(0, 7).map((file) => [file, 0])), 3);
  expect(zeros.map((shard) => shard.files.length)).toEqual([3, 2, 2]);
  expect(planShards([], new Map(), 24)).toEqual([]);
});

test('junit reports keep the largest duplicate, skip malformed or unreadable reports and missing directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-plan-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuites><testsuite file="src/a.test.ts" time="1"/><testsuite time="4"/></testsuites>');
  writeFileSync(join(dir, 'pod-1.junit.xml'), '<testsuite time="4" file="src/a.test.ts"/><testsuite file="src/b&amp;c.test.ts" time="2.5"/>');
  writeFileSync(join(dir, 'pod-2.junit.xml'), '<testsuites><testsuite file="src/bad.test.ts" time="NaN"');
  writeFileSync(join(dir, 'pod-3.junit.xml'), '<testsuite file="src/c.test.ts" time="7"/>');
  expect([...readFileDurations(dir)]).toEqual([['src/a.test.ts', 4], ['src/b&c.test.ts', 2.5], ['src/c.test.ts', 7]]);
  expect(readFileDurations(join(dir, 'missing')).size).toBe(0);
});

const realCut = join(homedir(), '.elanous/release/0.2.5/gate-logs/cut');
test.skipIf(!existsSync(realCut))('real 0.2.5 cut ledger has at least 900 timed files when available', () => {
  expect(readFileDurations(realCut).size).toBeGreaterThanOrEqual(900);
});
