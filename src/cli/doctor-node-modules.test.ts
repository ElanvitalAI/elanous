import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { checkNodeModules } from './doctor-node-modules.js';
import { registerDoctorCommand, runDoctor } from './doctor-cli.js';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(deps: Record<string, string> = { 'present': '1.0.0' }, dev: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'eln-doctor-modules-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: deps, devDependencies: dev }));
  const packages = Object.fromEntries(Object.keys({ ...deps, ...dev }).map((name) => [name, [`${name}@${name === 'different' ? '2.0.0' : '1.0.0'}`, '', {}]]));
  writeFileSync(join(dir, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, workspaces: { '': { dependencies: deps, devDependencies: dev } }, packages }));
  return dir;
}

function install(dir: string, name: string, version = '1.0.0'): void {
  const path = join(dir, 'node_modules', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version }));
}

async function cli(args: string[]): Promise<{ output: string; codes: number[] }> {
  const lines: string[] = [];
  const codes: number[] = [];
  const program = new Command();
  registerDoctorCommand(program, { out: { log: (line) => lines.push(line) }, setExitCode: (code) => codes.push(code) });
  await program.parseAsync(['doctor', 'node-modules', ...args], { from: 'user' });
  if (args.includes('--json') && !lines[0]?.startsWith('{') && !lines[0]?.startsWith('[')) throw new Error(`expected JSON, got ${lines[0]}`);
  return { output: lines.join('\n'), codes };
}

test('reports a missing package and a version mismatch against lock resolutions, not version ranges', async () => {
  const dir = tree({ missing: '^1.0.0', different: '^2.0.0' }, { '@scope/good': '~1.0.0' });
  install(dir, 'different', '1.0.0');
  install(dir, '@scope/good');
  const output = (await cli(['--dir', dir, '--json'])).output;
  expect(output).toStartWith('{');
  const result = JSON.parse(output);
  expect(result).toMatchObject({ dir, status: 'issues', missing: ['missing'], mismatch: [{ name: 'different', expected: '2.0.0', actual: '1.0.0' }], borrowed: null });
  const text = await cli(['--dir', dir]);
  expect(text.output).toContain('빠짐 1: missing');
  expect(text.output).toContain('버전 다름 1: different (1.0.0 != 2.0.0)');
  expect(text.codes).toEqual([1]);
});

test('reports healthy installs and a linked node_modules target with its borrowed tree', async () => {
  const donor = tree();
  install(donor, 'present');
  const own = await cli(['--dir', donor, '--json']);
  expect(JSON.parse(own.output)).toMatchObject({ status: 'ok', missing: [], mismatch: [], borrowed: null });
  expect(own.codes).toEqual([]);
  const borrower = tree();
  symlinkSync(join(donor, 'node_modules'), join(borrower, 'node_modules'), 'dir');
  const borrowed = JSON.parse((await cli(['--dir', borrower, '--json'])).output);
  // The target is a real path: on macOS the tmpdir /var resolves to /private/var.
  const real = realpathSync(donor);
  expect(borrowed).toMatchObject({ status: 'ok', borrowed: { target: join(real, 'node_modules'), tree: real } });
  expect((await cli(['--dir', borrower])).output).toContain(`빌린 트리: ${real} (node_modules → ${join(real, 'node_modules')})`);
});

test('an empty dependency set without node_modules is healthy, not unreadable', () => {
  const dir = tree({});
  expect(checkNodeModules(dir)).toMatchObject({ status: 'ok', missing: [], mismatch: [] });
});

test('a dangling node_modules symlink is unreadable rather than silently counted as absent', () => {
  const dir = tree();
  symlinkSync(join(dir, 'vanished', 'node_modules'), join(dir, 'node_modules'), 'dir');
  expect(checkNodeModules(dir)).toMatchObject({
    status: 'unreadable', missing: [], reason: 'node_modules symlink target is missing',
  });
});

test('a non-directory node_modules is unreadable, not a list of missing packages', () => {
  const dir = tree();
  writeFileSync(join(dir, 'node_modules'), 'not a directory');
  expect(checkNodeModules(dir)).toMatchObject({ status: 'unreadable', missing: [], reason: 'node_modules is not a directory' });
});

test('a missing lock is unreadable, not a healthy or missing-packages claim', async () => {
  const dir = tree();
  install(dir, 'present');
  rmSync(join(dir, 'bun.lock'));
  const result = await cli(['--dir', dir, '--json']);
  expect(JSON.parse(result.output)).toMatchObject({ status: 'unreadable', missing: [], mismatch: [], reason: expect.stringContaining('bun.lock') });
  expect(result.codes).toEqual([1]);
});

