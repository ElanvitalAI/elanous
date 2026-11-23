import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMockModuleRestoreGate, scanMockModuleRestoreCandidates } from './ci-mock-module-restore-gate.js';

const entry = (...modules: string[]) => ({ count: modules.length, modules });

const expandedRestore = [
  "import { afterAll, mock } from 'bun:test';",
  "import * as childProcess from 'node:child_process';",
  'const realChildProcess = { ...childProcess };',
  "mock.module('node:child_process', () => ({ execFileSync() {} }));",
  "afterAll(() => { mock.module('node:child_process', () => realChildProcess); });",
].join('\n');

describe('ci-mock-module-restore-gate', () => {
  test('compares actual base tree debt and fails closed when the base is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-restore-base-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    try {
      git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'test/old.test.ts'), "mock.module('old', () => ({}));\n");
      git('add', '.'); git('commit', '-qm', 'base');
      const errors: string[] = [];
      const run = (ref: string) => runMockModuleRestoreGate({ cwd: root, compareRef: ref, args: [], log: () => {}, error: s => errors.push(s) });
      expect(run('HEAD')).toBe(0);
      writeFileSync(join(root, 'test/new.test.ts'), "mock.module('new', () => ({}));\n");
      expect(run('HEAD')).toBe(1);
      expect(errors.join('\n')).toContain('test/new.test.ts: new');
      writeFileSync(join(root, 'test/new.test.ts'), '');
      writeFileSync(join(root, 'test/old.test.ts'), "mock.module('different', () => ({}));\n");
      expect(run('HEAD')).toBe(1); // Equal counts must not hide a different new mock.
      expect(run('missing-baseline-ref')).toBe(1);
      expect(errors.join('\n')).toContain('기준 측정 불가');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('accepts R-TST23 expanded-snapshot afterAll restoration and createRequire originals', () => {
    expect(scanMockModuleRestoreCandidates(expandedRestore)).toEqual([]);
    expect(scanMockModuleRestoreCandidates([
      "import { afterAll, mock } from 'bun:test';",
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const originalRuntime = require('react/jsx-runtime');",
      "mock.module('react/jsx-runtime', () => ({}));",
      "afterAll(() => { mock.module('react/jsx-runtime', () => originalRuntime); });",
    ].join('\n'))).toEqual([]);
  });

  test('rejects missing restoration and mock.restore-only because it does not restore mock.module', () => {
    expect(scanMockModuleRestoreCandidates("mock.module('node:fs', () => ({}));")).toEqual(['node:fs']);
    expect(scanMockModuleRestoreCandidates([
      "mock.module('node:fs', () => ({}));",
      'afterAll(() => mock.restore());',
    ].join('\n'))).toEqual(['node:fs']);
  });

  test('accepts only node:module named-import createRequire bindings', () => {
    expect(scanMockModuleRestoreCandidates([
      "import { afterAll, mock } from 'bun:test';",
      'function createRequire() { return () => ({}) }',
      'const require = createRequire();',
      "const originalRuntime = require('react/jsx-runtime');",
      "mock.module('react/jsx-runtime', () => ({}));",
      "afterAll(() => mock.module('react/jsx-runtime', () => originalRuntime));",
    ].join('\n'))).toEqual(['react/jsx-runtime']);

    expect(scanMockModuleRestoreCandidates([
      "import { afterAll, mock } from 'bun:test';",
      "import { createRequire as nodeCreateRequire } from 'node:module';",
      'const require = nodeCreateRequire(import.meta.url);',
      "const originalRuntime = require('react/jsx-runtime');",
      "mock.module('react/jsx-runtime', () => ({}));",
      "afterAll(() => mock.module('react/jsx-runtime', () => originalRuntime));",
    ].join('\n'))).toEqual([]);
  });

  test('rejects unrelated originals, factories that do not return the original, and afterAll-external re-mocks', () => {
    expect(scanMockModuleRestoreCandidates([
      "import * as childProcess from 'node:child_process';",
      "import * as filesystem from 'node:fs';",
      'const unrelatedOriginal = { ...filesystem };',
      "mock.module('node:child_process', () => ({}));",
      "afterAll(() => mock.module('node:child_process', () => unrelatedOriginal));",
    ].join('\n'))).toEqual(['node:child_process']);

    expect(scanMockModuleRestoreCandidates([
      "import * as childProcess from 'node:child_process';",
      'const realChildProcess = { ...childProcess };',
      "mock.module('node:child_process', () => ({}));",
      "afterAll(() => mock.module('node:child_process', () => ({ notTheOriginal: true })));",
    ].join('\n'))).toEqual(['node:child_process']);

    expect(scanMockModuleRestoreCandidates([
      "import * as childProcess from 'node:child_process';",
      'const realChildProcess = { ...childProcess };',
      "mock.module('node:child_process', () => ({}));",
      'afterAll(() => cleanup());',
      "mock.module('node:child_process', () => realChildProcess);",
    ].join('\n'))).toEqual(['node:child_process']);
  });

  test('rejects conditional, unreachable, and overwritten afterAll restorations', () => {
    const conditional = [
      "import { afterAll, mock } from 'bun:test';",
      "import * as filesystem from 'node:fs';",
      'const originalFilesystem = { ...filesystem };',
      "mock.module('node:fs', () => ({}));",
      "afterAll(() => { if (false) mock.module('node:fs', () => originalFilesystem); });",
    ].join('\n');
    const unreachable = [
      "import { afterAll, mock } from 'bun:test';",
      "import * as filesystem from 'node:fs';",
      'const originalFilesystem = { ...filesystem };',
      "mock.module('node:fs', () => ({}));",
      "afterAll(() => { return; mock.module('node:fs', () => originalFilesystem); });",
    ].join('\n');
    const overwritten = [
      "import { afterAll, mock } from 'bun:test';",
      "import * as filesystem from 'node:fs';",
      'const originalFilesystem = { ...filesystem };',
      "mock.module('node:fs', () => ({}));",
      "afterAll(() => mock.module('node:fs', () => originalFilesystem));",
      "afterAll(() => mock.module('node:fs', () => ({ stillMocked: true })));",
    ].join('\n');
    for (const source of [conditional, unreachable, overwritten]) expect(scanMockModuleRestoreCandidates(source)).toEqual(['node:fs']);

    const errors: string[] = [];
    expect(runMockModuleRestoreGate({
      args: [],
      scan: () => new Map([['test/control-flow-bypass.test.ts', entry('node:fs')]]),
      loadBaseline: () => new Map([['test/debt.test.ts', 1]]),
      error: message => errors.push(message),
    })).toBe(1);
    expect(errors.join('\n')).toContain('test/control-flow-bypass.test.ts');
  });

  test('allows baseline debt, blocks a new violation by filename, and advises ratchet down', () => {
    const errors: string[] = [];
    const baselineDebt = new Map([['test/debt.test.ts', entry('node:fs')]]);
    expect(runMockModuleRestoreGate({ args: [], scan: () => baselineDebt, loadBaseline: () => new Map([['test/debt.test.ts', 1]]), error: message => errors.push(message) })).toBe(0);
    expect(errors).toEqual([]);

    const newViolation = new Map([['test/new-leak.test.ts', entry('node:fs')]]);
    expect(runMockModuleRestoreGate({ args: [], scan: () => newViolation, loadBaseline: () => new Map([['test/debt.test.ts', 1]]), error: message => errors.push(message) })).toBe(1);
    expect(errors.join('\n')).toContain('test/new-leak.test.ts');

    const logs: string[] = [];
    expect(runMockModuleRestoreGate({ args: [], scan: () => new Map(), loadBaseline: () => new Map([['test/debt.test.ts', 1]]), log: message => logs.push(message) })).toBe(0);
    expect(logs.join('\n')).toContain('--update');
  });

  test('diagnoses missing or empty baselines instead of silently passing', () => {
    for (const baseline of [new Map<string, number>(), new Map<string, number>()]) {
      const errors: string[] = [];
      expect(runMockModuleRestoreGate({ args: [], scan: () => new Map(), loadBaseline: () => baseline, error: message => errors.push(message) })).toBe(1);
      expect(errors.join('\n')).toContain('baseline이 없거나 비어 있습니다');
    }
  });

  test('limits baseline comparison to changed files and rejects partial updates', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let wrote = false;
    const code = runMockModuleRestoreGate({
      args: ['--changed-files', 'test/changed.test.ts'],
      scan: () => new Map([['test/changed.test.ts', entry()], ['test/outside.test.ts', entry()]]),
      loadBaseline: () => new Map([['test/changed.test.ts', 0], ['test/outside.test.ts', 1]]),
      log: message => logs.push(message), error: message => errors.push(message),
    });
    const updateCode = runMockModuleRestoreGate({
      args: ['--changed-files', 'test/changed.test.ts', '--update'],
      scan: () => new Map([['test/changed.test.ts', entry('node:fs')]]),
      writeBaseline: () => { wrote = true; }, error: message => errors.push(message),
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('test/outside.test.ts');
    expect(updateCode).toBe(1);
    expect(wrote).toBe(false);
    expect(errors.join('\n')).toContain('--changed-files 와 --update');
  });

  test('resnapshots the observed count without a hard-coded debt total', () => {
    const current = new Map([['test/existing.test.ts', entry('node:fs', 'node:path')]]);
    const writes: Map<string, unknown>[] = [];
    expect(runMockModuleRestoreGate({ args: ['--update'], scan: () => current, writeBaseline: entries => writes.push(entries as never) })).toBe(0);
    expect(writes).toEqual([current]);
  });
});
