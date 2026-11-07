// PR-S1V.12 (Phase 6 wire · 2026-04-30) — Discord voice channel ↔
// elanous harness round-trip.
//
// onSessionStart hook (from `bootDiscordVoiceChannel`) calls
// `wireDiscordSessionToHarness({...})` which:
//   1. opens a streaming-STT session (Phase 3 provider abstraction)
//   2. forwards `session.onAudioReceived(pcm16k, userId)` to STT
//   3. on `onFinal(transcript)` → `runHarness(transcript)` callback
//   4. response stream chunks → TTS provider (Phase 1) → 24 kHz mono
//      PCM → `session.sendAudio()` (the adapter handles the 24k → 48k
//      stereo Opus encode for Discord)
//   5. session lifecycle teardown drains all of the above
//
// This module is intentionally framework-agnostic: the harness call is
// passed in by the caller (typically `src/index.ts` for the Discord
// bot boot path, which routes to `runAcpTurn` against the in-process
// ACP server). Tests and dogfood inject simpler mock harnesses.
//
// Reference: ROADMAP §7.3 (Phase 6D · elanous harness integration).

import { Buffer } from 'node:buffer';
import { debug } from '../../debug/log.js';
import { createSentenceSegmenter } from '../tts/sentence-segmenter.js';
import {
  buildTurnOutputTextBlocks,
} from '../../input/turn-output-block.js';
import { selectTurnOutputTextForSink } from '../../input/turn-output-sink-registry.js';
import {
  createStreamingSTTProvider,
  resolveStreamingSTTProviderIdFromEnv,
  type StreamingSTTProvider,
  type StreamingSTTProviderId,
  type StreamingSTTSession,
} from '../streaming-stt/streaming-stt-provider.js';
import { createVadDetector } from '../streaming-stt/streaming-stt-vad.js';
import {
  createTTSProvider,
  resolveTTSProviderIdFromEnv,
  type TTSProvider,
} from '../tts/tts-provider.js';
import {
  getDaemonStreamingSttProvider,
  initDaemonStreamingSttProvider,
} from '../voice-streaming-stt-singleton.js';
import {
  getDaemonTtsProvider,
  initDaemonTtsProvider,
} from '../voice-tts-singleton.js';
import type { DiscordVoiceChannelSession, DiscordVoiceJoinOpts } from './discord-voice-channel-adapter.js';
import { createDiscordVoiceEchoClassifier } from './discord-voice-echo-classifier.js';
import { pcm16kMonoTo24kMono, pcm24kMonoTo16kMono } from './discord-voice-resample.js';

export interface DiscordHarnessRunResponse {
  /** Streaming chunk callback — fires for every assistant text delta.
   *  The caller is expected to keep deltas short (sentence-aware) so
   *  the TTS provider can stream cleanly. */
  onChunk: (delta: string) => void | Promise<void>;
  /** Fires once the assistant turn finishes (success or error). */
  onDone: (reason: 'end_turn' | 'cancelled' | 'error') => void | Promise<void>;
}

export interface DiscordTranscriptHookCtx {
  userId: string | null;
  joinOpts: DiscordVoiceJoinOpts;
}

/** Caller-supplied harness adapter. Returns a promise that resolves
 *  when the assistant response completes. The adapter writes deltas
 *  into `cb.onChunk` and signals completion via `cb.onDone`. */
export type DiscordHarnessRunner = (
  transcript: string,
  ctx: { userId: string | null; joinOpts: DiscordVoiceJoinOpts },
  cb: DiscordHarnessRunResponse,
) => Promise<void>;

