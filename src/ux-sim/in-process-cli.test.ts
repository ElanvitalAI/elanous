import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { simInProcessCli } from './in-process-cli.js';

test('registered where action runs in an isolated universe without spawn', async () => {
  const oldArgv = process.argv;
  const oldState = process.env.ELANOUS_STATE_DIR;
  const first = await simInProcessCli(['where', '--json']);
  expect(first.exitCode).toBe(0);
  const observed = JSON.parse(first.stdout);
  expect(observed.kind).toBe('test');
  expect(observed.root).toBe(first.stateRoot);
  expect(observed.configDir).toBe(first.stateRoot);
  expect(existsSync(first.stateRoot)).toBe(false);
  expect(process.argv).toBe(oldArgv);
  expect(process.env.ELANOUS_STATE_DIR).toBe(oldState);

  // Commander command options must not leak into the next simulated turn.
  const second = await simInProcessCli(['where']);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain('지금 어느 우주인가');
  expect(second.stdout).not.toContain('"configDir"');
  expect(existsSync(second.stateRoot)).toBe(false);
}, 30_000);

test('unsafe command and root override are rejected before touching global state', async () => {
  const argv = process.argv;
  await expect(simInProcessCli(['pr', 'land', '123'])).rejects.toThrow('not allowed');
  await expect(simInProcessCli(['where', '--config-dir', '/tmp/escape'])).rejects.toThrow('owns its isolated state root');
  expect(process.argv).toBe(argv);
});

test('allowPaths matches registered commands and leaves positional arguments out', async () => {
  const result = await simInProcessCli(['config', 'get', 'llm.provider'], { allowPaths: [['config', 'get']] });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
  await expect(simInProcessCli(['config', 'set', 'llm.provider', 'openai'], { allowPaths: [['config']] }))
    .rejects.toThrow('not allowed');
});

test('allowPaths accepts a registered Commander alias by its invoked name', async () => {
  const result = await simInProcessCli(['drive', '--help'], { allowPaths: [['drive']] });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('drive');
});

test('one real CLI process confirms the same where contract at the entry boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-cli-entry-'));
  try {
    const bin = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
    const run = spawnSync(process.execPath, [bin, `--test=${root}`, 'where', '--json'], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(0);
    const observed = JSON.parse(run.stdout);
    expect(observed.kind).toBe('test');
    expect(observed.root).toBe(root);
    expect(observed.configDir).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
