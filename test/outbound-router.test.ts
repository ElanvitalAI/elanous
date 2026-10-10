// R6 Phase 1 — outbound fan-out router (PLAN-outbound-fanout §1).
// Covers: backward-compat resolution (no config → telegram only), per-kind
// routing, adapter payloads via fetchImpl mocks, per-channel fail-soft, and
// the source-level wire guard (outbound-report handler → routeOutbound —
// [[feedback_source_level_grep_test_value]] / dep-inject seam must be wired).

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePresence } from '../src/away/presence.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import {
  normalizeOutbound, resolveChannels, chunkForDiscord, routeOutbound,
} from '../src/nexus/outbound/router.js';
import { formatForChannel } from '../src/nexus/outbound/format.js';
import { openDeliveryDb, deliveryDedupKey, recentlyDelivered, recordDelivery, markRead, listUnread } from '../src/nexus/outbound/delivery-ledger.js';
import type { UserConfig } from '../src/user-config.js';

const cfgWith = (outbound: unknown): UserConfig =>
  ({ raw: outbound === undefined ? {} : { outbound } }) as unknown as UserConfig;

describe('normalizeOutbound', () => {
  test('absent / malformed → undefined (feature off)', () => {
    expect(normalizeOutbound(undefined)).toBeUndefined();
    expect(normalizeOutbound(null)).toBeUndefined();
    expect(normalizeOutbound('x')).toBeUndefined();
    expect(normalizeOutbound({})).toBeUndefined();
    expect(normalizeOutbound({ channels: 'nope' })).toBeUndefined();
    expect(normalizeOutbound({ channels: [] })).toBeUndefined();
  });

  test('drops non-actionable channels (discord w/o URL, pushcut w/o URL+name, unknown types)', () => {
    const out = normalizeOutbound({
      channels: [
        { type: 'telegram' },
        { type: 'discord' },                      // no webhookUrl → dropped
        { type: 'pushcut' },                      // no url/name → dropped
        { type: 'smoke-signal', webhookUrl: 'x' }, // unknown type → dropped
        { type: 'discord', webhookUrl: ' https://discord.com/api/webhooks/1/t ' },
        { type: 'pushcut', notification: 'elanous-outbound' },
      ],
      routes: { alert: ['telegram', 'pushcut'], junk: 'not-an-array' },
    });
    expect(out?.channels.map(c => c.type)).toEqual(['telegram', 'discord', 'pushcut']);
    expect(out?.channels[1]?.webhookUrl).toBe('https://discord.com/api/webhooks/1/t');
    expect(out?.routes).toEqual({ alert: ['telegram', 'pushcut'] });
  });
});

