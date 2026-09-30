import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { diffFailures, junitFailures, parseFailures } from './gate-diff';

const output = `bun test v1.4.2
src/demo/a.test.ts:
(pass) good [1.00ms]
(fail) group > A [3.00ms]
(fail) group > A [4.00ms]
\u001b[31m(fail) group > B [0.14ms]\u001b[0m
  error: expected 1
scripts/demo/b.test.tsx:
(fail) nested > C [12.00ms]
 2 pass
 4 fail
Ran 6 tests across 2 files.
`;

test('Bun failure headers associate test names with files, strip timing and deduplicate', () => {
  expect(parseFailures(output)).toEqual([
    'scripts/demo/b.test.tsx > nested > C',
    'src/demo/a.test.ts > group > A',
    'src/demo/a.test.ts > group > B',
  ]);
  expect(parseFailures('(fail) orphan [1ms]\n 1 fail\n')).toEqual([]);
});

test('parser consumes the actual Bun failure reporter, including the file header', () => {
  const probe = spawnSync('bun', ['test', '--dots', import.meta.path, '-t', 'deliberate parser fixture failure'], {
    env: { ...process.env, GATE_PARSER_PROBE: '1' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(probe.status).toBe(1);
  expect(parseFailures(probe.stderr)).toContain('scripts/release-loop/gate-diff.test.ts > deliberate parser fixture failure');
});

test('deliberate parser fixture failure', () => {
  if (process.env.GATE_PARSER_PROBE === '1') expect(parseFailures(output)).toHaveLength(0);
});

test('diffFailures compares identities, not totals or emission order', () => {
  const A = 'src/a.test.ts > A', B = 'src/b.test.ts > B', C = 'src/c.test.ts > C', D = 'src/d.test.ts > D';
  expect(diffFailures([A, B, C, C], [D, A, D])).toEqual({ newFailures: [B, C], fixed: [D], common: [A] });
});

test('junitFailures names failed testcases with their describe path in the console shape', () => {
  const xml = `<testsuites><testsuite name="src/a.test.ts" file="src/a.test.ts">
    <testsuite name="outer"><testcase name="ok case" file="src/a.test.ts" /><testcase name="bad &amp; worse" file="src/a.test.ts"><failure message="m"/></testcase></testsuite>
    <testcase name="top level" file="src/a.test.ts"><failure/></testcase>
  </testsuite></testsuites>`;
  expect(junitFailures(xml)).toEqual(['src/a.test.ts > outer > bad & worse', 'src/a.test.ts > top level']);
  expect(parseFailures('src/a.test.ts:\n(fail) outer > bad & worse [1.00ms]\n')).toEqual(['src/a.test.ts > outer > bad & worse']);
});
