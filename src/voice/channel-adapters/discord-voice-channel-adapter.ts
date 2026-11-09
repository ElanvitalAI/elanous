// PR-S1V.11 (Phase 6A architecture · 2026-04-29)
// PR-S1V.12 (Phase 6 wire    · 2026-04-30)
//
// Discord voice channel adapter — wires elanous's voice-chat-mode
// controller (Phase 4) to a Discord voice channel via `@discordjs/voice`.
//
// Dependencies (added 2026-04-30):
//   - `@discordjs/voice` — voice gateway handshake + UDP RTP send/recv
//   - `opusscript`        — WASM Opus codec (Bun-compatible · default)
//   - `libsodium-wrappers` — Discord voice encryption
//   - `prism-media`       — Opus encoder/decoder Transform streams
//
// Architecture:
//   - `DiscordVoiceChannelAdapter` — joinChannel / sendAudio /
//     onAudioReceived / state subs — wired to elanous's voice-chat-mode
//     controller (Phase 4) so the same harness path handles Discord
//     audio just like local mic.
//   - `createDiscordVoiceChannelAdapter()` — production constructor
//     that lazy-imports `@discordjs/voice` at the first joinChannel
//     call; throws `DiscordVoiceUnavailableError` with an install
//     hint if the user removed the deps.
//   - `createStubDiscordVoiceChannelAdapter()` — in-memory stub used
//     by tests and by the dashboard while the user hasn't enabled
//     voice yet (`ELANOUS_DISCORD_VOICE_CHANNEL` unset).
//
// PCM contracts (Phase 1 + 3):
//   - inbound  : 16 kHz · mono · 16-bit signed (push to streaming-stt)
//   - outbound : 24 kHz · mono · 16-bit signed (received from TTS)
// Internally Discord uses 48 kHz stereo Opus — the resample helpers
// in `discord-voice-resample.ts` bridge the two contracts.
//
// Reference: ROADMAP §7.1-§7.3 (Phase 6A/B/C/D wire).

import { Buffer } from 'node:buffer';
import { Readable, PassThrough } from 'node:stream';
import { debug } from '../../debug/log.js';
import { getUserConfig, VOICE_HARDCODED_DEFAULTS } from '../../user-config.js';
import type { VoiceDiscordChannelListenFilter } from '../../user-config/types.js';
import {
  pcm48kStereoTo16kMono,
  pcm24kMonoTo48kStereo,
} from './discord-voice-resample.js';
import type { DiscordVoiceGatewayCoordinator } from './discord-voice-gateway-adapter.js';

// ── Public types ───────────────────────────────────────────────────

export interface DiscordVoiceJoinOpts {
  guildId: string;
  channelId: string;
  /** Optional text channel used to mirror voice transcripts while the
   *  session is active. */
  textChannelId?: string;
  /** User who initiated the join command. Used by caller-default
   *  showroom flows and empty-room cleanup heuristics. */
  requesterUserId?: string;
  /** When false (default), bot listens to all speakers. When set to a
   *  user id, only that user's audio is forwarded to STT (caller
   *  filter from ROADMAP §7.3). */
  listenFilterUserId?: string | null;
  /** When true, bot self-mutes (no audio out) — useful for read-only
   *  dictation modes. Default false (full duplex). */
  selfMute?: boolean;
  /** When true, bot self-deafens (won't receive audio either). */
  selfDeaf?: boolean;
}

export type DiscordVoiceConnectionState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'disconnected';

export interface DiscordVoiceChannelSession {
  /** Push 24 kHz · 16-bit signed mono PCM to the channel (TTS output). */
  sendAudio(pcm: Buffer): void;
  /** Subscribe to incoming audio from voice-channel speakers. The
   *  callback receives 16 kHz mono PCM ready for STT. Returns
   *  unsubscribe. */
  onAudioReceived(cb: (pcm: Buffer, userId: string) => void): () => void;
  /** Subscribe to lifecycle transitions. */
  onStateChange(cb: (state: DiscordVoiceConnectionState) => void): () => void;
  /** Current connection state. */
  getState(): DiscordVoiceConnectionState;
  /** Immediately stop any in-flight outbound playback and drop queued
   *  audio (barge-in / turn supersede). The next sendAudio rebuilds
   *  the pipeline. Optional — stub + legacy fakes may omit it. */
  stopPlayback?(): void;
  /** Disconnect and clean up. Idempotent. */
  leave(): Promise<void>;
}

