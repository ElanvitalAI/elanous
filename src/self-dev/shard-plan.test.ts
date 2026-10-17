import { describe, expect, test } from 'bun:test';
import { planGateTestShards } from './shard-plan.js';
import { runShardedGateTests } from './shard-run.js';

describe('planGateTestShards', () => {
  test('60 files with measured RSS and seconds fit deterministic 8 GiB memory bundles', () => {
    const files = Array.from({ length: 60 }, (_, index) => `test/file-${String(index).padStart(2, '0')}.test.ts`);
    const rss = new Map(files.map((file) => [file, 800]));
    const seconds = new Map(files.map((file, index) => [file, 60 - index]));
    const planned = planGateTestShards(files, rss, seconds, 8);
    expect(planned).toHaveLength(6);
    expect(planned.map((shard) => shard.files.length)).toEqual([10, 10, 10, 10, 10, 10]);
    expect(planned.every((shard) => shard.plannedRssMb === 8000 && shard.plannedRssMb <= 8192)).toBe(true);
    expect(planned.flatMap((shard) => shard.files).sort()).toEqual(files);
    expect(planGateTestShards([...files].reverse(), rss, seconds, 8)).toEqual(planned);
    expect(planned[0]?.files[0]).toBe(files[0]);
  });

  test('seconds break equal-RSS ties and no measurement is invented', () => {
    const rss = new Map([['b', 4096], ['a', 4096], ['c', 2048]]);
    const seconds = new Map([['b', 10], ['a', 20], ['c', 1]]);
    expect(planGateTestShards(['c', 'b', 'a'], rss, seconds, 8).map((shard) => shard.files)).toEqual([['a', 'b'], ['c']]);
    expect(() => planGateTestShards(['a', 'missing'], rss, seconds, 8)).toThrow(/^missing or invalid RSS\/seconds measurement: missing$/);
    expect(() => planGateTestShards(['a'], rss, seconds, 2)).toThrow(/^test file exceeds shard memory budget: a$/);
    expect(() => planGateTestShards(['a'], rss, seconds, 0)).toThrow(/^invalid shard memory budget$/);
    expect(planGateTestShards(['a', 'b', 'c'], rss, seconds, 8, 2).map((shard) => shard.files)).toEqual([['a'], ['b', 'c']]);
    expect(() => planGateTestShards(['a', 'b', 'c'], rss, seconds, 8, 1)).toThrow('shard memory budgets');
    expect(() => planGateTestShards(['a'], rss, seconds, 8, 0)).toThrow('invalid shard count');
  });

  test('exceeded shard count reports unique files, measured RSS, budget and lower-bound shard count', () => {
    const rss = new Map([['a', 4096], ['b', 3000], ['c', 2048]]);
    const seconds = new Map([['a', 1], ['b', 1], ['c', 1]]);
    expect(() => planGateTestShards(['a', 'b', 'c', 'a'], rss, seconds, 8, 1)).toThrow(
      /^test files exceed 1 shard memory budgets \(files=3 · totalRssMb=9144 · largestRssMb=4096 · budgetMb=8192 · neededShards≥2\)$/,
    );
    const result = runShardedGateTests('/head', ['a', 'b', 'c', 'a'], 'HEAD', 1,
      (_cwd, selected) => ({ exitCode: 0, junit: `<testsuites>${selected.map((file) => `<testsuite file="${file}" tests="1"><testcase name="ok"/></testsuite>`).join('')}</testsuites>`, rssMb: rss.get(selected[0]!), seconds: 1 }),
      (_cwd, _ref, visit) => visit('/base'), 8,
      { hostResources: { cores: 8, freeMemoryGiB: 64, freeTmpGiB: 8 } });
    expect(result.shards).toHaveLength(2);
    expect(result.expandedFrom).toBe(1);
    expect(result.aggregate.status).toBe('passed');
    expect(() => planGateTestShards(['a', 'b', 'c'], new Map([['a', 4096.6], ['b', 3000.1], ['c', 2048]]), seconds, 8, 1)).toThrow(
      /^test files exceed 1 shard memory budgets \(files=3 · totalRssMb=9145 · largestRssMb=4097 · budgetMb=8192 · neededShards≥2\)$/,
    );
  });
});
