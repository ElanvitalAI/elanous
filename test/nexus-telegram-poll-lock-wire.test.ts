// 넥서스 Q&A 폴러 wire 의 토큰 잠금 — 잡히면 즉시, 잡혀 있으면 미뤘다가 늦게, 포기면 끝내 안 뜬다.
import { describe, expect, test } from 'bun:test';
import { wireNexusTelegramQaPollers, type NexusTelegramQaPollerWireDeps, type NexusTelegramQaPollerWireHandle } from '../src/nexus/index.js';
import type { NexusTelegramTriggerBotOpts } from '../src/nexus/api/telegram-trigger-bot.js';
import type { TelegramBot } from '../src/telegram.js';
import type { UserConfig } from '../src/user-config/types.js';

const A = '111:a';
const B = '222:b';
const cfg = {
  telegram: {
    enabled: true,
    botToken: A,
    allowedUsers: [1],
    channels: [
      { name: 'a', botToken: A, chatId: 1, interactive: true, roles: ['qa'] },
      { name: 'b', botToken: B, chatId: 1, interactive: true, roles: ['qa'] },
    ],
  },
} as unknown as UserConfig;

function baseDeps(created: string[], stopped: string[]): NexusTelegramQaPollerWireDeps {
  return {
    makeTelegramAgentRunTurn: () => (async () => ({ text: '' })) as never,
    resolveTelegramChannels: (t) => (t.channels ?? []) as never,
    interactivePollerTokens: (c) => c,
    createTriggerBot: (opts: NexusTelegramTriggerBotOpts) => {
      created.push(opts.token);
      return { bot: {} as TelegramBot, stop: async () => { stopped.push(opts.token); } };
    },
  };
}

const daemon = { dispatchTelegram: async () => [] };

describe('nexus telegram poller wire — token poll lock', () => {
  test('without pollLock the wire starts every poller at once (unchanged)', () => {
    const created: string[] = [];
    const handles = wireNexusTelegramQaPollers(cfg, daemon, baseDeps(created, []));
    expect(created).toEqual([A, B]);
    expect(handles).toHaveLength(2);
  });

  test('a held token is deferred, starts late through onLateStart, and releases its lock on stop', async () => {
    const created: string[] = [];
    const stopped: string[] = [];
    const released: string[] = [];
    let lateResolve!: (v: { ok: true; release: () => void }) => void;
    const late: NexusTelegramQaPollerWireHandle[] = [];
    const handles = wireNexusTelegramQaPollers(cfg, daemon, {
      ...baseDeps(created, stopped),
      pollLock: {
        tryAcquire: (token) => token === A ? { ok: true, release: () => released.push(A) } : { ok: false },
        acquire: () => new Promise((r) => { lateResolve = r; }),
      },
      onLateStart: (w) => late.push(w),
    });
    expect(handles.map((h) => h.channel.botToken)).toEqual([A]);
    expect(created).toEqual([A]);

    lateResolve({ ok: true, release: () => released.push(B) });
    await Promise.resolve(); await Promise.resolve();
    expect(created).toEqual([A, B]);
    expect(late.map((w) => w.channel.botToken)).toEqual([B]);

    await handles[0]!.handle.stop();
    await late[0]!.handle.stop();
    expect(stopped).toEqual([A, B]);
    expect(released).toEqual([A, B]);
  });

  test('a token whose lock is never freed never gets a poller', async () => {
    const created: string[] = [];
    const late: NexusTelegramQaPollerWireHandle[] = [];
    const handles = wireNexusTelegramQaPollers(cfg, daemon, {
      ...baseDeps(created, []),
      pollLock: { tryAcquire: () => ({ ok: false }), acquire: async () => ({ ok: false }) },
      onLateStart: (w) => late.push(w),
    });
    await Promise.resolve(); await Promise.resolve();
    expect(handles).toHaveLength(0);
    expect(late).toHaveLength(0);
    expect(created).toEqual([]);
  });
});
