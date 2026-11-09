// M4c — buildDiscordVoiceWire assembly test (stub adapter + fake
// STT/TTS/runTurn). Covers: env gate inertness, /voice-join dispatch
// (explicit + REST-discovery fallback), the full voice round-trip
// (inbound PCM → STT final → self turn → TTS → session outbound), the
// `!voice-*` alias, and teardown on /voice-leave.
//
// Session-store discipline: ELANOUS_STATE_DIR points at a tmp dir for
// the whole file (the wire's onSessionStart calls createSession —
// never let test turns land in the real ~/.elanous store).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import { buildDiscordVoiceWire } from '../src/discord-voice-wire.js';
import {
  createStubDiscordVoiceChannelAdapter,
  type DiscordVoiceChannelAdapter,
  type DiscordVoiceChannelSession,
  type DiscordVoiceJoinOpts,
} from '../src/voice/channel-adapters/discord-voice-channel-adapter.js';
import type { StreamingSTTOpts, StreamingSTTProvider } from '../src/voice/streaming-stt/streaming-stt-provider.js';
import type { TTSProvider } from '../src/voice/tts/tts-provider.js';
import type { runTurn } from '../src/session/chat.js';
import type { DcIncoming } from '../src/discord.js';
import type { UserConfig } from '../src/user-config/types.js';

let stateDir = '';
const envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dc-voice-wire-'));
  envBackup.ELANOUS_STATE_DIR = process.env.ELANOUS_STATE_DIR;
  envBackup.ELANOUS_DISCORD_VOICE_CHANNEL = process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
  envBackup.ELANOUS_DISCORD_VOICE_LEAVE_ON_EMPTY = process.env.ELANOUS_DISCORD_VOICE_LEAVE_ON_EMPTY;
  envBackup.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.ELANOUS_STATE_DIR = stateDir;
  // Config isolation (2026-07-12) — isDiscordVoiceChannelEnabled() 는
  // getUserConfig() 를 읽고 config 가 env 보다 우선한다. 개발 머신의
  // 실제 config 에 voice.discord.voiceChannel.enabled=true 가 있으면
  // "gate off" 케이스가 상시 깨진다 (stt-singleton 격리와 동일 클래스).
  process.env.XDG_CONFIG_HOME = stateDir;
});

afterAll(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* noop */ }
});

beforeEach(() => {
  process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
  // Auto-leave subscribes gateway voice state — irrelevant here.
  process.env.ELANOUS_DISCORD_VOICE_LEAVE_ON_EMPTY = '0';
});

const fakeCfg = {
  llm: { provider: 'anthropic', model: 'test-model' },
  discord: { botToken: '' }, // empty ⇒ REST discovery short-circuits
} as unknown as UserConfig;

function makeIncoming(text: string, overrides: Partial<DcIncoming> = {}): DcIncoming {
  return {
    channelId: 'txt-1',
    userId: 'u-1',
    text,
    messageId: 'm-1',
    isDm: false,
    attachments: [],
    raw: { guild_id: 'g-1' },
    ...overrides,
  };
}

/** Stub adapter wrapper that captures joined sessions + join opts. */
function makeCapturingAdapter(): {
  adapter: DiscordVoiceChannelAdapter;
  lastSession: () => (DiscordVoiceChannelSession & {
    emitInboundAudio(pcm: Buffer, userId: string): void;
    takeOutbound(): Buffer[];
  }) | null;
  lastJoinOpts: () => DiscordVoiceJoinOpts | null;
} {
  const stub = createStubDiscordVoiceChannelAdapter();
  let session: ReturnType<typeof Object> | null = null;
  let joinOpts: DiscordVoiceJoinOpts | null = null;
  const adapter: DiscordVoiceChannelAdapter = {
    get available() { return stub.available; },
    get unavailableReason() { return stub.unavailableReason; },
    joinChannel: async (opts) => {
      joinOpts = opts;
      const s = await stub.joinChannel(opts);
      session = s;
      return s;
    },
    shutdown: () => stub.shutdown(),
  };
  return {
    adapter,
    lastSession: () => session as never,
    lastJoinOpts: () => joinOpts,
  };
}