export interface DiscordVoiceChannelAdapter {
  /** True when underlying voice-gateway dependencies are available. */
  readonly available: boolean;
  /** Why `available` is false (env hint, missing deps, etc.). */
  readonly unavailableReason: string | null;
  /** Open a voice connection. Resolves to a session or rejects with
   *  `DiscordVoiceUnavailableError` if deps aren't installed. */
  joinChannel(opts: DiscordVoiceJoinOpts): Promise<DiscordVoiceChannelSession>;
  /** Forget any in-flight session and tear down lazy resources. Used
   *  on dashboard shutdown / hot-reload. */
  shutdown(): Promise<void>;
}

// ── Errors ─────────────────────────────────────────────────────────

export class DiscordVoiceUnavailableError extends Error {
  constructor(hint: string) {
    super(`Discord voice channel unavailable — ${hint}`);
    this.name = 'DiscordVoiceUnavailableError';
  }
}

// ── Stub implementation (test / dashboard idle) ────────────────────

export interface StubAdapterOpts {
  /** Fail joinChannel with the given error message. Used by tests
   *  to exercise the unavailable code path. */
  failWith?: string;
}

export function createStubDiscordVoiceChannelAdapter(
  opts: StubAdapterOpts = {},
): DiscordVoiceChannelAdapter {
  const reason = opts.failWith ?? null;
  let activeSession: StubSession | null = null;

  function joinChannel(joinOpts: DiscordVoiceJoinOpts): Promise<DiscordVoiceChannelSession> {
    if (reason) {
      return Promise.reject(new DiscordVoiceUnavailableError(reason));
    }
    if (activeSession) {
      void activeSession.leave();
    }
    const session = createStubSession(joinOpts);
    activeSession = session;
    return Promise.resolve(session);
  }

  async function shutdown(): Promise<void> {
    if (activeSession) {
      await activeSession.leave();
      activeSession = null;
    }
  }

  return {
    available: !reason,
    unavailableReason: reason,
    joinChannel,
    shutdown,
  };
}

interface StubSession extends DiscordVoiceChannelSession {
  /** Test-only: simulate inbound audio from a speaker. */
  emitInboundAudio(pcm: Buffer, userId: string): void;
  /** Test-only: drive state transitions. */
  emitState(state: DiscordVoiceConnectionState): void;
  /** Test-only: pull captured outbound PCM. */
  takeOutbound(): Buffer[];
}

function createStubSession(_joinOpts: DiscordVoiceJoinOpts): StubSession {
  let state: DiscordVoiceConnectionState = 'connecting';
  const audioSubs = new Set<(pcm: Buffer, userId: string) => void>();
  const stateSubs = new Set<(s: DiscordVoiceConnectionState) => void>();
  const outbound: Buffer[] = [];

  function setState(next: DiscordVoiceConnectionState): void {
    state = next;
    for (const cb of stateSubs) {
      try { cb(next); } catch { /* isolation */ }
    }
  }
  // Synthesize an immediate "ready" so tests / consumers can wire
  // through without waiting for a real Discord handshake.
  queueMicrotask(() => setState('ready'));

  return {
    sendAudio(pcm) {
      if (state !== 'ready') return;
      outbound.push(Buffer.from(pcm));
    },
    onAudioReceived(cb) {
      audioSubs.add(cb);
      return () => { audioSubs.delete(cb); };
    },
    onStateChange(cb) {
      stateSubs.add(cb);
      return () => { stateSubs.delete(cb); };
    },
    getState: () => state,
    async leave() {
      if (state === 'disconnected') return;
      setState('disconnected');
      audioSubs.clear();
      stateSubs.clear();
    },
    stopPlayback() {
      // Stub semantics: queued-but-unplayed audio is discarded.
      outbound.length = 0;
    },
    emitInboundAudio(pcm, userId) {
      for (const cb of audioSubs) {
        try { cb(pcm, userId); } catch { /* isolation */ }
      }
    },
    emitState(next) { setState(next); },
    takeOutbound() {
      const copy = outbound.slice();
      outbound.length = 0;
      return copy;
    },
  };
}