export interface WireDiscordSessionDeps {
  /** Active Discord voice session — already in `ready` state. */
  session: DiscordVoiceChannelSession;
  /** Join options (used for caller-only filter + harness ctx). */
  joinOpts: DiscordVoiceJoinOpts;
  /** Caller-supplied harness runner. */
  runHarness: DiscordHarnessRunner;
  /** Optional logger — defaults to console.log. */
  log?: (msg: string) => void;
  /** Optional sentence flush cap shared with dashboard auto-TTS. */
  ttsMaxSentenceChars?: number;
  onPartialTranscript?: (
    partial: string,
    ctx: DiscordTranscriptHookCtx,
  ) => void | Promise<void>;
  onFinalTranscript?: (
    final: string,
    ctx: DiscordTranscriptHookCtx,
  ) => void | Promise<void>;
  onAssistantTranscript?: (
    delta: string,
    full: string,
    ctx: DiscordTranscriptHookCtx,
  ) => void | Promise<void>;
  onTurnComplete?: (
    reason: 'end_turn' | 'cancelled' | 'error',
    ctx: DiscordTranscriptHookCtx,
  ) => void | Promise<void>;
  /** Optional short-circuit hook for transcripts that should not run a
   *  normal ACP turn (for example spoken intake commands). When it
   *  returns a reply string, the harness speaks that text directly and
   *  skips `runHarness`. */
  interceptTranscript?: (
    transcript: string,
    ctx: DiscordTranscriptHookCtx,
  ) => Promise<string | null> | string | null;
  /** ISO 639-1 STT language hint (e.g. 'ko') — forwarded to the
   *  streaming-STT session. Wire from `voice.discord.voiceLanguage`. */
  sttLanguage?: string;
  /** Discord-scoped STT provider override (`voice.discord.sttProvider`
   *  — config화 2026-07-12). Set 이면 데몬 싱글톤 대신 전용 인스턴스를
   *  생성해 이 서피스만 다른 provider 를 쓴다 (TUI 는 전역 체인 유지 —
   *  싱글톤 캐시를 오염시키지 않기 위해 별도 생성). */
  sttProviderId?: StreamingSTTProviderId;
  /** Half-duplex tail (ms) — inbound audio is ignored while the bot's
   *  own TTS is audibly playing PLUS this margin, so speaker echo of
   *  the bot's voice can't re-enter STT and interrupt the utterance
   *  (실기기 dogfood 2026-07-12: "자기 목소리를 다시 청취 → 발화 중단").
   *  Default 350. Trade-off: no barge-in during bot speech (v1). */
  selfEchoTailMs?: number;
  /** Barge-in mode (industry pattern: 재생 중에도 청취, 지속 발화만
   *  인터럽트로 인정 — AEC 없는 환경 절충). When true, inbound audio
   *  during bot playback is NOT dropped outright: sustained speech
   *  (≥ bargeInSustainMs of near-continuous packets) stops playback
   *  (session.stopPlayback) and the utterance flows to STT. Echo
   *  guard: finals that fuzzy-match the bot's own recent speech are
   *  discarded. Best with user-side echo cancellation / earphones.
   *  Wire from env `ELANOUS_VOICE_BARGE_IN`. Default false (half-duplex). */
  bargeIn?: boolean;
  /** Sustained-speech threshold for barge-in (ms). Default 350. */
  bargeInSustainMs?: number;
  /** RMS threshold (0-1) for the barge-in energy VAD. Default 0.012
   *  (streaming-stt-vad 표준 — TUI barge-in 기사용 값). 갭 #4 (2026-07-12):
   *  패킷 도착 카운트는 키보드/배경소음도 지속발화로 통과시켰다 — 에너지
   *  게이트가 진짜 음성만 인터럽트로 인정한다. */
  bargeInVadThreshold?: number;
  /** Reference-signal echo classifier (barge-in mode only). Compares
   *  inbound frames against the bot's own recently played TTS via
   *  normalized cross-correlation — frames that match are speaker
   *  echo and are dropped BEFORE the sustain gate, so echo can never
   *  fake an interruption regardless of its duration. Default true
   *  when bargeIn is on. */
  echoClassifier?: boolean;
  /** Silence gap (ms) after the last inbound audio chunk before the
   *  STT session is force-finalized. Discord stops SENDING packets on
   *  silence (the gap never reaches the STT server's audio timeline),
   *  so server-side VAD alone cannot detect end-of-utterance — finals
   *  arrive late/merged or never (실기기 dogfood 2026-07-12). Default
   *  700 ms. */
  sttSilenceFinalizeMs?: number;
  /** Test seam — override STT provider factory. */
  __sttProviderFactory?: () => StreamingSTTProvider;
  /** Test seam — override TTS provider factory. */
  __ttsProviderFactory?: () => TTSProvider;
}

