// NEXUS Telegram HITL channel wire-up — β-1b · 2026-05-08.
//
// Pairs with `nexus-hitl-pushcut-channel.test.ts` and
// `nexus-hitl-pwa-channel.test.ts`. The Telegram channel uses the
// existing src/hitl/telegram-channel.ts (TelegramConfirmDeps) +
// confirm.ts createTelegramConfirmChannel (channel adapter); β-1b
// adds the NEXUS-specific lifecycle (env reader + bot start/stop).
//
// What this file proves:
//   1. Env reader parses ELANOUS_TELEGRAM_HITL_BOT_TOKEN +
//      ELANOUS_TELEGRAM_HITL_CHAT_ID; missing/invalid → null.
//   2. Factory skips when token missing or chatId NaN.
//   3. Factory with prebuilt bot returns a handle whose channel is
//      named 'telegram'.
//   4. runNexus({ telegramHitlOpts }) registers a 'telegram' channel
//      alongside pushcut + pwa.
//   5. runNexus with no env + no opts → no telegram channel.
//   6. skipTelegramChannel: true forces skip even with opts.
//   7. release() stops the bot (idempotent).
//
// Real Telegram /getUpdates round-trip is out of scope; the
// existing `test/hitl-telegram-channel.test.ts` covers the
// callback_query → confirm.ts answer path with a fake bot poller.

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
  createNexusTelegramHitlHandle,
  readNexusTelegramHitlOptsFromEnv,
} from '../src/nexus/api/hitl-telegram-channel.js';
import { TelegramBot } from '../src/telegram.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-hitl-tg-'));
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
  return 55000 + Math.floor(Math.random() * 2000);
}

function makeStubBot(): TelegramBot {
  // The bot's poll loop never starts in tests (factory checks
  // `opts.bot` and skips bot.start()), so we only need a fetch impl
  // for the synchronous /sendMessage call surface that
  // createTelegramHitlPostDeps may exercise. Cast through `unknown`
  // because `typeof fetch` includes Bun's `preconnect` overload that
  // a plain async arrow doesn't satisfy.
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

describe('readNexusTelegramHitlOptsFromEnv', () => {
  test('returns parsed opts when both env vars set', () => {
    expect(
      readNexusTelegramHitlOptsFromEnv({
        ELANOUS_TELEGRAM_HITL_BOT_TOKEN: '999:abc',
        ELANOUS_TELEGRAM_HITL_CHAT_ID: '12345',
      }),
    ).toEqual({ token: '999:abc', chatId: 12345 });
  });

  test('handles negative chatId (groups can have negative ids)', () => {
    expect(
      readNexusTelegramHitlOptsFromEnv({
        ELANOUS_TELEGRAM_HITL_BOT_TOKEN: '999:abc',
        ELANOUS_TELEGRAM_HITL_CHAT_ID: '-1001234567890',
      }),
    ).toEqual({ token: '999:abc', chatId: -1001234567890 });
  });

  test('returns null when token missing', () => {
    expect(
      readNexusTelegramHitlOptsFromEnv({ ELANOUS_TELEGRAM_HITL_CHAT_ID: '1' }),
    ).toBeNull();
  });

  test('returns null when chatId missing', () => {
    expect(
      readNexusTelegramHitlOptsFromEnv({ ELANOUS_TELEGRAM_HITL_BOT_TOKEN: '999:abc' }),
    ).toBeNull();
  });

  test('returns null when chatId not numeric', () => {
    expect(
      readNexusTelegramHitlOptsFromEnv({
        ELANOUS_TELEGRAM_HITL_BOT_TOKEN: '999:abc',
        ELANOUS_TELEGRAM_HITL_CHAT_ID: 'not-a-number',
      }),
    ).toBeNull();
  });

  test('returns null when both env vars missing', () => {
    expect(readNexusTelegramHitlOptsFromEnv({})).toBeNull();
  });
});

describe('createNexusTelegramHitlHandle', () => {
  test('returns null when token empty', () => {
    expect(createNexusTelegramHitlHandle({ token: '', chatId: 1, bot: makeStubBot() })).toBeNull();
  });

  test('returns null when chatId is NaN', () => {
    expect(
      createNexusTelegramHitlHandle({ token: 't:1', chatId: Number.NaN, bot: makeStubBot() }),
    ).toBeNull();
  });

  test('returns a handle whose channel name is "telegram"', () => {
    const h = createNexusTelegramHitlHandle({ token: 't:1', chatId: 1, bot: makeStubBot() });
    expect(h).not.toBeNull();
    expect(h!.channel.name).toBe('telegram');
  });

  test('stop() is idempotent', async () => {
    const h = createNexusTelegramHitlHandle({ token: 't:1', chatId: 1, bot: makeStubBot() });
    await h!.stop();
    await expect(h!.stop()).resolves.toBeUndefined();
  });
});

describe('runNexus telegram channel integration', () => {
  test('default boot (no env) does NOT register telegram', async () => {
    // beforeEach sets HOME to tmpRoot but doesn't set the telegram
    // env vars; readNexusTelegramHitlOptsFromEnv returns null;
    // channel skipped.
    await bootNexus();
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('telegram');
  });

  test('telegramHitlOpts injected → channel registers with name "telegram"', async () => {
    await bootNexus({
      telegramHitlOpts: { token: 't:1', chatId: 1, bot: makeStubBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).toContain('telegram');
  });

  test('skipTelegramChannel:true skips even with opts injected', async () => {
    await bootNexus({
      skipTelegramChannel: true,
      telegramHitlOpts: { token: 't:1', chatId: 1, bot: makeStubBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('telegram');
  });

  test('release() unregisters the telegram channel along with siblings', async () => {
    const h = await bootNexus({
      telegramHitlOpts: { token: 't:1', chatId: 1, bot: makeStubBot() },
    });
    expect(getDefaultConfirmChannels().map((c) => c.name)).toContain('telegram');
    h.release();
    activeHandle = undefined;
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('three sibling channels coexist (pushcut + pwa + telegram)', async () => {
    await bootNexus({
      telegramHitlOpts: { token: 't:1', chatId: 1, bot: makeStubBot() },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).toContain('pushcut');
    expect(names).toContain('pwa');
    expect(names).toContain('telegram');
  });

  test('skipRuntimeApi:true short-circuits the telegram wire-up too', async () => {
    await bootNexus({
      skipRuntimeApi: true,
      telegramHitlOpts: { token: 't:1', chatId: 1, bot: makeStubBot() },
    });
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });
});
