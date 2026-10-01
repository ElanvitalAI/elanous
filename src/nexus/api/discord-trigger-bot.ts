// V2.2-3 (2026-05-12) — NEXUS-hosted Discord workflow trigger bot.
//
// Owns a single in-process DiscordBot whose only job is to surface
// inbound messages / mentions / reactions to the workflow runtime
// daemon's `dispatchDiscord(event)` so `discordTrigger` nodes fire
// from real Discord traffic.
//
// Why in-process (and not the channel-bot subprocess + HTTP IPC the
// HANDOFF originally chose): `elanous discord` CLI was deleted in
// #1951 (2026-05-08), leaving `channel-bot.ts` as a stub. Restoring
// the CLI subprocess + adding HTTP IPC is ~700 LOC of work that
// duplicates what we can wire in-process with one DiscordBot
// construction. The personal-agent scale (single user · single host)
// doesn't need subprocess isolation. A future v2 can swap the
// in-process bot for the subprocess + HTTP IPC pattern without
// touching the workflow runtime side (it only sees
// `dispatchDiscord(event)`).
//
// Distinct from the HITL Discord bot (`hitl-discord-channel.ts`):
//   • HITL bot   = ELANOUS_DISCORD_HITL_BOT_TOKEN  · interaction-only
//   • Trigger bot = cfg.discord.botToken           · message tap
// Production typically uses two separate Discord applications so the
// allowlists / channel scopes don't bleed.

import {
  DiscordBot,
  type DcMessageHandler,
  type DcTriggerEvent,
  type DiscordVoiceDispatchTap,
} from '../../discord.js';
import type { DiscordEvent } from '../../workflow-runtime/triggers/discord-source.js';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { registerSurfaceSink, registerStreamingSink } from '../../session/session-fanout.js';
import { parseDiscordEndpoint, isOwnInstanceEndpoint } from '../../session/session-endpoint-key.js';
import { createDiscordStreamSink } from '../../session/streaming/discord-stream-sink.js';
import { splitForDiscord } from '../../discord.js';
import { formatForDiscord } from '../../discord-markdown.js';

export interface NexusDiscordTriggerBotOpts {
  /** Bot token (without `Bot ` prefix). Production reads
   *  `cfg.discord.botToken` (which env-bridge already populates from
   *  `ELANOUS_DISCORD_BOT_TOKEN` when set). */
  token: string;
  /** Allowlist of Discord user ids — empty array refuses everyone (see
   *  `src/discord.ts:626`). The DM gate still applies first, so non-DM
   *  guild traffic is filtered regardless. */
  allowedUsers: string[];
  /** Workflow runtime fan-out — every Discord message / mention /
   *  reaction the bot accepts is forwarded here. */
  dispatch: (event: DiscordEvent) => Promise<unknown>;
  /** M4b (2026-07-12) — optional chat handler. When provided (the
   *  nexus wire passes buildDiscordSelfOnMessage: elanous self turn +
   *  /cc·/cdx·/gem interweaving), inbound DMs get answered like the
   *  telegram bot. Absent ⇒ trigger-only (legacy no-op reply). */
  onMessage?: DcMessageHandler;
  /** M4c (2026-07-12) — optional voice gateway tap. When provided (the
   *  nexus wire passes buildDiscordVoiceWire's tap, present only when
   *  ELANOUS_DISCORD_VOICE_CHANNEL is on), the bot adds the
   *  GUILD_VOICE_STATES intent and forwards READY / VOICE_STATE_UPDATE
   *  / VOICE_SERVER_UPDATE so `/voice-join` can drive a live
   *  @discordjs/voice connection. Absent ⇒ intents unchanged. */
  voiceTap?: DiscordVoiceDispatchTap;
  /** C3 (2026-07-12) — optional INTERACTION_CREATE handler. The nexus
   *  wire passes buildDiscordSlashWire's onInteraction so native slash
   *  commands (/cc·/fork·/voice-join·…) route into the same composed
   *  message pipeline. Absent ⇒ interactions ignored (legacy). */
  onInteraction?: (raw: Record<string, unknown>) => void | Promise<void>;
  /** EV12c — guild text channels answered like DMs (`discord.chatChannels`). Absent ⇒ DM-only. */
  guildTextChannels?: string[];
  /** Optional logger. Defaults to `[discord/trigger]` prefix. */
  log?: (msg: string) => void;
  /** Test seam — pre-built DiscordBot (factory skips construction +
   *  start() so unit tests can drive `onTriggerTap` directly). */
  bot?: DiscordBot;
  /** Test seam — fetch impl forwarded into the constructed bot. */
  fetchImpl?: typeof fetch;
  /** Test seam — WebSocket impl forwarded into the constructed bot. */
  wsImpl?: typeof WebSocket;
}

