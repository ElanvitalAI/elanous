// PR-S1V.11 (sprint 22 Phase 6) — Discord voice channel adapter +
// dispatcher + host-boot.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createStubDiscordVoiceChannelAdapter,
  createDiscordVoiceChannelAdapter,
  isDiscordVoiceChannelEnabled,
  DiscordVoiceUnavailableError,
} from '../src/voice/channel-adapters/discord-voice-channel-adapter.js';
import { createDiscordVoiceChannelDispatcher } from '../src/voice/channel-adapters/discord-voice-channel-commands.js';
import { bootDiscordVoiceChannel } from '../src/voice/channel-adapters/discord-voice-channel-host-boot.js';
import { resetUserConfig } from '../src/user-config.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

const ORIGINAL_ENV = { ...process.env };
let tempConfigRoot: string | null = null;

afterEach(() => {
  resetElanousConfigDir();
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
  resetUserConfig();
  if (tempConfigRoot) {
    rmSync(tempConfigRoot, { recursive: true, force: true });
    tempConfigRoot = null;
  }
});

function writeConfig(raw: unknown): void {
  tempConfigRoot = mkdtempSync(join(tmpdir(), 'elanous-dc-voice-'));
  const dir = join(tempConfigRoot, 'elanous');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(raw, null, 2));
  process.env.XDG_CONFIG_HOME = tempConfigRoot;
  setElanousConfigDir(dir);
  resetUserConfig();
}

// ── Stub adapter ───────────────────────────────────────────────────

describe('createStubDiscordVoiceChannelAdapter', () => {
  it('joinChannel resolves to a session that reaches ready', async () => {
    const adapter = createStubDiscordVoiceChannelAdapter();
    const session = await adapter.joinChannel({ guildId: 'g1', channelId: 'c1' });
    // Microtask ordering between Promise.resolve(session) and the
    // queued setState('ready') is runtime-dependent, so accept either
    // initial state and require ready after one more tick.
    expect(['connecting', 'ready']).toContain(session.getState());
    await new Promise((r) => setImmediate(r));
    expect(session.getState()).toBe('ready');
  });

  it('failWith causes joinChannel to reject Unavailable', async () => {
    const adapter = createStubDiscordVoiceChannelAdapter({ failWith: 'no deps' });
    expect(adapter.available).toBe(false);
    await expect(adapter.joinChannel({ guildId: 'g1', channelId: 'c1' }))
      .rejects.toThrow(DiscordVoiceUnavailableError);
  });

  it('shutdown leaves any active session', async () => {
    const adapter = createStubDiscordVoiceChannelAdapter();
    const session = await adapter.joinChannel({ guildId: 'g1', channelId: 'c1' });
    await adapter.shutdown();
    expect(session.getState()).toBe('disconnected');
  });

  it('sendAudio is dropped while state is not ready', async () => {
    const adapter = createStubDiscordVoiceChannelAdapter();
    const session = await adapter.joinChannel({ guildId: 'g1', channelId: 'c1' });
    const stub = asStubSession(session);
    // Force back to connecting before the microtask flips ready, so we
    // can deterministically assert sendAudio drops while non-ready.
    stub.emitState('connecting');
    session.sendAudio(Buffer.from([1, 2]));
    expect(stub.takeOutbound().length).toBe(0);
    stub.emitState('ready');
    session.sendAudio(Buffer.from([3, 4]));
    const captured = stub.takeOutbound();
    expect(captured.length).toBe(1);
    expect(Array.from(captured[0]!)).toEqual([3, 4]);
  });

  it('inbound audio reaches subscribers', async () => {
    const adapter = createStubDiscordVoiceChannelAdapter();
    const session = await adapter.joinChannel({ guildId: 'g1', channelId: 'c1' });
    await new Promise((r) => setImmediate(r));
    const received: Array<{ pcm: Buffer; userId: string }> = [];
    session.onAudioReceived((pcm, userId) => received.push({ pcm, userId }));
    asStubSession(session).emitInboundAudio(Buffer.from([0xAA]), 'user-99');
    expect(received.length).toBe(1);
    expect(received[0]!.userId).toBe('user-99');
  });
});

