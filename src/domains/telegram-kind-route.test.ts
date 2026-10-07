import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { resolveReportTarget, sendReportPhoto, sendReportPhotoBuffer, sendTelegramReport } from '../telegram-report.js';
import { flushDeferred, sendTelegramDirect, setInProcessOutbound } from './outbound-alert.js';
import { DEFAULT_KIND_ROLES, explainReportRoute, roleForKind } from './telegram-kind-route.js';
import { routeOutbound } from '../nexus/outbound/router.js';

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

test('legacy trading report needs a distinct, explicit report bot', () => {
  const cfg = config(main);
  for (const kind of ['report', 'alert', 'digest']) expect(resolveReportTarget(cfg, kind)).toBeNull();
  cfg.telegram.reportChannel = { chatId: 202 };
  for (const kind of ['report', 'alert', 'digest']) expect(resolveReportTarget(cfg, kind)).toBeNull();
});

test('report channel explicitly on the main token is ambiguous (could be the trading bot) — ops-alert fails closed; a report channel without its own token keeps ops on the main home', () => {
  // OUT1 review must-fix: an explicit report token equal to the main token cannot prove the main bot is the operations bot.
  expect(resolveReportTarget(config(main), 'ops-alert')).toBeNull();
  const single = { telegram: { enabled: true, botToken: main, homeChannel: 101, allowedUsers: [102], reportChannel: { chatId: 202 } } } as UserConfig;
  expect(resolveReportTarget(single, 'ops-alert')).toEqual({ botToken: main, chatId: 101 });
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

test('each kind resolves to its own bot; an absent exact role fails closed', () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system', 'default'] },
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
  ];
  for (const kind of ['ops-report', 'ops-alert', 'op-report', 'brief', 'intake', 'regression', 'agent-mission', 'new-kind', undefined]) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: main, chatId: 303 });
  }
  for (const kind of ['report', 'alert', 'digest']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: trading, chatId: 404 });
  }
  cfg.telegram.kindRoles = {
    'new-kind': 'report', report: 'system', alert: 'system', digest: 'system',
  };
  expect(resolveReportTarget(cfg, 'new-kind')).toEqual({ botToken: main, chatId: 303 });
  for (const kind of ['report', 'alert', 'digest']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: trading, chatId: 404 });
  }
  cfg.telegram.channels = [cfg.telegram.channels[1]!];
  expect(resolveReportTarget(cfg, 'new-kind')).toBeNull();
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  expect(resolveReportTarget(cfg, undefined)).toBeNull();
  cfg.telegram.channels = [{ name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system', 'default'] }];
  expect(resolveReportTarget(cfg, 'report')).toBeNull();
  cfg.telegram.channels = [{ name: 'mislabelled-trade', botToken: main, chatId: 303, interactive: false, roles: ['report'] }];
  for (const kind of ['report', 'alert', 'digest']) expect(resolveReportTarget(cfg, kind)).toBeNull();
  delete cfg.telegram.reportChannel;
  for (const kind of ['report', 'alert', 'digest']) expect(resolveReportTarget(cfg, kind)).toBeNull();
  cfg.telegram.reportChannel = { botToken: trading, chatId: 202 };
  cfg.telegram.channels = [
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
  ];
  expect(resolveReportTarget(cfg, 'brief')).toEqual({ botToken: main, chatId: 303 });
  cfg.telegram.channels = [{ name: 'malformed-ops', botToken: trading, chatId: 404, interactive: false, roles: ['system'] }];
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  delete cfg.telegram.reportChannel;
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
});

