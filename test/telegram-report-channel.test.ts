// Unit tests for the Telegram report channel (multi-channel split, 2026-07-05).
//
// Covers: config parse/serialize of telegram.reportChannel, target
// resolution (own bot token vs fallback to the main Q&A token), and the
// send-only sender's actual API call (via injected fetch — no network).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUserConfig, saveUserConfig, type UserConfig } from '../src/user-config.js';
import { resolveReportTarget, sendTelegramReport, sendReportPhoto, sendReportPhotoBuffer } from '../src/telegram-report.js';
import { findSessionByTelegramChat, loadSession } from '../src/session/index.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../src/dashboard/slash-runtime/index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-report-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeCfg(telegram: Record<string, unknown>): string {
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({ telegram }), 'utf-8');
  return p;
}

describe('config parse/serialize · telegram.testChannel', () => {
  test('parses testChannel with botToken + allowedUsers', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok',
      testChannel: { botToken: '8724930076:TEST', allowedUsers: [1301607555] },
    }));
    expect(cfg.telegram.testChannel).toEqual({ botToken: '8724930076:TEST', allowedUsers: [1301607555] });
  });

  test('parses testChannel with just a botToken (allowlist falls back at runtime)', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok', testChannel: { botToken: '8724930076:TEST' },
    }));
    expect(cfg.telegram.testChannel).toEqual({ botToken: '8724930076:TEST' });
  });

  test('drops a testChannel with no botToken → undefined (feature off)', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok', testChannel: { allowedUsers: [1] },
    }));
    expect(cfg.telegram.testChannel).toBeUndefined();
  });

  test('round-trips through saveUserConfig', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok',
      testChannel: { botToken: 'T:tok', allowedUsers: [7] },
    }));
    const out = join(dir, 'out-test.json');
    saveUserConfig(cfg, out);
    const stored = JSON.parse(readFileSync(out, 'utf-8'));
    expect(stored.telegram.testChannel).toEqual({ botToken: 'T:tok', allowedUsers: [7] });
  });
});

describe('config parse/serialize · telegram.poller (T1 split switch)', () => {
  test('round-trips standalone through saveUserConfig (was dropped by the serializer whitelist)', () => {
    const cfg = buildUserConfig(writeCfg({ enabled: true, botToken: 'MAIN:tok', poller: 'standalone' }));
    const out = join(dir, 'out-poller.json');
    saveUserConfig(cfg, out);
    expect(JSON.parse(readFileSync(out, 'utf-8')).telegram.poller).toBe('standalone');
    expect(buildUserConfig(out).telegram.poller).toBe('standalone');
  });
  test('an unknown poller value is not invented on save', () => {
    const cfg = buildUserConfig(writeCfg({ enabled: true, botToken: 'MAIN:tok', poller: 'bogus' }));
    const out = join(dir, 'out-poller2.json');
    saveUserConfig(cfg, out);
    expect(JSON.parse(readFileSync(out, 'utf-8')).telegram.poller).toBeUndefined();
  });
});

describe('config parse/serialize · telegram.reportChannel', () => {
  test('parses reportChannel with its own bot token', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok',
      reportChannel: { chatId: 1301607555, botToken: 'REPORT:tok' },
    }));
    expect(cfg.telegram.reportChannel).toEqual({ chatId: 1301607555, botToken: 'REPORT:tok' });
  });

  test('parses reportChannel without a bot token (reuses main bot)', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok', reportChannel: { chatId: 42 },
    }));
    expect(cfg.telegram.reportChannel).toEqual({ chatId: 42 });
  });

  test('drops malformed reportChannel (no chatId) → undefined', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok', reportChannel: { botToken: 'X:tok' },
    }));
    expect(cfg.telegram.reportChannel).toBeUndefined();
  });

  test('round-trips through saveUserConfig', () => {
    const cfg = buildUserConfig(writeCfg({
      enabled: true, botToken: 'MAIN:tok',
      reportChannel: { chatId: 99, botToken: 'R:tok' },
    }));
    const out = join(dir, 'out.json');
    saveUserConfig(cfg, out);
    const stored = JSON.parse(readFileSync(out, 'utf-8'));
    expect(stored.telegram.reportChannel).toEqual({ chatId: 99, botToken: 'R:tok' });
  });
});

function cfgWith(telegram: Partial<UserConfig['telegram']>): UserConfig {
  return { telegram: { enabled: true, allowedUsers: [], ...telegram } } as unknown as UserConfig;
}

