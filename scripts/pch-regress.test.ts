import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PCH_REGRESS_MAP } from './lib/pch-regress-map.js';
import { runPchRegress as runPchRegressRaw, type TestExecutor } from './pch-regress.js';

const runPchRegress = (args: readonly string[], executor: TestExecutor, map: Readonly<Record<string, readonly string[]>>) =>
  runPchRegressRaw(args, executor, map, () => true);

const pwa = join(import.meta.dir, '..', 'apps', 'pwa');

test('every mapped file exists inside apps/pwa and only documented slots are present', () => {
  const slots = ['PCH-1', 'PCH-2', 'PCH-2a', 'PCH-2b', 'PCH-3', 'PCH-4', 'PCH-4a', 'PCH-4b',
    'PCH-5', 'PCH-6', 'PCH-7', 'PCH-8', 'PCH-9', 'PCH-10', 'PCH-11', 'PCH-12', 'PCH-13', 'PCH-14', 'PCH-15'];
  expect(Object.keys(PCH_REGRESS_MAP)).toEqual(slots);
  for (const files of Object.values(PCH_REGRESS_MAP)) {
    for (const file of files) {
      expect(file).toMatch(/^src\/.*\.test\.tsx?$/);
      expect(existsSync(join(pwa, file))).toBe(true);
    }
  }
});

test('PCH-11 runs full-copy and turn-bearing branch checks through the real runner', () => {
  expect(PCH_REGRESS_MAP['PCH-11']).toEqual(['src/lib/chat-fork.test.ts', 'src/lib/chat-branch.test.ts']);
  const result = runPchRegressRaw(['--only', 'PCH-11']);
  expect(result.exitCode).toBe(0);
  expect(result.results).toEqual([{
    id: 'PCH-11', files: PCH_REGRESS_MAP['PCH-11'], status: 'pass', failure: '',
  }]);
});

test('injected executor produces pass, fail, 시험 없음 table and exit 1 in slot order', () => {
  const calls: string[] = [];
  const fake: TestExecutor = (files, cwd) => {
    expect(cwd).toBe(pwa);
    calls.push(files[0]!);
    return files[0] === 'fail.test.ts'
      ? { status: 1, stdout: '', stderr: '(fail) failed test name [3ms]\n 0 pass\n 1 fail' }
      : { status: 0, stdout: '1 pass\nRan 1 tests across 1 file.', stderr: '' };
  };
  const result = runPchRegress([], fake, { 'PCH-1': ['pass.test.ts'], 'PCH-2a': ['fail.test.ts'], 'PCH-10': [] });
  expect(calls).toEqual(['pass.test.ts', 'fail.test.ts']);
  expect(result.exitCode).toBe(1);
  expect(result.results.map(({ status }) => status)).toEqual(['pass', 'fail', '시험 없음']);
  expect(result.output).toContain('| PCH-1 | 1 | pass.test.ts | pass |');
  expect(result.output).toContain('| PCH-2a | 1 | fail.test.ts | fail | (fail) failed test name [3ms] |');
  expect(result.output).toContain('| PCH-10 | 0 | — | 시험 없음 |');
});

test('--only filters slots, JSON reports results, and empty or unknown selections are rejected', () => {
  const calls: string[] = [];
  const fake: TestExecutor = (files) => {
    calls.push(files[0]!);
    return { status: 0, stdout: '1 pass\nRan 1 tests across 1 file.', stderr: '' };
  };
  const map = { 'PCH-1': ['one.test.ts'], 'PCH-5': ['five.test.ts'], 'PCH-10': [] };
  const result = runPchRegress(['--only', 'PCH-5,PCH-10', '--json'], fake, map);
  expect(calls).toEqual(['five.test.ts']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toMatchObject({ pass: 1, fail: 0, noTests: 1,
    results: [{ id: 'PCH-5', status: 'pass' }, { id: 'PCH-10', status: '시험 없음' }] });
  expect(runPchRegress(['--only', 'PCH-99'], fake, map).exitCode).toBe(2);
  expect(runPchRegress(['--only', ''], fake, map).exitCode).toBe(2);
});

test('zero executed tests and spawn errors are failures, not false passes', () => {
  expect(runPchRegress([], () => ({ status: 0, stdout: '0 pass\nRan 0 tests across 1 file.', stderr: '' }), { 'PCH-1': ['x.test.ts'] }).exitCode).toBe(1);
  const skipped = runPchRegress([], () => ({ status: 0, stdout: '0 pass\n1 skip\nRan 1 test across 1 file.', stderr: '' }), { 'PCH-1': ['skipped.test.ts'] });
  expect(skipped.exitCode).toBe(1);
  expect(skipped.results[0]?.status).toBe('fail');
  expect(skipped.output).toContain('| PCH-1 | 1 | skipped.test.ts | fail | 통과한 시험 없음 (0 pass) |');
  const todo = runPchRegress([], () => ({ status: 0, stdout: '0 pass\n1 todo\nRan 1 test across 1 file.', stderr: '' }), { 'PCH-1': ['todo.test.ts'] });
  expect(todo.exitCode).toBe(1);
  expect(todo.results[0]?.status).toBe('fail');
  const result = runPchRegress([], () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') }), { 'PCH-1': ['x.test.ts'] });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('spawn ENOENT');
});

test('missing apps/pwa deps is an environment error (exit 2), and error: lines beat the unhandled-error banner', () => {
  const calls: string[] = [];
  const fake: TestExecutor = (files) => { calls.push(files[0]!); return { status: 0, stdout: '1 pass\nRan 1 tests across 1 file.', stderr: '' }; };
  const missing = runPchRegressRaw([], fake, { 'PCH-1': ['x.test.ts'] }, () => false);
  expect(missing.exitCode).toBe(2);
  expect(missing.output).toContain('bun install');
  expect(calls).toEqual([]);
  expect(runPchRegressRaw([], fake, { 'PCH-10': [] }, () => false).exitCode).toBe(0);
  const unhandled = runPchRegress([], () => ({ status: 1, stdout: '', stderr: "# Unhandled error between tests\n-----\nerror: Cannot find package 'react'\n 0 pass\n 1 fail\nRan 1 test across 1 file." }), { 'PCH-1': ['x.test.ts'] });
  expect(unhandled.results[0]?.failure).toBe("error: Cannot find package 'react'");
});
