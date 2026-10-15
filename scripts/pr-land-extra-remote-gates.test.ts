import { expect, test } from 'bun:test';
import { runPrLandExtraRemoteGates } from './pr-land-extra-remote-gates.js';

const BASE = 'a'.repeat(40);

test('remote global check failure blocks before interference runs', async () => {
  let interferenceRan = false;
  expect(await runPrLandExtraRemoteGates(BASE, '/repo', {
    changedFiles: () => ['src/cli/example.ts'],
    runGlobal: () => false,
    runInterference: async () => { interferenceRan = true; return 0; },
  })).toBe(1);
  expect(interferenceRan).toBe(false);
});

test('unmeasured global check propagates so the remote command fails closed', async () => {
  await expect(runPrLandExtraRemoteGates(BASE, '/repo', {
    changedFiles: () => ['src/cli/example.ts'],
    runGlobal: () => { throw new Error('runner unavailable'); },
  })).rejects.toThrow('runner unavailable');
});

test('interference exception stays a warning after a measured global pass', async () => {
  const warned: string[] = [];
  const logged: string[] = [];
  const original = console.warn;
  const originalLog = console.log;
  console.warn = (line: string) => { warned.push(line); };
  console.log = (line: string) => { logged.push(line); };
  try {
    expect(await runPrLandExtraRemoteGates(BASE, '/repo', {
      changedFiles: () => ['test/one.test.ts', 'test/two.test.ts'],
      runGlobal: () => true,
      runInterference: async () => { throw new Error('interference runner unavailable'); },
    })).toBe(0);
    expect(warned.join('\n')).toContain('경고: 측정 불가');
    expect(logged.join('\n')).toContain('interference=unmeasured');
  } finally { console.warn = original; console.log = originalLog; }
});

test('interference runner unmeasurable result is recorded without blocking', async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => { logged.push(line); };
  try {
    expect(await runPrLandExtraRemoteGates(BASE, '/repo', {
      changedFiles: () => ['test/one.test.ts', 'test/two.test.ts'],
      runGlobal: () => true,
      runInterference: async (_files, _cwd, log) => {
        log('[test-interference-gate] 경고: 측정 불가 — 판정기 실행 실패');
        return 0;
      },
    })).toBe(0);
    expect(logged.join('\n')).toContain('interference=unmeasured');
  } finally { console.log = originalLog; }
});