// OUT1 (#23137): only named finance kinds (report · alert · digest) use the legacy report bot;
// an unnamed kind is an operations message and goes to the main bot's home chat.
describe('resolveReportTarget', () => {
  test('a finance kind uses the report channel own token when set', () => {
    const t = resolveReportTarget(cfgWith({ botToken: 'MAIN', reportChannel: { chatId: 5, botToken: 'REPORT' } }), 'report');
    expect(t).toEqual({ botToken: 'REPORT', chatId: 5 });
  });

  test('a finance kind never falls back to the main bot when reportChannel has no token of its own', () => {
    expect(resolveReportTarget(cfgWith({ botToken: 'MAIN', reportChannel: { chatId: 7 } }), 'report')).toBeNull();
  });

  test('an unnamed kind goes to the main bot home chat, not the report bot', () => {
    const t = resolveReportTarget(cfgWith({ botToken: 'MAIN', homeChannel: 9, reportChannel: { chatId: 5, botToken: 'REPORT' } }));
    expect(t).toEqual({ botToken: 'MAIN', chatId: 9 });
  });

  test('null when no reportChannel configured', () => {
    expect(resolveReportTarget(cfgWith({ botToken: 'MAIN' }))).toBeNull();
  });

  test('null when no token available anywhere', () => {
    expect(resolveReportTarget(cfgWith({ reportChannel: { chatId: 7 } }))).toBeNull();
  });
});

describe('sendTelegramReport', () => {
  test('POSTs to the report bot token + chat, returns true', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }) as unknown as typeof fetch;

    const ok = await sendTelegramReport(
      cfgWith({ botToken: 'MAIN:tok', reportChannel: { chatId: 1301607555, botToken: 'REPORT:tok' } }),
      'daily digest',
      { markdown: false, fetchImpl: fetchMock, kind: 'report' },
    );
    expect(ok).toBe(true);
    const send = calls.find(c => c.url.includes('/sendMessage'));
    expect(send).toBeDefined();
    expect(send!.url).toContain('botREPORT:tok');       // report bot token, not main
    expect(send!.body.chat_id).toBe(1301607555);
    expect(send!.body.text).toContain('daily digest');
  });

  test('no-op (false) when no report channel configured', async () => {
    const ok = await sendTelegramReport(cfgWith({ botToken: 'MAIN:tok' }), 'x', {});
    expect(ok).toBe(false);
  });

  // Fix 2 — cross-surface memory: the alert is mirrored into the REPORT
  // channel's bot-scoped session so a follow-up in that chat can recall it
  // (was surface_events-only, session_id NULL → wrong/no answer).
  test('mirrors the alert into the report channel bot-scoped session', async () => {
    const prev = process.env.ELANOUS_SESSION_ROOT;
    process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
    try {
      const fetchMock = (async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) })) as unknown as typeof fetch;
      const alert = '⚠️ 자율매매 국면 브레이크 — RISK_ON 전환. elanous가 이 알림을 기억합니다.';
      await sendTelegramReport(
        cfgWith({ botToken: 'MAIN:tok', reportChannel: { chatId: 1301607555, botToken: 'REPORT:tok' } }),
        alert,
        { markdown: false, fetchImpl: fetchMock, kind: 'alert' },
      );
      // Landed in the REPORT bot's session (botId = token prefix 'REPORT')…
      const sess = findSessionByTelegramChat(1301607555, undefined, 'REPORT');
      expect(sess).not.toBeNull();
      const loaded = loadSession(sess!.id);
      expect(loaded!.messages.some(m => m.role === 'assistant' && m.content.includes('국면 브레이크'))).toBe(true);
      // …NOT the default/main bot's session (bot-scoped isolation).
      expect(findSessionByTelegramChat(1301607555, undefined, 'MAIN')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = prev;
    }
  });
});

// The report slash must reach the injected sender only for a configured target.
describe('/telegram report wire', () => {
  function context(lines: string[], telegramReport: NonNullable<DashboardSlashContext['telegramReport']>): DashboardSlashContext {
    const identity = (line: string) => line;
    return {
      chatLines: lines,
      telegramReport,
      warning: identity,
      success: identity,
      error: identity,
      setChatScrollOffset: () => {},
    } as unknown as DashboardSlashContext;
  }

  test('report subcommand dispatches the exact message once to the report sender', async () => {
    const lines: string[] = [];
    const cfg = cfgWith({ botToken: 'MAIN:tok', homeChannel: 42, reportChannel: { chatId: 7, botToken: 'REPORT:tok' } });
    const sends: Array<{ cfg: UserConfig; text: string }> = [];
    const registry = buildDashboardSlashRegistry();
    const report = {
      getConfig: () => cfg,
      send: async (sentCfg: UserConfig, text: string) => { sends.push({ cfg: sentCfg, text }); return true; },
    };
    expect(registry.names()).toContain('telegram');
    expect(await registry.dispatch('telegram', ['report', 'daily', 'digest'], context(lines, report)))
      .toEqual({ kind: 'continue' });
    expect(sends).toHaveLength(1);
    expect(sends).toEqual([{ cfg, text: 'daily digest' }]);
    expect(lines).toContain('  ✓ report sent to chat 42');
  });

  test('report subcommand gates on a configured target', async () => {
    const lines: string[] = [];
    const sends: string[] = [];
    const registry = buildDashboardSlashRegistry();
    const report = {
      getConfig: () => cfgWith({ botToken: 'MAIN:tok' }),
      send: async (_cfg: UserConfig, text: string) => { sends.push(text); return true; },
    };
    expect(await registry.dispatch('telegram', ['report', 'daily digest'], context(lines, report)))
      .toEqual({ kind: 'continue' });
    expect(sends).toEqual([]);
    expect(lines).toContain('  No report channel — set telegram.reportChannel.chatId (+ optional botToken) in config.');
  });
});

