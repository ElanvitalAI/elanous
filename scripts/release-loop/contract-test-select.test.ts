import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compareContractShadowFailures, contractTestCandidate, fullContractTestCandidate, publicContract, runContractTestPrimary } from './contract-test-select.js';
import surfaces from './gate-contract-surfaces.json';

const runner = 'src/graph-runner/runner.ts';
const gate = 'scripts/release-loop/gate-node.ts';

test('declared public export lists match the current source', () => {
  for (const [path, names] of Object.entries(surfaces))
    expect(publicContract(path, readFileSync(path, 'utf8')).names).toEqual(names);
});

test('default export and declaration-kind changes cannot keep a limited contract', () => {
  expect(() => publicContract(runner, 'export default 1;')).toThrow('unsupported default export');
  expect(() => publicContract(runner, 'export default function run() {}')).toThrow('unsupported default export');
  expect(publicContract(runner, 'export const value = 1;').signatures)
    .not.toEqual(publicContract(runner, 'export let value = 1;').signatures);
});

test('shadow failure join requires the measured full inventory and preserves unknown counts', () => {
  // Source: synthetic two-file sweep exercises the exact-inventory and failure-ID join.
  const candidate = { status: 'limited' as const, reason: 'fixture', files: ['a.test.ts'], direct: 1, twoHop: 1 };
  const input = { candidate, tests: ['a.test.ts', 'b.test.ts'], measuredFiles: ['a.test.ts', 'b.test.ts'],
    failureIds: ['b.test.ts > fails', 'a.test.ts > fails'], sweepComplete: true,
    fileOfId: (id: string) => id.split(' > ')[0]! };
  expect(compareContractShadowFailures(input)).toMatchObject({ comparison: 'complete', savedTests: 1,
    observedFailureCount: 2, missedFailureCount: 1, missedFailures: ['b.test.ts > fails'] });
  expect(compareContractShadowFailures({ ...input, sweepComplete: false })).toMatchObject({ comparison: 'unmeasured',
    savedTests: null, observedFailureCount: null, missedFailures: null, missedFailureCount: null });
  expect(compareContractShadowFailures({ ...input, measuredFiles: ['a.test.ts'] })).toMatchObject({ comparison: 'unmeasured',
    savedTests: null, missedFailures: null });
  expect(compareContractShadowFailures({ ...input, failureIds: ['unknown.test.ts > fails'] })).toMatchObject({ comparison: 'unmeasured',
    observedFailureCount: null, missedFailureCount: null });
});

test('opt-in primary run executes only the candidate list and remains disabled by default', async () => {
  const candidate = { status: 'limited' as const, reason: 'unchanged contract', files: ['a.test.ts'], direct: 1, twoHop: 1 };
  let selected: readonly string[] | undefined;
  const disabled = await runContractTestPrimary({ enabled: false, candidate, sweep: async (only) => {
    selected = only; return { rc: 0 };
  } });
  expect(disabled).toMatchObject({ status: 'disabled', rc: null });
  expect(selected).toBeUndefined();
  const measured = await runContractTestPrimary({ enabled: true, candidate, sweep: async (only) => {
    selected = only; return { rc: 0 };
  } });
  expect(selected).toEqual(['a.test.ts']);
  expect(measured).toMatchObject({ status: 'measured', selectedFiles: ['a.test.ts'], rc: 0 });
  const failed = await runContractTestPrimary({ enabled: true, candidate, sweep: async (only) => {
    expect(only).toEqual(['a.test.ts']); return { rc: 1 };
  } });
  expect(failed).toMatchObject({ status: 'measured', rc: 1 });
});

test('unreadable selector evidence uses the full test inventory as a conservative candidate', () => {
  const tests = ['src/a.test.ts', 'src/b.test.ts'];
  expect(fullContractTestCandidate(tests, 'selection evidence unavailable')).toEqual({
    status: 'full', reason: 'selection evidence unavailable', files: tests, direct: 0, twoHop: 0,
  });
});