function makeFakeStt(): {
  provider: StreamingSTTProvider;
  emitFinal: (text: string) => void;
  pushed: () => Buffer[];
  finalized: () => boolean;
} {
  let latest: StreamingSTTOpts | undefined;
  const pushed: Buffer[] = [];
  let finalized = false;
  const provider = {
    id: 'whisper-cpp-local',
    format: { sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
    openSession: async (opts?: StreamingSTTOpts) => {
      latest = opts;
      return {
        pushAudio: (pcm: Buffer) => { pushed.push(pcm); },
        finalize: async () => { finalized = true; },
        abort: async () => {},
        isOpen: () => true,
      };
    },
  } as unknown as StreamingSTTProvider;
  return {
    provider,
    emitFinal: (text) => latest?.onFinal?.(text),
    pushed: () => pushed.slice(),
    finalized: () => finalized,
  };
}

function makeFakeTts(): { provider: TTSProvider; spoken: () => string[] } {
  const spoken: string[] = [];
  const provider = {
    id: 'macos-say',
    format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
    synthesizeBatch: async (text: string) => {
      spoken.push(text);
      return {
        pcm: Buffer.from(`pcm:${text}`),
        format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
        charCount: text.length,
      };
    },
  } as unknown as TTSProvider;
  return { provider, spoken: () => spoken.slice() };
}

async function waitFor(cond: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('buildDiscordVoiceWire', () => {
  it('non-voice text falls through with null (no side effects)', async () => {
    const { adapter } = makeCapturingAdapter();
    const wire = buildDiscordVoiceWire({
      userConfig: fakeCfg,
      runTurnImpl: (async () => ({ text: 'x' })) as unknown as typeof runTurn,
      getBot: () => null,
      __adapter: adapter,
    });
    expect(await wire.dispatchVoiceCommand(makeIncoming('그냥 일반 메시지'))).toBeNull();
    expect(await wire.dispatchVoiceCommand(makeIncoming('/cc build it'))).toBeNull();
    await wire.shutdown();
  });

  it('gate off ⇒ voiceTap null + /voice-* replies explain the gate', async () => {
    delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    const wire = buildDiscordVoiceWire({
      userConfig: fakeCfg,
      runTurnImpl: (async () => ({ text: 'x' })) as unknown as typeof runTurn,
      getBot: () => null,
      // NOTE: no __adapter — exercises the real gate-driven stub path.
    });
    expect(wire.enabled).toBe(false);
    expect(wire.voiceTap).toBeNull();
    const reply = await wire.dispatchVoiceCommand(makeIncoming('/voice-status'));
    expect(reply).toContain('disabled');
    await wire.shutdown();
  });

  it('joins, round-trips voice→STT→self turn→TTS→outbound, and leaves', async () => {
    const { adapter, lastSession, lastJoinOpts } = makeCapturingAdapter();
    const stt = makeFakeStt();
    const tts = makeFakeTts();
    const turnCalls: Array<{ sessionId: string; userText: string; systemPrompt?: string }> = [];
    const runTurnImpl = (async (opts: { sessionId: string; userText: string; systemPrompt?: string; onDelta?: (d: string) => void }) => {
      turnCalls.push({ sessionId: opts.sessionId, userText: opts.userText, systemPrompt: opts.systemPrompt });
      opts.onDelta?.('빌드는 정상입니다. ');
      opts.onDelta?.('tsc 오류는 없습니다.');
      return { text: '빌드는 정상입니다. tsc 오류는 없습니다.' };
    }) as unknown as typeof runTurn;

    const wire = buildDiscordVoiceWire({
      userConfig: fakeCfg,
      runTurnImpl,
      getBot: () => null,
      __adapter: adapter,
      __sttProviderFactory: () => stt.provider,
      __ttsProviderFactory: () => tts.provider,
    });
    expect(wire.enabled).toBe(true);
    expect(wire.voiceTap).not.toBeNull();

    const joinReply = await wire.dispatchVoiceCommand(makeIncoming('/voice-join vc-1'));
    expect(joinReply).toContain('Joined voice channel vc-1');
    // caller filter defaults to the command issuer; text channel mirrors.
    expect(lastJoinOpts()?.textChannelId).toBe('txt-1');
    expect(lastJoinOpts()?.requesterUserId).toBe('u-1');

    const session = lastSession();
    expect(session).not.toBeNull();
    await waitFor(() => session!.getState() === 'ready');

    // Inbound audio reaches the STT session…
    session!.emitInboundAudio(Buffer.alloc(320), 'u-1');
    await waitFor(() => stt.pushed().length > 0);

    // …STT final runs the SAME self turn contract as text chat…
    stt.emitFinal('빌드 상태 알려줘');
    await waitFor(() => turnCalls.length === 1);
    expect(turnCalls[0]!.userText).toBe('빌드 상태 알려줘');
    expect(turnCalls[0]!.sessionId).toBeTruthy();
    // V2 — 보이스 발화 규율이 시스템 프롬프트로 합성된다.
    expect(turnCalls[0]!.systemPrompt).toContain('보이스 턴 규율');

    // …and the streamed sentences come back as outbound PCM.
    await waitFor(() => session!.takeOutbound().length > 0 || tts.spoken().length > 0);
    await waitFor(() => tts.spoken().join('').includes('tsc 오류는 없습니다'));

    const leaveReply = await wire.dispatchVoiceCommand(makeIncoming('/voice-leave'));
    expect(leaveReply).toContain('Left voice channel');
    await waitFor(() => stt.finalized());
    await wire.shutdown();
  });

  it('voice- prefixed typo returns usage instead of leaking into the LLM turn', async () => {
    const { adapter } = makeCapturingAdapter();
    let turnRan = false;
    const wire = buildDiscordVoiceWire({
      userConfig: fakeCfg,
      runTurnImpl: (async () => { turnRan = true; return { text: 'x' }; }) as unknown as typeof runTurn,
      getBot: () => null,
      __adapter: adapter,
    });
    // dogfood 실사례: `!voice-jin` — join 오타.
    const reply = await wire.dispatchVoiceCommand(makeIncoming('!voice-jin'));
    expect(reply).toContain('voice-join');
    expect(turnRan).toBe(false);
    // dogfood 실사례 2: `!voice_join` — 밑줄 표기는 정상 명령으로 수용.
    const underscore = await wire.dispatchVoiceCommand(makeIncoming('!voice_status'));
    expect(underscore).toContain('voice-channel: not connected');
    expect(turnRan).toBe(false);
    await wire.shutdown();
  });

  it('`!voice-*` alias normalizes to the dispatcher spelling', async () => {
    const { adapter } = makeCapturingAdapter();
    const wire = buildDiscordVoiceWire({
      userConfig: fakeCfg,
      runTurnImpl: (async () => ({ text: 'x' })) as unknown as typeof runTurn,
      getBot: () => null,
      __adapter: adapter,
    });
    const reply = await wire.dispatchVoiceCommand(makeIncoming('!voice-status'));
    expect(reply).toContain('voice-channel: not connected');
    await wire.shutdown();
  });

  it('bare /voice-join discovers guild + voice channel via REST (DM path)', async () => {
    const { adapter, lastJoinOpts } = makeCapturingAdapter();
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetchCalls.push(url);
      if (url.endsWith('/users/@me/guilds')) {
        return { json: async () => [{ id: 'g-9', name: 'G' }] };
      }
      return {
        json: async () => [
          { id: 'txt-9', type: 0 },
          { id: 'vc-9', type: 2 },
        ],
      };
    }) as unknown as typeof fetch;

    const wire = buildDiscordVoiceWire({
      userConfig: { ...fakeCfg, discord: { botToken: 'tok' } } as unknown as UserConfig,
      runTurnImpl: (async () => ({ text: 'x' })) as unknown as typeof runTurn,
      getBot: () => null,
      __adapter: adapter,
      __fetchImpl: fakeFetch,
      __sttProviderFactory: () => makeFakeStt().provider,
      __ttsProviderFactory: () => makeFakeTts().provider,
    });
    // DM shape: no guild_id on the raw payload, bare join.
    const reply = await wire.dispatchVoiceCommand(makeIncoming('/voice-join', { isDm: true, raw: {} }));
    expect(reply).toContain('Joined voice channel vc-9');
    expect(lastJoinOpts()?.guildId).toBe('g-9');
    // Discovery is cached — a second command must not refetch.
    const callsAfterJoin = fetchCalls.length;
    await wire.dispatchVoiceCommand(makeIncoming('/voice-status'));
    expect(fetchCalls.length).toBe(callsAfterJoin);
    await wire.shutdown();
  });
});