describe('sendReportPhoto (URL)', () => {
  test('POSTs sendPhoto with the URL and caption', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 2 } }) };
    }) as unknown as typeof fetch;

    const ok = await sendReportPhoto(
      cfgWith({ botToken: 'MAIN:tok', reportChannel: { chatId: 1301607555, botToken: 'REPORT:tok' } }),
      'https://example.test/heat.png',
      { caption: 'url photo', fetchImpl: fetchMock, kind: 'report' },
    );
    expect(ok).toBe(true);
    const send = calls.find(c => c.url.includes('/sendPhoto'));
    expect(send).toBeDefined();
    expect(send!.url).toContain('botREPORT:tok');
    expect(send!.body.chat_id).toBe(1301607555);
    expect(send!.body.photo).toBe('https://example.test/heat.png');
    expect(send!.body.caption).toBe('url photo');
  });
});

describe('sendReportPhotoBuffer', () => {
  test('uploads via TelegramBot.sendPhotoBuffer(chatId, png, { caption })', async () => {
    const calls: Array<{ url: string; body: FormData }> = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url: String(url), body: init.body });
      return { json: async () => ({ ok: true, result: { message_id: 3 } }) };
    }) as unknown as typeof fetch;
    const png = Buffer.from('local-png-bytes');

    const ok = await sendReportPhotoBuffer(
      cfgWith({ botToken: 'MAIN:tok', reportChannel: { chatId: 42, botToken: 'REPORT:tok' } }),
      png,
      { caption: 'digest png', fetchImpl: fetchMock, kind: 'report' },
    );
    expect(ok).toBe(true);
    const send = calls.find(c => c.url.includes('/sendPhoto'));
    expect(send).toBeDefined();
    expect(send!.url).toContain('botREPORT:tok');
    expect(String(send!.body.get('chat_id'))).toBe('42');
    expect(String(send!.body.get('caption'))).toBe('digest png');
    const photo = send!.body.get('photo');
    expect(photo).toBeInstanceOf(Blob);
  });

  test('no-op (false) when no report channel configured', async () => {
    const ok = await sendReportPhotoBuffer(cfgWith({ botToken: 'MAIN:tok' }), Buffer.from('x'));
    expect(ok).toBe(false);
  });
});

describe('purpose kind → channel role (explicit channels)', () => {
  const tg = {
    enabled: true, botToken: 'MAIN:tok',
    reportChannel: { chatId: 222, botToken: 'CONATUS:tok' },
    channels: [
      { name: 'main', botToken: 'MAIN:tok', chatId: 111, interactive: true, roles: ['qa', 'default', 'system', 'mission'] },
      { name: 'conatus', botToken: 'CONATUS:tok', chatId: 222, interactive: true, roles: ['report', 'investment', 'signal'] },
    ],
  };

  test('intake · ops · unnamed kinds go to the operations channel; report/alert go to the report-role channel', () => {
    const cfg = buildUserConfig(writeCfg(tg));
    for (const kind of [undefined, 'intake', 'ops-report', 'ops-alert', 'ops-health']) expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: 'MAIN:tok', chatId: 111 });
    for (const kind of ['report', 'alert']) expect(resolveReportTarget(cfg, kind)).toEqual({ botToken: 'CONATUS:tok', chatId: 222 });
  });

  test('telegram.kindRoles is parsed, but an override cannot move a kind across the operations/trading bot line (OUT1)', () => {
    const cfg = buildUserConfig(writeCfg({ ...tg, kindRoles: { intake: 'investment', report: 'system', bad: 3 } }));
    expect(cfg.telegram.kindRoles).toEqual({ intake: 'investment', report: 'system' });
    expect(resolveReportTarget(cfg, 'intake')).toEqual({ botToken: 'MAIN:tok', chatId: 111 });
    expect(resolveReportTarget(cfg, 'report')).toEqual({ botToken: 'CONATUS:tok', chatId: 222 });
  });

  test('without explicit channels a purpose kind goes to the main home and a finance kind keeps the legacy report channel', () => {
    const { channels: _c, ...legacy } = tg;
    const cfg = buildUserConfig(writeCfg({ ...legacy, homeChannel: 111 }));
    expect(resolveReportTarget(cfg, 'intake')).toEqual({ botToken: 'MAIN:tok', chatId: 111 });
    expect(resolveReportTarget(cfg, 'report')).toEqual({ botToken: 'CONATUS:tok', chatId: 222 });
  });

  test('sendTelegramReport with kind posts to the role channel bot', async () => {
    const cfg = buildUserConfig(writeCfg(tg));
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => { urls.push(`${url} ${String(init?.body ?? '')}`); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); }) as unknown as typeof fetch;
    expect(await sendTelegramReport(cfg, 'hello', { kind: 'intake', fetchImpl, markdown: false })).toBe(true);
    expect(urls.some((u) => u.includes('/botMAIN:tok/sendMessage') && u.includes('111'))).toBe(true);
    expect(urls.some((u) => u.includes('CONATUS'))).toBe(false);
  });
});
