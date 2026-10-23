import { expect, test } from 'bun:test';
import { resolve, relative } from 'node:path';
import { findUnwiredExports, gitBaseFileReader, type BaseGitRun } from './wiring-check.js';

function check(files: Record<string, string>, changedFiles = ['src/feature.ts']) {
  const cwd = '/fixture';
  return findUnwiredExports({
    cwd,
    changedFiles,
    readBaseFile: () => undefined,
    readFile: (absolutePath) => {
      const file = relative(cwd, resolve(absolutePath));
      if (!(file in files)) throw new Error(`missing ${file}`);
      return files[file]!;
    },
    listFiles: () => Object.keys(files),
  });
}

test('new export used only by a test is reported; a production call clears it', () => {
  const feature = 'export function solve() { return 1; }';
  const onlyTest = check({
    'src/feature.ts': feature,
    'src/feature.test.ts': "import { solve } from './feature.js'; solve();",
  });
  expect(onlyTest).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'solve', reason: 'no-production-importer' }],
  });
  const wired = check({
    'src/feature.ts': feature,
    'src/consumer.ts': "import { solve } from './feature.js'; solve();",
  });
  expect(wired).toEqual({ checked: 1, unwired: [] });
});

test('a local call counts as production use; types and known entry surfaces are excluded', () => {
  expect(check({ 'src/feature.ts': 'export function solve() { return 1; }\nexport const answer = solve();\nexport type Shape = { x: number };' })).toEqual({
    checked: 2,
    unwired: [{ file: 'src/feature.ts', name: 'answer', reason: 'no-production-importer' }],
  });
  expect(check({
    'src/index.ts': 'export const publicApi = 1;',
    'src/feature.ts': 'export function makeForTesting() {}',
  }, ['src/index.ts', 'src/feature.ts'])).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'makeForTesting', reason: 'no-production-importer' }],
  });
});

test('same-named locals do not count as use of an exported binding', () => {
  expect(check({
    'src/feature.ts': 'export function fresh() {}\nfunction helper() { const fresh = 1; return fresh; }',
    'src/consumer.ts': "import { fresh } from './feature.js'; function helper() { const fresh = 1; return fresh; }",
  })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'fresh', reason: 'no-production-importer' }],
  });
});

test('aliased named exports are checked by their public name', () => {
  expect(check({
    'src/feature.ts': 'const impl = () => 1; export { impl as publicApi };',
    'src/consumer.ts': "import { publicApi } from './feature.js'; publicApi();",
  })).toEqual({ checked: 1, unwired: [] });
  expect(check({
    'src/feature.ts': 'const impl = () => 1; export { impl as publicApi };',
    'src/consumer.test.ts': "import { publicApi } from './feature.js'; publicApi();",
  })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'publicApi', reason: 'no-production-importer' }],
  });
});

test('ordinary index modules are checked while the root CLI entrypoint is excluded', () => {
  expect(check({
    'src/domain/index.ts': 'export const domainApi = 1;',
    'src/index.ts': 'export const cliApi = 1;',
  }, ['src/domain/index.ts', 'src/index.ts'])).toEqual({
    checked: 1,
    unwired: [{ file: 'src/domain/index.ts', name: 'domainApi', reason: 'no-production-importer' }],
  });
});

test('type queries cannot make an otherwise unused runtime export look wired', () => {
  expect(check({ 'src/feature.ts': 'export function solve() {}\ntype T = typeof solve;' })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'solve', reason: 'no-production-importer' }],
  });
});

test('an existing export and an unused import do not change the wiring verdict', () => {
  const files = {
    'src/feature.ts': 'export const old = 1; export const fresh = 2;',
    'src/consumer.ts': "import { fresh } from './feature.js'; export const unrelated = 3;",
  };
  const result = findUnwiredExports({
    cwd: '/fixture', changedFiles: ['src/feature.ts'],
    readBaseFile: () => 'export const old = 1;',
    readFile: (path) => files[relative('/fixture', path) as keyof typeof files]!,
    listFiles: () => Object.keys(files),
  });
  expect(result).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'fresh', reason: 'no-production-importer' }],
  });
});

test('default exports are runtime exports: test-only use is reported, a default import call clears it', () => {
  expect(check({
    'src/feature.ts': 'export default function solve() {}',
    'src/feature.test.ts': "import solve from './feature.js'; solve();",
  })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'default', reason: 'no-production-importer' }],
  });
  expect(check({
    'src/feature.ts': 'export default function solve() {}',
    'src/consumer.ts': "import run from './feature.js'; run();",
  })).toEqual({ checked: 1, unwired: [] });
  expect(check({ 'src/feature.ts': 'export default function solve() {}\nconst boot = () => solve();\nboot();' }))
    .toEqual({ checked: 1, unwired: [] });
  expect(check({
    'src/feature.ts': 'const impl = () => 1; export default impl;',
    'src/consumer.ts': "import { default as run } from './feature.js'; run();",
  })).toEqual({ checked: 1, unwired: [] });
});

