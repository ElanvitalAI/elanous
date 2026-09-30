// NEXUS Discord HITL channel wire-up — β-1c · 2026-05-08.
//
// Mirrors `nexus-hitl-telegram-channel.test.ts`. The Discord channel
// uses INTERACTION_CREATE button taps where Telegram uses
// callback_query, but both share the same race semantics + the
// shared `/v1/hitl/callback/:id` resolver.
//
// What this file proves:
//   1. Env reader parses ELANOUS_DISCORD_HITL_BOT_TOKEN +
//      ELANOUS_DISCORD_HITL_CHANNEL_ID; missing → null.
//   2. Factory skips when token / channelId missing.
//   3. Factory with prebuilt bot returns a handle whose channel
//      is named 'discord'.
//   4. runNexus({ discordHitlOpts }) registers a 'discord' channel.
//   5. skipDiscordChannel:true forces skip even with opts.
//   6. release() unregisters all sibling channels including discord.
//   7. Four sibling channels coexist (pushcut + pwa + telegram +
//      discord) when all configured.
//
// Real Discord gateway connection is out of scope; the existing
// `test/hitl-discord-channel.test.ts` covers the customId parser
// + onButtonClick path with a fake DiscordBot interface.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import {
  getDefaultConfirmChannels,
  registerDefaultConfirmChannels,
} from '../src/hitl/confirm.js';
import {
  createNexusDiscordHitlHandle,
  readNexusDiscordHitlOptsFromEnv,
} from '../src/nexus/api/hitl-discord-channel.js';
import { DiscordBot } from '../src/discord.js';
import { TelegramBot } from '../src/telegram.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-hitl-dc-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.HOME = tmpRoot;
  setIntakeStoreForTest(createIntakeStore({ archiveDir: null, replayOnInit: false }));
  registerDefaultConfirmChannels([]);
});

afterEach(async () => {
  if (activeHandle) {
    try { activeHandle.release(); } catch { /* swallow */ }
    activeHandle = undefined;
  }
  if (prevNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexusDir;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  setIntakeStoreForTest(null);
  registerDefaultConfirmChannels([]);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

function uniquePort(): number {
  return 57000 + Math.floor(Math.random() * 2000);
}

function makeStubDiscordBot(): DiscordBot {
  // Fake fetch + WebSocket so DiscordBot construction doesn't try
  // to network. The bot's start() is never called in tests
  // (factory's `botWasInjected` guard skips it).
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ id: '1' }), { status: 200 })
  ) as unknown as typeof fetch;
  const fakeWs = class FakeWebSocket {
    constructor() { /* no-op */ }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  } as unknown as typeof WebSocket;
  return new DiscordBot({
    token: 'stub:123',
    allowedUsers: [],
    onMessage: async () => undefined,
    fetchImpl: fakeFetch,
    wsImpl: fakeWs,
  });
}

function makeStubTelegramBot(): TelegramBot {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
  ) as unknown as typeof fetch;
  return new TelegramBot({
    token: 'stub:123',
    allowedUsers: [],
    onMessage: async () => undefined,
    fetchImpl: fakeFetch,
  });
}

async function bootNexus(extra: Parameters<typeof runNexus>[0] = {}): Promise<RunNexusHandle> {
  const handle = await runNexus({
    detachForTesting: true,
    skipHttpServer: true,
    skipRuntimeApi: false,
    skipSupervisor: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    httpStartPort: uniquePort(),
    voiceAdapter: createStubPwaVoiceAdapter(),
    toolCwd: tmpRoot,
    ...extra,
  });
  if (!handle) throw new Error('runNexus returned undefined');
  activeHandle = handle;
  return handle;
}

describe('readNexusDiscordHitlOptsFromEnv', () => {
  test('parses both env vars when set', () => {
    expect(
      readNexusDiscordHitlOptsFromEnv({
        ELANOUS_DISCORD_HITL_BOT_TOKEN: 'abc',
        ELANOUS_DISCORD_HITL_CHANNEL_ID: '987654321',
      }),
    ).toEqual({ token: 'abc', channelId: '987654321' });
  });

  test('returns null when token missing', () => {
    expect(readNexusDiscordHitlOptsFromEnv({ ELANOUS_DISCORD_HITL_CHANNEL_ID: '1' })).toBeNull();
  });

  test('returns null when channelId missing', () => {
    expect(readNexusDiscordHitlOptsFromEnv({ ELANOUS_DISCORD_HITL_BOT_TOKEN: 'abc' })).toBeNull();
  });

  test('returns null when both missing', () => {
    expect(readNexusDiscordHitlOptsFromEnv({})).toBeNull();
  });
});

describe('createNexusDiscordHitlHandle', () => {
  test('returns null when token empty', () => {
    expect(
      createNexusDiscordHitlHandle({ token: '', channelId: '1', bot: makeStubDiscordBot() }),
    ).toBeNull();
  });

  test('returns null when channelId empty', () => {
    expect(
      createNexusDiscordHitlHandle({ token: 't', channelId: '', bot: makeStubDiscordBot() }),
    ).toBeNull();
  });

  test('returns a handle whose channel name is "discord"', () => {
    const h = createNexusDiscordHitlHandle({
      token: 't',
      channelId: '1',
      bot: makeStubDiscordBot(),
    });
    expect(h).not.toBeNull();
    expect(h!.channel.name).toBe('discord');
  });

  test('stop() is idempotent', async () => {
    const h = createNexusDiscordHitlHandle({
      token: 't',
      channelId: '1',
      bot: makeStubDiscordBot(),
    });
    await h!.stop();
    await expect(h!.stop()).resolves.toBeUndefined();
  });
});

describe('runNexus discord channel integration', () => {
  test('default boot (no env) does NOT register discord', async () => {
    await bootNexus();
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('discord');
  });

  test('discordHitlOpts injected → channel registers with name "discord"', async () => {
    await bootNexus({
      discordHitlOpts: { token: 't', channelId: '1', bot: makeStubDiscordBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).toContain('discord');
  });

  test('skipDiscordChannel:true skips even with opts injected', async () => {
    await bootNexus({
      skipDiscordChannel: true,
      discordHitlOpts: { token: 't', channelId: '1', bot: makeStubDiscordBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('discord');
  });

  test('release() unregisters discord along with siblings', async () => {
    const h = await bootNexus({
      discordHitlOpts: { token: 't', channelId: '1', bot: makeStubDiscordBot() },
    });
    expect(getDefaultConfirmChannels().map((c) => c.name)).toContain('discord');
    h.release();
    activeHandle = undefined;
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('four sibling channels coexist (pushcut + pwa + telegram + discord)', async () => {
    await bootNexus({
      telegramHitlOpts: { token: 't', chatId: 1, bot: makeStubTelegramBot() },
      discordHitlOpts: { token: 't', channelId: '1', bot: makeStubDiscordBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).toContain('pushcut');
    expect(names).toContain('pwa');
    expect(names).toContain('telegram');
    expect(names).toContain('discord');
  });

  test('skipRuntimeApi:true short-circuits the discord wire-up too', async () => {
    await bootNexus({
      skipRuntimeApi: true,
      discordHitlOpts: { token: 't', channelId: '1', bot: makeStubDiscordBot() },
    });
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });
});
