import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { resolveReportTarget, sendTelegramReport } from '../telegram-report.js';
import { flushDeferred, sendTelegramDirect, setInProcessOutbound } from './outbound-alert.js';
import { DEFAULT_KIND_ROLES } from './telegram-kind-route.js';

const main = 'MAIN:token-not-real';
const trading = 'TRADING:token-not-real';
const config = (reportToken: string = trading): UserConfig => ({
  telegram: { enabled: true, botToken: main, homeChannel: 101, allowedUsers: [102], reportChannel: { botToken: reportToken, chatId: 202 } },
}) as UserConfig;

let log: ReturnType<typeof spyOn<typeof debug, 'log'>>;
beforeEach(() => { log = spyOn(debug, 'log').mockImplementation(() => undefined); });
afterEach(() => { log.mockRestore(); });

function fallback(kind: string | undefined, to: string, sameBot: boolean): void {
  expect(log.mock.calls.filter(([category, event]) => category === 'telegram.kind-route' && event === 'fallback')
    .map(([, , fields]) => fields)).toEqual([{ kind, to, sameBot }]);
  const fields = JSON.stringify(log.mock.calls.filter(([category]) => category === 'telegram.kind-route'));
  expect(fields).not.toContain('token-not-real');
  expect(fields).not.toContain('101');
  expect(fields).not.toContain('202');
}

test('unmapped ops-report with separate report bot falls back to main home', () => {
  expect(resolveReportTarget(config(), 'ops-report')).toEqual({ botToken: main, chatId: 101 });
  fallback('ops-report', 'main-home', false);
});

test('plain trading report stays on reportChannel', () => {
  expect(resolveReportTarget(config(), 'report')).toEqual({ botToken: trading, chatId: 202 });
  fallback('report', 'report-channel', false);
});

test('ops-alert with the same report bot stays on reportChannel', () => {
  expect(resolveReportTarget(config(main), 'ops-alert')).toEqual({ botToken: main, chatId: 202 });
  fallback('ops-alert', 'report-channel', true);
});

test('explicit system channel wins for operational and mission kinds without fallback', () => {
  const cfg = config();
  cfg.telegram.channels = [{ name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] }];
  for (const kind of ['ops-report', 'regression', 'agent-mission']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: main, chatId: 303 });
  }
  expect(DEFAULT_KIND_ROLES.regression).toBe('system');
  expect(DEFAULT_KIND_ROLES['agent-mission']).toBe('system');
  expect(log.mock.calls.filter(([category]) => category === 'telegram.kind-route')).toHaveLength(0);
});

test('unmapped ops-report without reportChannel uses allowedUsers home fallback; missing home fails closed', () => {
  const cfg = config();
  delete cfg.telegram.reportChannel;
  delete cfg.telegram.homeChannel;
  expect(resolveReportTarget(cfg, 'ops-report')).toEqual({ botToken: main, chatId: 102 });
  fallback('ops-report', 'main-home', false);
  log.mockClear();
  cfg.telegram.allowedUsers = [];
  expect(resolveReportTarget(cfg, 'ops-report')).toBeNull();
  fallback('ops-report', 'none', false);
});

test('report sender posts ops kind to the main bot/home, never the trading bot', async () => {
  const calls: Array<{ url: string; chatId: number; text: string }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), chatId: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  expect(await sendTelegramReport(config(), 'ops', { kind: 'ops-report', markdown: false, fetchImpl })).toBe(true);
  expect(calls).toEqual([{ url: `https://api.telegram.org/bot${main}/sendMessage`, chatId: 101, text: 'ops' }]);
  fallback('ops-report', 'main-home', false);
});

