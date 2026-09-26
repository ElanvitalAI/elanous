// V2.2-4 (2026-05-12) — NEXUS-hosted Telegram workflow trigger bot.
//
// Mirrors `discord-trigger-bot.ts` (V2.2-3 · #2311) for Telegram:
// NEXUS daemon owns a single in-process TelegramBot whose only job
// is to surface inbound messages / commands / callback_queries to
// the workflow runtime daemon's `dispatchTelegram(event)` so
// `telegramTrigger` nodes fire from real Telegram traffic.
//
// Why in-process (parallel to V2.2-3 reasoning): the HANDOFF chose
// subprocess + HTTP IPC assuming the channel-bot kind worked, but
// `elanous telegram` standalone runner was deleted as part of the
// 2026-05-08 hardlanding cycle. The personal-agent scale doesn't
// need subprocess isolation. The workflow runtime side only sees
// `dispatchTelegram(event)` so a future v2 can swap to subprocess +
// HTTP IPC without touching the workflow side.
//
// Distinct from HITL Telegram bot (`hitl-telegram-channel.ts`):
//   • HITL bot    = ELANOUS_TELEGRAM_HITL_BOT_TOKEN · interaction-only
//   • Trigger bot = resolved channel token        · message tap
// Production typically uses two separate Telegram bots so the
// allowlists / chat scopes don't bleed.

import {
  TelegramBot,
  botFromConfig,
  type TgTriggerEvent,
} from '../../telegram.js';
import type { runTurn } from '../../session/chat.js';
import type { UserConfig } from '../../user-config.js';
import { registerMissionHitlCallback } from '../../autopilot/mission-hitl-callback.js';
import type { TelegramEvent } from '../../workflow-runtime/triggers/telegram-source.js';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { registerSurfaceSink, registerStreamingSink } from '../../session/session-fanout.js';
import { parseTelegramEndpoint, isOwnInstanceEndpoint, matchesBot } from '../../session/session-endpoint-key.js';
import { createTelegramStreamSink } from '../../session/streaming/telegram-stream-sink.js';
import { splitMarkdownForTelegram } from '../../telegram-format.js';
import { formatTablesAndRules } from '../../discord-markdown.js';

export interface NexusTelegramTriggerBotOpts {
  /** Bot token (without `Bot ` prefix). Production reads
   *  the channel token resolved by the NEXUS caller. */
  token: string;
  /** Allowlist of Telegram user ids — empty array refuses everyone
   *  (see `src/telegram.ts` allowedUsers gate). */
  allowedUsers: number[];
  /** Workflow runtime fan-out — every Telegram message / command /
   *  callback_query the bot accepts is forwarded here. */
  dispatch: (event: TelegramEvent) => Promise<unknown>;
  /** Optional logger. Defaults to `[telegram/trigger]` prefix. */
  log?: (msg: string) => void;
  /** Test seam — pre-built TelegramBot (factory skips construction +
   *  start() so unit tests can drive the tap directly). */
  bot?: TelegramBot;
  /** Test seam — the promise `bot.start()` would have returned. When
   *  `bot` is injected the factory does not call `start()`, so tests
   *  that assert drain behavior pass the retained promise here. */
  startPromise?: Promise<void>;
  /** Test seam — fetch impl forwarded into the constructed bot. */
  fetchImpl?: typeof fetch;
  /** 2026-07-05 — unified inbound. When set, the ONE nexus-hosted bot
   *  ALSO answers Q&A (botFromConfig's onMessage = local runTurn) in
   *  addition to firing workflow triggers via onTriggerTap. This keeps a
   *  single getUpdates poller per token — a separate Q&A poller would 409.
   *  Omit for a trigger-only bot (legacy / tests). */
  userConfig?: UserConfig;
  /** T1 (2026-07-05) — tool-enabled runTurn for Q&A (agent tool surface +
   *  analyst orientation, `makeTelegramAgentRunTurn`). Forwarded to
   *  botFromConfig so the Q&A bot can query live data / run skills instead
   *  of answering from memory. Only meaningful alongside `userConfig`. */
  runTurnImpl?: typeof runTurn;
  /** `false` 면 폴링(`getUpdates`)을 시작하지 않는다 — 배달 싱크만 등록하는 «보내기 전용» 봇.
   *  폴링을 넥서스 밖(`elanous telegram run`)이 맡을 때, core 에서 시작한 턴이 텔레그램 구독자에게 가는 길이다. */
  poll?: boolean;
}

