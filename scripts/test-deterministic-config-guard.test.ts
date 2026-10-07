import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_LOCATION_ENV_KEYS, runDeterministicTests } from './test-deterministic.js';

function withRepo(runTest: (repo: string, configFile: string, git: (args: string[]) => string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'elanous-config-guard-'));
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV_KEYS) delete env[key];
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0 && !(result.status === 1 && args.includes('--get-all'))) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  git(['init']);
  return runTest(repo, join(repo, '.git', 'config'), git).finally(() => rmSync(repo, { recursive: true, force: true }));
}

test('user.email change is restored and fails the run even when its child passes', async () => {
  await withRepo(async (repo, configFile, git) => {
    git(['config', '--file', configFile, 'user.email', 'before@example.com']);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, 'user.email', 'x@y']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(git(['config', '--file', configFile, '--get-all', 'user.email'])).toBe('before@example.com');
    expect(messages).toEqual([
      '[test-deterministic] user.email changed before@example.com -> x@y; restored before@example.com; failing run',
    ]);
  });
});

test('unset user.name and duplicate user.email are restored independently', async () => {
  await withRepo(async (repo, configFile, git) => {
    git(['config', '--file', configFile, '--add', 'user.email', 'one@example.com']);
    git(['config', '--file', configFile, '--add', 'user.email', 'two@example.com']);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, 'user.name', 'Test']);
        git(['config', '--file', configFile, '--add', 'user.email', 'three@example.com']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(git(['config', '--file', configFile, '--get-all', 'user.name'])).toBe('');
    expect(git(['config', '--file', configFile, '--get-all', 'user.email'])).toBe('one@example.com\ntwo@example.com');
    expect(messages).toEqual([
      '[test-deterministic] user.name changed <unset> -> Test; restored <unset>; failing run',
      '[test-deterministic] user.email changed one@example.com,two@example.com -> one@example.com,two@example.com,three@example.com; restored one@example.com,two@example.com; failing run',
    ]);
  });
});

test('unset user.name changed to an empty value is removed and fails the run', async () => {
  await withRepo(async (repo, configFile, git) => {
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, 'user.name', '']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    const result = spawnSync('git', ['config', '--file', configFile, '--get-all', 'user.name'], {
      cwd: repo, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(messages).toEqual([
      '[test-deterministic] user.name changed <unset> -> <empty>; restored <unset>; failing run',
    ]);
  });
});

test('an originally empty user.name is restored as present after a changed value', async () => {
  await withRepo(async (repo, configFile, git) => {
    git(['config', '--file', configFile, 'user.name', '']);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, 'user.name', 'Test']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    const result = spawnSync('git', ['config', '--file', configFile, '--get-all', 'user.name'], {
      cwd: repo, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('\n');
    expect(messages).toEqual([
      '[test-deterministic] user.name changed <empty> -> Test; restored <empty>; failing run',
    ]);
  });
});

test('newline-containing user.name and user.email remain one value after restoration', async () => {
  await withRepo(async (repo, configFile, git) => {
    for (const key of ['user.name', 'user.email']) {
      git(['config', '--file', configFile, key, 'first\nsecond']);
    }
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        for (const key of ['user.name', 'user.email']) git(['config', '--file', configFile, key, 'changed']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    for (const key of ['user.name', 'user.email']) {
      const result = spawnSync('git', ['config', '--file', configFile, '--null', '--get-all', key], {
        cwd: repo, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('first\nsecond\0');
      expect(messages.some((message) => message.includes(`${key} changed`) && message.includes('; restored '))).toBe(true);
    }
  });
});

test('a newline value split into two entries is detected and restored', async () => {
  await withRepo(async (repo, configFile, git) => {
    git(['config', '--file', configFile, 'user.email', 'first\nsecond']);
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, '--replace-all', 'user.email', 'first']);
        git(['config', '--file', configFile, '--add', 'user.email', 'second']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    const result = spawnSync('git', ['config', '--file', configFile, '--null', '--get-all', 'user.email'], {
      cwd: repo, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('first\nsecond\0');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('user.email changed');
    expect(messages[0]).toContain('failing run');
  });
});

test('core.bare restoration keeps its original message and nonzero exit', async () => {
  await withRepo(async (repo, configFile, git) => {
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => {
        git(['config', '--file', configFile, 'core.bare', 'true']);
        return { pid: process.pid, exited: Promise.resolve(0), kill: () => true };
      },
    });
    expect(code).toBe(1);
    expect(git(['config', '--file', configFile, '--get-all', 'core.bare'])).toBe('false');
    expect(messages).toEqual([
      '[test-deterministic] core.bare changed false -> true; restored false; failing run',
    ]);
  });
});

test('unchanged shared config preserves the passing child exit code', async () => {
  await withRepo(async (repo) => {
    const messages: string[] = [];
    const code = await runDeterministicTests({
      cwd: repo,
      argv: ['scripts/test-deterministic-config-guard.test.ts'],
      waitForSignal: () => new Promise(() => {}),
      report: (message) => messages.push(message),
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(0), kill: () => true }),
    });
    expect(code).toBe(0);
    expect(messages).toEqual([]);
  });
});
