// ── Discord voice-channel wire — shared by discord-test + nexus (M4c) ──
//
// PLAN-multi-surface-pty-shell M4c: the missing production connector
// for the Phase-6 voice stack (dormant since 2026-04-30). Assembles,
// per bot process:
//
//   coordinator (voiceTap ↔ @discordjs/voice adapterCreator)
//     → bootDiscordVoiceChannel (env-gated production adapter)
//       → /voice-join·leave·status text dispatch (BEFORE the self turn)
//         → on join: wireDiscordSessionToHarness with the SAME self
//           turn the text path uses (makeDiscordAgentRunTurn — tools +
//           finance + delegate + M1 terminal layer), so voice turns
//           and text turns share brains, session memory conventions
//           and the PtyShell observation surface.
//
// Voice turn ↔ text turn parity notes:
//   - each /voice-join opens ONE chat session (origin 'dc', title
//     `dc-voice:<channel>`); STT finals run runTurnImpl against it so
//     multi-utterance context accumulates like a text chat.
//   - transcripts mirror into the text channel the command came from
//     (editable "hearing…" + assistant lines — discord-voice-text-mirror).
//   - PtyShellScreenshot PNGs / oversized tool bodies attach into the
//     same text channel via fileSinkForChannel (M2), so "터미널 관측"
//     stays visual while the summary is spoken.
//
// Guild/channel ergonomics: production's DM-only gate means the join
// command usually arrives WITHOUT guild_id, and users shouldn't need
// to paste snowflakes — the wire lazily discovers the bot's (single)
// guild + first voice channel via REST and caches the result, so a
// bare `/voice-join` just works in both DM and #elanous_test.
//
// Everything is inert unless ELANOUS_DISCORD_VOICE_CHANNEL (or
// `voice.discord.voiceChannel.enabled`) is on: voiceTap is null (no
// GUILD_VOICE_STATES intent change) and /voice-* replies explain the
// gate. Production behavior is unchanged until the operator opts in.

import type { UserConfig } from './user-config.js';
import { resolveChannelBotToken } from './channel-bot-token.js';
import type { runTurn } from './session/chat.js';
import type { DiscordBot, DcIncoming, DiscordVoiceDispatchTap } from './discord.js';
import { createSession } from './session/index.js';
import { debug } from './debug/log.js';
import {
  createDiscordVoiceGatewayCoordinator,
  type DiscordVoiceGatewayCoordinator,
} from './voice/channel-adapters/discord-voice-gateway-adapter.js';
import {
  bootDiscordVoiceChannel,
  type BootDiscordVoiceChannelResult,
} from './voice/channel-adapters/discord-voice-channel-host-boot.js';
import {
  isDiscordVoiceChannelEnabled,
  shouldDiscordVoiceChannelLeaveOnEmpty,
  type DiscordVoiceChannelAdapter,
  type DiscordVoiceChannelSession,
  type DiscordVoiceJoinOpts,
} from './voice/channel-adapters/discord-voice-channel-adapter.js';
import {
  wireDiscordSessionToHarness,
  type DiscordHarnessRunner,
  type WireDiscordSessionHandle,
} from './voice/channel-adapters/discord-voice-channel-harness.js';
import { createDiscordVoiceTextMirror, type DiscordVoiceTextMirror } from './voice/channel-adapters/discord-voice-text-mirror.js';
import { createDiscordVoiceChannelAutoLeaveMonitor } from './voice/channel-adapters/discord-voice-channel-auto-leave.js';
import type { StreamingSTTProvider } from './voice/streaming-stt/streaming-stt-provider.js';
import { readVadOptsFromEnv } from './voice/streaming-stt/streaming-stt-vad.js';
import type { TTSProvider } from './voice/tts/tts-provider.js';

const VOICE_PREFIX_RE = /^[/!]voice[-_]/;

/** 양의 정수 env 판독 — 미설정/비정상 값은 undefined (하네스 기본값 사용). */
function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
const VOICE_COMMAND_RE = /^[/!]voice[-_](join|leave|status)\b/;

/** V2 (2026-07-12) — 보이스 턴 발화 규율. self턴은 텍스트 턴과 같은
 *  브레인/도구를 쓰지만, 응답이 TTS로 낭독되므로 쓰기 방식이 달라야
 *  한다. 사후 발화 필터(buildSpeakableOutputText — 코드블록 제거·480자
 *  캡)는 안전망일 뿐 — 모델이 애초에 짧게 말하고 상세를 텍스트 미러/
 *  스크린샷으로 보내야 "말은 대화, 눈은 관측" 분업이 성립한다.
 *  monad-agent-turn이 opts.systemPrompt를 추가 파트로 합성하므로
 *  기존 오리엔테이션은 그대로 유지된다. */