test('safe kindRoles select alternate channels on the correct bot; unsafe overrides cannot cross the bot boundary', () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
    { name: 'ops-brief', botToken: main, chatId: 305, interactive: false, roles: ['briefing'] },
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
    { name: 'trade-alert', botToken: trading, chatId: 405, interactive: false, roles: ['trade-alert'] },
  ];
  cfg.telegram.kindRoles = { brief: 'briefing', 'new-kind': 'briefing', alert: 'trade-alert' };
  expect(roleForKind(cfg, 'brief')).toBe('briefing');
  expect(resolveReportTarget(cfg, 'brief')).toEqual({ botToken: main, chatId: 305 });
  expect(resolveReportTarget(cfg, 'new-kind')).toEqual({ botToken: main, chatId: 305 });
  expect(resolveReportTarget(cfg, 'alert')).toEqual({ botToken: trading, chatId: 405 });
  cfg.telegram.kindRoles = { brief: 'report', 'new-kind': 'trade-alert', report: 'system', alert: 'briefing' };
  expect(roleForKind(cfg, 'brief')).toBe('system');
  expect(resolveReportTarget(cfg, 'brief')).toEqual({ botToken: main, chatId: 303 });
  expect(resolveReportTarget(cfg, 'new-kind')).toEqual({ botToken: main, chatId: 303 });
  expect(resolveReportTarget(cfg, 'report')).toEqual({ botToken: trading, chatId: 404 });
  expect(resolveReportTarget(cfg, 'alert')).toEqual({ botToken: trading, chatId: 404 });
  cfg.telegram.channels = [
    { name: 'mislabelled-trade', botToken: main, chatId: 303, interactive: true, roles: ['report', 'trade-alert'] },
  ];
  delete cfg.telegram.reportChannel;
  for (const kind of ['report', 'alert', 'digest']) expect(resolveReportTarget(cfg, kind)).toBeNull();
  cfg.telegram.channels = [
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
  ];
  delete cfg.telegram.botToken;
  expect(resolveReportTarget(cfg, 'brief')).toEqual({ botToken: main, chatId: 303 });
  expect(resolveReportTarget(cfg, 'report')).toEqual({ botToken: trading, chatId: 404 });
});

test('explicit ops channel without botToken routes operational kinds and photos with injected fetch', async () => {
  const cfg = config();
  delete cfg.telegram.botToken;
  cfg.telegram.channels = [
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
  ];
  const calls: Array<{ url: string; chatId: number }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    calls.push({ url: String(url), chatId: body instanceof FormData
      ? Number(body.get('chat_id')) : JSON.parse(String(body)).chat_id });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  for (const kind of ['ops-report', 'op-report', 'brief', 'unknown-kind']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: main, chatId: 303 });
    expect(await sendTelegramReport(cfg, kind, { kind, markdown: false, fetchImpl })).toBe(true);
  }
  expect(await sendReportPhoto(cfg, 'https://example.invalid/image.png', { fetchImpl })).toBe(true);
  expect(await sendReportPhotoBuffer(cfg, Buffer.from('png'), { fetchImpl })).toBe(true);
  for (const kind of ['report', 'alert', 'digest']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: trading, chatId: 404 });
    expect(await sendTelegramReport(cfg, kind, { kind, markdown: false, fetchImpl })).toBe(true);
  }
  expect(calls).toEqual([
    ...Array(4).fill({ url: `https://api.telegram.org/bot${main}/sendMessage`, chatId: 303 }),
    ...Array(2).fill({ url: `https://api.telegram.org/bot${main}/sendPhoto`, chatId: 303 }),
    ...Array(3).fill({ url: `https://api.telegram.org/bot${trading}/sendMessage`, chatId: 404 }),
  ]);
  const direct: Array<[string, string]> = [];
  expect(sendTelegramDirect('brief', 'brief', {
    config: cfg,
    sendRaw: (token, chatId) => { direct.push([token, String(chatId)]); return true; },
    legacyEnv: () => { throw new Error('conatus must not be read'); },
  })).toBe(true);
  expect(direct).toEqual([[main, '303']]);
});

test('channel identity ambiguity and a report-token ops impostor fail closed without botToken', () => {
  const cfg = config();
  delete cfg.telegram.botToken;
  cfg.telegram.channels = [
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
    { name: 'ops', botToken: trading, chatId: 303, interactive: true, roles: ['system'] },
  ];
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  cfg.telegram.channels[1] = { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] };
  cfg.telegram.channels.push({ name: 'main', botToken: 'OTHER:token-not-real', chatId: 505, interactive: true, roles: ['qa'] });
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  cfg.telegram.channels = [{ name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['system', 'report'] }];
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  cfg.telegram.channels = [
    { name: 'ops', botToken: trading, chatId: 303, interactive: true, roles: ['system'] },
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
  ];
  delete cfg.telegram.reportChannel;
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
  cfg.telegram.channels = [{ name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] }];
  cfg.telegram.botToken = trading;
  expect(resolveReportTarget(cfg, 'brief')).toBeNull();
});

