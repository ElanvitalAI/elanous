import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { pathOnlyEnv, withEnv } from './child-env-args.js';

// A fake binary put first on PATH at runtime must win — without the preload Bun uses the
// startup PATH and every line below prints the real `uname` output.
const dir = mkdtempSync(join(tmpdir(), 'preload-child-env-'));
mkdirSync(join(dir, 'bin'));
writeFileSync(join(dir, 'bin', 'uname'), '#!/bin/sh\necho FAKE-UNAME\n');
chmodSync(join(dir, 'bin', 'uname'), 0o755);
const previousPath = process.env.PATH;
process.env.PATH = `${join(dir, 'bin')}:${previousPath}`;
afterAll(() => { process.env.PATH = previousPath; rmSync(dir, { recursive: true, force: true }); });

const finished = (child: ReturnType<typeof spawn>) => new Promise<string>((resolve) => {
  let out = ''; child.stdout?.on('data', (d) => { out += d; }); child.on('close', () => resolve(out.trim()));
});

test('node:child_process calls without env resolve commands on the current PATH', async () => {
  expect(execFileSync('uname', { encoding: 'utf8' }).trim()).toBe('FAKE-UNAME');
  expect(execFileSync('uname').toString().trim()).toBe('FAKE-UNAME');
  expect(execFileSync('uname', [], { encoding: 'utf8' }).trim()).toBe('FAKE-UNAME');
  expect(spawnSync('uname', { encoding: 'utf8' }).stdout.trim()).toBe('FAKE-UNAME');
  expect(execSync('uname', { encoding: 'utf8' }).trim()).toBe('FAKE-UNAME');
  expect(await finished(spawn('uname'))).toBe('FAKE-UNAME');
  expect(await new Promise<string>((r) => execFile('uname', (_e, out) => r(String(out).trim())))).toBe('FAKE-UNAME');
  expect(await new Promise<string>((r) => exec('uname', (_e, out) => r(String(out).trim())))).toBe('FAKE-UNAME');
  expect((await promisify(execFile)('uname', [], { encoding: 'utf8' })).stdout.trim()).toBe('FAKE-UNAME');
  expect((await promisify(exec)('uname', { encoding: 'utf8' })).stdout.trim()).toBe('FAKE-UNAME');
});

test('Bun.spawnSync / Bun.spawn without env resolve on the current PATH', async () => {
  expect(Bun.spawnSync(['uname']).stdout.toString().trim()).toBe('FAKE-UNAME');
  expect(Bun.spawnSync({ cmd: ['uname'] }).stdout.toString().trim()).toBe('FAKE-UNAME');
  expect((await new Response(Bun.spawn(['uname']).stdout).text()).trim()).toBe('FAKE-UNAME');
});

test('an explicit env is left exactly as given · only PATH follows the current process', () => {
  const env = { PATH: '/usr/bin:/bin' };
  expect(execFileSync('uname', { encoding: 'utf8', env }).trim()).not.toBe('FAKE-UNAME');
  expect(withEnv(['x', ['a'], { env }], { A: '1' })).toEqual(['x', ['a'], { env }]);
  expect(withEnv(['x'], { A: '1' })).toEqual(['x', { env: { A: '1' } }]);
  const cb = () => {};
  expect(withEnv(['x', cb], { A: '1' })).toEqual(['x', { env: { A: '1' } }, cb]);
  expect(pathOnlyEnv({ PATH: '/a', HOME: '/h' }, { PATH: '/a', HOME: '/other' })).toBeNull();
  expect(pathOnlyEnv({ PATH: '/a', HOME: '/h' }, { PATH: '/fake:/a', HOME: '/other' })).toEqual({ PATH: '/fake:/a', HOME: '/h' });
});
