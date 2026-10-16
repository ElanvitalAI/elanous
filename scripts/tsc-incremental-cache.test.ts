import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizedDiagnosticSet } from './tsc-incremental-diagnostics.js';
import { incrementalCacheKey, runIncrementalCachedTsc, type CachedTscRun } from './tsc-incremental-cache.js';

const coldUnion = `test/x.test.ts(1,1): error TS2322: Type '(s: unknown) => { posture: "default" | "control"; }' is not assignable.\n  Type 'Action | "consumed" | "passthrough" | Promise<Action | "consumed" | "passthrough">' is invalid.\n`;
const warmUnion = `test/x.test.ts(1,1): error TS2322: Type '(s: unknown) => { posture: "control" | "default"; }' is not assignable.\n  Type '"consumed" | "passthrough" | Action | Promise<"consumed" | "passthrough" | Action>' is invalid.\n`;

test('H1 union member display order normalizes, but a changed diagnostic does not', () => {
  expect(normalizedDiagnosticSet(coldUnion)).toBe(normalizedDiagnosticSet(warmUnion));
  expect(normalizedDiagnosticSet(warmUnion.replace('TS2322', 'TS2339'))).not.toBe(normalizedDiagnosticSet(coldUnion));
  expect(normalizedDiagnosticSet(warmUnion.replace('invalid', 'valid'))).not.toBe(normalizedDiagnosticSet(coldUnion));
  expect(normalizedDiagnosticSet(`src/x.ts(1,1): error TS2322: Type '"a | b"' is invalid.\n`))
    .not.toBe(normalizedDiagnosticSet(`src/x.ts(1,1): error TS2322: Type '"b | a"' is invalid.\n`));
  expect(normalizedDiagnosticSet(`src/x.ts(1,1): error TS2322: Value 'a | b' is invalid.\n`))
    .not.toBe(normalizedDiagnosticSet(`src/x.ts(1,1): error TS2322: Value 'b | a' is invalid.\n`));
  expect(normalizedDiagnosticSet('error TS5058: bad config')).toBeNull();
});

test('cache hit accepts normalized diagnostics and rc 1/2; mismatch returns cold result', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tsc-cache-test-'));
  const cacheDir = join(cwd, 'cache');
  writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}');
  let warmOut = warmUnion;
  let coldOut = coldUnion;
  const calls: string[] = [];
  const logs: string[] = [];
  const run = (command: string): CachedTscRun => {
    calls.push(command);
    if (command.includes('--incremental')) {
      const info = /--tsBuildInfoFile '([^']+)'/.exec(command)![1]!;
      writeFileSync(info, '{}');
      return { out: warmOut, ran: true, exitCode: 1 };
    }
    return { out: coldOut, ran: true, exitCode: 2 };
  };
  const input = { cwd, base: 'a'.repeat(40), head: 'b'.repeat(40), changed: new Set(['src/x.ts']),
    config: 'tsconfig.gate.json', command: 'tsc --noEmit -p tsconfig.gate.json', cacheDir, run,
    decision: (result: CachedTscRun) => !result.out.includes('NEW_ERROR'), log: (message: string) => logs.push(message) };
  try {
    const initialKey = incrementalCacheKey(input);
    writeFileSync(join(cwd, 'tsconfig.gate.json'), '{"strict":true}');
    expect(incrementalCacheKey(input)).not.toBe(initialKey);
    writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}');
    expect(incrementalCacheKey({ ...input, changed: new Set(['src/y.ts']) })).not.toBe(initialKey);
    expect(runIncrementalCachedTsc(input).out).toBe(coldUnion);
    expect(calls).toHaveLength(2);
    expect(logs.at(-1)).toContain('miss-cold');
    expect(runIncrementalCachedTsc(input).out).toBe(warmUnion);
    expect(calls).toHaveLength(3);
    expect(logs.at(-1)).toContain('warmRc=1 coldRc=2');
    warmOut = warmUnion.replace('invalid', 'NEW_ERROR');
    coldOut = coldUnion.replace('invalid', 'NEW_ERROR');
    expect(runIncrementalCachedTsc(input).out).toBe(coldOut);
    expect(calls).toHaveLength(5);
    expect(logs.at(-1)).toContain('mismatch-cold');
    warmOut = warmUnion.replace('invalid', 'stale');
    coldOut = coldUnion.replace('invalid', 'fresh');
    expect(runIncrementalCachedTsc(input).out).toContain('fresh');
    expect(logs.at(-1)).toContain('normalized=different');
    expect(readFileSync(join(cwd, 'tsconfig.gate.json'), 'utf8')).toBe('{}');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('unwritable cache path is an observed cold run, never a gate exception', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tsc-cache-unavailable-'));
  const cacheDir = join(cwd, 'occupied');
  writeFileSync(cacheDir, 'file');
  const calls: string[] = [];
  const logs: string[] = [];
  try {
    const result = runIncrementalCachedTsc({ cwd, base: 'a'.repeat(40), changed: new Set(['src/x.ts']),
      config: 'tsconfig.gate.json', command: 'tsc -p tsconfig.gate.json', cacheDir,
      run: (cmd) => { calls.push(cmd); return { out: '', ran: true, exitCode: 0 }; },
      decision: () => true, log: (line) => logs.push(line) });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['tsc -p tsconfig.gate.json']);
    expect(logs.at(-1)).toContain('unavailable');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
