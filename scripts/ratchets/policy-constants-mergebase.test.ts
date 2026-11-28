import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPolicyConstantsGate } from './policy-constants';

test('merge-base tolerates main drift, rejects PR growth and preserves old no-base behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaml-ratchet-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const file = 'src/a.ts';
  const put = (path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  put(file, 'export const OLD_MAX = 1;\n');
  put('scripts/ratchets/policy-constants.baseline.json', JSON.stringify({ threshold: { [file]: 1 }, place: {} }));
  git('add', '.'); git('commit', '-qm', 'initial');
  expect(runPolicyConstantsGate({cwd: dir, args:['--changed-files', file], log:()=>{}, error:()=>{}})).toBe(0);
  put(file, 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\n');
  git('add', '.'); git('commit', '-qm', 'main drift');
  git('checkout', '-qb', 'pr');
  put(file, 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\nexport function f() { return 1; }\n');
  const gate = (baseRef?: string) => { const messages: string[] = []; const rc = runPolicyConstantsGate({cwd: dir, args:['--changed-files', file], baseRef, log:m=>messages.push(m), error:m=>messages.push(m)}); return {rc, messages}; };
  expect(gate('main').rc).toBe(0);
  expect(gate().rc).toBe(1); // old count baseline reproduces main drift failure
  put(file, 'export const OLD_MAX = 1;\nexport const MAIN_MAX = 2;\nexport const PR_MAX = 3;\n');
  const red = gate('main'); expect(red.rc).toBe(1); expect(red.messages.join('\n')).toContain('PR_MAX');
  expect(gate('nonexistent-ref').rc).toBe(1);
  // Same count, different declaration: PR additions cannot hide behind a removal.
  put(file, 'export const OLD_MAX = 1;\nexport const PR_MAX = 3;\n'); expect(gate('main').rc).toBe(1);
});

test('divergent base compares the common ancestor; fixtures are excluded at any depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaml-mergebase-divergent-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  put('scripts/ratchets/policy-constants.baseline.json', JSON.stringify({ threshold: {}, place: {} }));
  put('src/a.ts', 'export const ORIGINAL_MAX = 1;\n');
  git('add', '.'); git('commit', '-qm', 'common'); git('checkout', '-qb', 'pr');
  put('src/a.ts', 'export const ORIGINAL_MAX = 1;\nexport const SHARED_MAX = 2;\n');
  git('add', '.'); git('commit', '-qm', 'pr add');
  git('checkout', '-q', 'main'); put('src/a.ts', 'export const ORIGINAL_MAX = 1;\nexport const SHARED_MAX = 2;\n');
  git('add', '.'); git('commit', '-qm', 'main add independently'); git('checkout', '-q', 'pr');
  const messages: string[] = [];
  const gate = (files: string[], baseRef = 'main') => runPolicyConstantsGate({ cwd: dir, args: ['--changed-files', ...files], baseRef, log: m => messages.push(m), error: m => messages.push(m) });
  expect(gate(['src/a.ts'])).toBe(1); expect(messages.join('\n')).toContain('SHARED_MAX');
  for (const f of ['src/fixtures/a.ts', 'src/__fixtures__/a.ts', 'src/nested/fixtures/a.ts', 'src/node_modules/a.ts', 'src/a.test.ts', 'src/a.d.ts']) put(f, 'export const NEW_MAX = 9;\n');
  expect(gate(['src/fixtures/a.ts', 'src/__fixtures__/a.ts', 'src/nested/fixtures/a.ts', 'src/node_modules/a.ts', 'src/a.test.ts', 'src/a.d.ts'])).toBe(0);
  put('src/new.ts', 'export const NEW_MAX = 9;\n'); expect(gate(['src/new.ts'], 'HEAD')).toBe(1);
});