test('role overrides choose the first safe matching channel even if an earlier channel misuses the role', () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'wrong-brief', botToken: trading, chatId: 404, interactive: false, roles: ['briefing'] },
    { name: 'ops-brief', botToken: main, chatId: 305, interactive: true, roles: ['briefing'] },
    { name: 'wrong-trade', botToken: main, chatId: 303, interactive: true, roles: ['trade-alert'] },
    { name: 'trade-alert', botToken: trading, chatId: 405, interactive: false, roles: ['trade-alert'] },
  ];
  cfg.telegram.kindRoles = { brief: 'briefing', alert: 'trade-alert' };
  expect(resolveReportTarget(cfg, 'brief')).toEqual({ botToken: main, chatId: 305 });
  expect(resolveReportTarget(cfg, 'alert')).toEqual({ botToken: trading, chatId: 405 });
});

test('report, photo and buffer use the same kind policy with injected fetch only', async () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
  ];
  const calls: Array<{ url: string; chatId: number }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const chatId = body instanceof FormData ? Number(body.get('chat_id')) : JSON.parse(String(body)).chat_id;
    calls.push({ url: String(url), chatId });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  expect(await sendTelegramReport(cfg, 'brief', { kind: 'brief', markdown: false, fetchImpl })).toBe(true);
  expect(await sendTelegramReport(cfg, 'trade', { kind: 'report', markdown: false, fetchImpl })).toBe(true);
  expect(await sendReportPhoto(cfg, 'https://example.invalid/image.png', { fetchImpl })).toBe(true);
  expect(await sendReportPhotoBuffer(cfg, Buffer.from('png'), { fetchImpl })).toBe(true);
  expect(await sendReportPhoto(cfg, 'https://example.invalid/image.png', { kind: 'report', fetchImpl })).toBe(true);
  expect(await sendReportPhotoBuffer(cfg, Buffer.from('png'), { kind: 'digest', fetchImpl })).toBe(true);
  expect(calls).toEqual([
    { url: `https://api.telegram.org/bot${main}/sendMessage`, chatId: 303 },
    { url: `https://api.telegram.org/bot${trading}/sendMessage`, chatId: 404 },
    { url: `https://api.telegram.org/bot${main}/sendPhoto`, chatId: 303 },
    { url: `https://api.telegram.org/bot${main}/sendPhoto`, chatId: 303 },
    { url: `https://api.telegram.org/bot${trading}/sendPhoto`, chatId: 404 },
    { url: `https://api.telegram.org/bot${trading}/sendPhoto`, chatId: 404 },
  ]);
  cfg.telegram.channels = [{ name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] }];
  calls.length = 0;
  expect(await sendTelegramReport(cfg, 'unknown', { kind: 'new-kind', fetchImpl })).toBe(false);
  expect(await sendReportPhoto(cfg, 'https://example.invalid/image.png', { fetchImpl })).toBe(false);
  expect(await sendReportPhotoBuffer(cfg, Buffer.from('png'), { fetchImpl })).toBe(false);
  expect(calls).toEqual([]);
});

test('outbound router passes its kind through the real Telegram sender, without a network call', async () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'ops', botToken: main, chatId: 303, interactive: true, roles: ['system'] },
    { name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] },
  ];
  const db = new Database(':memory:');
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  try {
    for (const kind of ['ops-report', 'op-report', 'brief', 'unlisted', 'report']) {
      const result = await routeOutbound(cfg, { kind, text: `test-${kind}`, markdown: false }, {
        fetchImpl, deliveryDb: db, dedup: false, spill: text => ({ text, spilled: false }),
      });
      expect(result.delivered).toBe(true);
    }
    expect(calls).toEqual([
      ...Array(4).fill(`https://api.telegram.org/bot${main}/sendMessage`),
      `https://api.telegram.org/bot${trading}/sendMessage`,
    ]);
  } finally { db.close(); }
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

test('direct fallback cannot send unlisted kind to either a trading channel or the conatus env', () => {
  const cfg = config();
  cfg.telegram.channels = [{ name: 'trading', botToken: trading, chatId: 202, interactive: false, roles: ['report', 'default'] }];
  for (const kind of ['brief', 'op-report', 'not-listed', undefined]) {
    expect(sendTelegramDirect('text', kind, {
      config: cfg,
      legacyEnv: () => { throw new Error('conatus must not be read'); },
      sendRaw: () => { throw new Error('must not send'); },
    })).toBe(false);
    log.mockClear();
  }
});