export interface WireDiscordSessionHandle {
  /** Tear down STT session + flush in-flight TTS. */
  shutdown(): Promise<void>;
}

export function wireDiscordSessionToHarness(
  deps: WireDiscordSessionDeps,
): WireDiscordSessionHandle {
  // LF2 — 실패 경로가 '[voice.discord]' 원시 콘솔로만 새던 것을 이중화.
  const log = deps.log ?? ((m) => { console.log(m); debug.log('voice.discord.harness', m); });

  // Provider creation is async (factories lazy-load provider impls);
  // resolve them once on the first incoming audio chunk and cache the
  // promises so subsequent calls await the same instance.
  let sttProviderPromise: Promise<StreamingSTTProvider> | null = null;
  let ttsProviderPromise: Promise<TTSProvider> | null = null;
  function getStt(): Promise<StreamingSTTProvider> {
    if (!sttProviderPromise) {
      // 데몬 STT 싱글톤 우선 (config화 2026-07-12) — TTS 와 동일 패턴.
      // 싱글톤 resolver 가 user-config `voice.stt.provider/model/…` 를
      // 읽으므로 디스코드 경로도 config 가 발효된다. bare env 해석은
      // 싱글톤 init 실패 시의 최후 fallback 뿐.
      sttProviderPromise = deps.__sttProviderFactory
        ? Promise.resolve(deps.__sttProviderFactory())
        : deps.sttProviderId
          // Discord-scoped override — dedicated instance, singleton untouched.
          ? createStreamingSTTProvider({ id: deps.sttProviderId })
          : (async () => {
              const shared = getDaemonStreamingSttProvider();
              if (shared) return shared;
              const initialized = await initDaemonStreamingSttProvider();
              if (initialized) return initialized;
              return createStreamingSTTProvider({ id: resolveStreamingSTTProviderIdFromEnv() });
            })();
    }
    return sttProviderPromise;
  }
  function getTts(): Promise<TTSProvider> {
    if (!ttsProviderPromise) {
      ttsProviderPromise = deps.__ttsProviderFactory
        ? Promise.resolve(deps.__ttsProviderFactory())
        : (async () => {
            const shared = getDaemonTtsProvider();
            if (shared) return shared;
            const initialized = await initDaemonTtsProvider();
            if (initialized) return initialized;
            return createTTSProvider({ id: resolveTTSProviderIdFromEnv() });
          })();
    }
    return ttsProviderPromise;
  }

  // Per-speaker STT session — for v1 we run a single-user pipeline
  // (the caller filter is enforced by the adapter so only one speaker
  // ever reaches `onAudioReceived`). Multi-user mode is a future add
  // (per-user session map keyed by userId).
  //
  // Memoize the open PROMISE, not the resolved session: audio packets
  // arrive every 20 ms while openSession takes hundreds of ms — caching
  // only the resolved session let every packet in that window open
  // ANOTHER session, scattering one utterance across a dozen parallel
  // sessions (실기기 dogfood 2026-07-12: 12 sessions in 200 ms →
  // "STT 인식을 거의 못함").
  let sttSessionPromise: Promise<StreamingSTTSession> | null = null;
  let activeUserId: string | null = null;
  let teardown = false;
  let inFlightHarness: Promise<void> | null = null;

  function ensureSttSession(userId: string): Promise<StreamingSTTSession> {
    if (sttSessionPromise && activeUserId === userId) return sttSessionPromise;
    const stale = sttSessionPromise;
    if (stale) {
      void stale.then((s) => s.abort()).catch(() => { /* already dead */ });
    }
    activeUserId = userId;
    sttSessionPromise = openSttSession(userId);
    return sttSessionPromise;
  }

  async function openSttSession(userId: string): Promise<StreamingSTTSession> {
    const stt = await getStt();
    const opened = await stt.openSession({
      ...(deps.sttLanguage ? { language: deps.sttLanguage } : {}),
      onPartial: (partial: string) => {
        if (debug.enabled)
          debug.log('voice.discord.harness', 'stt.partial', { userId, partial });
        try {
          void deps.onPartialTranscript?.(partial, { userId, joinOpts: deps.joinOpts });
        } catch { /* isolate transcript mirrors */ }
      },
      onFinal: (final: string) => {
        if (debug.enabled)
          debug.log('voice.discord.harness', 'stt.final', { userId, final });
        try {
          void deps.onFinalTranscript?.(final, { userId, joinOpts: deps.joinOpts });
        } catch { /* isolate transcript mirrors */ }
        const trimmed = final.trim();
        if (!trimmed) return;
        // Echo guard (barge-in mode) — a "user" utterance that matches
        // the bot's own recent speech is its echo, not a command.
        if (bargeIn && looksLikeOwnEcho(trimmed)) {
          if (debug.enabled)
            debug.log('voice.discord.harness', 'stt.final.echo-dropped', { chars: trimmed.length });
          return;
        }
        // One speaking turn at a time — a genuine new utterance takes
        // the floor from whatever is still playing.
        supersedeActiveTurn();
        const hookCtx = { userId, joinOpts: deps.joinOpts };
        if (deps.interceptTranscript) {
          inFlightHarness = (async () => {
            const intercepted = await deps.interceptTranscript?.(trimmed, hookCtx);
            if (intercepted == null || !intercepted.trim()) {
              await runHarnessTurn(trimmed, userId);
              return;
            }
            await runSynthOnlyTurn(intercepted, userId);
          })().catch((err: unknown) => {
            log(`[voice.discord] transcript intercept failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return;
        }
        // Run harness — chunked response goes back through TTS.
        inFlightHarness = runHarnessTurn(trimmed, userId).catch((err: unknown) => {
          log(`[voice.discord] harness turn failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      onError: (err: unknown) => {
        log(`[voice.discord] STT error: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    // ── Provider-format 적응 (2026-07-12 실측) ──────────────────────
    // 디스코드 인바운드는 16k mono 인데 openai-realtime 은 24 kHz 세션
    // (`rate: 24000`)이다. 16k 를 그대로 밀면 서버가 1.5배 빨리감기로
    // 해석해 핵심 어휘가 깨진다 (라이브 프로브: "스냅샷인지 델타인지" →
    // "쓰립시하신지 데이터인지" / 업샘플 후 완벽 전사). provider 선언
    // 포맷이 24k 면 push 경계에서 2:3 업샘플. scribe(16k)는 그대로.
    if (stt.format?.sampleRate === 24_000) {
      if (debug.enabled)
        debug.log('voice.discord.harness', 'stt.resample', { from: 16_000, to: 24_000, providerId: stt.id });
      return { ...opened, pushAudio: (pcm: Buffer) => { opened.pushAudio(pcm16kMonoTo24kMono(pcm)); } };
    }
    return opened;
  }

  // ── Half-duplex speaking gate ────────────────────────────────────
  // Track how long the bot's queued TTS audio will remain audible in
  // the channel (24 kHz mono s16 ⇒ 48 bytes/ms). While that horizon
  // (plus a tail margin) is in the future, inbound audio is dropped —
  // otherwise the bot's own voice echoes back through the user's mic,
  // STT transcribes it, and the resulting turn interrupts playback.
  const selfEchoTailMs = deps.selfEchoTailMs ?? 350;
  let playbackHorizonMs = 0;
  function noteSpokenPcm(pcm: Buffer): void {
    const durationMs = pcm.length / 48;
    playbackHorizonMs = Math.max(playbackHorizonMs, Date.now()) + durationMs;
    // Feed the echo classifier's reference window (24k → inbound 16k).
    echoClassifier?.noteReference(pcm24kMonoTo16kMono(pcm));
  }
  function isBotSpeaking(): boolean {
    return Date.now() < playbackHorizonMs + selfEchoTailMs;
  }

  // ── Turn supersede ───────────────────────────────────────────────
  // Only ONE turn may speak at a time. A new final while a turn is
  // still speaking bumps the epoch: the old turn's queued sentences
  // stop sending, and stopPlayback() kills whatever the adapter has
  // buffered (실기기 dogfood 2026-07-12: "새 Q&A가 시작돼도 이전 발화가
  // 안 멈추고 두 개가 따로 놂").
  let turnEpoch = 0;
  // Rolling window of the bot's recently spoken text — echo guard for
  // barge-in mode (self-transcript similarity: AEC 없는 환경에서 자기
  // 발화 에코가 STT를 통과해도 여기서 폐기).
  let recentSpokenText = '';
  function noteSpokenText(text: string): void {
    recentSpokenText = (recentSpokenText + ' ' + text).slice(-600);
  }
  function normalizeForEchoMatch(s: string): string {
    return s.toLowerCase().replace(/[\s.,!?~…·'"“”‘’()\-]/g, '');
  }
  function looksLikeOwnEcho(final: string): boolean {
    const f = normalizeForEchoMatch(final);
    if (f.length < 4) return false;
    return normalizeForEchoMatch(recentSpokenText).includes(f);
  }
  function supersedeActiveTurn(): void {
    turnEpoch += 1;
    playbackHorizonMs = 0;
    try { deps.session.stopPlayback?.(); } catch { /* best-effort */ }
  }

  // ── Reference-signal echo classifier (AEC-lite) ──────────────────
  const bargeIn = deps.bargeIn ?? false;
  const useEchoClassifier = bargeIn && (deps.echoClassifier ?? true);
  const echoClassifier = useEchoClassifier ? createDiscordVoiceEchoClassifier() : null;

  // ── Barge-in sustained-speech detector (energy VAD · 갭 #4) ──────
  // 기존 패킷 도착 카운트(≥350ms 연속 수신 = 발화)는 Discord 클라이언트가
  // 소음 게이트를 열어주는 한 키보드 타건·배경소음도 통과시켰다. RMS
  // 에너지 VAD (streaming-stt-vad.ts — TUI barge-in 이 이미 쓰는 검출기)
  // 로 교체: 임계 이상 에너지가 sustainMs 누적돼야 인터럽트로 인정.
  const bargeInSustainMs = deps.bargeInSustainMs ?? 350;
  const bargeVad = bargeIn
    ? createVadDetector({
        sampleRate: 16000,
        minSpeechMs: bargeInSustainMs,
        // 재생 중 게이트라 speech-end 은 쓰지 않지만, 낮은 에너지가
        // sustain 길이만큼 이어지면 다음 판정을 위해 상태가 풀리도록.
        silenceMs: bargeInSustainMs,
        ...(deps.bargeInVadThreshold !== undefined ? { threshold: deps.bargeInVadThreshold } : {}),
      })
    : null;
  let bargeWindowLast = 0;
  /** Returns true when inbound audio during playback should flow to
   *  STT (sustained speech ⇒ interrupt). False ⇒ drop the packet. */
  function bargeInAdmit(pcm: Buffer): boolean {
    if (!bargeVad) return false;
    const now = Date.now();
    // >250 ms packet gap — Discord 는 침묵 중 패킷을 안 보내므로 VAD 의
    // 시간축이 얼어붙는다 (G-VOX-6 역방향). 새 발화 창으로 리셋해 이전
    // 창의 in-speech 잔상이 즉시 인터럽트로 오인되지 않게 한다.
    if (now - bargeWindowLast > 250) bargeVad.reset();
    bargeWindowLast = now;
    bargeVad.push(pcm);
    if (!bargeVad.isInSpeech()) return false;
    // Sustained above-threshold speech during playback — genuine
    // interruption.
    if (debug.enabled)
      debug.log('voice.discord.harness', 'barge.in', {
        sustainMs: bargeInSustainMs,
        rms: Number(bargeVad.lastRms().toFixed(4)),
      });
    supersedeActiveTurn();
    return true;
  }

  // ── Silence-gap finalize ─────────────────────────────────────────
  // Discord only ships packets WHILE the user speaks; the silence
  // afterwards never enters the STT audio timeline, so server VAD
  // can't close the turn. Detect the gap client-side: N ms without a
  // chunk ⇒ finalize (emits onFinal); the next chunk opens a fresh
  // session.
  const silenceFinalizeMs = deps.sttSilenceFinalizeMs ?? 700;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  function armSilenceFinalize(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      const p = sttSessionPromise;
      if (!p || teardown) return;
      sttSessionPromise = null; // next audio chunk reopens a fresh session
      if (debug.enabled)
        debug.log('voice.discord.harness', 'stt.silence.finalize', { gapMs: silenceFinalizeMs });
      void p.then((s) => s.finalize()).catch((err: unknown) => {
        log(`[voice.discord] STT finalize failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, silenceFinalizeMs);
  }

  // ── Audio in: pcm16k → STT push ────────────────────────────────
  const unsubAudio = deps.session.onAudioReceived((pcm, userId) => {
    if (teardown) return;
    if (deps.joinOpts.listenFilterUserId && userId !== deps.joinOpts.listenFilterUserId) return;
    // While the bot is audibly speaking: half-duplex drops inbound
    // outright; barge-in mode first discards frames the classifier
    // recognizes as the bot's own echo, then admits only sustained
    // (non-echo) speech — which stops playback so the user takes the
    // floor.
    if (isBotSpeaking()) {
      if (!bargeIn) return;
      if (echoClassifier?.hasReference()) {
        const verdict = echoClassifier.classify(pcm);
        if (verdict.echo) {
          if (debug.enabled)
            debug.log('voice.discord.harness', 'aec.echo-dropped', { ncc: Number(verdict.ncc.toFixed(3)), lagMs: verdict.lagMs });
          return;
        }
      }
      if (!bargeInAdmit(pcm)) return;
    }
    armSilenceFinalize();
    void ensureSttSession(userId)
      .then((s) => s.pushAudio(pcm))
      .catch((err) => {
        log(`[voice.discord] STT pushAudio failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  async function runHarnessTurn(transcript: string, userId: string): Promise<void> {
    // Buffer text deltas into sentence-sized chunks for TTS so Discord
    // doesn't synthesize every tiny LLM delta independently.
    let cancelled = false;
    let assistantFull = '';
    let pending: Promise<void> = Promise.resolve();
    const segmenter = createSentenceSegmenter({
      ...(deps.ttsMaxSentenceChars !== undefined
        ? { maxSentenceChars: deps.ttsMaxSentenceChars }
        : {}),
    });
    // Epoch snapshot — a newer final supersedes this turn: queued
    // sentences stop sending the moment the epoch moves on.
    const epoch = turnEpoch;
    const speakChunk = async (text: string): Promise<void> => {
      if (cancelled || teardown || epoch !== turnEpoch || !text.trim()) return;
      const speakableText = selectTurnOutputTextForSink(
        'audio-tts',
        buildTurnOutputTextBlocks(text),
      ) ?? text;
      noteSpokenText(speakableText);
      try {
        const tts = await getTts();
        if (tts.synthesizeStream) {
          for await (const chunk of tts.synthesizeStream(speakableText, {})) {
            if (cancelled || teardown || epoch !== turnEpoch) break;
            if (chunk.pcm.length > 0) {
              noteSpokenPcm(chunk.pcm);
              deps.session.sendAudio(Buffer.from(chunk.pcm));
            }
          }
        } else {
          const { pcm } = await tts.synthesizeBatch(speakableText, {});
          if (!cancelled && !teardown && epoch === turnEpoch) {
            noteSpokenPcm(pcm);
            deps.session.sendAudio(Buffer.from(pcm));
          }
        }
      } catch (err) {
        log(`[voice.discord] TTS chunk failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    let completionReason: 'end_turn' | 'cancelled' | 'error' = 'end_turn';
    await deps.runHarness(transcript, {
      userId,
      joinOpts: deps.joinOpts,
    }, {
      onChunk: (delta) => {
        assistantFull += delta;
        try {
          void deps.onAssistantTranscript?.(delta, assistantFull, {
            userId,
            joinOpts: deps.joinOpts,
          });
        } catch { /* isolate transcript mirrors */ }
        const sentences = segmenter.feed(delta);
        for (const sentence of sentences) {
          // Serialize TTS chunks so they hit the wire in order even when
          // the caller emits deltas faster than synthesis completes.
          pending = pending.then(() => speakChunk(sentence));
        }
      },
      onDone: (reason) => {
        completionReason = reason;
        if (reason !== 'end_turn') {
          cancelled = true;
          segmenter.reset();
          return;
        }
        const tail = segmenter.flushRemainder();
        for (const sentence of tail) {
          pending = pending.then(() => speakChunk(sentence));
        }
      },
    });
    await pending;
    try {
      await deps.onTurnComplete?.(completionReason, {
        userId,
        joinOpts: deps.joinOpts,
      });
    } catch { /* isolate transcript mirrors */ }
  }

  async function runSynthOnlyTurn(replyText: string, userId: string): Promise<void> {
    let assistantFull = '';
    let pending: Promise<void> = Promise.resolve();
    const segmenter = createSentenceSegmenter({
      ...(deps.ttsMaxSentenceChars !== undefined
        ? { maxSentenceChars: deps.ttsMaxSentenceChars }
        : {}),
    });
    const epoch = turnEpoch;
    const speakChunk = async (text: string): Promise<void> => {
      if (teardown || epoch !== turnEpoch || !text.trim()) return;
      const speakableText = selectTurnOutputTextForSink(
        'audio-tts',
        buildTurnOutputTextBlocks(text),
      ) ?? text;
      noteSpokenText(speakableText);
      try {
        const tts = await getTts();
        if (tts.synthesizeStream) {
          for await (const chunk of tts.synthesizeStream(speakableText, {})) {
            if (teardown || epoch !== turnEpoch) break;
            if (chunk.pcm.length > 0) {
              noteSpokenPcm(chunk.pcm);
              deps.session.sendAudio(Buffer.from(chunk.pcm));
            }
          }
        } else {
          const { pcm } = await tts.synthesizeBatch(speakableText, {});
          if (!teardown && epoch === turnEpoch) {
            noteSpokenPcm(pcm);
            deps.session.sendAudio(Buffer.from(pcm));
          }
        }
      } catch (err) {
        log(`[voice.discord] TTS chunk failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    assistantFull += replyText;
    try {
      await deps.onAssistantTranscript?.(replyText, assistantFull, {
        userId,
        joinOpts: deps.joinOpts,
      });
    } catch { /* isolate transcript mirrors */ }
    const sentences = segmenter.feed(replyText);
    for (const sentence of sentences) {
      pending = pending.then(() => speakChunk(sentence));
    }
    const tail = segmenter.flushRemainder();
    for (const sentence of tail) {
      pending = pending.then(() => speakChunk(sentence));
    }
    await pending;
    try {
      await deps.onTurnComplete?.('end_turn', {
        userId,
        joinOpts: deps.joinOpts,
      });
    } catch { /* isolate transcript mirrors */ }
  }

  async function shutdown(): Promise<void> {
    teardown = true;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    try { unsubAudio(); } catch { /* swallow */ }
    if (inFlightHarness) {
      try { await inFlightHarness; } catch { /* swallow */ }
    }
    const p = sttSessionPromise;
    sttSessionPromise = null;
    if (p) {
      try { await (await p).finalize(); } catch { /* swallow */ }
    }
  }

  return { shutdown };
}