export interface NexusDiscordTriggerBotHandle {
  /** Underlying bot — exposed for tests + future inspection only. */
  bot: DiscordBot;
  /** Stop the gateway connection. Idempotent. */
  stop: () => Promise<void>;
}

export interface DiscordTriggerLoggerSinks {
  console?: Pick<Console, 'log' | 'warn'>;
  observe?: (category: string, event: string) => void;
}

/** Default trigger logger: keep the supervisor stdout heartbeat while
 *  `debug.log` remains the single logs.db path. */
export function createDiscordTriggerLogger(
  sinks: DiscordTriggerLoggerSinks = {},
): (msg: string) => void {
  const consoleSink = sinks.console ?? console;
  const observe = sinks.observe ?? ((category, event) => debug.log(category, event));
  return (msg: string): void => {
    consoleSink.log(`[discord/trigger] ${msg}`);
    observe('discord.trigger', msg);
  };
}

/** Map the DiscordBot's tap event onto the workflow runtime's
 *  DiscordEvent shape. The two were intentionally kept congruent
 *  (`src/discord.ts:160-172` comment) so the wire is a near-identity
 *  with `raw` carrying the full gateway payload for debugging. */
export function toDiscordEvent(tap: DcTriggerEvent): DiscordEvent {
  return {
    kind: tap.kind,
    channel: tap.channel,
    user: tap.user,
    body: tap.body,
    raw: tap,
  };
}

/** Build the onTriggerTap closure that the DiscordBot will invoke
 *  for every accepted message / mention / reaction. Exported so unit
 *  tests can drive synthetic taps without spinning up a real bot
 *  (the bot's onTriggerTap is set readonly in the constructor, so
 *  testing through the bot instance requires either a mock or this
 *  seam). */
export function buildDiscordTriggerTap(
  dispatch: (event: DiscordEvent) => Promise<unknown>,
  log: (msg: string) => void,
): (tap: DcTriggerEvent) => void {
  return (tap: DcTriggerEvent): void => {
    // Fire-and-forget — workflow dispatch errors are surfaced via the
    // workflow daemon's lifecycle bus, not the gateway loop. Any
    // synchronous throw lands here so the chat reply (no-op in this
    // bot) keeps flowing.
    void Promise.resolve()
      .then(() => dispatch(toDiscordEvent(tap)))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        log(`workflow dispatch failed: ${reason}`);
      });
  };
}

/** Construct the trigger bot. Returns null when `token` is empty so
 *  the caller can skip wiring without a try/catch (mirrors the
 *  `readNexusDiscordHitlOptsFromEnv` factory pattern). */