// ── Production lazy adapter ────────────────────────────────────────

export interface DiscordVoiceProductionOpts {
  /** Gateway coordinator wired to the Discord bot's voiceTap +
   *  sendGatewayPayload. Required for the voice-gateway handshake. */
  coordinator: DiscordVoiceGatewayCoordinator;
  /** Test seam — override the lazy import path so unit tests can
   *  feed a fake `@discordjs/voice` module. Production never sets
   *  this. */
  __voiceModuleLoader?: () => Promise<DiscordVoiceModule>;
  /** Test seam — override `prism-media`'s opus Decoder/Encoder. */
  __opusFactory?: OpusCodecFactory;
}

/** Subset of the `@discordjs/voice` API the wire actually touches.
 *  Kept narrow so tests can satisfy it without recreating the entire
 *  module surface. */
export interface DiscordVoiceModule {
  joinVoiceChannel(opts: {
    channelId: string;
    guildId: string;
    adapterCreator: unknown;
    selfMute?: boolean;
    selfDeaf?: boolean;
  }): DiscordVoiceConnectionLike;
  entersState(
    target: DiscordVoiceConnectionLike,
    state: string,
    timeoutMs: number,
  ): Promise<DiscordVoiceConnectionLike>;
  createAudioPlayer(opts?: {
    behaviors?: { maxMissedFrames?: number; noSubscriber?: string };
  }): DiscordAudioPlayerLike;
  createAudioResource(
    input: Readable,
    opts?: { inputType?: string },
  ): DiscordAudioResourceLike;
  VoiceConnectionStatus: Readonly<Record<
    'Ready' | 'Connecting' | 'Disconnected' | 'Destroyed' | 'Signalling',
    string
  >>;
  EndBehaviorType: Readonly<Record<'AfterSilence' | 'Manual', number | string>>;
  StreamType: Readonly<Record<'Raw' | 'Opus' | 'OggOpus', string>>;
  AudioPlayerStatus: Readonly<Record<'Idle' | 'Playing', string>>;
}