export const DISCORD_VOICE_TURN_DISCIPLINE = [
  '## 디스코드 보이스 턴 규율',
  '지금 응답은 보이스 채널에서 음성(TTS)으로 낭독된다. 응답 전문은 텍스트 채널에 자동 미러되고, 스크린샷·파일도 그 채널에 첨부된다.',
  '- 말은 1~3문장, 결론부터. 480자를 넘기면 낭독이 잘린다.',
  '- 코드·로그·파일 경로·URL·표·긴 목록은 낭독 불가 — 말로 나열하지 말고 "자세한 내용은 텍스트 채널에 남겼습니다"라고 안내만 하라.',
  '- 터미널 작업을 보여줄 때는 PtyShellScreenshot을 찍어라(텍스트 채널에 자동 첨부). 말로는 "화면 올려뒀습니다" 수준으로 요약.',
  '- 작업이 길어지면 중간에 한 문장으로 진행 상황을 말하라. 긴 침묵 금지.',
].join('\n');
const VOICE_USAGE =
  '보이스 명령: `!voice-join [보이스채널ID] [caller|all]` (무인자 = 첫 보이스채널 자동) · `!voice-leave` · `!voice-status`';

export interface DiscordVoiceWireDeps {
  userConfig: UserConfig;
  /** The self turn (makeDiscordAgentRunTurn(cfg)) — SAME instance the
   *  text onMessage path uses, so voice and text stay congruent. */
  runTurnImpl: typeof runTurn;
  /** Late-bound bot ref (bot is constructed with the composed handler). */
  getBot: () => DiscordBot | null;
  log?: (msg: string) => void;
  /** Test seams — forwarded to bootDiscordVoiceChannel / harness wire. */
  __adapter?: DiscordVoiceChannelAdapter;
  __sttProviderFactory?: () => StreamingSTTProvider;
  __ttsProviderFactory?: () => TTSProvider;
  __fetchImpl?: typeof fetch;
}

export interface DiscordVoiceWire {
  /** Env-gate snapshot at build time. */
  enabled: boolean;
  /** Attach to DiscordBotOpts.voiceTap — null when the gate is off so
   *  the bot's intents stay untouched. */
  voiceTap: DiscordVoiceDispatchTap | null;
  /** Call from onMessage BEFORE the self/ACP handler. Returns the
   *  reply for /voice-* commands, or null to fall through. */
  dispatchVoiceCommand: (ctx: DcIncoming) => Promise<string | null>;
  shutdown: () => Promise<void>;
}