export function createNexusDiscordTriggerBot(
  opts: NexusDiscordTriggerBotOpts,
): NexusDiscordTriggerBotHandle | null {
  if (!opts.token || opts.token.trim().length === 0) return null;

  // LF2 — 콘솔 하트비트 유지 + debug.log 병행(telegram-trigger 동형).
  const log = opts.log ?? createDiscordTriggerLogger();
  const onTriggerTap = buildDiscordTriggerTap(opts.dispatch, log);

  const botWasInjected = opts.bot !== undefined;
  const bot = opts.bot ?? new DiscordBot({
    token: opts.token,
    allowedUsers: opts.allowedUsers,
    ...(opts.guildTextChannels?.length ? { guildTextChannels: opts.guildTextChannels } : {}),
    // Chat path: the injected self-turn handler (M4b nexus wire) or the
    // legacy trigger-only no-op. Workflows wanting a chat reply can
    // still declare a `chatTrigger` (routes via `/v1/workflows/chat/*`).
    onMessage: opts.onMessage ?? (async () => undefined),
    log,
    onTriggerTap,
    ...(opts.voiceTap ? { voiceTap: opts.voiceTap } : {}),
    ...(opts.onInteraction ? { onInteraction: opts.onInteraction } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.wsImpl ? { wsImpl: opts.wsImpl } : {}),
  });

  // §C3 — discord 서피스 sink(config gate·telegram-trigger 동형). shadowFanout OR
  // primary.discord 시 등록. endpoint 완전스코프면 parse→인스턴스 가드 후 channelId 배달,
  // 구 bare channelId 하위호환. 실제 flip(옛 arc 비활성)은 대표 실기기 게이트.
  let offDiscordSink: (() => void) | undefined;
  try {
    const sf = getUserConfig().sessionFabric;
    if (sf?.shadowFanout === true || sf?.primary?.discord === true) {
      offDiscordSink = registerSurfaceSink('discord', {
        deliver: async (endpoint, ev) => {
          if (!ev.text) return;
          const parsed = parseDiscordEndpoint(endpoint);
          let channelId: string;
          if (parsed) {
            if (!isOwnInstanceEndpoint(parsed.instance)) return;   // 크로스 인스턴스 차단
            channelId = parsed.channelId;
          } else {
            channelId = endpoint;   // 구 bare channelId 하위호환
          }
          if (!channelId) return;
          await bot.sendMessage(channelId, ev.text);
        },
      });
      log(`session fan-out: discord surface sink registered (${sf?.primary?.discord ? 'primary' : 'shadow'})`);
    }
  } catch (err) { log(`discord surface sink register failed: ${err instanceof Error ? err.message : String(err)}`); }

  // §C5c — discord 스트리밍 sink 등록(청크 fan-out). shadow OR streaming.discord 시. transport =
  // bot.sendMessage/editMessage(content plain·디스코드 네이티브 markdown). replyTo 미지원 → 연속
  // 순차 전송(reply-threading 은 C5-enh). split = splitForDiscord(2000). flip 은 대표 dogfood.
  let offDiscordStream: (() => void) | undefined;
  try {
    const sf = getUserConfig().sessionFabric;
    if (sf?.shadowFanout === true || sf?.streaming?.discord === true) {
      offDiscordStream = registerStreamingSink('discord', createDiscordStreamSink(
        {
          send: async (channelId, text, o) => {
            const r = await bot.sendMessage(channelId, text, { ...(o.suppressEmbeds ? { suppressEmbeds: true } : {}) });
            return { messageId: r?.id ?? '' };
          },
          edit: async (channelId, messageId, text) => { await bot.editMessage(channelId, messageId, text); },
        },
        {
          split: (t) => splitForDiscord(formatForDiscord(t)), // 테이블/--- 디스코드 렌더 보정 후 분할
          ...(sf?.discord?.streamingMode ? { mode: sf.discord.streamingMode } : {}),
          ...(sf?.discord?.editGapMs ? { throttleMs: sf.discord.editGapMs } : {}),
        },
      ));
      log(`session fan-out: discord STREAMING sink registered (${sf?.streaming?.discord ? 'primary' : 'shadow'}·mode=${sf?.discord?.streamingMode ?? 'partial'})`);
    }
  } catch (err) { log(`discord streaming sink register failed: ${err instanceof Error ? err.message : String(err)}`); }

  if (!botWasInjected) {
    void bot.start().catch((err: unknown) => {
      log(`bot.start exited with error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    bot,
    stop: async (): Promise<void> => {
      try { offDiscordSink?.(); } catch { /* swallow */ }
      try { offDiscordStream?.(); } catch { /* swallow */ }
      try { bot.stop(); } catch { /* swallow */ }
    },
  };
}