// Type helper for test-only methods on the stub session.
type StubSessionExtras = {
  takeOutbound: () => Buffer[];
  emitInboundAudio: (pcm: Buffer, userId: string) => void;
  emitState: (state: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'disconnected') => void;
};
function asStubSession(s: unknown): StubSessionExtras {
  return s as unknown as StubSessionExtras;
}

// ── Production adapter (lazy probe) ────────────────────────────────

describe('createDiscordVoiceChannelAdapter', () => {
  it('joinChannel rejects with install hint when voice module loader fails', async () => {
    const stubCoordinator = {
      tap: {},
      getBotUserId: () => null,
      getSessionId: () => null,
      createAdapterFor: () => () => ({ sendPayload: () => true, destroy: () => {} }),
      destroyAll: () => {},
    } as unknown as Parameters<typeof createDiscordVoiceChannelAdapter>[0]['coordinator'];
    const adapter = createDiscordVoiceChannelAdapter({
      coordinator: stubCoordinator,
      __voiceModuleLoader: () => Promise.reject(new Error('Cannot find package')),
    });
    let err: Error | null = null;
    try {
      await adapter.joinChannel({ guildId: 'g1', channelId: 'c1' });
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err).not.toBeNull();
    expect(err?.name).toBe('DiscordVoiceUnavailableError');
    expect(err!.message).toContain('@discordjs/voice');
    expect(err!.message).toContain('bun add');
    expect(adapter.available).toBe(false);
    expect(adapter.unavailableReason).toContain('@discordjs/voice');
  });
});

// ── Env gate ───────────────────────────────────────────────────────

describe('isDiscordVoiceChannelEnabled', () => {
  it('false when ELANOUS_DISCORD_VOICE_CHANNEL unset', () => {
    delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    expect(isDiscordVoiceChannelEnabled()).toBe(false);
  });
  it('prefers user-config enabled=true over missing env', () => {
    delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    writeConfig({ voice: { discord: { voiceChannel: { enabled: true } } } });
    expect(isDiscordVoiceChannelEnabled()).toBe(true);
  });
  it('true for 1/true/on/yes (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'On', 'YES']) {
      process.env.ELANOUS_DISCORD_VOICE_CHANNEL = v;
      expect(isDiscordVoiceChannelEnabled()).toBe(true);
    }
  });
  it('false for 0/false/off', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      process.env.ELANOUS_DISCORD_VOICE_CHANNEL = v;
      expect(isDiscordVoiceChannelEnabled()).toBe(false);
    }
  });
});

// ── Dispatcher ─────────────────────────────────────────────────────