test('direct ops-alert ignores both trading envs even without a daemon; sends to main home', () => {
  const calls: Array<[string, string | number, string]> = [];
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  const previousChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = trading;
  process.env.TELEGRAM_CHAT_ID = '202';
  try {
    expect(sendTelegramDirect('ops', 'ops-alert', {
      config: config(),
      legacyEnv: () => { throw new Error('conatus must not be read'); },
      sendRaw: (token, chatId, text) => { calls.push([token, chatId, text]); return true; },
    })).toBe(true);
    expect(calls).toEqual([[main, '101', 'ops']]);
    fallback('ops-alert', 'main-home', false);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
    if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChat;
  }
});

test('direct ops-alert without main target prints to console and returns false, not conatus', () => {
  const cfg = config();
  delete cfg.telegram.botToken;
  cfg.telegram.allowedUsers = [];
  delete cfg.telegram.homeChannel;
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(sendTelegramDirect('ops', 'ops-alert', {
      config: cfg,
      legacyEnv: () => { throw new Error('conatus must not be read'); },
      sendRaw: () => { throw new Error('must not send'); },
    })).toBe(false);
    expect(error).toHaveBeenCalled();
    fallback('ops-alert', 'none', false);
  } finally { error.mockRestore(); }
});

test('direct mapped ops kind sends to the explicit system channel', () => {
  const cfg = config();
  cfg.telegram.channels = [{ name: 'system', botToken: main, chatId: 303, interactive: true, roles: ['system'] }];
  const calls: string[] = [];
  expect(sendTelegramDirect('ops', 'ops-report', {
    config: cfg, sendRaw: (token, chatId) => { calls.push(`${token}/${chatId}`); return true; },
  })).toBe(true);
  expect(calls).toEqual([`${main}/303`]);
  expect(log.mock.calls.filter(([category]) => category === 'telegram.kind-route')).toHaveLength(0);
});

test('direct trading report preserves the legacy conatus-env fallback', () => {
  const calls: string[] = [];
  expect(sendTelegramDirect('trade', 'report', {
    config: config(),
    legacyEnv: () => ({ TELEGRAM_BOT_TOKEN: trading, TELEGRAM_CHAT_ID: '202' }),
    sendRaw: (token, chatId) => { calls.push(`${token}/${chatId}`); return true; },
  })).toBe(true);
  expect(calls).toEqual([`${trading}/202`]);
  fallback('report', 'conatus-env', false);
});

test('deferred operational and trading notifications remain in separate delivery batches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-kind-flush-'));
  const path = join(dir, 'deferred.jsonl');
  const kinds: string[] = [];
  writeFileSync(path, [
    { ts: new Date().toISOString(), kind: 'ops-report', text: 'operations' },
    { ts: new Date().toISOString(), kind: 'alert', text: 'trading' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const previous = process.env.SEND_VIA_ELANOUS;
  process.env.SEND_VIA_ELANOUS = '1';
  setInProcessOutbound(async (_text, kind) => { kinds.push(kind); return true; });
  try {
    expect(flushDeferred(path)).toBe(2);
    expect(kinds).toEqual(['report', 'ops-report']);
  } finally {
    setInProcessOutbound(null);
    if (previous === undefined) delete process.env.SEND_VIA_ELANOUS;
    else process.env.SEND_VIA_ELANOUS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operational scripts send only operational kinds at their sendOutbound call sites', () => {
  const cases: Record<string, string[]> = {
    'schedule-health-report': ['ops-alert'], 'tree-sync-alert': ['ops-alert'],
    'retro-cycle': ['ops-report', 'ops-alert'], 'memory-lifecycle-cycle': ['ops-report', 'ops-report'],
    'repo-watch-cycle': ['ops-report'], 'waitlist-daily-digest': ['ops-report'],
  };
  for (const [name, expected] of Object.entries(cases)) {
    const source = readFileSync(join(import.meta.dir, '../../scripts', `${name}.ts`), 'utf8');
    const kinds = [...source.matchAll(/sendOutbound\([^;\n]*?,\s*'(ops-report|ops-alert|report|alert)'\)/g)].map(m => m[1]);
    expect(kinds).toEqual(expected);
  }
});
