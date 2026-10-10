import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHqLaunchSeat } from './seats.js';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';

const cli = join(import.meta.dir, '../../bin/elanous.mjs');

test('launch lookup reads registered home and detached OP seat without creating or refreshing it', () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'hq-launch-seat-')));
  const home = join(temp, 'home');
  const seed = join(temp, 'seed');
  const remote = join(temp, 'remote.git');
  const root = join(home, 'elanous-hq');
  const house = join(home, 'registered-house');
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') };
  const run = (bin: string, args: string[], cwd = temp) => spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  const git = (args: string[], cwd = temp): string => {
    const result = run('git', args, cwd);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    mkdirSync(home);
    mkdirSync(house);
    git(['init', '--bare', remote]);
    git(['init', '-b', 'main', seed]);
    git(['config', 'user.name', 'Fixture'], seed);
    git(['config', 'user.email', 'fixture@example.test'], seed);
    writeFileSync(join(seed, 'README'), 'base\n');
    git(['add', 'README'], seed);
    git(['commit', '-m', 'base'], seed);
    git(['remote', 'add', 'origin', remote], seed);
    git(['push', '-u', 'origin', 'main'], seed);
    const args = [cli, `--test=${join(home, 'test-state')}`, '--config-dir', house, 'hq'];
    const init = run('bun', [...args, 'init', '--root', root], seed);
    expect(init.status, init.stderr).toBe(0);
    const ledgerBefore = readFileSync(join(root, 'house.json'), 'utf8');
    expect(() => resolveHqLaunchSeat('OP', house, { root })).toThrow();
    expect(() => resolveHqLaunchSeat('FAKE', house, { root })).toThrow('unregistered seat');
    const created = run('bun', [...args, 'seat', 'OP', '--root', root]);
    expect(created.status, created.stderr).toBe(0);
    const seat = join(root, 'seats', 'OP');
    expect(resolveHqLaunchSeat('OP', house, { root })).toBe(seat);
    expect(() => resolveHqLaunchSeat('OP', home, { root })).toThrow('house.json home mismatch');
    expect(readFileSync(join(root, 'house.json'), 'utf8')).toBe(ledgerBefore);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], seat)).toBe('HEAD');
    setGitCommandRunnerForTesting((cwd, gitArgs) => {
      const result = run('git', gitArgs, cwd);
      if (gitArgs.join(' ') === 'symbolic-ref --quiet HEAD') return { status: 128, stdout: '', stderr: 'fatal: cannot read HEAD' };
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
    expect(() => resolveHqLaunchSeat('OP', house, { root })).toThrow('git symbolic-ref --quiet HEAD: fatal: cannot read HEAD');
    setGitCommandRunnerForTesting((cwd, gitArgs) => {
      const result = run('git', gitArgs, cwd);
      if (gitArgs.join(' ') === 'symbolic-ref --quiet HEAD') return { status: 1, stdout: '', stderr: '' };
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
    expect(resolveHqLaunchSeat('OP', house, { root })).toBe(seat);
  } finally {
    setGitCommandRunnerForTesting(undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);