test('a bare reference is not wiring; only calls and production consumption count', () => {
  expect(check({ 'src/feature.ts': 'export function fresh() {}\nvoid fresh;\nfresh;' })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'fresh', reason: 'no-production-importer' }],
  });
  expect(check({
    'src/feature.ts': 'export function fresh() {}',
    'src/consumer.ts': "import { fresh } from './feature.js'; void fresh; const alias = fresh;",
  })).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'fresh', reason: 'no-production-importer' }],
  });
  expect(check({
    'src/feature.ts': 'export function fresh() {}',
    'src/consumer.ts': "import { fresh } from './feature.js'; import { register } from './registry.js'; register(fresh);",
    'src/registry.ts': 'export function register(fn: () => void) { fn(); }',
  })).toEqual({ checked: 1, unwired: [] });
  expect(check({
    'src/feature.ts': 'export const TABLE = { a: 1 };',
    'src/consumer.ts': "import * as feature from './feature.js'; export function read() { return feature.TABLE.a; }",
  }, ['src/feature.ts'])).toEqual({ checked: 1, unwired: [] });
});

test('ambient declarations and re-exported types are not runtime exports', () => {
  expect(check({
    'src/feature.ts': [
      'export declare const value: string;',
      'export declare function declared(): void;',
      'export declare class Declared {}',
      'type Alias = { x: number };',
      'interface Shape { y: number }',
      'export { Alias, Shape };',
    ].join('\n'),
  })).toEqual({ checked: 0, unwired: [] });
});

test('a file deleted by the run is skipped, not reported as a failure', () => {
  const files: Record<string, string> = { 'src/feature.ts': 'export function fresh() {}' };
  const result = findUnwiredExports({
    cwd: '/fixture', changedFiles: ['src/removed.ts', 'src/feature.ts'],
    readBaseFile: () => undefined,
    readFile: (path) => {
      const file = relative('/fixture', path);
      if (!(file in files)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return files[file]!;
    },
    listFiles: () => Object.keys(files),
  });
  expect(result).toEqual({
    checked: 1,
    unwired: [{ file: 'src/feature.ts', name: 'fresh', reason: 'no-production-importer' }],
  });
});

function runner(results: Record<string, ReturnType<BaseGitRun>>): BaseGitRun {
  return (args) => {
    const result = results[args[0]!];
    if (!result) throw new Error(`unexpected command ${args.join(' ')}`);
    return result;
  };
}

test('a base read that times out or errors is a failure, not a file that did not exist', () => {
  const base = 'a'.repeat(40);
  const timedOut = gitBaseFileReader(runner({ 'ls-tree': { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT', stdout: '', stderr: '' } }), base);
  expect(() => timedOut('src/feature.ts')).toThrow(/base-read-failed/);
  const treeError = gitBaseFileReader(runner({ 'ls-tree': { status: 128, stdout: '', stderr: 'fatal: not a tree object' } }), base);
  expect(() => treeError('src/feature.ts')).toThrow(/base-read-failed/);
  const showFails = gitBaseFileReader(runner({
    'ls-tree': { status: 0, stdout: 'src/feature.ts\0', stderr: '' },
    show: { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT', stdout: '', stderr: '' },
  }), base);
  expect(() => showFails('src/feature.ts')).toThrow(/base-read-failed/);
  expect(gitBaseFileReader(runner({ 'ls-tree': { status: 0, stdout: '', stderr: '' } }), base)('src/feature.ts')).toBeUndefined();
  expect(gitBaseFileReader(runner({
    'ls-tree': { status: 0, stdout: 'src/feature.ts\0', stderr: '' },
    show: { status: 0, stdout: 'export const old = 1;', stderr: '' },
  }), base)('src/feature.ts')).toBe('export const old = 1;');

  const files = { 'src/feature.ts': 'export const old = 1;', 'src/other.ts': 'export const x = 1;' };
  const result = findUnwiredExports({
    cwd: '/fixture', changedFiles: ['src/feature.ts'],
    readBaseFile: timedOut,
    readFile: (path) => files[relative('/fixture', path) as keyof typeof files]!,
    listFiles: () => Object.keys(files),
  });
  expect(result.unwired).toEqual([]);
  expect(result.failure).toMatch(/base-read-failed/);
});