test('implementation changes select direct and two-hop tests; contract and other changes expand to full', () => {
  const before = 'export function run(input: string): string { return input; }';
  const after = 'export function run(input: string): string { return input.trim(); }';
  const files = [runner, gate, 'src/direct.test.ts', 'src/helper.ts', 'src/second.test.ts', 'src/other.test.ts'];
  const contents = new Map([
    [runner, after], [gate, 'export const gate = 1;'],
    ['src/direct.test.ts', "import { run } from './graph-runner/runner'; test('direct', () => run('x'));"],
    ['src/helper.ts', "import { run } from './graph-runner/runner'; export const helper = run;"],
    ['src/second.test.ts', "import { helper } from './helper'; test('second', () => helper('x'));"],
    ['src/other.test.ts', "test('other', () => 1);"],
  ]);
  const tree = { files, read: (path: string) => contents.get(path), preload: [] };
  // This fixture has a deliberately smaller export list than production, so it must fail closed.
  expect(contractTestCandidate({ tree, priorRead: () => before, changed: [runner], tests: files.filter((f) => f.endsWith('.test.ts')) }))
    .toMatchObject({ status: 'full', reason: `export list differs from declaration: ${runner}` });
  const current = readFileSync(runner, 'utf8');
  const edited = current.replace('export function withRunnerGateObservation<T>(identity: { runId: string; invocation: string; batch: string }, run: () => T): T {',
    'export function withRunnerGateObservation<T>(identity: { runId: string; invocation: string; batch: string }, run: () => T): T {\n  // implementation only');
  expect(edited).not.toBe(current);
  const actualTree = { ...tree, read: (path: string) => path === runner ? edited : contents.get(path) };
  const limited = contractTestCandidate({ tree: actualTree, priorRead: (path) => path === runner ? current : undefined,
    changed: [runner], tests: files.filter((f) => f.endsWith('.test.ts')) });
  expect(limited).toMatchObject({ status: 'limited', files: ['src/direct.test.ts', 'src/second.test.ts'], direct: 1, twoHop: 2 });
  expect(contractTestCandidate({ tree: actualTree, priorRead: (path) => path === runner ? current : undefined,
    changed: [runner, 'src/other.test.ts'], tests: files.filter((f) => f.endsWith('.test.ts')) }))
    .toMatchObject({ status: 'limited', files: ['src/direct.test.ts', 'src/other.test.ts', 'src/second.test.ts'] });
  const contractChanged = current.replace('identity: { runId: string; invocation: string; batch: string }',
    'identity: { runId: number; invocation: string; batch: string }');
  expect(contractChanged).not.toBe(current);
  expect(contractTestCandidate({ tree: { ...tree, read: (path: string) => path === runner ? contractChanged : contents.get(path) },
    priorRead: (path) => path === runner ? current : undefined, changed: [runner],
    tests: files.filter((f) => f.endsWith('.test.ts')) }).reason).toBe(`public contract changed: ${runner}`);
  const valueChanged = current.replace("'ELANOUS_GRAPH_GROWTH_SCOPE'", "'ELANOUS_GRAPH_GROWTH_SCOPE_V2'");
  expect(valueChanged).not.toBe(current);
  expect(contractTestCandidate({ tree: { ...tree, read: (path: string) => path === runner ? valueChanged : contents.get(path) },
    priorRead: (path) => path === runner ? current : undefined, changed: [runner],
    tests: files.filter((f) => f.endsWith('.test.ts')) }).reason).toBe(`public contract changed: ${runner}`);
  expect(contractTestCandidate({ tree: actualTree, priorRead: (path) => path === runner ? current : undefined,
    changed: [runner, 'src/helper.ts'], tests: files.filter((f) => f.endsWith('.test.ts')) }).status).toBe('full');
  expect(contractTestCandidate({ tree: actualTree, priorRead: (path) => path === runner ? current : undefined,
    changed: [runner, 'package.json'], tests: files.filter((f) => f.endsWith('.test.ts')) }).status).toBe('full');
  expect(publicContract(runner, current.replace('export function withRunnerGateObservation<T>(', 'export function renamedObservation<T>(')).names)
    .not.toEqual(surfaces[runner]);
});
