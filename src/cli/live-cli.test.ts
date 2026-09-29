import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLiveCommands } from './live-cli.js';
import { liveDetailPath, readLiveDetail, resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'live-cli-')); roots.push(dir); return dir; };
afterEach(() => { resetLiveDetailCacheForTesting(); process.exitCode = 0; for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cli(local: string, production: string, now = 1_000) {
  const output: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerLiveCommands(program, {
    localRoot: () => local, productionRoot: () => production, now: () => now,
    out: { log: (line) => output.push(line), error: (line) => output.push(line) },
  });
  return { output, run: async (...args: string[]) => { await program.parseAsync(['node', 'elanous', 'live', 'detail', ...args]); return output.at(-1)!; } };
}

test('임시 두 뿌리 on/status/off — 자기 우주만 쓰고 운영 파일은 보존', async () => {
  const local = root();
  const production = root();
  const prodPath = liveDetailPath(production);
  writeLiveDetail({ ttlMin: 20 }, { path: prodPath, now: 0 });
  const before = readFileSync(prodPath, 'utf8');
  const command = cli(local, production);
  expect(JSON.parse(await command.run('status', '--json'))).toMatchObject({ on: true, source: 'production', remainingMin: 19 + 59 / 60 });
  expect(JSON.parse(await command.run('on', '--scope', 'r1', '--json'))).toMatchObject({ on: true, scope: 'r1', source: 'local', remainingMin: 30 });
  expect(JSON.parse(await command.run('status', '--scope', 'r2', '--json'))).toMatchObject({ on: false, source: 'local' });
  expect(JSON.parse(await command.run('off', '--json'))).toMatchObject({ on: false, source: 'local', remainingMin: 0 });
  expect(readLiveDetail({ path: liveDetailPath(local), now: 1_001 })).toBeNull();
  expect(readFileSync(prodPath, 'utf8')).toBe(before);
});

test('실제 CLI dispatch 는 --test 임시 우주에만 on/off 를 기록한다', () => {
  const local = root();
  const bin = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
  const invoke = (...args: string[]) => Bun.spawnSync({
    cmd: [process.execPath, bin, `--test=${local}`, 'live', 'detail', ...args, '--json'],
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(existsSync(liveDetailPath(local))).toBe(false);
  const on = invoke('on', '--scope', 'run-1');
  expect(on.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(on.stdout))).toMatchObject({ on: true, source: 'local', scope: 'run-1' });
  expect(readLiveDetail({ path: liveDetailPath(local) })?.scope).toBe('run-1');
  const status = invoke('status', '--scope', 'run-1');
  expect(status.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(status.stdout))).toMatchObject({ on: true, source: 'local' });
  const off = invoke('off');
  expect(off.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(off.stdout))).toMatchObject({ on: false, source: 'local', remainingMin: 0 });
}, 30_000);

test('TTL 상한·입력 검증 및 파일 없는 status', async () => {
  const local = root();
  const production = root();
  const command = cli(local, production);
  expect(JSON.parse(await command.run('status', '--json'))).toMatchObject({ on: false, source: null, remainingMin: 0 });
  expect(await command.run('on', '--ttl', '241')).toContain('--ttl');
  expect(await command.run('on', '--scope', '../bad')).toContain('--scope');
  expect(existsSync(liveDetailPath(local))).toBe(false);
  process.exitCode = 0;
  expect(JSON.parse(await command.run('on', '--ttl', '240', '--json'))).toMatchObject({ on: true, source: 'local', remainingMin: 240 });
});