describe('resolveChannels', () => {
  const outbound = normalizeOutbound({
    channels: [
      { type: 'telegram' },
      { type: 'discord', webhookUrl: 'https://d/w' },
      { type: 'pushcut', webhookUrl: 'https://p/w' },
    ],
    routes: { alert: ['telegram', 'pushcut'], heartbeat: [], default: ['telegram', 'discord'] },
  });

  test('no config → telegram only (pre-R6 backward compat)', () => {
    expect(resolveChannels(undefined, 'report')).toEqual([{ type: 'telegram' }]);
  });

  test('kind route filters channels, preserving channel order', () => {
    expect(resolveChannels(outbound, 'alert').map(c => c.type)).toEqual(['telegram', 'pushcut']);
  });

  test('explicit empty route suppresses the kind', () => {
    expect(resolveChannels(outbound, 'heartbeat')).toEqual([]);
  });

  test('unrouted kind falls back to routes.default', () => {
    expect(resolveChannels(outbound, 'mystery').map(c => c.type)).toEqual(['telegram', 'discord']);
  });

  test('no routes at all → all channels', () => {
    const noRoutes = normalizeOutbound({ channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://d/w' }] });
    expect(resolveChannels(noRoutes, 'anything').map(c => c.type)).toEqual(['telegram', 'discord']);
  });
});

describe('chunkForDiscord', () => {
  test('short text passes through; long text splits on line boundaries under limit', () => {
    expect(chunkForDiscord('hi')).toEqual(['hi']);
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(60)}`);
    const chunks = chunkForDiscord(lines.join('\n'), 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  test('single oversized line hard-splits', () => {
    const chunks = chunkForDiscord('a'.repeat(4500), 2000);
    expect(chunks.map(c => c.length)).toEqual([2000, 2000, 500]);
  });
});

describe('routeOutbound', () => {
  const msg = { text: 'hello', markdown: false, kind: 'alert' };
  // 격리 — 각 호출에 fresh :memory: 배송원장(실 DB 미접촉·cross-test dedup 차단).
  const mem = () => openDeliveryDb(':memory:');

  test('no outbound config → telegram adapter only, delivered mirrors telegram', async () => {
    const calls: string[] = [];
    const r = await routeOutbound(cfgWith(undefined), msg, {
      telegramSend: async () => { calls.push('tg'); return true; }, deliveryDb: mem(),
    });
    expect(calls).toEqual(['tg']);
    expect(r.delivered).toBe(true);
    expect(r.channels).toEqual([{ type: 'telegram', ok: true }]);
  });

  test('unconfigured telegram → delivered:false with not-configured (503 path)', async () => {
    const r = await routeOutbound(cfgWith(undefined), msg, { telegramSend: async () => false, deliveryDb: mem() });
    expect(r.delivered).toBe(false);
    expect(r.channels[0]).toEqual({ type: 'telegram', ok: false, error: 'not-configured' });
  });

  test('fan-out posts discord + pushcut webhooks; one failure never blocks the rest', async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(url), body: String(init?.body ?? '') });
      // discord webhook fails; pushcut webhook succeeds
      return new Response('', { status: String(url).includes('discord') ? 500 : 200 });
    }) as unknown as typeof fetch;
    const r = await routeOutbound(cfgWith({
      channels: [
        { type: 'telegram' },
        { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' },
        { type: 'pushcut', webhookUrl: 'https://api.pushcut.io/x/notifications/y' },
      ],
    }), msg, { fetchImpl, telegramSend: async () => { throw new Error('tg down'); }, deliveryDb: mem() });

    expect(r.delivered).toBe(true); // pushcut succeeded
    expect(r.channels).toEqual([
      { type: 'telegram', ok: false, error: 'tg down' },
      { type: 'discord', ok: false, error: 'http-500' },
      { type: 'pushcut', ok: true },
    ]);
    // discord payload = {content}, pushcut payload = {title, text}
    const discordPost = posts.find(p => p.url.includes('discord'));
    expect(JSON.parse(discordPost!.body)).toEqual({ content: 'hello' });
    const pushcutPost = posts.find(p => p.url.includes('pushcut'));
    expect(JSON.parse(pushcutPost!.body)).toEqual({ title: 'elanous alert', text: 'hello' });
    // fail-soft errors never leak webhook URLs
    for (const c of r.channels) expect(c.error ?? '').not.toContain('webhooks');
  });

  test('롱콘텐츠 spill → 전 채널이 링크 버전 수신(단일 수렴점 공용)', async () => {
    const seen: Record<string, string> = {};
    const posts: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await routeOutbound(cfgWith({
      channels: [
        { type: 'telegram' },
        { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' },
      ],
    }), { text: 'X'.repeat(5000), markdown: true, kind: 'alert' }, {
      fetchImpl,
      telegramSend: async (_c, text) => { seen.tg = text; return true; },
      deliveryDb: mem(),
      spill: () => ({ text: '미리보기…\n\n📄 전체 5000자 · https://s3/spill/abc.txt', spilled: true, url: 'https://s3/spill/abc.txt' }),
    });
    expect(r.delivered).toBe(true);
    // telegram + discord 둘 다 링크 버전(원문 5000자 아님)
    expect(seen.tg).toContain('spill/abc.txt');
    expect(seen.tg!.length).toBeLessThan(200);
    const discordPost = posts.find(p => p.url.includes('discord'));
    expect(JSON.parse(discordPost!.body).content).toContain('spill/abc.txt');
  });

  test('spill 안 함(짧음) → 원문 그대로 전달', async () => {
    let got = '';
    await routeOutbound(cfgWith(undefined), { text: 'short', markdown: false, kind: 'alert' }, {
      telegramSend: async (_c, text) => { got = text; return true; },
      deliveryDb: mem(),
      spill: (t) => ({ text: t, spilled: false }),
    });
    expect(got).toBe('short');
  });

  test('same kind uses only away channel while away, original route again when home or presence unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-away-'));
    const path = join(root, 'presence.json');
    setElanousConfigDir(root);
    const calls: string[] = [];
    const cfg = cfgWith({
      channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
      routes: { alert: ['telegram'], report: ['telegram'] },
      awayRoutes: { alert: ['discord'] },
    });
    const deps = {
      telegramSend: async () => { calls.push('telegram'); return true; },
      fetchImpl: (async () => { calls.push('discord'); return new Response('', { status: 200 }); }) as unknown as typeof fetch,
      deliveryDb: mem(),
    };
    try {
      writePresence(true, 'cli', { path });
      const away = await routeOutbound(cfg, { ...msg, text: 'away' }, deps);
      expect(calls).toEqual(['discord']);
      expect(away.delivered).toBe(true);
      expect(away.channels).toEqual([{ type: 'discord', ok: true }]);
      const awayRecord = deps.deliveryDb.prepare('SELECT kind, channels FROM deliveries WHERE message_id = ?')
        .get(away.messageId!) as { kind: string; channels: string };
      expect(awayRecord).toEqual({ kind: 'alert', channels: JSON.stringify([{ type: 'discord', ok: true }]) });

      calls.length = 0;
      const legacy = await routeOutbound(cfgWith({
        channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
        routes: { alert: ['telegram'] },
      }), { ...msg, text: 'legacy' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(legacy.channels).toEqual([{ type: 'telegram', ok: true }]);

      calls.length = 0;
      const unmapped = await routeOutbound(cfg, { ...msg, kind: 'report', text: 'unmapped' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(unmapped.channels).toEqual([{ type: 'telegram', ok: true }]);

      calls.length = 0;
      const viaDefault = await routeOutbound(cfgWith({
        channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
        routes: { alert: ['telegram'], report: ['telegram'] },
        awayRoutes: { alert: ['telegram'], default: ['discord'] },
      }), { ...msg, kind: 'report', text: 'via-default' }, deps);
      expect(calls).toEqual(['discord']);
      expect(viaDefault.channels).toEqual([{ type: 'discord', ok: true }]);

      calls.length = 0;
      writePresence(false, 'cli', { path });
      const home = await routeOutbound(cfg, { ...msg, text: 'home' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(home.delivered).toBe(true);
      expect(home.channels).toEqual([{ type: 'telegram', ok: true }]);
      const homeRecord = deps.deliveryDb.prepare('SELECT kind, channels FROM deliveries WHERE message_id = ?')
        .get(home.messageId!) as { kind: string; channels: string };
      expect(homeRecord).toEqual({ kind: 'alert', channels: JSON.stringify([{ type: 'telegram', ok: true }]) });

      calls.length = 0;
      writeFileSync(path, '{invalid-json');
      const unreadable = await routeOutbound(cfg, { ...msg, text: 'unreadable' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(unreadable.channels).toEqual([{ type: 'telegram', ok: true }]);

      calls.length = 0;
      rmSync(path);
      const missing = await routeOutbound(cfg, { ...msg, text: 'missing' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(missing.channels).toEqual([{ type: 'telegram', ok: true }]);
    } finally {
      resetElanousConfigDir();
      deps.deliveryDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('same alert kind switches exclusively to awayRoutes and back without changing its message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-switch-'));
    const path = join(root, 'presence.json');
    const db = mem();
    const calls: string[] = [];
    const cfg = cfgWith({
      channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
      routes: { alert: ['telegram'] },
      awayRoutes: { alert: ['discord'] },
    });
    const deps = {
      telegramSend: async () => { calls.push('telegram'); return true; },
      fetchImpl: (async () => { calls.push('discord'); return new Response('', { status: 200 }); }) as unknown as typeof fetch,
      deliveryDb: db,
      dedup: false,
    };
    setElanousConfigDir(root);
    try {
      writePresence(false, 'cli', { path });
      const home = await routeOutbound(cfg, msg, deps);
      expect(home.channels).toEqual([{ type: 'telegram', ok: true }]);
      expect(calls).toEqual(['telegram']);

      calls.length = 0;
      writePresence(true, 'cli', { path });
      const away = await routeOutbound(cfg, msg, deps);
      expect(away.channels).toEqual([{ type: 'discord', ok: true }]);
      expect(calls).toEqual(['discord']);

      calls.length = 0;
      writePresence(false, 'cli', { path });
      const back = await routeOutbound(cfg, msg, deps);
      expect(back.channels).toEqual([{ type: 'telegram', ok: true }]);
      expect(calls).toEqual(['telegram']);
    } finally {
      resetElanousConfigDir();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pushcut API-key path uses injected notify with the configured name', async () => {
    const seen: Array<{ name: string; title: string }> = [];
    const r = await routeOutbound(cfgWith({
      channels: [{ type: 'pushcut', notification: 'elanous-outbound' }],
    }), { ...msg, kind: 'report' }, {
      pushcutNotify: async (name, payload) => { seen.push({ name, title: payload.title }); return { ok: true }; },
      deliveryDb: mem(),
    });
    expect(seen).toEqual([{ name: 'elanous-outbound', title: 'elanous report' }]);
    expect(r.delivered).toBe(true);
  });
});

describe('outbound handler wire (source-level)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src/nexus/api/outbound-report.ts'), 'utf-8');
  test('handleOutboundReport and routeOutboundInProcess call routeOutbound, preserving delivered', () => {
    expect(src).toMatch(/import\s*\{\s*routeOutbound\s*\}\s*from\s*['"][^'"]*outbound\/router/);
    // 함수 본문(선언부터 첫 최상위 `}` 까지)만 잘라 본다 — 다른 함수의 호출로 통과하지 않게.
    const body = (name: string): string => {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      return src.slice(start, src.indexOf('\n}\n', start));
    };
    expect(body('routeOutboundInProcess')).toMatch(/await routeOutbound\(cfg,/);
    expect(body('handleOutboundReport')).toMatch(/await routeOutbound\(cfg,/);
    expect(src).toMatch(/delivered: result\.delivered/);
  });
});

describe('발송 팬아웃 구조 — 포맷터 (채널별)', () => {
  test('formatForChannel — telegram/discord/pushcut 각기 다르게', () => {
    const msg = { text: 'a\n'.repeat(1500) + 'end', markdown: true, kind: 'alert' };
    const tg = formatForChannel('telegram', msg);
    expect(tg.markdown).toBe(true);
    const dc = formatForChannel('discord', msg);
    expect(dc.markdown).toBe(false);
    expect(dc.chunks!.length).toBeGreaterThan(1); // 2000자 분할
    const pc = formatForChannel('pushcut', { text: 'hi', markdown: false, kind: 'report' });
    expect(pc.title).toBe('elanous report');
  });
});

describe('발송 팬아웃 구조 — 중복 발사 제어 (dedup)', () => {
  test('같은 dedupKey 120s 내 재발송이면 억제(suppressed)', async () => {
    const db = openDeliveryDb(':memory:');
    const msg = { text: 'dup-body', markdown: false, kind: 'alert' };
    const cfg = { raw: {} } as unknown as UserConfig;
    const r1 = await routeOutbound(cfg, msg, { telegramSend: async () => true, deliveryDb: db });
    expect(r1.suppressed).toBeUndefined(); // 1차 발송
    const r2 = await routeOutbound(cfg, msg, { telegramSend: async () => true, deliveryDb: db });
    expect(r2.suppressed).toBe(true);       // 2차 억제
    expect(r2.delivered).toBe(true);        // 수락(재시도 루프 방지)
  });
  test('dedup:false면 억제 안 함', async () => {
    const db = openDeliveryDb(':memory:');
    const msg = { text: 'nodup', markdown: false, kind: 'alert' };
    const cfg = { raw: {} } as unknown as UserConfig;
    await routeOutbound(cfg, msg, { telegramSend: async () => true, deliveryDb: db });
    const r2 = await routeOutbound(cfg, msg, { telegramSend: async () => true, deliveryDb: db, dedup: false });
    expect(r2.suppressed).toBeUndefined();
  });
});

describe('발송 팬아웃 구조 — 크로스채널 리드 동기화', () => {
  test('markRead가 messageId/dedupKey로 전체 read 처리', () => {
    const db = openDeliveryDb(':memory:');
    const key = deliveryDedupKey('alert', 'read me');
    recordDelivery(db, { messageId: 'm1', kind: 'alert', dedupKey: key, text: 'read me', channels: [{ type: 'telegram', ok: true }, { type: 'discord', ok: true }] });
    expect(listUnread(db).length).toBe(1);
    const n = markRead(db, 'm1', 'telegram'); // 한 채널에서 읽음
    expect(n).toBe(1);
    expect(listUnread(db).length).toBe(0);    // 전체 read
  });
  test('recentlyDelivered 창 밖은 통과', () => {
    const db = openDeliveryDb(':memory:');
    recordDelivery(db, { messageId: 'old', kind: 'alert', dedupKey: 'k', text: 't', channels: [], ts: '2020-01-01T00:00:00Z' });
    expect(recentlyDelivered(db, 'k', 120)).toBe(false); // 오래됨
  });
});

describe('away mode respects role routes', () => {
  test('away route never widens the channels a role is allowed to reach', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-away-role-'));
    const path = join(root, 'presence.json');
    setElanousConfigDir(root);
    const calls: string[] = [];
    const cfg = cfgWith({
      channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
      routes: { alert: ['telegram'] },
      roleRoutes: { OP: ['telegram'] },
      awayRoutes: { alert: ['telegram', 'discord'] },
    });
    const deps = {
      telegramSend: async () => { calls.push('telegram'); return true; },
      fetchImpl: (async () => { calls.push('discord'); return new Response('', { status: 200 }); }) as unknown as typeof fetch,
      deliveryDb: openDeliveryDb(':memory:'), dedup: false,
    };
    try {
      writePresence(true, 'cli', { path });
      const op = await routeOutbound(cfg, { text: 'op away', markdown: false, kind: 'alert', role: 'OP' }, deps);
      expect(calls).toEqual(['telegram']);
      expect(op.channels).toEqual([{ type: 'telegram', ok: true }]);
      calls.length = 0;
      const silenced = await routeOutbound(cfgWith({
        channels: [{ type: 'telegram' }, { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/t' }],
        routes: { alert: ['telegram'] }, roleRoutes: { OP: [] }, awayRoutes: { alert: ['telegram', 'discord'] },
        primary: { OP: 'telegram' }, fallback: { OP: 'discord' },
      }), { text: 'silenced role away', markdown: false, kind: 'alert', role: 'OP' }, deps);
      expect(silenced.channels).toEqual([]);
      expect(silenced.delivered).toBe(false);
      expect(calls).toEqual([]);
      calls.length = 0;
      const plain = await routeOutbound(cfg, { text: 'plain away', markdown: false, kind: 'alert' }, deps);
      expect(calls.sort()).toEqual(['discord', 'telegram']);
      expect(plain.channels).toHaveLength(2);
    } finally {
      resetElanousConfigDir();
      deps.deliveryDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
