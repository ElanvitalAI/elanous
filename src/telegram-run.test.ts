import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from './elanous-config-dir.js';
import { resetUserConfig } from './user-config.js';
import { runTelegramPoller, startTelegramPollers } from './telegram-run.js';

let dir: string;
const previousToken = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telegram-run-'));
  setElanousConfigDir(dir);
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  resetUserConfig();
});
afterEach(() => {
  resetUserConfig();
  resetElanousConfigDir();
  if (previousToken === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
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