/** Default bound for draining in-flight turns after `bot.stop()`. A stuck
 *  turn must not hold a restart forever (RFC R1). */
export const TELEGRAM_TRIGGER_DRAIN_TIMEOUT_MS = 8_000;

export interface NexusTelegramTriggerBotStopOpts {
  /** Upper bound for awaiting the retained `bot.start()` promise after
   *  `bot.stop()`. Defaults to {@link TELEGRAM_TRIGGER_DRAIN_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface NexusTelegramTriggerBotHandle {
  /** Underlying bot — exposed for tests + future inspection only. */
  bot: TelegramBot;
  /** Stop the polling loop and drain in-flight turns up to `timeoutMs`.
   *  Idempotent — a second call awaits the same drain promise (it does
   *  not return before the first drain finishes, and it does not call
   *  `bot.stop()` again). */
  stop: (opts?: NexusTelegramTriggerBotStopOpts) => Promise<void>;
}

export interface TelegramTriggerLoggerSinks {
  console?: Pick<Console, 'log' | 'warn'>;
  observe?: (category: string, event: string) => void;
}

/** Default trigger logger: keep the supervisor stdout heartbeat while
 *  `debug.log` remains the single logs.db path. */
export function createTelegramTriggerLogger(
  sinks: TelegramTriggerLoggerSinks = {},
): (msg: string) => void {
  const consoleSink = sinks.console ?? console;
  const observe = sinks.observe ?? ((category, event) => debug.log(category, event));
  return (msg: string): void => {
    consoleSink.log(`[telegram/trigger] ${msg}`);
    observe('telegram.trigger', msg);
  };
}

/** Map the TelegramBot's tap event onto the workflow runtime's
 *  TelegramEvent shape. Congruent fields (`src/telegram.ts:166-180`
 *  comment) so the wire is a near-identity with `raw` carrying the
 *  full payload (messageId · isDm) for debugging. */
export function toTelegramEvent(tap: TgTriggerEvent): TelegramEvent {
  return {
    kind: tap.kind,
    chat: tap.chat,
    user: tap.user,
    body: tap.body,
    ...(tap.command !== undefined ? { command: tap.command } : {}),
    raw: tap,
  };
}

/** Build the onTriggerTap closure that the TelegramBot invokes for
 *  every accepted message / command / callback_query. Exported so
 *  unit tests can drive synthetic taps without spinning up a real
 *  bot (the bot's onTriggerTap is set readonly in the constructor,
 *  so testing through the bot instance requires either a mock or
 *  this seam). */
export function buildTelegramTriggerTap(
  dispatch: (event: TelegramEvent) => Promise<unknown>,
  log: (msg: string) => void,
): (tap: TgTriggerEvent) => void {
  return (tap: TgTriggerEvent): void => {
    // Fire-and-forget — workflow dispatch errors surface via the
    // workflow daemon's lifecycle bus, not the polling loop. Any
    // synchronous throw lands here so the chat reply (no-op in this
    // bot) keeps flowing.
    void Promise.resolve()
      .then(() => dispatch(toTelegramEvent(tap)))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        log(`workflow dispatch failed: ${reason}`);
      });
  };
}

/** Construct the trigger bot. Returns null when `token` is empty so
 *  the caller can skip wiring without a try/catch (mirrors the
 *  readNexusTelegramHitlOptsFromEnv factory pattern). */
