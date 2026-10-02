import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';
import {
  classifyDaemonResponse,
  deliver,
  type DaemonPathClass,
  FLUSH_LAG_WARN_MIN_ENV,
  flushDeferred,
  flushLagWarnMin,
  inQuietHours,
  kstMinutes,
  sendOutbound,
  setInProcessOutbound,
} from './outbound-alert.js';
import type { MissionOrigin } from '../autopilot/mission-origin.js';

const TOUCHED_ENV = [
  FLUSH_LAG_WARN_MIN_ENV,
  'SEND_VIA_ELANOUS',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'CONATUS_ENV',
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

type FlushObs = {
  event: string;
  data: Record<string, unknown>;
  level?: string;
};

function captureFlush(run: () => void): FlushObs[] {
  const seen: FlushObs[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data, opts) => {
    if (category === 'outbound.send' && event === 'flush') {
      seen.push({
        event,
        data: (data ?? {}) as Record<string, unknown>,
        level: opts && typeof opts === 'object' && 'level' in opts
          ? String((opts as { level?: string }).level)
          : undefined,
      });
    }
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return seen;
}

function writeQueue(dir: string, items: Array<{ ts: string; kind?: string; text?: string }>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'outbound_deferred.jsonl');
  const body = items.map((i) => JSON.stringify({
    ts: i.ts,
    kind: i.kind ?? 'alert',
    text: i.text ?? 'x',
  })).join('\n') + (items.length ? '\n' : '');
  writeFileSync(path, body);
  return path;
}

function isoAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

describe('flushDeferred 관측 — 경로 · 밀림 경고 등급', () => {
  const dirs: string[] = [];
  const envSnap = snapshotEnv(TOUCHED_ENV);

  beforeEach(() => {
    process.env.SEND_VIA_ELANOUS = '0';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    process.env.CONATUS_ENV = join(tmpdir(), 'outbound-alert-no-creds.env');
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  afterAll(() => {
    restoreEnv(envSnap);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'outbound-alert-'));
    dirs.push(d);
    return d;
  }

  it('임계보다 오래된 항목이 든 큐는 경고 등급 관측을 낸다', () => {
    process.env[FLUSH_LAG_WARN_MIN_ENV] = '60';
    expect(flushLagWarnMin()).toBe(60);
    const path = writeQueue(tmp(), [{ ts: isoAgo(90), kind: 'codex-rotate' }]);
    const seen = captureFlush(() => {
      flushDeferred(path);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data.path).toBe(path);
    expect(seen[0]!.data.count).toBe(1);
    expect(Number(seen[0]!.data.lagMin)).toBeGreaterThan(60);
    expect(seen[0]!.data.lagWarnMin).toBe(60);
    expect(seen[0]!.level).toBe('warn');
  });

  it('임계보다 젊은 항목만 든 큐는 경고 등급을 내지 않는다', () => {
    process.env[FLUSH_LAG_WARN_MIN_ENV] = '60';
    expect(flushLagWarnMin()).toBe(60);
    const path = writeQueue(tmp(), [{ ts: isoAgo(5), kind: 'codex-rotate' }]);
    const seen = captureFlush(() => {
      flushDeferred(path);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data.path).toBe(path);
    expect(seen[0]!.data.count).toBe(1);
    expect(Number(seen[0]!.data.lagMin)).toBeLessThan(60);
    expect(seen[0]!.level).not.toBe('warn');
  });

  it('큐가 없는 우주에서 0건과 해석된 경로를 같이 싣는다', () => {
    const path = join(tmp(), 'missing', 'outbound_deferred.jsonl');
    const seen = captureFlush(() => {
      const n = flushDeferred(path);
      expect(n).toBe(0);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data.count).toBe(0);
    expect(seen[0]!.data.path).toBe(path);
    expect(seen[0]!.level).not.toBe('warn');
  });

  it('야간 무음 창 판정은 그대로 00:00~06:30 KST 이다', () => {
    const quiet = new Date('2026-09-18T15:00:00Z');
    const open = new Date('2026-09-18T21:40:00Z');
    expect(kstMinutes(quiet)).toBe(0);
    expect(inQuietHours(quiet)).toBe(true);
    expect(inQuietHours(open)).toBe(false);
  });
});

type LogFn = typeof debug.log;
type Logged = { category: string; event: string; data: unknown };

const ENV_KEYS = ['SEND_VIA_ELANOUS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ELANOUS_TELEGRAM_BOT_TOKEN', 'ELANOUS_NEXUS_URL', 'ELANOUS_DISCORD_BOT_TOKEN'] as const;

const savedEnv: Record<string, string | undefined> = {};
const logged: Logged[] = [];
let originalLog: LogFn;
let curlSpy: ReturnType<typeof spyOn> | undefined;
let daemonBody: string | null | 'throw' = '{"delivered":true}';
let discordBody: string | null = '{"id":"posted"}';
const discordRequests: Array<{ url: string; body: string; headers: string[] }> = [];
const telegramUrls: string[] = [];
const telegramBodies: string[] = [];
const outboundUrls: string[] = [];

function daemonPathLogs(): Logged[] {
  return logged.filter((row) => row.category === 'outbound.send' && row.event === 'daemon-path');
}

function outcomeLogs(): Logged[] {
  return logged.filter((row) => row.category === 'outbound.send' && ['sent', 'deferred', 'failed'].includes(row.event));
}

function expectOutcome(event: 'sent' | 'deferred' | 'failed', text: string, kind: string): void {
  const rows = outcomeLogs();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event).toBe(event);
  expect(rows[0]!.data).toEqual({ kind, source: 'src/domains/outbound-alert.test.ts', chars: text.length });
  expect(JSON.stringify(rows[0]!.data)).not.toContain(text);
}

function captureConsole(run: () => void): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function linesWith(lines: string[], name: string): string[] {
  return lines.filter((line) => line.includes(name));
}

function classifications(): DaemonPathClass[] {
  return daemonPathLogs().map((row) => (row.data as { classification: DaemonPathClass }).classification);
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.SEND_VIA_ELANOUS;
  delete process.env.ELANOUS_NEXUS_URL;
  setResolveDaemonEndpointForTest(() => ({
    baseUrl: 'http://127.0.0.1:45678', healthUrl: 'http://127.0.0.1:45678/v1/health', pwaUrl: 'http://127.0.0.1:45678/app/', source: 'registry',
  }));
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token:dummy';
  process.env.TELEGRAM_CHAT_ID = '12345';
  logged.length = 0;
  telegramUrls.length = 0;
  telegramBodies.length = 0;
  outboundUrls.length = 0;
  discordRequests.length = 0;
  discordBody = '{"id":"posted"}';
  daemonBody = '{"delivered":true}';
  originalLog = debug.log.bind(debug) as LogFn;
  (debug as { log: LogFn }).log = ((category: string, event: string, data?: unknown) => {
    logged.push({ category, event, data });
  }) as LogFn;
  curlSpy = spyOn(childProcess, 'execFileSync').mockImplementation(((
    _cmd: string,
    args: readonly string[] | undefined,
    opts?: { input?: string },
  ) => {
    const url = String(args?.[args.length - 1] ?? '');
    if (url.includes('/v1/outbound')) {
      outboundUrls.push(url);
      if (daemonBody === 'throw') throw new Error('econnrefused');
      if (daemonBody === null) throw new Error('non-json');
      return daemonBody;
    }
    if (url.includes('api.telegram.org')) {
      telegramUrls.push(url);
      telegramBodies.push(opts?.input ?? '');
      return JSON.stringify({ ok: true });
    }
    if (url.startsWith('https://discord.com/api/v10/channels/')) {
      discordRequests.push({ url, body: opts?.input ?? '', headers: (args ?? []).flatMap((arg, i, all) => arg === '-H' ? [all[i + 1]!] : []) });
      return discordBody ?? 'not-json';
    }
    throw new Error(`unexpected curl ${url}`);
  }) as never);
});

afterEach(() => {
  setResolveDaemonEndpointForTest(null);
  setSystemTime();
  curlSpy?.mockRestore();
  curlSpy = undefined;
  (debug as { log: LogFn }).log = originalLog;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('sendOutbound outcome ledger', () => {
  const text = 'private-alert-body';
  const kind = 'ops-alert';
  const daytime = () => setSystemTime(new Date('2026-10-01T03:00:00Z'));

  beforeEach(() => {
    daytime();
    flushDeferred();
    logged.length = 0;
    outboundUrls.length = 0;
    telegramUrls.length = 0;
  });

  test('daemon success records one sent with source and length, never body', () => {
    expect(sendOutbound(text, kind)).toBe(true);
    expect(outboundUrls).toHaveLength(1);
    expectOutcome('sent', text, kind);
  });

  test('quiet hours record one deferred without transmitting', () => {
    setSystemTime(new Date('2026-10-01T16:00:00Z'));
    expect(sendOutbound(text, kind)).toBe(true);
    expect(outboundUrls).toHaveLength(0);
    expect(telegramUrls).toHaveLength(0);
    expectOutcome('deferred', text, kind);
  });

  test('daemon rejection and direct fallback failure record one failed', () => {
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    curlSpy?.mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
      const url = String(args?.[args.length - 1] ?? '');
      if (url.includes('/v1/outbound')) return daemonBody;
      throw new Error('telegram down');
    }) as never);
    expect(sendOutbound(text, kind)).toBe(false);
    expectOutcome('failed', text, kind);
  });

  test('direct fallback success records one sent after daemon rejection', () => {
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    expect(sendOutbound(text, kind)).toBe(true);
    expect(outboundUrls).toHaveLength(1);
    expect(telegramUrls).toHaveLength(1);
    expectOutcome('sent', text, kind);
  });

  test('origin success records one sent without report fanout', () => {
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-test-token';
    expect(sendOutbound(text, kind, { channel: 'discord', channelId: '123' })).toBe(true);
    expect(discordRequests).toHaveLength(1);
    expect(outboundUrls).toHaveLength(0);
    expectOutcome('sent', text, kind);
  });

  test('origin failure followed by daemon success still records one sent', () => {
    delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
    expect(sendOutbound(text, kind, { channel: 'discord', channelId: '123' })).toBe(true);
    expect(outboundUrls).toHaveLength(1);
    expectOutcome('sent', text, kind);
  });

  test('distinct origin surfaces in one host retain their sender names, not argv', () => {
    const argv = process.argv[1];
    process.argv[1] = '/tmp/shared-daemon.ts';
    try {
      expect(sendOutbound(text, kind, { channel: 'cli', surface: 'codex-quota-alert' })).toBe(true);
      expect(sendOutbound(text, kind, { channel: 'cli', surface: 'ops-health-check' })).toBe(true);
      expect(outcomeLogs().map(row => (row.data as { source: string }).source))
        .toEqual(['codex-quota-alert', 'ops-health-check']);
      expect(outcomeLogs().map(row => row.event)).toEqual(['sent', 'sent']);
      expect(outcomeLogs().every(row => !JSON.stringify(row.data).includes(text))).toBe(true);
    } finally { process.argv[1] = argv; }
  });

  test('callers with the same filename in different directories keep distinct source paths', () => {
    const realError = globalThis.Error;
    const errorSpy = spyOn(globalThis, 'Error');
    try {
      for (const path of ['/repo/src/alpha/index.ts', '/repo/src/beta/index.ts']) {
        errorSpy.mockImplementation((() => ({ stack: `Error\n    at sendOutbound (/repo/src/domains/outbound-alert.ts:258:18)\n    at producer (${path}:12:3)` })) as never);
        expect(sendOutbound(text, kind)).toBe(true);
      }
      const sources = outcomeLogs().map(row => (row.data as { source: string }).source);
      expect(sources).toHaveLength(2);
      expect(sources[0]).not.toBe(sources[1]);
      expect(sources[0]).toMatch(/src\/alpha\/index\.ts$/);
      expect(sources[1]).toMatch(/src\/beta\/index\.ts$/);
    } finally {
      errorSpy.mockRestore();
      globalThis.Error = realError;
    }
  });

  test('failed queue append records failed only, not deferred', () => {
    setSystemTime(new Date('2026-10-01T16:00:00Z'));
    const appendSpy = spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('queue unavailable'); });
    try {
      captureConsole(() => {
        expect(sendOutbound(text, kind, { channel: 'cli', surface: 'codex-quota-alert' })).toBe(true);
      });
      expect(outcomeLogs()).toHaveLength(1);
      expect(outcomeLogs()[0]!.event).toBe('failed');
      expect(outcomeLogs()[0]!.data).toEqual({ kind, source: 'codex-quota-alert', chars: text.length });
      expect(JSON.stringify(outcomeLogs()[0]!.data)).not.toContain(text);
      expect(outboundUrls).toHaveLength(0);
      expect(telegramUrls).toHaveLength(0);
    } finally { appendSpy.mockRestore(); }
  });
});