export interface DiscordVoiceConnectionLike {
  receiver: {
    subscribe(
      userId: string,
      opts?: { end?: { behavior: number | string; duration?: number } },
    ): Readable;
    speaking: { on(event: 'start' | 'end', cb: (userId: string) => void): void };
  };
  on(event: string, cb: (...args: unknown[]) => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  subscribe(player: DiscordAudioPlayerLike): { unsubscribe(): void } | undefined;
  destroy(): void;
}

export interface DiscordAudioPlayerLike {
  play(resource: DiscordAudioResourceLike): void;
  stop(force?: boolean): boolean;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

export interface DiscordAudioResourceLike {
  /** Marker only — kept opaque to avoid leaking lib internals. */
  readonly __resource?: true;
}

export interface OpusCodecFactory {
  createDecoder(): NodeJS.ReadWriteStream;
  createEncoder(): NodeJS.ReadWriteStream;
}

const DEFAULT_VOICE_MODULE_LOADER: () => Promise<DiscordVoiceModule> = () =>
  import('@discordjs/voice' as string) as unknown as Promise<DiscordVoiceModule>;

const DEFAULT_OPUS_FACTORY: OpusCodecFactory = (() => {
  // Lazy — only resolved on first joinChannel. Captured in a closure
  // so test seams can replace it before the first call.
  let cached: { Decoder: any; Encoder: any } | null = null;
  async function load(): Promise<void> {
    if (cached) return;
    const prism = (await import('prism-media' as string)) as unknown as {
      opus: { Decoder: any; Encoder: any };
      default?: { opus: { Decoder: any; Encoder: any } };
    };
    cached = prism.opus ?? prism.default?.opus ?? null;
    if (!cached) throw new Error('prism-media opus codec not available');
  }
  return {
    createDecoder() {
      if (!cached) throw new Error('opus codec not loaded — call load() first');
      // 48 kHz · 2 ch · 20 ms frame = 960 samples/frame
      return new cached.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    },
    createEncoder() {
      if (!cached) throw new Error('opus codec not loaded — call load() first');
      return new cached.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    },
    // Internal — used by probe(). The factory pattern means tests can
    // skip this entirely by injecting a pre-loaded factory.
    __load: load,
  } as OpusCodecFactory & { __load: () => Promise<void> };
})();

/**
 * Production adapter constructor — lazy-imports `@discordjs/voice` on
 * first joinChannel call. When the package isn't installed, returns
 * an adapter that fails join with `DiscordVoiceUnavailableError`
 * pointing at the install command.
 *
 * Bun runtime compatibility: ships with `opusscript` (WASM) by default;
 * upgrade to `@discordjs/opus` (native) for higher throughput once
 * Bun's prebuild loader is verified for that package.
 */
export function createDiscordVoiceChannelAdapter(
  prodOpts: DiscordVoiceProductionOpts,
): DiscordVoiceChannelAdapter {
  let unavailableReason: string | null = null;
  let probed = false;
  let voiceModule: DiscordVoiceModule | null = null;
  const opusFactory = prodOpts.__opusFactory ?? DEFAULT_OPUS_FACTORY;
  const moduleLoader = prodOpts.__voiceModuleLoader ?? DEFAULT_VOICE_MODULE_LOADER;
  let activeSession: ProductionSession | null = null;

  async function probe(): Promise<void> {
    if (probed) return;
    probed = true;
    try {
      voiceModule = await moduleLoader();
      // Pre-load prism-media's opus codec (the default factory exposes
      // a hidden __load thunk; injected factories are assumed warm).
      const lazy = opusFactory as OpusCodecFactory & { __load?: () => Promise<void> };
      if (typeof lazy.__load === 'function') await lazy.__load();
    } catch (err) {
      unavailableReason =
        '`@discordjs/voice` deps not installed. Run: bun add @discordjs/voice opusscript libsodium-wrappers prism-media';
      voiceModule = null;
      if (debug.enabled)
        debug.log('voice.discord.adapter', 'probe.miss', { err: String(err) });
    }
  }

  async function joinChannel(opts: DiscordVoiceJoinOpts): Promise<DiscordVoiceChannelSession> {
    await probe();
    if (unavailableReason || !voiceModule) {
      throw new DiscordVoiceUnavailableError(
        unavailableReason ?? '@discordjs/voice not loaded',
      );
    }
    if (activeSession) {
      // joinChannel is one-session-at-a-time per adapter; tear down
      // the previous before opening a new one (mirrors stub behavior).
      await activeSession.leave();
      activeSession = null;
    }
    const adapterCreator = prodOpts.coordinator.createAdapterFor(opts.guildId);
    const connection = voiceModule.joinVoiceChannel({
      channelId: opts.channelId,
      guildId: opts.guildId,
      adapterCreator,
      selfMute: opts.selfMute ?? false,
      selfDeaf: opts.selfDeaf ?? false,
    });
    const session = createProductionSession(connection, voiceModule, opusFactory, opts);
    activeSession = session;
    session.onTerminalCleanup(() => {
      if (activeSession === session) activeSession = null;
    });
    // Wait for Ready before returning — caller can start sending audio
    // immediately. 30 s window matches Discord's typical handshake max.
    try {
      await voiceModule.entersState(connection, voiceModule.VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      if (debug.enabled)
        debug.log('voice.discord.adapter', 'ready.timeout', { err: String(err) }, { level: 'warn' });
      try { await session.leave(); } catch { /* swallow */ }
      throw new DiscordVoiceUnavailableError(
        `voice channel did not reach Ready within 30s — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return session;
  }

  async function shutdown(): Promise<void> {
    if (activeSession) {
      await activeSession.leave();
      activeSession = null;
    }
    voiceModule = null;
    probed = false;
    prodOpts.coordinator.destroyAll();
  }

  return {
    get available() { return !unavailableReason; },
    get unavailableReason() { return unavailableReason; },
    joinChannel,
    shutdown,
  };
}

interface ProductionSession extends DiscordVoiceChannelSession {
  onTerminalCleanup(cb: () => void): void;
}

function createProductionSession(
  connection: DiscordVoiceConnectionLike,
  voiceModule: DiscordVoiceModule,
  opusFactory: OpusCodecFactory,
  joinOpts: DiscordVoiceJoinOpts,
): ProductionSession {
  let state: DiscordVoiceConnectionState = 'connecting';
  const audioSubs = new Set<(pcm: Buffer, userId: string) => void>();
  const stateSubs = new Set<(s: DiscordVoiceConnectionState) => void>();
  const terminalCleanupSubs = new Set<() => void>();
  let outboundPcm: PassThrough | null = null;
  // Odd trailing byte of a mid-sample-split TTS chunk, prepended to
  // the next sendAudio call (int16 alignment across stream chunks).
  let sendRemainder: Buffer | null = null;
  // AudioPlayer default kills playback after 5 consecutive missed
  // frames (100 ms of underflow) — TTS chunk/sentence gaps routinely
  // exceed that, which silently dropped ALL subsequent audio (M4c
  // dogfood 2026-07-12: "인식은 되는데 음성 응답이 안 들림"). Tolerate
  // 5 s of underflow (silence frames are transmitted meanwhile), and
  // if the player still idles, sendAudio() rebuilds the pipeline.
  const player = voiceModule.createAudioPlayer({
    behaviors: { maxMissedFrames: 250 },
  });
  let playerIdle = false;
  player.on('stateChange', (...args: unknown[]) => {
    const from = (args[0] as { status?: string } | undefined)?.status;
    const to = (args[1] as { status?: string } | undefined)?.status;
    if (typeof to === 'string') playerIdle = to === 'idle';
    if (debug.enabled)
      debug.log('voice.discord.adapter', 'player.state', { from, to });
  });
  player.on('error', (err: unknown) => {
    if (debug.enabled)
      debug.log('voice.discord.adapter', 'player.error', { err: String(err) }, { level: 'error' });
  });
  let playerSub: { unsubscribe(): void } | undefined;
  // Per-speaker decoder pipelines so we can multiplex multiple users.
  const speakerStreams = new Map<string, { input: Readable; cleanup: () => void }>();
  let teardown = false;

  function setState(next: DiscordVoiceConnectionState): void {
    if (state === next) return;
    state = next;
    for (const cb of stateSubs) {
      try { cb(next); } catch { /* isolation */ }
    }
    if (next === 'disconnected') {
      for (const cb of terminalCleanupSubs) {
        try { cb(); } catch { /* isolation */ }
      }
    }
  }

  // Wire connection lifecycle → DiscordVoiceConnectionState.
  const VCS = voiceModule.VoiceConnectionStatus;
  connection.on('stateChange', (...args: unknown[]) => {
    const next = (args[1] as { status?: string } | undefined)?.status;
    if (typeof next !== 'string') return;
    if (next === VCS.Ready) setState('ready');
    else if (next === VCS.Connecting || next === VCS.Signalling) setState('connecting');
    else if (next === VCS.Disconnected) {
      // Auto-reconnect: give the gateway 5 s to re-issue Ready before
      // tearing down. Matches ROADMAP §7.3 reconnect spec.
      setState('reconnecting');
      Promise.race([
        voiceModule.entersState(connection, VCS.Signalling, 5_000),
        voiceModule.entersState(connection, VCS.Connecting, 5_000),
      ]).catch(() => {
        try { connection.destroy(); } catch { /* swallow */ }
        setState('disconnected');
      });
    } else if (next === VCS.Destroyed) setState('disconnected');
  });

  // Subscribe to receiver — audio in path. Discord's speaking events
  // mark when a user starts/stops talking; we open a per-speaker
  // subscription on `start` and tear it down on `end` (AfterSilence).
  function attachSpeaker(userId: string): void {
    if (speakerStreams.has(userId)) return;
    if (joinOpts.listenFilterUserId && userId !== joinOpts.listenFilterUserId) return;
    if (joinOpts.selfDeaf) return;
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: voiceModule.EndBehaviorType.AfterSilence,
        duration: 500,
      },
    });
    const decoder = opusFactory.createDecoder();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { (opusStream as Readable & { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
      try { (decoder as NodeJS.ReadWriteStream & { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
      speakerStreams.delete(userId);
    };
    opusStream.on('error', (err) => {
      if (debug.enabled)
        debug.log('voice.discord.adapter', 'recv.error', { userId, err: String(err) }, { level: 'error' });
      cleanup();
    });
    opusStream.on('end', cleanup);
    decoder.on('data', (chunk: Buffer) => {
      const mono16k = pcm48kStereoTo16kMono(chunk);
      if (mono16k.length === 0) return;
      for (const cb of audioSubs) {
        try { cb(mono16k, userId); } catch { /* isolation */ }
      }
    });
    (opusStream as Readable & { pipe: (dest: NodeJS.WritableStream) => void }).pipe(decoder as unknown as NodeJS.WritableStream);
    speakerStreams.set(userId, { input: opusStream, cleanup });
  }

  connection.receiver.speaking.on('start', (userId) => attachSpeaker(userId));
  // 'end' is informational — AfterSilence in `subscribe()` already
  // takes care of stream teardown.

  // Outbound: lazily create a PassThrough + Encoder + AudioResource the
  // first time sendAudio is called. Re-create after stop/idle so the
  // next utterance starts cleanly.
  function ensureOutbound(): PassThrough {
    if (outboundPcm) return outboundPcm;
    const pcm48Stereo = new PassThrough();
    const encoder = opusFactory.createEncoder();
    // Outbound observability (M4c dogfood) — the chain fails SILENTLY
    // when a stage stalls, so surface stream errors. NOTE: never attach
    // a 'data' listener here — it flips the encoder into flowing mode
    // and starves the AudioResource's pull-based read() (실측: player가
    // 무음 프레임만 읽고 180ms 만에 idle).
    encoder.on('error', (err: unknown) => {
      if (debug.enabled)
        debug.log('voice.discord.adapter', 'send.encoder.error', { err: String(err) }, { level: 'error' });
    });
    pcm48Stereo.on('error', (err: unknown) => {
      if (debug.enabled)
        debug.log('voice.discord.adapter', 'send.pcm.error', { err: String(err) }, { level: 'error' });
    });
    pcm48Stereo.pipe(encoder as unknown as NodeJS.WritableStream);
    // prism's opus.Encoder emits RAW Opus frames (one packet per data
    // event) — StreamType.Opus. Declaring OggOpus routed the frames
    // through an OggDemuxer which crashed on the missing `OggS` magic
    // (real-device smoke 2026-07-12).
    const resource = voiceModule.createAudioResource(
      encoder as unknown as Readable,
      { inputType: voiceModule.StreamType.Opus },
    );
    player.play(resource);
    if (!playerSub) playerSub = connection.subscribe(player) ?? undefined;
    pcm48Stereo.on('end', () => {
      // Reset so the next sendAudio creates a fresh resource — avoids
      // the AudioPlayer staying stuck on a finished resource.
      if (outboundPcm === pcm48Stereo) outboundPcm = null;
    });
    outboundPcm = pcm48Stereo;
    return pcm48Stereo;
  }

  return {
    sendAudio(pcm) {
      if (state !== 'ready' || teardown) return;
      // Sample-alignment carry — TTS providers stream raw HTTP body
      // chunks with ARBITRARY byte boundaries (openai-tts yields
      // response.body chunks as-is). A chunk that splits a 16-bit
      // sample shifts every subsequent read by one byte and the rest
      // of the utterance becomes loud static (실기기 dogfood
      // 2026-07-12: "5초 후부터 엄청난 노이즈"). Carry the odd byte
      // into the next chunk so int16 alignment survives chunking.
      let aligned = pcm;
      if (sendRemainder) {
        aligned = Buffer.concat([sendRemainder, aligned]);
        sendRemainder = null;
      }
      if (aligned.length % 2 === 1) {
        sendRemainder = Buffer.from(aligned.subarray(aligned.length - 1));
        aligned = aligned.subarray(0, aligned.length - 1);
      }
      const pcm48Stereo = pcm24kMonoTo48kStereo(aligned);
      if (pcm48Stereo.length === 0) return;
      // Player idled (extended underflow / previous utterance drained)
      // ⇒ the old resource is dead; writing into it would be silently
      // discarded. Rebuild the PassThrough→encoder→resource pipeline.
      if (outboundPcm && playerIdle) {
        const stale = outboundPcm;
        outboundPcm = null;
        try { stale.end(); } catch { /* already dead */ }
        if (debug.enabled)
          debug.log('voice.discord.adapter', 'send.pipeline.rebuild', {});
      }
      try {
        ensureOutbound().write(pcm48Stereo);
      } catch (err) {
        if (debug.enabled)
          debug.log('voice.discord.adapter', 'send.error', { err: String(err) }, { level: 'error' });
      }
    },
    onAudioReceived(cb) {
      audioSubs.add(cb);
      return () => { audioSubs.delete(cb); };
    },
    onStateChange(cb) {
      stateSubs.add(cb);
      return () => { stateSubs.delete(cb); };
    },
    getState: () => state,
    stopPlayback() {
      // Barge-in / turn supersede — kill current + queued audio NOW.
      // player.stop(true) → Idle → playerIdle=true, so the next
      // sendAudio rebuilds a fresh pipeline.
      if (debug.enabled) debug.log('voice.discord.adapter', 'playback.stop', {});
      const stale = outboundPcm;
      outboundPcm = null;
      try { stale?.end(); } catch { /* already dead */ }
      try { player.stop(true); } catch { /* swallow */ }
    },
    async leave() {
      if (teardown) return;
      teardown = true;
      try { player.stop(true); } catch { /* swallow */ }
      try { playerSub?.unsubscribe?.(); } catch { /* swallow */ }
      try { outboundPcm?.end(); } catch { /* swallow */ }
      for (const [, entry] of speakerStreams) {
        try { entry.cleanup(); } catch { /* isolation */ }
      }
      speakerStreams.clear();
      try { connection.destroy(); } catch { /* swallow */ }
      setState('disconnected');
      audioSubs.clear();
      stateSubs.clear();
    },
    onTerminalCleanup(cb) { terminalCleanupSubs.add(cb); },
  };
}

// ── Env gate ───────────────────────────────────────────────────────

export function isDiscordVoiceChannelEnabled(): boolean {
  const cfgEnabled = getUserConfig().voice.discord.voiceChannel?.enabled;
  if (typeof cfgEnabled === 'boolean') return cfgEnabled;
  const raw = process.env.ELANOUS_DISCORD_VOICE_CHANNEL?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export function resolveDiscordVoiceChannelListenFilter(): VoiceDiscordChannelListenFilter {
  const fromConfig = getUserConfig().voice.discord.voiceChannel?.listenFilter;
  if (fromConfig === 'caller' || fromConfig === 'all') return fromConfig;
  const raw = process.env.ELANOUS_DISCORD_VOICE_LISTEN_FILTER?.trim().toLowerCase();
  if (raw === 'all') return 'all';
  if (raw === 'caller') return 'caller';
  return VOICE_HARDCODED_DEFAULTS.discordVoiceChannelListenFilter;
}

export function shouldDiscordVoiceChannelLeaveOnEmpty(): boolean {
  const fromConfig = getUserConfig().voice.discord.voiceChannel?.leaveOnEmpty;
  if (typeof fromConfig === 'boolean') return fromConfig;
  const raw = process.env.ELANOUS_DISCORD_VOICE_LEAVE_ON_EMPTY?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return VOICE_HARDCODED_DEFAULTS.discordVoiceChannelLeaveOnEmpty;
}
