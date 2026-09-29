import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { diffFailures, parseFailures } from './gate-diff';

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
  if (process.env.GATE_PARSER_PROBE === '1') expect(1).toBe(2);
});

test('diffFailures compares identities, not totals or emission order', () => {
  const A = 'src/a.test.ts > A', B = 'src/b.test.ts > B', C = 'src/c.test.ts > C', D = 'src/d.test.ts > D';
  expect(diffFailures([A, B, C, C], [D, A, D])).toEqual({ newFailures: [B, C], fixed: [D], common: [A] });
});
