import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const script = join(root, 'scripts/homebrew-formula-bump.ts');
const formula = readFileSync(join(root, 'integrations/homebrew/elanous.rb'));
const helloSha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const oldVersion = formula.toString('utf8').match(/^  url "https:\/\/registry\.npmjs\.org\/elanous\/-\/elanous-(\d+\.\d+\.\d+)\.tgz"$/m)![1]!;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(content: Buffer = formula) {
  const dir = mkdtempSync(join(tmpdir(), 'homebrew-bump-'));
  dirs.push(dir);
  const copy = join(dir, 'elanous.rb');
  const tgz = join(dir, 'hello.tgz');
  writeFileSync(copy, content);
  writeFileSync(tgz, 'hello');
  const run = (...extra: string[]) => spawnSync(process.execPath,
    [script, '--version', '9.9.9', '--tarball', tgz, '--formula', copy, ...extra],
    { cwd: root, encoding: 'utf8' });
  return { copy, run };
}

function expected(original: string): string {
  return original
    .replace(/(  url "https:\/\/registry\.npmjs\.org\/elanous\/-\/elanous-)\d+\.\d+\.\d+(\.tgz")/, '$19.9.9$2')
    .replace(/(  sha256 ")[0-9a-f]{64}(\")/, `$1${helloSha}$2`);
}

test('real CLI changes only the two formula lines together using the local tarball digest', () => {
  const { copy, run } = fixture();
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const before = formula.toString('utf8');
  const after = readFileSync(copy, 'utf8');
  expect(after).toBe(expected(before));
  expect(after).toContain('elanous-9.9.9.tgz');
  expect(after).toContain(`sha256 "${helloSha}"`);
  expect(result.stdout.trim()).toBe(`formula: ${oldVersion} → 9.9.9 · sha256 2cf24dba5fb0`);
});

test('missing sha256 line fails without changing a single byte', () => {
  const input = Buffer.from(formula.toString('utf8').replace(/^  sha256 .*\n/m, ''));
  const { copy, run } = fixture(input);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe('formula must contain exactly one npm url and one sha256 line');
  expect(readFileSync(copy)).toEqual(input);
});

test('dry-run prints only prospective lines and summary without writing', () => {
  const { copy, run } = fixture();
  const before = readFileSync(copy);
  const result = run('--dry-run');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trimEnd().split('\n')).toEqual([
    '  url "https://registry.npmjs.org/elanous/-/elanous-9.9.9.tgz"',
    `  sha256 "${helloSha}"`,
    `formula: ${oldVersion} → 9.9.9 · sha256 2cf24dba5fb0`,
  ]);
  expect(readFileSync(copy)).toEqual(before);
});

test('failed local tarball read reports one reason and preserves the formula', () => {
  const { copy, run } = fixture();
  const before = readFileSync(copy);
  const result = run('--tarball', join(root, 'no-such-homebrew-tarball.tgz'));
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split('\n')).toHaveLength(1);
  expect(readFileSync(copy)).toEqual(before);
});

test('missing url line fails without writing the sha256 line', () => {
  const input = Buffer.from(formula.toString('utf8').replace(/^  url .*\n/m, ''));
  const { copy, run } = fixture(input);
  expect(run().status).toBe(1);
  expect(readFileSync(copy)).toEqual(input);
});
