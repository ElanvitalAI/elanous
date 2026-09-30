import { expect, test } from 'bun:test';
import { collectDurations, parseJunitSuites, topShare } from './test-durations.js';

const suite = (file: string, time: number, tests = 1) => `<testsuite name="${file}" file="${file}" tests="${tests}" assertions="1" failures="0" skipped="0" time="${time}" hostname="h">`;

test('a bun junit report yields one duration per test file', () => {
  const xml = `<?xml version="1.0"?>\n<testsuites name="bun test" tests="3" time="4">\n  ${suite('src/a.test.ts', 1.25, 2)}\n    <testcase name="x" time="0.1" />\n  </testsuite>\n  ${suite('test/b.test.ts', 2.5)}\n  </testsuite>\n</testsuites>`;
  expect(parseJunitSuites(xml)).toEqual([{ file: 'src/a.test.ts', seconds: 1.25, tests: 2 }, { file: 'test/b.test.ts', seconds: 2.5, tests: 1 }]);
});

test('a file measured in a shard and again alone keeps the alone value, and the list is slowest first', () => {
  const shard = [suite('src/a.test.ts', 9), suite('src/b.test.ts', 3), suite('src/c.test.ts', 1)].join('\n');
  const alone = suite('src/a.test.ts', 4);
  expect(collectDurations([shard, alone]).map((item) => [item.file, item.seconds, item.runFiles])).toEqual([
    ['src/a.test.ts', 4, 1], ['src/b.test.ts', 3, 3], ['src/c.test.ts', 1, 3],
  ]);
});

test('top 5% rounds up to at least one file and reports its share of the total', () => {
  const durations = collectDurations([Array.from({ length: 40 }, (_, index) => suite(`src/f${index}.test.ts`, index === 0 ? 60 : 1)).join('\n')]);
  const top = topShare(durations, 5);
  expect(top.files.map((item) => item.file)).toEqual(['src/f0.test.ts', 'src/f1.test.ts']);
  expect(top.seconds).toBe(61);
  expect(top.totalSeconds).toBe(99);
});