describe('origin delivery', () => {
  const discord = (thread?: string): MissionOrigin => ({ channel: 'discord', channelId: 'parent-123', ...(thread ? { discordThreadId: thread } : {}) });
  const daytime = () => setSystemTime(new Date('2026-10-01T03:00:00Z'));

  test('Discord channel and thread receive results with Bot authentication, without report fanout', () => {
    daytime();
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-test-token';
    expect(sendOutbound('channel result', 'alert', discord())).toBe(true);
    expect(sendOutbound('thread result', 'alert', discord('thread-456'))).toBe(true);
    expect(discordRequests.map(r => r.url)).toEqual([
      'https://discord.com/api/v10/channels/parent-123/messages',
      'https://discord.com/api/v10/channels/thread-456/messages',
    ]);
    expect(discordRequests.map(r => JSON.parse(r.body).content)).toEqual(['channel result', 'thread result']);
    expect(discordRequests[0]!.headers).toContain('Authorization: Bot discord-test-token');
    expect(discordRequests[0]!.headers).toContain('Content-Type: application/json');
    expect(outboundUrls).toEqual([]);
    expect(telegramUrls).toEqual([]);
  });

  test('Discord output exceeding 2000 characters is sent as separate messages', () => {
    daytime();
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-test-token';
    const text = 'x'.repeat(2100);
    expect(sendOutbound(text, 'alert', discord())).toBe(true);
    expect(discordRequests.map(r => JSON.parse(r.body).content)).toEqual(['x'.repeat(2000), 'x'.repeat(100)]);
  });

  test('Discord missing token and failed REST response fall back to report', () => {
    daytime();
    delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
    expect(sendOutbound('no token', 'alert', discord())).toBe(true);
    expect(discordRequests).toEqual([]);
    expect(outboundUrls).toHaveLength(1);
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-test-token';
    discordBody = '{"message":"Missing Access"}';
    expect(sendOutbound('failed send', 'alert', discord('thread-456'))).toBe(true);
    expect(discordRequests).toHaveLength(1);
    expect(outboundUrls).toHaveLength(2);
  });

  test('Telegram origin retains chat and forum thread routing', () => {
    daytime();
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'telegram-origin-test-token';
    const origin: MissionOrigin = { channel: 'telegram', chatId: 98765, threadId: 42 };
    expect(sendOutbound('telegram result', 'alert', origin)).toBe(true);
    expect(telegramUrls).toEqual(['https://api.telegram.org/bottelegram-origin-test-token/sendMessage']);
    const body = new URLSearchParams(telegramBodies[0]);
    expect(body.get('chat_id')).toBe('98765');
    expect(body.get('message_thread_id')).toBe('42');
    expect(body.get('text')).toContain('telegram result');
    expect(outboundUrls).toEqual([]);
  });

  test('deferred Discord origins group separately by thread, not just parent channel', () => {
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-test-token';
    const dir = mkdtempSync(join(tmpdir(), 'outbound-discord-'));
    try {
      const path = join(dir, 'outbound_deferred.jsonl');
      writeFileSync(path, [discord('thread-a'), discord('thread-b'), discord('thread-a')]
        .map((origin, i) => JSON.stringify({ ts: isoAgo(10), kind: 'alert', text: `result-${i}`, origin })).join('\n') + '\n');
      expect(flushDeferred(path)).toBe(3);
      expect(discordRequests.map(r => r.url)).toEqual([
        'https://discord.com/api/v10/channels/thread-a/messages',
        'https://discord.com/api/v10/channels/thread-b/messages',
      ]);
      expect(discordRequests[0]!.body).toContain('result-0');
      expect(discordRequests[0]!.body).toContain('result-2');
      expect(discordRequests[0]!.body).not.toContain('result-1');
      expect(discordRequests[1]!.body).toContain('result-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('classifyDaemonResponse', () => {
  test('네 응답이 ok / unauthorized / rejected / unreachable 로 갈린다', () => {
    const classes = [
      classifyDaemonResponse({ delivered: true }),
      classifyDaemonResponse({ error: 'unauthorized' }),
      classifyDaemonResponse({ error: 'missing-text' }),
      classifyDaemonResponse(null),
    ];
    expect(classes).toEqual(['ok', 'unauthorized', 'rejected', 'unreachable']);
    expect(new Set(classes).size).toBe(4);
  });

  test('unauthorized 와 unreachable 은 같은 값으로 접히지 않는다', () => {
    expect(classifyDaemonResponse({ error: 'unauthorized' })).toBe('unauthorized');
    expect(classifyDaemonResponse(null)).toBe('unreachable');
    expect(classifyDaemonResponse({ error: 'unauthorized' }))
      .not.toBe(classifyDaemonResponse(null));
  });
});

describe('deliver()', () => {
  test('delivered=true 는 daemon 을 반환하고 폴백하지 않는다', () => {
    daemonBody = JSON.stringify({ delivered: true });
    const stdout = captureConsole(() => {
      expect(deliver('hello', 'alert')).toBe('daemon');
    });
    expect(outboundUrls.length).toBe(1);
    expect(telegramUrls.length).toBe(0);
    expect(classifications()).toEqual([]);
    expect(linesWith(stdout, 'ok')).toEqual([]);
    expect(linesWith(stdout, 'unauthorized')).toEqual([]);
    expect(linesWith(stdout, 'rejected')).toEqual([]);
    expect(linesWith(stdout, 'unreachable')).toEqual([]);
  });

  test('네 데몬 응답이 deliver 경로에서 서로 다른 분류로 갈린다', () => {
    const seen: Record<string, string | false> = {};
    const stdout: Record<string, string[]> = {};

    daemonBody = JSON.stringify({ delivered: true });
    stdout.ok = captureConsole(() => {
      seen.ok = deliver('t', 'alert');
    });

    daemonBody = JSON.stringify({ error: 'unauthorized' });
    logged.length = 0;
    telegramUrls.length = 0;
    stdout.unauthorized = captureConsole(() => {
      seen.unauthorized = deliver('t', 'alert');
    });
    const unauthorizedClass = classifications()[0];

    daemonBody = JSON.stringify({ error: 'missing-text' });
    logged.length = 0;
    telegramUrls.length = 0;
    stdout.rejected = captureConsole(() => {
      seen.rejected = deliver('t', 'alert');
    });
    const rejectedClass = classifications()[0];

    daemonBody = null;
    logged.length = 0;
    telegramUrls.length = 0;
    stdout.unreachable = captureConsole(() => {
      seen.unreachable = deliver('t', 'alert');
    });
    const unreachableClass = classifications()[0];

    expect(seen.ok).toBe('daemon');
    expect([seen.unauthorized, seen.rejected, seen.unreachable]).toEqual(['direct', 'direct', 'direct']);
    expect([unauthorizedClass, rejectedClass, unreachableClass])
      .toEqual(['unauthorized', 'rejected', 'unreachable']);
    expect(new Set([unauthorizedClass, rejectedClass, unreachableClass, 'ok']).size).toBe(4);

    expect(linesWith(stdout.ok ?? [], 'ok')).toEqual([]);
    expect(linesWith(stdout.ok ?? [], 'unauthorized')).toEqual([]);
    expect(linesWith(stdout.ok ?? [], 'rejected')).toEqual([]);
    expect(linesWith(stdout.ok ?? [], 'unreachable')).toEqual([]);
    expect(linesWith(stdout.unauthorized ?? [], 'unauthorized')).toHaveLength(1);
    expect(linesWith(stdout.rejected ?? [], 'rejected')).toHaveLength(1);
    expect(linesWith(stdout.unreachable ?? [], 'unreachable')).toHaveLength(1);
    expect(linesWith(stdout.unauthorized ?? [], 'unauthorized')[0])
      .not.toBe(linesWith(stdout.rejected ?? [], 'rejected')[0]);
  });

  test('unauthorized 와 unreachable 이 deliver 관측에서 접히지 않는다', () => {
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    deliver('t', 'alert');
    const unauthorized = classifications()[0];

    logged.length = 0;
    daemonBody = 'throw';
    deliver('t', 'alert');
    const unreachable = classifications()[0];

    expect(unauthorized).toBe('unauthorized');
    expect(unreachable).toBe('unreachable');
    expect(unauthorized).not.toBe(unreachable);
  });

  test('실패 세 갈래 전부에서 폴백 sendTelegramDirect 가 호출된다', () => {
    const cases: Array<{ body: string | null | 'throw'; classification: DaemonPathClass }> = [
      { body: JSON.stringify({ error: 'unauthorized' }), classification: 'unauthorized' },
      { body: JSON.stringify({ error: 'missing-text' }), classification: 'rejected' },
      { body: null, classification: 'unreachable' },
    ];
    const namedLines: string[] = [];
    for (const c of cases) {
      telegramUrls.length = 0;
      logged.length = 0;
      daemonBody = c.body;
      const stdout = captureConsole(() => {
        const result = deliver('payload', 'alert');
        expect({ classification: c.classification, result, fallback: telegramUrls.length })
          .toEqual({ classification: c.classification, result: 'direct', fallback: 1 });
      });
      expect(classifications()).toEqual([c.classification]);
      const named = linesWith(stdout, c.classification);
      expect(named).toHaveLength(1);
      namedLines.push(named[0]!);
    }
    expect(new Set(namedLines).size).toBe(3);
  });

  test('unauthorized 와 unreachable 각각에서 분류 이름이 담긴 관측이 한 번씩 남는다', () => {
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    deliver('t', 'alert');
    daemonBody = 'throw';
    deliver('t', 'alert');

    const names = classifications();
    expect(names.filter((c) => c === 'unauthorized')).toEqual(['unauthorized']);
    expect(names.filter((c) => c === 'unreachable')).toEqual(['unreachable']);
    expect(names).toEqual(['unauthorized', 'unreachable']);
  });

  test('반환 계약은 daemon | direct | false 그대로다', () => {
    daemonBody = JSON.stringify({ delivered: true });
    expect(deliver('t')).toBe('daemon');

    daemonBody = JSON.stringify({ error: 'unauthorized' });
    expect(deliver('t')).toBe('direct');

    curlSpy?.mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
      const url = String(args?.[args.length - 1] ?? '');
      if (url.includes('/v1/outbound')) return JSON.stringify({ error: 'missing-text' });
      throw new Error('telegram down');
    }) as never);
    expect(deliver('t')).toBe(false);
  });

  test('SEND_VIA_ELANOUS=0 이면 데몬 경로를 건너뛰고 폴백만 탄다', () => {
    process.env.SEND_VIA_ELANOUS = '0';
    const result = deliver('t', 'alert');
    expect(result).toBe('direct');
    expect(outboundUrls.length).toBe(0);
    expect(telegramUrls.length).toBe(1);
    expect(daemonPathLogs()).toEqual([]);
  });

  test('관측이 실패해도 폴백 발송은 죽지 않는다', () => {
    (debug as { log: LogFn }).log = (() => {
      throw new Error('log-down');
    }) as LogFn;
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    expect(deliver('t', 'alert')).toBe('direct');
    expect(telegramUrls.length).toBe(1);
  });

  test('토큰·chatId 값을 로그에 넣지 않는다', () => {
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    const stdout = captureConsole(() => {
      deliver('t', 'alert');
    });
    const blob = JSON.stringify(daemonPathLogs()) + '\n' + stdout.join('\n');
    expect(blob).not.toContain('test-bot-token:dummy');
    expect(blob).not.toContain('12345');
    expect(blob).toContain('unauthorized');
  });

  test('ok 는 표준 출력에 분류 이름을 내지 않고 실패 세 갈래는 서로 다른 한 줄을 낸다', () => {
    daemonBody = JSON.stringify({ delivered: true });
    const okOut = captureConsole(() => {
      expect(deliver('t', 'alert')).toBe('daemon');
    });
    expect(telegramUrls.length).toBe(0);
    expect(linesWith(okOut, 'ok')).toHaveLength(0);
    expect(linesWith(okOut, 'unauthorized')).toHaveLength(0);
    expect(linesWith(okOut, 'rejected')).toHaveLength(0);
    expect(linesWith(okOut, 'unreachable')).toHaveLength(0);

    logged.length = 0;
    telegramUrls.length = 0;
    daemonBody = JSON.stringify({ error: 'unauthorized' });
    const unauthorizedOut = captureConsole(() => {
      expect(deliver('t', 'alert')).toBe('direct');
    });
    expect(telegramUrls.length).toBe(1);
    expect(classifications()).toEqual(['unauthorized']);
    expect(linesWith(unauthorizedOut, 'unauthorized')).toHaveLength(1);

    logged.length = 0;
    telegramUrls.length = 0;
    daemonBody = JSON.stringify({ error: 'missing-text' });
    const rejectedOut = captureConsole(() => {
      expect(deliver('t', 'alert')).toBe('direct');
    });
    expect(telegramUrls.length).toBe(1);
    expect(classifications()).toEqual(['rejected']);
    expect(linesWith(rejectedOut, 'rejected')).toHaveLength(1);

    logged.length = 0;
    telegramUrls.length = 0;
    daemonBody = null;
    const unreachableOut = captureConsole(() => {
      expect(deliver('t', 'alert')).toBe('direct');
    });
    expect(telegramUrls.length).toBe(1);
    expect(classifications()).toEqual(['unreachable']);
    expect(linesWith(unreachableOut, 'unreachable')).toHaveLength(1);

    const unauthorizedLine = linesWith(unauthorizedOut, 'unauthorized')[0]!;
    const rejectedLine = linesWith(rejectedOut, 'rejected')[0]!;
    const unreachableLine = linesWith(unreachableOut, 'unreachable')[0]!;
    expect(unauthorizedLine).not.toBe(rejectedLine);
    expect(rejectedLine).not.toBe(unreachableLine);
    expect(unauthorizedLine).not.toBe(unreachableLine);
  });

  test('데몬 주소는 해석기가 낸 주소다 — 31415 로 짐작하지 않는다', () => {
    daemonBody = JSON.stringify({ delivered: true });
    expect(deliver('t', 'alert')).toBe('daemon');
    expect(outboundUrls).toEqual(['http://127.0.0.1:45678/v1/outbound']);
  });

  test('ELANOUS_NEXUS_URL 이 있으면 해석기보다 먼저다', () => {
    process.env.ELANOUS_NEXUS_URL = 'http://127.0.0.1:31999';
    daemonBody = JSON.stringify({ delivered: true });
    expect(deliver('t', 'alert')).toBe('daemon');
    expect(outboundUrls).toEqual(['http://127.0.0.1:31999/v1/outbound']);
  });

  test('해석기가 null 이면 데몬에 쓰지 않고 직접 발송으로 간다', () => {
    setResolveDaemonEndpointForTest(() => null);
    daemonBody = JSON.stringify({ delivered: true });
    expect(deliver('t', 'alert')).toBe('direct');
    expect(outboundUrls).toEqual([]);
    expect(telegramUrls.length).toBe(1);
  });
});

describe('OB8 — inside the daemon, deliver never curls its own /v1/outbound', () => {
  afterEach(() => setInProcessOutbound(null));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('routes in-process and makes no curl to /v1/outbound (the CS1 freeze)', async () => {
    const calls: Array<[string, string]> = [];
    setInProcessOutbound(async (text, kind) => { calls.push([text, kind]); return true; });
    expect(deliver('seat-doc ready', 'report')).toBe('daemon');
    await settle();
    expect(calls).toEqual([['seat-doc ready', 'report']]);
    expect(outboundUrls).toEqual([]);
    expect(telegramUrls).toEqual([]);
    expect(daemonPathLogs().map((row) => row.data)).toEqual([{ classification: 'ok', kind: 'report', inProcess: true }]);
  });

  it('an in-process failure falls back to Telegram directly, still without a self-call', async () => {
    setInProcessOutbound(async () => false);
    expect(deliver('rotation alert', 'alert')).toBe('daemon');
    await settle();
    expect(outboundUrls).toEqual([]);
    expect(telegramUrls.length).toBe(1);
    expect(classifications()).toEqual(['rejected']);
    setInProcessOutbound(async () => { throw new Error('router down'); });
    deliver('rotation alert 2', 'alert');
    await settle();
    expect(outboundUrls).toEqual([]);
    expect(telegramUrls.length).toBe(2);
  });

  it('outside the daemon (nothing registered) the HTTP path is unchanged', () => {
    expect(deliver('cron report', 'report')).toBe('daemon');
    expect(outboundUrls.length).toBe(1);
  });
});

describe('OB8b — when nothing can deliver, say why instead of a silent false', () => {
  it('no daemon and no token: false, an undeliverable event with the universe, and one loud stderr line', () => {
    setResolveDaemonEndpointForTest(() => null);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const conatus = process.env.CONATUS_ENV;
    process.env.CONATUS_ENV = join(tmpdir(), 'outbound-alert-ob8b-no-creds.env');
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    try {
      expect(deliver('field-feed ready', 'report')).toBe(false);
    } finally {
      errorSpy.mockRestore();
      if (conatus === undefined) delete process.env.CONATUS_ENV; else process.env.CONATUS_ENV = conatus;
    }
    expect(outboundUrls).toEqual([]);
    const row = logged.find((r) => r.category === 'outbound.send' && r.event === 'undeliverable');
    expect(row?.data).toMatchObject({ kind: 'report', daemonPath: 'not-found' });
    expect(['prod', 'test']).toContain((row?.data as { universe: string }).universe);
    const loud = errors.find((line) => line.includes('⛔ 못 보냄(report)'));
    expect(loud).toBeDefined();
    expect(loud).toContain('데몬 not-found');
    expect(loud).toContain('우주 ');
  });

  it('a reachable daemon that refuses still reports the class it got', () => {
    daemonBody = '{"delivered":false}';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const conatus = process.env.CONATUS_ENV;
    process.env.CONATUS_ENV = join(tmpdir(), 'outbound-alert-ob8b-no-creds.env');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try { expect(deliver('x', 'alert')).toBe(false); } finally {
      errorSpy.mockRestore();
      if (conatus === undefined) delete process.env.CONATUS_ENV; else process.env.CONATUS_ENV = conatus;
    }
    expect(logged.find((r) => r.event === 'undeliverable')?.data).toMatchObject({ daemonPath: 'rejected' });
  });
});