describe('createDiscordVoiceChannelDispatcher', () => {
  it('returns null for non-voice messages (fall through)', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({ body: 'hello there', guildId: 'g1' });
    expect(reply).toBeNull();
  });

  it('reports disabled when env unset', async () => {
    delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({ body: '/voice-join 1234', guildId: 'g1' });
    expect(reply).toContain('disabled');
  });

  it('reports unavailable when adapter has reason', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter({ failWith: 'no deps' });
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({ body: '/voice-join 1234', guildId: 'g1' });
    expect(reply).toContain('unavailable');
    expect(reply).toContain('no deps');
  });

  it('joins on /voice-join + channel id', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({
      body: '/voice-join 9876543210',
      guildId: 'g1',
      userId: 'u1',
    });
    expect(reply).toContain('Joined');
    expect(reply).toContain('9876543210');
    expect(dispatcher.getActiveSession()).not.toBeNull();
  });

  it('defaults to caller-only filter when the command omits a suffix', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    let captured: { listenFilterUserId?: string | null } | null = null;
    const dispatcher = createDiscordVoiceChannelDispatcher({
      adapter,
      defaultListenFilter: 'caller',
      onSessionStart: (_s, opts) => { captured = opts; },
    });
    await dispatcher.handle({
      body: '/voice-join 1111',
      guildId: 'g1',
      userId: 'inviter-42',
    });
    expect(captured?.listenFilterUserId).toBe('inviter-42');
  });

  it('allows explicit all-speaker override even when default is caller', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    let captured: { listenFilterUserId?: string | null } | null = null;
    const dispatcher = createDiscordVoiceChannelDispatcher({
      adapter,
      defaultListenFilter: 'caller',
      onSessionStart: (_s, opts) => { captured = opts; },
    });
    await dispatcher.handle({
      body: '/voice-join 1111 all',
      guildId: 'g1',
      userId: 'inviter-42',
    });
    expect(captured?.listenFilterUserId).toBeUndefined();
  });

  it('uses defaultChannelId when /voice-join has no arg', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({
      body: '/voice-join',
      guildId: 'g1',
      defaultChannelId: '111222333',
    });
    expect(reply).toContain('111222333');
  });

  it('caller filter sets listenFilterUserId', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    let captured: { listenFilterUserId?: string | null } | null = null;
    const dispatcher = createDiscordVoiceChannelDispatcher({
      adapter,
      onSessionStart: (_s, opts) => { captured = opts; },
    });
    await dispatcher.handle({
      body: '/voice-join 1111 caller',
      guildId: 'g1',
      userId: 'inviter-42',
    });
    expect(captured).not.toBeNull();
    expect(captured!.listenFilterUserId).toBe('inviter-42');
  });

  it('captures command channel as textChannelId for transcript mirror fan-out', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    let captured: { textChannelId?: string } | null = null;
    const dispatcher = createDiscordVoiceChannelDispatcher({
      adapter,
      onSessionStart: (_s, opts) => { captured = opts; },
    });
    await dispatcher.handle({
      body: '/voice-join 1111',
      guildId: 'g1',
      channelId: 'text-42',
    });
    expect(captured?.textChannelId).toBe('text-42');
  });

  it('rejects /voice-join when missing guildId', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    const reply = await dispatcher.handle({ body: '/voice-join 1234' });
    expect(reply).toContain('Missing guildId');
  });

  it('/voice-leave tears down session', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    await dispatcher.handle({ body: '/voice-join 1111', guildId: 'g1' });
    expect(dispatcher.getActiveSession()).not.toBeNull();
    const reply = await dispatcher.handle({ body: '/voice-leave' });
    expect(reply).toContain('Left');
    expect(dispatcher.getActiveSession()).toBeNull();
  });

  it('/voice-status reports current state', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const adapter = createStubDiscordVoiceChannelAdapter();
    const dispatcher = createDiscordVoiceChannelDispatcher({ adapter });
    expect(await dispatcher.handle({ body: '/voice-status' })).toContain('not connected');
    await dispatcher.handle({ body: '/voice-join 5555', guildId: 'g1' });
    const reply = await dispatcher.handle({ body: '/voice-status' });
    expect(reply).toContain('5555');
  });
});

// ── Host-boot ──────────────────────────────────────────────────────

describe('bootDiscordVoiceChannel', () => {
  it('reports disabled when env unset', () => {
    delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    const result = bootDiscordVoiceChannel();
    expect(result.enabled).toBe(false);
    expect(result.adapter.available).toBe(false);
    expect(result.adapter.unavailableReason).toContain('not set');
  });

  it('reports missing coordinator when env enabled but no gateway wire', () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const result = bootDiscordVoiceChannel();
    expect(result.enabled).toBe(true);
    expect(result.adapter.available).toBe(false);
    expect(result.adapter.unavailableReason).toContain('coordinator');
  });

  it('passes through dispatcher.handle as dispatchVoiceCommand', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const stubAdapter = createStubDiscordVoiceChannelAdapter();
    const result = bootDiscordVoiceChannel({ adapter: stubAdapter });
    const reply = await result.dispatchVoiceCommand({
      body: '/voice-join 999',
      guildId: 'g1',
    });
    expect(reply).toContain('Joined');
  });

  it('shutdown tears down adapter', async () => {
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const stubAdapter = createStubDiscordVoiceChannelAdapter();
    const result = bootDiscordVoiceChannel({ adapter: stubAdapter });
    await result.dispatchVoiceCommand({ body: '/voice-join 1', guildId: 'g1' });
    await result.shutdown();
    // Stub adapter shutdown leaves the session.
    expect(result.dispatcher.getActiveSession()?.getState()).not.toBe('ready');
  });
});