export function buildDiscordVoiceWire(deps: DiscordVoiceWireDeps): DiscordVoiceWire {
  const log = deps.log ?? ((m: string): void => { console.log(m); });
  const cfg = deps.userConfig;
  const fetchImpl = deps.__fetchImpl ?? fetch;
  const enabled = isDiscordVoiceChannelEnabled();

  const coordinator: DiscordVoiceGatewayCoordinator = createDiscordVoiceGatewayCoordinator({
    sendPayload: (p) => deps.getBot()?.sendGatewayPayload(p) ?? false,
  });

  // ── Per-session state (one voice session per bot process) ────────
  let harnessHandle: WireDiscordSessionHandle | null = null;
  let mirror: DiscordVoiceTextMirror | null = null;
  let unsubAutoLeave: (() => void) | null = null;

  function onSessionStart(session: DiscordVoiceChannelSession, joinOpts: DiscordVoiceJoinOpts): void {
    const bot = deps.getBot();
    // One chat session per voice join — utterances accumulate context
    // exactly like a text channel session.
    const sessionId = createSession({
      source: 'voice',
      origin: 'dc',
      provider: cfg.llm.provider,
      model: cfg.llm.model ?? '',
      title: `dc-voice:${joinOpts.channelId}`,
    }).id;
    log(`[voice.discord] session start — voice=${joinOpts.channelId} chat=${sessionId}`);
    debug.log('voice.discord.wire', 'session.start', { channelId: joinOpts.channelId, sessionId });

    // Transcript mirror into the commanding text channel.
    if (bot && joinOpts.textChannelId) {
      const textChannelId = joinOpts.textChannelId;
      mirror = createDiscordVoiceTextMirror({
        sendMessage: (text) => bot.sendMessage(textChannelId, text),
        editMessage: (messageId, text) => bot.editMessage(textChannelId, messageId, text),
      });
      mirror.setListening();
    }

    // The voice brain IS the text brain: same runTurn, same tool
    // surface. Spoken reply = streamed deltas; screenshots/files land
    // in the mirror text channel via the M2 FileSink.
    const runHarness: DiscordHarnessRunner = async (transcript, _ctx, cb) => {
      let streamed = 0;
      try {
        const turnBot = deps.getBot();
        const result = await deps.runTurnImpl({
          userConfig: cfg,
          sessionId,
          userText: transcript,
          // V2 — 보이스 발화 규율 (기존 오리엔테이션에 추가 합성됨).
          systemPrompt: DISCORD_VOICE_TURN_DISCIPLINE,
          dcChannel: { channelId: joinOpts.textChannelId ?? joinOpts.channelId },
          ...(turnBot && joinOpts.textChannelId
            ? { hitlFileSink: turnBot.fileSinkForChannel(joinOpts.textChannelId) }
            : {}),
          onDelta: (delta: string) => { streamed += 1; void cb.onChunk(delta); },
        });
        // Non-streaming providers resolve with only the final text —
        // speak it as a single chunk so the reply is never silent.
        if (streamed === 0 && result.text) void cb.onChunk(result.text);
        await cb.onDone('end_turn');
      } catch (err) {
        log(`[voice.discord] self turn failed: ${err instanceof Error ? err.message : String(err)}`);
        await cb.onDone('error');
      }
    };

    // STT 언어 힌트 — 한국어 인식 정확도의 핵심 레버 (config
    // voice.discord.voiceLanguage > env). 미설정이면 프로바이더 자동감지.
    const sttLanguage = cfg.voice?.discord?.voiceLanguage
      ?? process.env.ELANOUS_VOICE_STT_LANGUAGE?.trim();
    // 재생 중 청취 정책 — 기본 half-duplex(에코 원천차단·barge-in 불가),
    // barge-in 켜면 지속발화 인터럽트 + 에코 트랜스크립트 가드 (이어폰/
    // 디스코드 에코제거 환경 권장).
    //
    // 갭 #4 (2026-07-12) — 튜닝 상수 표면화. 하네스 하드코딩이던
    // 700(침묵갭)/350(반이중 꼬리)/350(barge-in 지속) 을 user-config
    // `voice.discord.voiceChannel.*` > env `ELANOUS_VOICE_*` > 기본값
    // 레이어로 노출 (AGENTS.md §user-config-over-env). barge-in 에너지
    // VAD 임계는 기존 voice.vad 레이어(readVadOptsFromEnv)를 재사용.
    const vc = cfg.voice?.discord?.voiceChannel;
    const bargeInRaw = process.env.ELANOUS_VOICE_BARGE_IN?.trim().toLowerCase();
    const bargeIn = vc?.bargeIn
      ?? (bargeInRaw === '1' || bargeInRaw === 'true' || bargeInRaw === 'on');
    const bargeInSustainMs = vc?.bargeInSustainMs
      ?? readPositiveIntEnv('ELANOUS_VOICE_BARGE_IN_SUSTAIN_MS');
    const selfEchoTailMs = vc?.selfEchoTailMs
      ?? readPositiveIntEnv('ELANOUS_VOICE_SELF_ECHO_TAIL_MS');
    const sttSilenceFinalizeMs = vc?.sttSilenceFinalizeMs
      ?? readPositiveIntEnv('ELANOUS_VOICE_STT_SILENCE_FINALIZE_MS');
    const bargeInVadThreshold = readVadOptsFromEnv({}, {
      configOverride: cfg.voice?.vad ?? {},
    }).threshold;
    // 디스코드 스코프 STT provider override — 전역 voice.stt.provider 는
    // TUI 튜닝(gpt-realtime-whisper)이 쓰므로, 이 서피스만 다른 provider
    // (예: scribe dogfood)를 쓰려면 voice.discord.sttProvider 로 지정.
    const sttProviderId = cfg.voice?.discord?.sttProvider;
    harnessHandle = wireDiscordSessionToHarness({
      session,
      joinOpts,
      runHarness,
      log,
      bargeIn,
      ...(bargeInSustainMs !== undefined ? { bargeInSustainMs } : {}),
      ...(selfEchoTailMs !== undefined ? { selfEchoTailMs } : {}),
      ...(sttSilenceFinalizeMs !== undefined ? { sttSilenceFinalizeMs } : {}),
      ...(bargeInVadThreshold !== undefined ? { bargeInVadThreshold } : {}),
      ...(sttLanguage ? { sttLanguage } : {}),
      ...(sttProviderId ? { sttProviderId } : {}),
      ...(deps.__sttProviderFactory ? { __sttProviderFactory: deps.__sttProviderFactory } : {}),
      ...(deps.__ttsProviderFactory ? { __ttsProviderFactory: deps.__ttsProviderFactory } : {}),
      onPartialTranscript: (partial) => { mirror?.pushPartial(partial); },
      onFinalTranscript: async (final) => { await mirror?.commitFinal(final); },
      onAssistantTranscript: (_delta, full) => { mirror?.pushAssistant(full); },
      onTurnComplete: () => { mirror?.setListening(); },
    });

    // Caller-default showroom: leave when the join requester exits.
    if (joinOpts.requesterUserId && shouldDiscordVoiceChannelLeaveOnEmpty()) {
      const monitor = createDiscordVoiceChannelAutoLeaveMonitor({
        guildId: joinOpts.guildId,
        channelId: joinOpts.channelId,
        requesterUserId: joinOpts.requesterUserId,
        botUserId: coordinator.getBotUserId(),
        leave: () => session.leave(),
        log,
      });
      unsubAutoLeave = coordinator.subscribeVoiceState(monitor.onVoiceState);
    }
  }

  function onSessionEnd(): void {
    log('[voice.discord] session end');
    debug.log('voice.discord.wire', 'session.end', {});
    const h = harnessHandle;
    harnessHandle = null;
    if (h) void h.shutdown().catch(() => { /* teardown is best-effort */ });
    try { unsubAutoLeave?.(); } catch { /* noop */ }
    unsubAutoLeave = null;
    try { mirror?.reset(); } catch { /* noop */ }
    mirror = null;
  }

  const vboot: BootDiscordVoiceChannelResult = bootDiscordVoiceChannel({
    coordinator,
    onSessionStart,
    onSessionEnd,
    ...(deps.__adapter ? { adapter: deps.__adapter } : {}),
  });

  // ── Guild + default voice channel discovery (cached) ─────────────
  // Production's DM-only gate strips guild_id from the join command's
  // context; the bot lives in one guild, so resolve it (and its first
  // voice channel) via REST once instead of demanding snowflakes.
  let discovered: Promise<{ guildId: string | null; voiceChannelId: string | null }> | null = null;
  function discover(): Promise<{ guildId: string | null; voiceChannelId: string | null }> {
    if (discovered) return discovered;
    discovered = (async () => {
      const token = resolveChannelBotToken('discord', cfg)?.token.trim();
      if (!token) return { guildId: null, voiceChannelId: null };
      try {
        const auth = { headers: { Authorization: `Bot ${token}` } };
        const guilds = await (await fetchImpl('https://discord.com/api/v10/users/@me/guilds', auth)).json() as Array<{ id: string }>;
        const guildId = Array.isArray(guilds) && guilds[0] ? guilds[0].id : null;
        if (!guildId) return { guildId: null, voiceChannelId: null };
        const channels = await (await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/channels`, auth)).json() as Array<{ id: string; type: number }>;
        const voice = Array.isArray(channels) ? channels.find((c) => c.type === 2) : undefined;
        return { guildId, voiceChannelId: voice?.id ?? null };
      } catch (err) {
        log(`[voice.discord] guild discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        discovered = null; // allow retry on the next command
        return { guildId: null, voiceChannelId: null };
      }
    })();
    return discovered;
  }

  async function dispatchVoiceCommand(ctx: DcIncoming): Promise<string | null> {
    const body = ctx.text.trim();
    if (!VOICE_PREFIX_RE.test(body)) return null;
    // Near-miss guard (dogfood 2026-07-12: `!voice-jin` 오타가 LLM 턴으로
    // 흘러가 "Jin 음성으로 설정" 같은 오해석 응답이 나감) — voice- 접두인데
    // 모르는 명령이면 브레인 대신 사용법을 돌려준다.
    if (!VOICE_COMMAND_RE.test(body)) return VOICE_USAGE;
    // Discord's client swallows `/` for its native palette — accept the
    // `!voice-*` spelling too (dispatcher only knows the `/` form).
    // `voice_join` 밑줄 표기도 수용 (dogfood: 하이픈/밑줄 혼동 빈번).
    const normalized = (body.startsWith('!') ? `/${body.slice(1)}` : body)
      .replace(/^\/voice_/, '/voice-');
    const rawGuildId = typeof ctx.raw.guild_id === 'string' ? ctx.raw.guild_id : null;
    let guildId = rawGuildId;
    let defaultChannelId: string | null = null;
    if (vboot.enabled) {
      const found = await discover();
      guildId = guildId ?? found.guildId;
      defaultChannelId = found.voiceChannelId;
    }
    return vboot.dispatchVoiceCommand({
      body: normalized,
      channelId: ctx.channelId,
      userId: ctx.userId,
      ...(guildId ? { guildId } : {}),
      ...(defaultChannelId ? { defaultChannelId } : {}),
    });
  }

  return {
    enabled,
    voiceTap: enabled ? coordinator.tap : null,
    dispatchVoiceCommand,
    shutdown: async () => {
      onSessionEnd();
      await vboot.shutdown();
      coordinator.destroyAll();
    },
  };
}
