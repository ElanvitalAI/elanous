import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { defaultFieldReelRunner } from './field/field-reel.js';
import { setElanousConfigDir, resetElanousConfigDir } from './elanous-config-dir.js';
import { resetUserConfig } from './user-config.js';
import { runTelegramPoller, startTelegramPollers } from './telegram-run.js';
import { capturedEnvAvailable, resetCapturedEnvForTesting } from './shell-env-bootstrap.js';

let dir: string;
const previousToken = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telegram-run-'));
  setElanousConfigDir(dir);
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  resetUserConfig();
});
afterEach(() => {
  resetCapturedEnvForTesting();
  resetUserConfig();
  resetElanousConfigDir();
  if (previousToken === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

test('poller starts before capture completes; an immediate reel synchronously captures node PATH', async () => {
  const previousPath = process.env.PATH;
  const previousShell = process.env.SHELL;
  const previousSkip = process.env.ELANOUS_SKIP_LOGIN_ENV;
  const previousTerm = process.env.TERM_PROGRAM;
  let release!: (value: boolean) => void;
  const capture = new Promise<boolean>((resolve) => { release = resolve; });
  let warmCalled = false;
  let started = false;
  const shellDir = join(dir, 'login-shell');
  mkdirSync(shellDir);
  const shell = join(shellDir, 'sh');
  writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/opt/node/bin:/usr/bin\\nHOME=/tmp\\nUSER=test\\nSHELL=/bin/sh\\nLANG=C\\nTOKEN=not-inherited\\n'");
  chmodSync(shell, 0o755);
  try {
    resetCapturedEnvForTesting();
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = shell;
    delete process.env.ELANOUS_SKIP_LOGIN_ENV;
    delete process.env.TERM_PROGRAM;
    const poller = runTelegramPoller({
      warm: () => { warmCalled = true; return capture; },
      start: async () => {
        started = true;
        return { started: [{ channel: { name: 'main', botToken: 'fake:token' }, handle: { stop: async () => {} } }] as never,
          refusedBotIds: [], late: [] };
      },
      wait: async () => {}, registerLogSink: async () => {},
    });
    await poller;
    expect(warmCalled).toBe(true);
    expect(started).toBe(true);
    expect(capturedEnvAvailable()).toBe(false);
    expect(process.env.PATH).toBe('/usr/bin:/bin');
    let childPath: string | undefined;
    const fakeSpawn = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(command).toBe('zsh');
      expect(args[0]).toEndWith('reel.sh');
      childPath = options.env?.PATH;
      expect(options.env?.TOKEN).not.toBe('not-inherited');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }) as unknown as typeof spawn;
    await defaultFieldReelRunner(dir, { title: 'event', sub: 'date' }, fakeSpawn);
    expect(capturedEnvAvailable()).toBe(true);
    expect(childPath).toBe('/usr/bin:/bin:/opt/node/bin');
    expect(process.env.PATH).toBe('/usr/bin:/bin');
    release(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/node/bin');
    expect(process.env.TOKEN).not.toBe('not-inherited');
  } finally {
    release(false);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (previousSkip === undefined) delete process.env.ELANOUS_SKIP_LOGIN_ENV;
    else process.env.ELANOUS_SKIP_LOGIN_ENV = previousSkip;
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previousTerm;
  }
});

test('disabled and unresolved token have distinct startup errors with ref id and path', async () => {
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, global: {}, telegram: { enabled: false } }));
  resetUserConfig();
  await expect(startTelegramPollers()).rejects.toThrow('telegram.enabled 가 꺼져 있다');
  writeFileSync(configPath, JSON.stringify({ version: 1, global: {}, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:missing' },
  }, telegram: { enabled: true } }));
  resetUserConfig();
  await expect(startTelegramPollers()).rejects.toThrow(`ref-id-missing missing in ${join(dir, 'secrets.json')}`);
});

test('third consecutive failed start alerts once and returns successfully; a successful start clears the count', async () => {
  const path = join(dir, 'telegram', 'run-failures.json');
  const alerts: Array<[string, string]> = [];
  const fail = { start: async () => { throw new Error('no-source'); },
    alert: (text: string, kind: string) => { alerts.push([text, kind]); return true; },
    registerLogSink: async () => {} };
  for (let count = 1; count <= 2; count++) {
    await expect(runTelegramPoller(fail)).rejects.toThrow('no-source');
    expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(count);
  }
  await expect(runTelegramPoller(fail)).resolves.toBeUndefined();
  expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(3);
  expect(alerts).toEqual([['텔레그램 폴러가 3번 연속 못 떴다 — no-source', 'alert']]);
  await expect(runTelegramPoller(fail)).resolves.toBeUndefined();
  expect(alerts).toHaveLength(1);
  await runTelegramPoller({ start: async () => ({ started: [{ channel: { name: 'main', botToken: 'fake:token' }, handle: { stop: async () => {} } }] as never,
    refusedBotIds: [], late: [] }), wait: async () => {}, registerLogSink: async () => {} });
  expect(() => readFileSync(path)).toThrow();
  await expect(runTelegramPoller(fail)).rejects.toThrow('no-source');
  expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(1);
  expect(alerts).toHaveLength(1);
});

test('undelivered alert stays pending across false and thrown results, then sends exactly once', async () => {
  const path = join(dir, 'telegram', 'run-failures.json');
  const attempts: string[] = [];
  const fail = { start: async () => { throw new Error('no-source'); }, registerLogSink: async () => {} };
  for (let i = 0; i < 2; i++) await expect(runTelegramPoller(fail)).rejects.toThrow('no-source');
  await expect(runTelegramPoller({ ...fail, alert: (text) => { attempts.push(text); return false; } }))
    .rejects.toThrow('outbound alert not delivered');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ count: 3, alerted: false });
  await expect(runTelegramPoller({ ...fail, alert: (text) => { attempts.push(text); throw new Error('sender down'); } }))
    .rejects.toThrow('sender down');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ count: 4, alerted: false });
  await expect(runTelegramPoller({ ...fail, alert: (text) => { attempts.push(text); return true; } }))
    .resolves.toBeUndefined();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ count: 5, alerted: true });
  await expect(runTelegramPoller({ ...fail, alert: (text) => { attempts.push(text); return true; } }))
    .resolves.toBeUndefined();
  expect(attempts).toEqual(Array(3).fill('텔레그램 폴러가 3번 연속 못 떴다 — no-source'));
});

test('existing failure count of two reaches the alert threshold on next process start', async () => {
  const path = join(dir, 'telegram', 'run-failures.json');
  mkdirSync(join(dir, 'telegram'));
  writeFileSync(path, '{"count":2}');
  const alerts: string[] = [];
  await runTelegramPoller({ start: async () => { throw new Error('reason'); },
    alert: (text) => { alerts.push(text); return true; }, registerLogSink: async () => {} });
  expect(alerts).toEqual(['텔레그램 폴러가 3번 연속 못 떴다 — reason']);
  expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(3);
});