test('--all checks nested package.json trees against their own locks; default checks only root', async () => {
  const dir = tree();
  install(dir, 'present');
  const app = join(dir, 'apps', 'pwa');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }));
  writeFileSync(join(app, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, workspaces: { '': { dependencies: { react: '^19' } } }, packages: { react: ['react@19.2.5', '', {}] } }));
  expect(JSON.parse((await cli(['--dir', dir, '--json'])).output).status).toBe('ok');
  const all = JSON.parse((await cli(['--dir', dir, '--all', '--json'])).output);
  expect(all.map((entry: { dir: string; status: string; missing: string[] }) => ({ dir: entry.dir, status: entry.status, missing: entry.missing })))
    .toEqual([{ dir, status: 'ok', missing: [] }, { dir: app, status: 'issues', missing: ['react'] }]);
});

test('--all checks a workspace without its own lock against the root bun.lock workspace entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eln-doctor-modules-ws-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', dependencies: { present: '1.0.0' }, workspaces: ['apps/*'] }));
  writeFileSync(join(dir, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, workspaces: {
    '': { name: 'root', dependencies: { present: '1.0.0' } },
    'apps/pwa': { name: 'pwa', dependencies: { react: '^19', zod: '^4' } },
  }, packages: { present: ['present@1.0.0', '', {}], react: ['react@19.2.5', '', {}], zod: ['zod@4.1.0', '', {}] } }));
  install(dir, 'present');
  install(dir, 'zod', '3.9.0');
  const app = join(dir, 'apps', 'pwa');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pwa', dependencies: { react: '^19', zod: '^4' } }));
  const all = JSON.parse((await cli(['--dir', dir, '--all', '--json'])).output);
  expect(all[1]).toMatchObject({ dir: app, status: 'issues', missing: ['react'], mismatch: [{ name: 'zod', expected: '4.1.0', actual: '3.9.0' }] });
});

test('the original doctor credential report stays independent of the new subcommand', async () => {
  const dir = tree();
  install(dir, 'present');
  const output: string[] = [];
  const program = new Command();
  const injected = {
    repositoryRoot: '/fake',
    readFile: (path: string) => path === '/fake/.env.example' ? 'TOKEN=\n' : '',
    exists: () => false,
    env: {},
    userConfig: { registry: { discovery: { firecrawl: { apiKey: '' } } } } as UserConfig,
    readiness: { provider: 'auto' },
  };
  const before = runDoctor(injected);
  registerDoctorCommand(program, { ...injected, out: { log: (line) => output.push(line) }, setExitCode: () => {} });
  await program.parseAsync(['doctor', 'node-modules', '--dir', dir], { from: 'user' });
  await program.parseAsync(['doctor', '--json'], { from: 'user' });
  const after = JSON.parse(output[1]!);
  expect(after.credentials).toEqual(before.credentials);
  expect(after.externalCommands).toEqual(before.externalCommands);
  expect(after.readiness).toEqual(before.readiness);
});

test('records the checked tree and anomaly counts in the doctor debug event', () => {
  const dir = tree({ missing: '^1', different: '^2' });
  install(dir, 'different');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checkNodeModules(dir);
    expect(log).toHaveBeenCalledWith('doctor.node-modules', 'checked', {
      dir, missing: ['missing'], mismatch: [{ name: 'different', expected: '2.0.0', actual: '1.0.0' }], borrowed: null,
    });
  } finally { log.mockRestore(); }
});

test('parses Bun JSONC lockfiles with trailing commas rather than declaring healthy installs unreadable', () => {
  const dir = tree();
  install(dir, 'present');
  writeFileSync(join(dir, 'bun.lock'), '{ "workspaces": { "": { "dependencies": { "present": "^1", }, }, }, "packages": { "present": ["present@1.0.0", "", {}, ], }, }');
  expect(checkNodeModules(dir)).toMatchObject({ status: 'ok', missing: [], mismatch: [] });
});

test('a stale or invalid lock resolution cannot silently pass as healthy', () => {
  const dir = tree();
  install(dir, 'present');
  const lockPath = join(dir, 'bun.lock');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  delete lock.packages.present;
  writeFileSync(lockPath, JSON.stringify(lock));
  expect(checkNodeModules(dir)).toMatchObject({ status: 'unreadable', reason: 'bun.lock has no resolved version for present' });
});
