import { setDefaultTimeout, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { diffFailures, junitFailures, parseFailures } from './gate-diff';
import { shardFailureIds } from './gate-node';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

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

test('failure marker in a passing test title is not parsed as a failure line', () => {
  const isolated = `src/self-implement/decision-signal-press.test.ts:\n(pass) moves a signal out of pressedRed when every (fail) name also failed on the baseline [0.61ms]\n 21 pass\n 0 fail\nRan 21 tests across 1 file.\n`;
  const body = `src/self-implement/decision-signal-press.test.ts:\n(pass) assertion body mentions (fail) without failing [0.20ms]\n  expected: every (fail) name also failed\n  received: (fail) was only in the assertion body\n  (fail) indented reporter-shaped text is still body\n 21 pass\n 0 fail\nRan 21 tests across 1 file.\n`;
  const mixed = `${isolated}src/real.test.ts:\n(pass) title contains (fail) as ordinary text\n  body also says (fail) here\n(fail) actual broken case [1.00ms]\n 1 pass\n 1 fail\nRan 2 tests across 1 file.\n`;
  expect(parseFailures(isolated)).toEqual([]);
  expect(parseFailures(body)).toEqual([]);
  expect(parseFailures(mixed)).toEqual(['src/real.test.ts > actual broken case']);
});

test('GATE-RECHECK-REMOTE: 대상 경로이자 완료 경계 코드는 scripts/release-loop/gate-diff', () => {
  const title = `src/self-implement/decision-signal-press.test.ts:\n(pass) moves a signal out of pressedRed when every (fail) name also failed on the baseline [0.61ms]\n 21 pass\n 0 fail\nRan 21 tests across 1 file.\n`;
  const body = `src/self-implement/decision-signal-press.test.ts:\n(pass) assertion body mentions (fail) without failing [0.20ms]\n  expected: every (fail) name also failed\n  received: (fail) was only in the assertion body\n  (fail) indented reporter-shaped text is still body\nexpected (fail) actual broken case [1.00ms]\n 21 pass\n 0 fail\nRan 21 tests across 1 file.\n`;
  const mixed = `src/real.test.ts:\n(pass) title contains (fail) as ordinary text\n  body also says (fail) here\n(fail) reports (fail) in the title on purpose [1.00ms]\n(fail) actual broken case [1.00ms]\n 1 pass\n 2 fail\nRan 3 tests across 1 file.\n`;
  // Pod logs may leave a CR on the last reporter row; that is still a real Bun fail row.
  const crRow = `src/real.test.ts:\n(pass) title contains (fail) as ordinary text\n  body also says (fail) here\n(fail) actual broken case [1.00ms]\r`;
  expect(parseFailures(title)).toEqual([]);
  expect(parseFailures(body)).toEqual([]);
  expect(shardFailureIds(`${title}0 fail\n0 errors\n`, undefined, 0, 0)).toEqual({ failures: [], errors: [] });
  expect(shardFailureIds(`${body}0 fail\n0 errors\n`, undefined, 0, 0)).toEqual({ failures: [], errors: [] });
  expect(parseFailures(mixed)).toEqual([
    'src/real.test.ts > actual broken case',
    'src/real.test.ts > reports (fail) in the title on purpose',
  ]);
  expect(parseFailures(crRow)).toEqual(['src/real.test.ts > actual broken case']);
  expect(shardFailureIds(mixed + '2 pass\n2 fail\n0 errors\nRan 4 tests across 1 files.\n', undefined, 2, 0))
    .toEqual({ failures: ['src/real.test.ts > actual broken case', 'src/real.test.ts > reports (fail) in the title on purpose'], errors: [] });
});

test('parser distinguishes a passing Bun reporter title and body from an actual failure row', () => {
  const passing = spawnSync('bun', ['test', import.meta.path, '-t', 'gate-diff-pass-probe-unique'], {
    env: { ...process.env, GATE_PARSER_PASS_PROBE: '1' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(passing.status).toBe(0);
  const passingOutput = `${passing.stdout}\n${passing.stderr}`;
  expect(passingOutput).toContain('(fail) is ordinary passing-test output');
  expect(passingOutput).toContain('scripts/release-loop/gate-diff.test.ts:');
  expect(parseFailures(passingOutput)).toEqual([]);
  expect(shardFailureIds(`${passingOutput}0 fail\\n0 errors\\n`, undefined, 0, 0)).toEqual({ failures: [], errors: [] });

  const failing = spawnSync('bun', ['test', '--dots', import.meta.path, '-t', 'deliberate parser fixture failure'], {
    env: { ...process.env, GATE_PARSER_PROBE: '1' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(failing.status).toBe(1);
  const failingOutput = `${failing.stdout}\n${failing.stderr}`;
  const failureId = 'scripts/release-loop/gate-diff.test.ts > deliberate parser fixture failure';
  expect(parseFailures(failingOutput)).toContain(failureId);
  expect(shardFailureIds(failingOutput, undefined, 1, 0)).toEqual({ failures: [failureId], errors: [] });
});

test('gate-diff-pass-probe-unique', () => {
  if (process.env.GATE_PARSER_PASS_PROBE === '1') console.log('(fail) is ordinary passing-test output');
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