test('direct unknown kind with unavailable config never reads trading env', () => {
  const cfg = config();
  delete cfg.telegram.botToken;
  cfg.telegram.allowedUsers = [];
  delete cfg.telegram.homeChannel;
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(sendTelegramDirect('briefing', 'brief', {
      config: cfg,
      legacyEnv: () => { throw new Error('conatus must not be read'); },
      sendRaw: () => { throw new Error('must not send'); },
    })).toBe(false);
    expect(error).toHaveBeenCalled();
  } finally { error.mockRestore(); }
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
    { ts: new Date().toISOString(), kind: 'brief', text: 'briefing' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const previous = process.env.SEND_VIA_ELANOUS;
  process.env.SEND_VIA_ELANOUS = '1';
  setInProcessOutbound(async (_text, kind) => { kinds.push(kind); return true; });
  try {
    expect(flushDeferred(path)).toBe(3);
    expect(kinds).toEqual(['report', 'ops-report', 'brief']);
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

test('without a channels table, a main token equal to the report (trading) bot token is not an operations bot — operational kinds stop, nothing is sent', async () => {
  const cfg = { telegram: { enabled: true, botToken: trading, homeChannel: 101, allowedUsers: [102], reportChannel: { botToken: trading, chatId: 202 } } } as UserConfig;
  let sent = 0;
  const fetchImpl = (async (_url: RequestInfo | URL, _init?: RequestInit) => { sent++; return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  for (const kind of ['brief', 'ops-report', 'ops-alert', 'intake', undefined]) {
    expect(resolveReportTarget(cfg, kind)).toBeNull();
    expect(await sendTelegramReport(cfg, 'x', { kind, markdown: false, fetchImpl })).toBe(false);
  }
  expect(sent).toBe(0);
  // a trading kind still has no distinct report bot here → also not sent
  expect(await sendTelegramReport(cfg, 'x', { kind: 'report', markdown: false, fetchImpl })).toBe(false);
  expect(sent).toBe(0);
});

test('without a channels table, distinct tokens: every operational kind goes to the main bot home, every trading kind to the report bot', async () => {
  const calls: Array<{ url: string; chatId: number }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), chatId: JSON.parse(String(init?.body)).chat_id });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  for (const kind of Object.keys(DEFAULT_KIND_ROLES)) {
    calls.length = 0;
    expect(await sendTelegramReport(config(), 'x', { kind, markdown: false, fetchImpl })).toBe(true);
    const trading_ = ['report', 'alert', 'digest'].includes(kind);
    expect(calls).toEqual([{ url: `https://api.telegram.org/bot${trading_ ? trading : main}/sendMessage`, chatId: trading_ ? 202 : 101 }]);
  }
  // a kind missing from every table is operational — main home, never the trading bot
  calls.length = 0;
  expect(await sendTelegramReport(config(), 'x', { kind: 'not-in-any-table', markdown: false, fetchImpl })).toBe(true);
  expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${main}/sendMessage`);
});

// BRIEF-DELIVERY-1007 — the production shape: a channels table whose trading channel carries finance
// roles but not `report`, with the legacy reportChannel pointing at that same bot and chat.
test('channels table without a report role: the skip names the missing role, and adding it restores the old target', async () => {
  const cfg = config();
  cfg.telegram.channels = [
    { name: 'main', botToken: main, chatId: 101, interactive: true, roles: ['qa', 'default', 'system', 'mission', 'tuning'] },
    { name: 'conatus', botToken: trading, chatId: 202, interactive: false, roles: ['investment', 'finance', 'trade', 'signal'] },
  ];
  for (const kind of ['report', 'alert', 'digest']) {
    expect(resolveReportTarget(cfg, kind)).toBeNull();
    const why = explainReportRoute(cfg, kind);
    expect(why.reason).toBe('report-role-missing');
    expect(why.hint).toContain('telegram.channels[].roles');
  }
  expect(explainReportRoute(cfg, 'ops-report').reason).toBe('routed');

  log.mockClear();
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as unknown as typeof fetch;
  expect(await sendTelegramReport(cfg, '브리핑', { kind: 'report', fetchImpl })).toBe(false);
  const unrouted = log.mock.calls.filter(([c, e]) => c === 'telegram.report' && e === 'unrouted').map(([, , f]) => f);
  expect(unrouted).toEqual([{ kind: 'report', role: 'report', reason: 'report-role-missing' }]);

  cfg.telegram.channels[1]!.roles.push('report');
  for (const kind of ['report', 'alert', 'digest']) {
    expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: trading, chatId: 202 });
    expect(explainReportRoute(cfg, kind).reason).toBe('routed');
  }
});

test('explainReportRoute separates the legacy (no channels table) reasons', () => {
  expect(explainReportRoute(config(), 'report').reason).toBe('routed');
  expect(explainReportRoute(config(main), 'report').reason).toBe('report-bot-not-distinct');
  const badChat = config();
  badChat.telegram.reportChannel = { botToken: trading, chatId: Number.NaN };
  expect(resolveReportTarget(badChat, 'report')).toBeNull();
  expect(explainReportRoute(badChat, 'report').reason).toBe('report-chat-invalid');
  const none = config();
  delete none.telegram.reportChannel;
  expect(explainReportRoute(none, 'report').reason).toBe('no-report-channel');
  const homeless = { telegram: { enabled: true, botToken: main, allowedUsers: [] } } as unknown as UserConfig;
  expect(explainReportRoute(homeless, 'ops-report').reason).toBe('no-main-home');
  const table = config();
  table.telegram.channels = [{ name: 'trade', botToken: trading, chatId: 404, interactive: false, roles: ['report'] }];
  expect(explainReportRoute(table, 'brief').reason).toBe('no-role-channel');
});

test('a standalone report skip reaches logs.db as telegram.report unrouted (no token · no chat id · no body)', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, NODE_ENV: '', ELANOUS_STATE_DIR: join(repo, '.elanous-test'), ELANOUS_CONFIG_DIR: join(repo, '.elanous-test') };
  const run = (args: string[]) => spawnSync('bun', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  const probe = run(['src/telegram-report-log-probe.ts']);
  expect(probe.status).toBe(0);
  const start = /probe-start (\S+)/.exec(probe.stdout)?.[1];
  expect(start).toBeTruthy();
  const query = run(['bin/elanous.mjs', '--test', 'logs', '--category', 'telegram.report', '--event', 'unrouted', '--since', '10m', '--json', '--json-data']);
  expect(query.status).toBe(0);
  const rows = query.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    .filter(r => r.event === 'unrouted' && String(r.ts) >= start!);
  expect(rows).toHaveLength(1);
  expect(rows[0].data).toMatchObject({ kind: 'report', role: 'report', reason: 'report-role-missing' });
  for (const leak of ['private-secret', '98765', '98766', 'SECRET-BODY-DO-NOT-LOG']) expect(query.stdout).not.toContain(leak);
  // Control: the same probe without the entry-point sink leaves no row — the library itself registers nothing.
  const control = spawnSync('bun', ['src/telegram-report-log-probe.ts'], { cwd: repo, env: { ...env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000 });
  expect(control.status).toBe(0);
  const controlStart = /probe-start (\S+)/.exec(control.stdout)?.[1];
  expect(controlStart).toBeTruthy();
  const after = run(['bin/elanous.mjs', '--test', 'logs', '--category', 'telegram.report', '--event', 'unrouted', '--since', '10m', '--json', '--json-data']);
  expect(after.status).toBe(0);
  expect(after.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    .filter(r => r.event === 'unrouted' && String(r.ts) >= controlStart!)).toHaveLength(0);
}, 90_000);

test('telegram.report sent needs a Telegram message id; an empty answer is unconfirmed and an API error records nothing', async () => {
  const cfg = config();
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  const events = () => log.mock.calls.filter(([c]) => c === 'telegram.report').map(([, e, f]) => [e, f]);

  log.mockClear();
  expect(await sendTelegramReport(cfg, '보고', { kind: 'report', fetchImpl: answer({ ok: true, result: { message_id: 7, chat: { id: 202 } } }) })).toBe(true);
  expect(events()).toEqual([['sent', { kind: 'report', role: 'report', bot: 'configured', chars: 2 }]]);

  log.mockClear();
  for (const result of [{}, { message_id: null }, { message_id: '7' }, { message_id: 0 }]) {
    log.mockClear();
    expect(await sendTelegramReport(cfg, '보고', { kind: 'report', fetchImpl: answer({ ok: true, result }) })).toBe(false);
    expect(events().map(([e]) => e)).toEqual(['unconfirmed']);
  }

  log.mockClear();
  await expect(sendTelegramReport(cfg, '보고', { kind: 'report', fetchImpl: answer({ ok: false, error_code: 403, description: 'Forbidden' }) })).rejects.toThrow();
  expect(events()).toEqual([]);
  expect(JSON.stringify(log.mock.calls)).not.toContain('token-not-real');
});