export function createNexusTelegramTriggerBot(
  opts: NexusTelegramTriggerBotOpts,
): NexusTelegramTriggerBotHandle | null {
  if (!opts.token || opts.token.trim().length === 0) return null;

  // LF2 — 콘솔 하트비트는 유지하고 debug.log 를 병행(파일 트레일+logs.db).
  const log = opts.log ?? createTelegramTriggerLogger();
  const onTriggerTap = buildTelegramTriggerTap(opts.dispatch, log);

  const botWasInjected = opts.bot !== undefined;
  const bot = opts.bot ?? (opts.userConfig
    // Unified inbound: botFromConfig gives the full Q&A handler
    // (onMessage → runTurn, sessions, attachments, slash) and we graft
    // the workflow trigger tap on top. One bot, one poller, both roles.
    ? botFromConfig({
        userConfig: opts.userConfig,
        log,
        ...(opts.runTurnImpl ? { runTurnImpl: opts.runTurnImpl } : {}),
        telegramBotOpts: {
          token: opts.token,
          onTriggerTap,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        },
      })
    // Trigger-only fallback (no userConfig): no LLM chat reply, the bot
    // exists purely for the trigger surface.
    : new TelegramBot({
        token: opts.token,
        allowedUsers: opts.allowedUsers,
        onMessage: async () => undefined,
        log,
        onTriggerTap,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }));

  // 미션 HITL 텔레그램 콜백 — 승인/거절 버튼 탭을 공유 write(approve/cancel)로 처리하고
  // 크로스서피스(PWA) 와 상태 싱크. surface HITL 과 동일 poll·prefix 로 공존(apm-hitl:).
  try { registerMissionHitlCallback(bot); }
  catch (err) { log(`mission HITL callback register failed: ${err instanceof Error ? err.message : String(err)}`); }

  // §P1/C2 — telegram 서피스 sink 등록(config gate). shadow(추가 미러) 또는 primary.telegram
  // (배달 cutover) 중 하나라도 켜지면 등록. 기존 배달 무접촉(flip 은 대표 실기기 게이트).
  // endpoint: 완전 스코프 키(<instance>:<botId>:<chatId>:<threadId>·C2) → parse 후 인스턴스/봇
  // 가드 + chatId 추출. 구 bare chatId(현 shadow) 는 하위호환으로 Number() 폴백.
  // ★ 봇 스코프 id(2026-07-21·"확" 크로스봇 누출 근본수리) — token prefix(telegram.ts:304 동형). 여러 봇이
  //   같은 chatId(대표 user id)를 공유해도 이 sink 는 자기 봇 endpoint 만 배달(matchesBot 가드).
  const thisBotId = opts.token.split(':')[0] || opts.token;
  let offTelegramSink: (() => void) | undefined;
  try {
    const sf = getUserConfig().sessionFabric;
    if (sf?.shadowFanout === true || sf?.primary?.telegram === true) {
      offTelegramSink = registerSurfaceSink('telegram', {
        // 봇 여럿 합성 시 «내 endpoint 인가» — deliver 의 가드와 같은 규칙(스코프 키면 인스턴스·봇 · 아니면 bare chatId).
        accepts: (endpoint) => {
          const parsed = parseTelegramEndpoint(endpoint);
          if (parsed) return isOwnInstanceEndpoint(parsed.instance) && matchesBot(parsed.botId, thisBotId);
          return Number.isFinite(Number(endpoint));
        },
        deliver: async (endpoint, ev) => {
          if (!ev.text) return;
          const parsed = parseTelegramEndpoint(endpoint);
          let chatId: number;
          if (parsed) {
            // 완전 스코프 — 크로스 인스턴스 배달 차단(#4064) + 크로스봇 차단(확 누출 근본수리).
            if (!isOwnInstanceEndpoint(parsed.instance)) return;
            if (!matchesBot(parsed.botId, thisBotId)) return;   // ★ 다른 봇 endpoint 스킵
            chatId = Number(parsed.chatId);
          } else {
            chatId = Number(endpoint);   // 구 bare chatId 하위호환(현 shadow)
          }
          if (!Number.isFinite(chatId)) return;
          await bot.sendMessage(chatId, ev.text, {});
        },
      });
      log(`session fan-out: telegram surface sink registered (${sf?.primary?.telegram ? 'primary' : 'shadow'})`);
    }
  } catch (err) { log(`telegram surface sink register failed: ${err instanceof Error ? err.message : String(err)}`); }

  // §C5b — telegram 스트리밍 sink 등록(청크 fan-out). shadow OR streaming.telegram 시 등록.
  // transport = bot.sendMessage/editMessageText(markdown 옵션·내부 plain fallback). 스트리밍 중엔
  // plain, finalize 에만 markdown. split = splitMarkdownForTelegram(4096). flip 은 대표 dogfood.
  let offTelegramStream: (() => void) | undefined;
  try {
    const sf = getUserConfig().sessionFabric;
    if (sf?.shadowFanout === true || sf?.streaming?.telegram === true) {
      offTelegramStream = registerStreamingSink('telegram', createTelegramStreamSink(
        {
          send: async (chatId, text, o) => {
            const r = await bot.sendMessage(chatId, text, {
              ...(o.threadId != null ? { threadId: o.threadId } : {}),
              ...(o.replyTo != null ? { replyTo: o.replyTo } : {}),
              ...(o.markdown ? { markdown: true } : {}),
            });
            return { messageId: (r && typeof r === 'object' && 'messageId' in r ? r.messageId : 0) };
          },
          edit: async (chatId, messageId, text, o) => {
            await bot.editMessageText(chatId, messageId, text, {
              ...(o.threadId != null ? { threadId: o.threadId } : {}),
              ...(o.markdown ? { markdown: true } : {}),
            });
          },
          chatAction: async (chatId, threadId) => { await bot.sendChatAction(chatId, 'typing', { ...(threadId != null ? { threadId } : {}) }); },
          delete: async (chatId, messageId) => { await bot.deleteMessage(chatId, messageId); },
        },
        {
          split: (t) => splitMarkdownForTelegram(formatTablesAndRules(t), 4096), // 테이블/--- 보정 후 분할
          botId: thisBotId,   // ★ 봇 스코프 — 다른 봇 endpoint 배달 차단(확 크로스봇 누출 근본수리)
          ...(sf?.telegram?.streamingMode ? { mode: sf.telegram.streamingMode } : {}),
          ...(sf?.telegram?.editGapMs ? { throttleMs: sf.telegram.editGapMs } : {}),
          ...(sf?.telegram?.typing ? { typing: true } : {}),
          ...(sf?.telegram?.fairQueue ? { fairQueue: true } : {}),
          ...(sf?.telegram?.rotate ? { rotate: true } : {}),
        },
      ));
      log(`session fan-out: telegram STREAMING sink registered (${sf?.streaming?.telegram ? 'primary' : 'shadow'}·mode=${sf?.telegram?.streamingMode ?? 'partial'}${sf?.telegram?.typing ? '·typing' : ''}${sf?.telegram?.fairQueue ? '·fairQueue' : ''}${sf?.telegram?.rotate ? '·rotate' : ''})`);
    }
  } catch (err) { log(`telegram streaming sink register failed: ${err instanceof Error ? err.message : String(err)}`); }

  // R1 — retain start()'s promise. It resolves only after the poll loop
  // drains `turnChain`, which is the only signal that an already-acked
  // Telegram turn finished (or that we never started one). An injected
  // bot does not call start(); tests pass that promise explicitly.
  let startPromise: Promise<void> | undefined = opts.startPromise;
  if (!botWasInjected && opts.poll !== false) {
    startPromise = bot.start().catch((err: unknown) => {
      log(`bot.start exited with error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // One drain promise for every caller. A second stop (SIGINT then
  // SIGTERM, or a duplicate SIGTERM) must wait for the same bound —
  // returning immediately would let the process exit before the turn
  // chain is drained.
  let drainPromise: Promise<void> | undefined;
  return {
    bot,
    stop: (stopOpts?: NexusTelegramTriggerBotStopOpts): Promise<void> => {
      if (drainPromise) return drainPromise;
      const timeoutMs = stopOpts?.timeoutMs ?? TELEGRAM_TRIGGER_DRAIN_TIMEOUT_MS;
      drainPromise = (async (): Promise<void> => {
        try { offTelegramSink?.(); } catch { /* swallow */ }
        try { offTelegramStream?.(); } catch { /* swallow */ }
        try { bot.stop(); } catch { /* swallow */ }
        if (!startPromise) return;
        const startedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([
          startPromise.then(() => 'drained' as const),
          timeout,
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === 'timeout') {
          debug.log('nexus.telegram.shutdown', 'drain-timeout', { timeoutMs });
          return;
        }
        debug.log('nexus.telegram.shutdown', 'drained', { elapsedMs: Date.now() - startedAt });
      })();
      return drainPromise;
    },
  };
}
