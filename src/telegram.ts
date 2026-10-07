// ── Telegram Bot API client ──
//
// Pure fetch-based long-polling. No deps (node-telegram-bot-api would
// pull ~40 transitive packages for what's effectively three HTTP calls:
// getUpdates, sendMessage, and, on rate-limit, a retry with respect for
// retry_after). Modeled after hermes-agent's gateway/platforms/telegram.py
// but translated to the Bot API directly.
//
// Features:
//   - Long-polling via /getUpdates?timeout=25
//   - Allowlist enforcement (TelegramConfig.allowedUsers) — reject
//     politely on unknown users.
//   - Chunked replies for >4000-char responses (Telegram caps message
//     at 4096; we leave headroom for formatting).
//   - retry_after respected on 429. Other errors logged + loop continues.
//   - Graceful shutdown via bot.stop() (drops the current long-poll in
//     the next iteration).
//   - fetch injection for tests — stubFetch factory returns a mockable
//     bot instance that never touches the network.

import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTurnOutputTextBlocks } from './input/turn-output-block.js';
import { selectTurnOutputTextForSink } from './input/turn-output-sink-registry.js';
import { debug } from './debug/log.js';
import { botAudienceFor, filterBotCommands, readBotAudience } from './maturity/bot-command-maturity.js';
import { resolveChannelBotToken } from './channel-bot-token.js';
import type { TelegramVoiceAdapter } from './voice/channel-adapters/telegram-voice-adapter.js';
import { createTelegramSurfaceHitl, type TelegramSurfaceHitl } from './hitl/telegram-surface-hitl.js';
import { beginCancelableTurn, endCancelableTurn, cancelAcpTurn } from './acp/turn-runner.js';
import type { ConfirmChannel } from './hitl/confirm.js';
import type { QuestionChannel } from './hitl/question.js';
import {
  markdownToTelegramHtml,
  splitMarkdownForTelegram,
  isTelegramParseEntityError,
} from './telegram-format.js';
import {
  matchBotIntent,
  matchBotsIntent,
  matchChartIntent,
  matchRoutinesIntent,
  matchScreenIntent,
  needsPersonaRegistry,
  defaultKoreanResolver,
} from './bots/command-surface.js';
import { awaitGlobalPersonaLoad, getGlobalPersonaRegistry } from './persona/global-registry.js';
import {
  dispatchTelegramSlash,
  parseTelegramSlash,
  buildUnknownSlashReply,
  toTelegramBotCommands,
  defaultTelegramCommands,
  runAcpViaSlash,
  type TgSlashCommand,
  type TgSlashParse,
} from './telegram-commands.js';
import {
  getActiveDelegation, setActiveDelegation, touchActiveDelegation, clearActiveDelegation,
  delegationChatKey, classifyDelegationOverride,
} from './acp/active-delegation.js';
import { selfToolArgHint } from './telegram-exec-footer.js';
import { detectUrlRoute, type UrlRouteDecision } from './skills/url-router.js';
import { observeDevRequestRouteFailSoft } from './skills/dev-request-router.js';
import { runUrlRoute } from './skills/url-route-exec.js';
import { recordRoutedLinkAbsorbed } from './intake-plane/link-ledger.js';
import { classifyFrontInput, telegramAbsorbUrls } from './intake-plane/front-classifier.js';
import { scheduleIntakeEvent } from './intake-plane/route.js';
import { dispatchTaskCreate } from './task-orchestrator/runtimes/create.js';
import { handleTelegramSeatWork, type TelegramSeatWorkDeps } from './intake-plane/telegram-seat-work.js';
import { deliverSeatAnswers } from './seat-dispatch/seat-ask.js';
import { effectiveInstanceRoot } from './instance/resolve.js';
import { getElanousConfigDir } from './elanous-config-dir.js';
import { defaultFieldEvent, FieldUploadError, parseFieldCaption, resolveFieldMime, saveFieldMedia } from './field/field-media.js';
import { scheduleFieldReel, type FieldReelOptions } from './field/field-reel.js';
import { handleTelegramFieldNote } from './field-note/telegram.js';
import type { TranscriptionEngine, FieldAudio } from './field-note/transcribe.js';
import { maybeHandleCardPhoto, type CardPhotoDeps } from './telegram-card-followup.js';
import { attachTelegramProjectButtons } from './telegram-project-command.js';
import { attachTelegramFabricPlan } from './telegram-fabric-plan.js';
import { contextNow as readContextNow, type ContextNowDeps } from './context-bus/context-now.js';
import { renderTelegramNow } from './context-bus/context-now-surfaces.js';
import { createContextFirstGate, renderContextFirst } from './context-bus/context-first.js';

export type TgAttachmentKind = 'photo' | 'voice' | 'audio' | 'document';

export interface TgIncomingAttachment {
  kind: TgAttachmentKind;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  /** Source-file size in bytes (pre-download). */
  fileSize?: number;
  /** Voice / audio duration in seconds. */
  duration?: number;
  /** Image dimensions (photo only). */
  width?: number;
  height?: number;
}

export interface TgIncoming {
  updateId: number;
  chatId: number;
  userId: number;
  userName?: string;
  /** Text body, or caption for photo/document. Empty string for
   *  pure attachment messages (voice without caption, etc.). */
  text: string;
  messageId: number;
  threadId?: number;
  /** Telegram message timestamp, not poll time. */
  receivedAt?: string;
  isDm: boolean;
  isGroup: boolean;
  /** Zero or more attached media — populated by parseUpdate from
   *  photo/voice/audio/document message fields. */
  attachments: TgIncomingAttachment[];
  /** Id of the bot (token prefix) that RECEIVED this update. Set by the
   *  poll loop (parseUpdate can't know it). Scopes session lookup so
   *  multiple bots sharing a chatId (multi-channel DMs) don't collide. */
  botId?: string;
  /** 답장 대상 메시지의 텍스트(force_reply 정정 가로채기용). parseUpdate 가 채운다. */
  replyToText?: string;
  /** 앨범(media group) id — `#현장` 캡션은 앨범의 첫 항목에만 붙으므로 나머지를 같은 행사로 묶는 데 쓴다. */
  mediaGroupId?: string;
  /** 영상 — `#현장` 저장 전용. `attachments` 에 넣지 않는다(LLM 경로의 동작을 안 바꾸려고). */
  video?: TgIncomingAttachment;
}

/** Streaming surface passed to the message handler. The handler can
 *  call `edit(partial)` as tokens arrive; the bot applies local
 *  coalescing so rapid-fire calls only produce ~1 Telegram edit per
 *  second (below the per-chat 1msg/sec limit). Handlers that don't
 *  stream can just ignore this arg and return the final string. */
export interface TgMessageStreamer {
  /** Fire-and-forget: request that the placeholder be updated with
   *  the accumulated partial markdown. Coalesced — many calls within
   *  the throttle window result in one final edit with the latest
   *  value. Safe to call from a tight `onDelta` loop. */
  edit(partialText: string): void;
  /** P1.4 file spill — fire-and-forget. Uploads `body` as a document
   *  into the streamer's chat (Bot API sendDocument). The ACP relay
   *  calls this when a tool body overflows the inline cap so the full
   *  diff/stdout reaches the user without blowing the message limit. */
  sendFile?: import('./channel/file-sink.js').FileSink['sendFile'];
}

function selectTelegramFanoutText(text: string): string {
  return selectTurnOutputTextForSink('fan-out-telegram', buildTurnOutputTextBlocks(text)) ?? text;
}

export type TgMessageHandler = (
  ctx: TgIncoming,
  streamer?: TgMessageStreamer,
) => Promise<string | void>;

export interface TelegramBotOpts {
  /** Comma-free bot token from @BotFather, e.g. "123456:ABC-…". */
  token: string;
  /** User IDs allowed to invoke the bot. Empty = refuse everyone. */
  allowedUsers: number[];
  /** Where to deliver cron/push output. Optional. */
  homeChannel?: number;
  /** Message handler. Return a string to reply, or void to stay silent.
   *  When called from a real user turn, a `streamer` arg is provided so
   *  the handler can emit partial output as tokens arrive. */
  onMessage: TgMessageHandler;
  /** Dependency injection for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Dependency injection for tests — override the polling delay after
   *  non-fatal errors (default: 5000ms). Tests pass 0. */
  errorBackoffMs?: number;
  /** Poll timeout in seconds (sent to /getUpdates?timeout=). 25 gives
   *  Telegram headroom under their 30s server-side cap. */
  pollTimeoutSec?: number;
  /** Chunk size for outbound messages. Telegram caps at 4096. */
  maxMessageChars?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Test seam — override sleep implementation for retry/throttle paths. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Test seam — override clock source for retry/throttle paths. */
  nowImpl?: () => number;
  /** Per-chat minimum gap between outbound sends. Default 900ms. */
  perChatGapMs?: number;
  /** Global outbound cap inside a 1s window. Default 28 msgs/sec. */
  globalMaxPerSec?: number;
  /** Minimum gap between placeholder edits. Default 1100ms. */
  streamEditGapMs?: number;
  /** Slash commands to dispatch locally before the LLM path + publish
   *  to Telegram via setMyCommands on start. When undefined, slash
   *  messages fall through to onMessage like any other text. */
  slashCommands?: TgSlashCommand[];
  /** Host-side context required by slash-command handlers (LLM
   *  provider config, etc.). Required when `slashCommands` is set. */
  slashContext?: {
    userConfig: import('./user-config.js').UserConfig;
    /** Tier 1 telegram fan-out arc — opaque bridge handle so the
     *  /resume slash command can call setDaemonSessionForChat. The
     *  command does its own cast to avoid coupling telegram.ts to
     *  the bridge module (cyclic import otherwise). */
    daemonBridge?: unknown;
  };
  /** Phase 8 (2026-04-30) — voice msg adapter. When supplied + the
   *  incoming msg has a `voice` attachment, the bot:
   *    1. Downloads the .ogg via downloadFile()
   *    2. Calls adapter.transcribeOgg() to get the transcript text
   *    3. Substitutes ctx.text with the transcript so onMessage /
   *       slash dispatch sees the spoken words as if typed
   *    4. After reply, when adapter.replyMode resolves to 'voice'
   *       (auto + fromVoice or explicit voice), generates the voice
   *       reply and sends via sendVoice instead of sendMessage.
   *  Without this opt, voice attachments are summarised as text
   *  placeholders (existing behaviour). */
  voiceAdapter?: TelegramVoiceAdapter;
  /** Surface-unification v2 (2026-05-11 · FU-2) — workflow-runtime
   *  Telegram trigger tap. Receives a normalized event for every
   *  allowed inbound message so the workflow daemon can match
   *  telegramTrigger nodes (chat/user/command/pattern) and dispatch
   *  independently of the LLM chat path. Best-effort: errors are
   *  swallowed by the caller — never blocks chat reply. */
  onTriggerTap?: (event: TgTriggerEvent) => void | Promise<void>;
  /** Test seam for addressed seat intake; defaults to the real intake door. */
  seatWorkDeps?: TelegramSeatWorkDeps;
  /** `#현장` 기본 행사 — 없으면 `slashContext.userConfig.telegram.fieldDefaultEvent` · 그것도 없으면 `field-<로컬 날짜>`. */
  fieldDefaultEvent?: string;
  /** 시험 seam — 현장 폴더 뿌리(기본 `getElanousConfigDir()`). */
  fieldRootDir?: () => string;
  /** 시험에서는 실제 렌더 대신 가짜 실행기를 주입한다. */
  fieldReel?: FieldReelOptions;
  /** NOTE3a engine and audio decoder are injected; no transcription provider is assumed. */
  fieldNoteEngine?: TranscriptionEngine;
  fieldNoteDecodeAudio?: (file: string, recordedAt: string) => FieldAudio;
  /** Test seam for the business-card graph and its private run root. */
  cardFollowupDeps?: Pick<CardPhotoDeps, 'runGraph' | 'rootDir' | 'ocrText'>;
  fabricPlanDeps?: import('./telegram-fabric-plan.js').TelegramFabricPlanDeps;
  /** 시험 seam — `/v1/context/now` 와 같은 `contextNow` 읽기. 던지면 «맥락 못 읽음». */
  readContextNow?: typeof readContextNow;
  contextNowDeps?: ContextNowDeps;
}

/** Surface-unification v2 (FU-2) — Telegram trigger event passed to
 *  `onTriggerTap`. Maps onto workflow-runtime's TelegramEvent. */
export interface TgTriggerEvent {
  kind: 'message' | 'command' | 'callback_query';
  /** Chat id as a string (TelegramEvent.chat is string). */
  chat: string;
  /** User id as a string. */
  user: string;
  /** Message body / command body / callback data. */
  body: string;
  /** When kind='command', the parsed command name without leading `/`. */
  command?: string;
  messageId: number;
  isDm: boolean;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_POLL_TIMEOUT = 25;
const DEFAULT_ERROR_BACKOFF = 5000;
const DEFAULT_PER_CHAT_GAP_MS = 900;
const DEFAULT_GLOBAL_MAX_PER_SEC = 28;
const DEFAULT_STREAM_EDIT_GAP_MS = 1100;
const EMPTY_ALLOWLIST_NOTICE_GAP_MS = 10 * 60 * 1000;
// A turn slower than this delivers its result as FRESH messages (which
// push-notify) instead of a silent placeholder edit — so a long /cc job
// or HITL-approved task the user walked away from actually pings them.
// Tuned above a normal chat answer but below a real delegation (which
// pays a multi-second session load before any work).
const NOTIFY_AS_NEW_MSG_THRESHOLD_MS = 20_000;

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Surface-unification v2 FU-2 — derive command name + kind from a
 *  Telegram message text. `/cmd@bot rest` → { kind: 'command', command:
 *  'cmd', body: 'rest' }. Falls back to plain 'message'. Exported so
 *  tests can pin the parser independently of the bot's outbound IO. */
export function classifyTelegramText(
  text: string,
): { kind: 'message' } | { kind: 'command'; command: string; body: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'message' };
  // Match /<cmd>[@bot] [rest]
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(trimmed);
  if (!m) return { kind: 'message' };
  return { kind: 'command', command: m[1]!, body: m[2] ?? '' };
}

export class TelegramBot {
  private readonly token: string;
  readonly botId: string;
  private readonly allowedUsers: Set<number>;
  private readonly onMessage: TelegramBotOpts['onMessage'];
  private readonly fetchImpl: typeof fetch;
  private readonly errorBackoffMs: number;
  private readonly pollTimeoutSec: number;
  private readonly maxChars: number;
  private readonly log: (msg: string) => void;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly perChatGapMs: number;
  private readonly globalMaxPerSec: number;
  private readonly streamEditGapMs: number;
  readonly homeChannel?: number;
  private offset = 0;
  private running = false;
  private readonly slashCommands: TgSlashCommand[];
  private readonly slashContext?: {
    userConfig: import('./user-config.js').UserConfig;
    daemonBridge?: unknown;
  };
  private readonly voiceAdapter?: TelegramVoiceAdapter;
  /** Surface-unification v2 FU-2 — workflow-runtime tap. */
  private readonly onTriggerTap: ((event: TgTriggerEvent) => void | Promise<void>) | null = null;
  /** Per-chat throttle (ms timestamp of last outbound message). Empty
   *  means no recent send. Telegram's documented limit is 1 msg/sec
   *  per chat — we enforce 900ms to leave jitter slack. */
  private readonly chatLastSentAt = new Map<number, number>();
  private readonly emptyAllowlistNoticeAt = new Map<number, number>();
  /** T2-P6 — callback_query subscribers. When any is registered the
   *  getUpdates poller also asks for callback_query updates so
   *  inline-keyboard taps reach a handler. */
  private readonly callbackHandlers = new Set<TgCallbackHandler>();
  private readonly reactionHandlers = new Set<TgReactionHandler>();
  /** Lazily-built surface-scoped HITL provider (single callback
   *  subscription, per-chat confirm channels). See
   *  `hitlConfirmChannelForChat`. */
  private surfaceHitl?: TelegramSurfaceHitl;
  /** Serialized turn chain. Message/command turns run one-at-a-time
   *  here but are NOT awaited by the poll loop — so the loop keeps
   *  fetching updates (incl. `callback_query`) while a turn is in
   *  flight. This is what lets an in-turn HITL approval tap reach the
   *  bot on the SAME token: without it, `await handleIncoming` blocks
   *  the single poller and the tap can't be fetched until the turn
   *  (deadlocked on the tap) times out. Drained at loop exit so
   *  `stop()` / tests see turns finish. */
  private turnChain: Promise<void> = Promise.resolve();
  /** Pending "next text message" captures, keyed by chat+thread. Used
   *  by the HITL multi-option question channel's "Other" free-form
   *  step: while a capture is registered, the next plain-text message
   *  from that chat resolves the capture INSTEAD of starting a new
   *  turn. Rare + short-lived (only during an Other prompt). */
  private readonly pendingTextCaptures = new Map<string, (text: string | null) => void>();
  /** Global sliding window of outbound timestamps (last 1s). Keeps
   *  the bot under Telegram's ~30/sec global cap without blocking
   *  further if load is bursty but average-safe. */
  private readonly globalWindow: number[] = [];
  private readonly fieldDefaultEventOpt?: string;
  private readonly fieldRootDir: () => string;
  private readonly fieldReel?: FieldReelOptions;
  private readonly fieldNoteEngine?: TranscriptionEngine;
  private readonly fieldNoteDecodeAudio?: (file: string, recordedAt: string) => FieldAudio;
  private readonly cardFollowupDeps: Pick<CardPhotoDeps, 'runGraph' | 'rootDir' | 'ocrText'>;
  private readonly seatWorkDeps: TelegramSeatWorkDeps;
  private readonly handleFabricPlan: (ctx: TgIncoming) => Promise<boolean>;
  private readonly readContextNow: typeof readContextNow;
  private readonly contextNowDeps?: ContextNowDeps;
  private readonly contextFirstGate = createContextFirstGate({ now: () => this.nowImpl() });
  private seatAskTimer: ReturnType<typeof setInterval> | null = null;
  /** 앨범 id → `#현장` 행사 · 답장 디바운스. 태그된 앨범만 들어온다. */
  private readonly fieldGroups = new Map<string, {
    event: string; mode?: 'instant'; at: number; chatId: number; threadId?: number; replyTo: number; count: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  constructor(opts: TelegramBotOpts) {
    if (!opts.token) throw new Error('TelegramBot: token required');
    this.token = opts.token;
    // Bot id = the token's non-secret numeric prefix (before ':'). Stable
    // + unique per bot; used to scope telegram sessions per channel.
    this.botId = opts.token.split(':')[0] || opts.token;
    this.allowedUsers = new Set(opts.allowedUsers);
    this.onMessage = opts.onMessage;
    this.homeChannel = opts.homeChannel;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.errorBackoffMs = opts.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT;
    this.maxChars = opts.maxMessageChars ?? DEFAULT_MAX_CHARS;
    // LF2(2026-07-13) — 기본 no-op 이던 봇 코어 로거를 debug.log 브릿지로:
    // env(ELANOUS_DAEMON_MIRROR_VERBOSE) 없이도 프로덕션 봇 라인이 파일
    // 트레일 + logs.db 에 남는다(로그 소실 해소). 호출측 log 주입이 우선.
    this.log = opts.log ?? ((m: string) => debug.log('telegram.core', m));
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.nowImpl = opts.nowImpl ?? (() => Date.now());
    this.perChatGapMs = opts.perChatGapMs ?? DEFAULT_PER_CHAT_GAP_MS;
    this.globalMaxPerSec = opts.globalMaxPerSec ?? DEFAULT_GLOBAL_MAX_PER_SEC;
    this.streamEditGapMs = opts.streamEditGapMs ?? DEFAULT_STREAM_EDIT_GAP_MS;
    this.slashCommands = opts.slashCommands ?? [];
    this.slashContext = opts.slashContext;
    this.voiceAdapter = opts.voiceAdapter;
    this.fieldDefaultEventOpt = opts.fieldDefaultEvent;
    this.fieldRootDir = opts.fieldRootDir ?? getElanousConfigDir;
    this.fieldReel = opts.fieldReel;
    this.fieldNoteEngine = opts.fieldNoteEngine;
    this.fieldNoteDecodeAudio = opts.fieldNoteDecodeAudio;
    this.cardFollowupDeps = opts.cardFollowupDeps ?? {};
    this.handleFabricPlan = attachTelegramFabricPlan(this, opts.fabricPlanDeps);
    this.readContextNow = opts.readContextNow ?? readContextNow;
    this.contextNowDeps = opts.contextNowDeps;
    this.seatWorkDeps = { ...opts.seatWorkDeps, askDeps: { ...opts.seatWorkDeps?.askDeps,
      channel: 'telegram', botId: this.botId,
      send: opts.seatWorkDeps?.askDeps?.send ?? (async (origin, text) => {
        if (origin.channel !== 'telegram') throw new Error('seat ask belongs to another surface');
        const posted = await this.sendMessage(Number(origin.chatId), text, { replyTo: origin.messageId, threadId: origin.threadId });
        if (!posted) throw new Error('Telegram seat ask reply was not posted');
      }),
    } };

    if (opts.onTriggerTap) {
      // Assign through `as unknown` to bypass `readonly` + private —
      // the tap is set once at construction and never reassigned.
      (this as unknown as { onTriggerTap: TelegramBotOpts['onTriggerTap'] }).onTriggerTap = opts.onTriggerTap;
    }
  }

  isOwnerAllowed(userId: number): boolean {
    return this.allowedUsers.size > 0 && this.allowedUsers.has(userId);
  }

  /** 허용된 모든 발화(명령 포함)마다 부른다 — 쉼은 마지막 발화부터 재고, 요약 전송과는 따로 기록한다. */
  private noteUtterance(ctx: TgIncoming): void {
    this.contextFirstGate.note(`${ctx.chatId}:${ctx.threadId ?? ''}`);
  }

  /** 처음이거나 6시간 이상 쉰 대화의 첫 일반 답 앞에 context-now 요약 한 메시지를 보낸다. 실패해도 본 답은 막지 않는다. */
  private async maybeSendContextFirst(ctx: TgIncoming): Promise<void> {
    const key = `${ctx.chatId}:${ctx.threadId ?? ''}`;
    if (!this.contextFirstGate.take(key)) return;
    const cfg = this.slashContext?.userConfig.telegram;
    if (cfg?.contextFirst === false) return;
    try {
      await this.sendMessage(ctx.chatId, renderContextFirst(this.readContextNow, this.contextNowDeps, renderTelegramNow), { replyTo: ctx.messageId, threadId: ctx.threadId });
    } catch (err) {
      this.log(`telegram context-first failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refuseMessage(ctx: TgIncoming): Promise<void> {
    const empty = this.allowedUsers.size === 0;
    debug.log('telegram.owner-gate', 'refused', {
      kind: 'message', reason: empty ? 'empty-allowlist' : 'not-allowed', userId: ctx.userId,
    });
    if (!empty) this.log(`telegram: refusing unknown user ${ctx.userId}`);
    if (empty) {
      const now = this.nowImpl();
      const previous = this.emptyAllowlistNoticeAt.get(ctx.chatId);
      if (previous !== undefined && now - previous < EMPTY_ALLOWLIST_NOTICE_GAP_MS) return;
      this.emptyAllowlistNoticeAt.set(ctx.chatId, now);
    }
    try {
      await this.sendMessage(
        ctx.chatId,
        empty
          ? `이 봇은 아직 소유자가 정해지지 않았습니다. 당신의 사용자 ID 는 ${ctx.userId} 입니다 — 기계에서 \`elanous config set telegram.allowedUsers '[${ctx.userId}]'\` 로 등록하면 쓸 수 있습니다.`
          : 'This bot is private. Your user ID is not on the allowlist.',
        { replyTo: ctx.messageId, threadId: ctx.threadId },
      );
    } catch { /* swallow — refusal must not enter the turn */ }
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async apiCall<T>(method: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(this.apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json() as ApiResponse<T>;
    if (!json.ok) {
      const err = new Error(`telegram ${method} failed: ${json.description ?? 'unknown'}`);
      (err as any).retryAfter = json.parameters?.retry_after;
      (err as any).errorCode = json.error_code;
      (err as any).description = json.description;  // exposed so callers
                                                     // can match on the
                                                     // raw string (e.g.
                                                     // "message is not modified")
      throw err;
    }
    return json.result as T;
  }

  /** Bot API /getMe — returns the bot's identity. Used by the
   *  onboarding wizard to validate a just-pasted token. */
  async getMe(): Promise<{ id: number; username?: string; firstName?: string; canJoinGroups?: boolean }> {
    const r = await this.apiCall<{ id: number; username?: string; first_name?: string; can_join_groups?: boolean }>('getMe', {});
    return {
      id: r.id,
      username: r.username,
      firstName: r.first_name,
      canJoinGroups: r.can_join_groups,
    };
  }

  /** Bot API /sendPhoto — `photo` may be a URL string(텔레그램이 직접 fetch)
   *  또는 file_id. 캡션은 1024자 상한. fail 시 throw(호출측 fail-soft 권장). */
  async sendPhoto(chatId: number, photo: string, opts: { caption?: string; threadId?: number; parseMode?: 'MarkdownV2' | 'HTML' } = {}): Promise<{ messageId: number } | void> {
    const body: Record<string, unknown> = { chat_id: chatId, photo };
    if (opts.caption) body.caption = opts.caption.slice(0, 1024);
    if (opts.threadId != null) body.message_thread_id = opts.threadId;
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    const r = await this.apiCall<{ message_id: number }>('sendPhoto', body);
    return r ? { messageId: r.message_id } : undefined;
  }

  /** Bot API /sendPhoto with FRESH binary bytes (multipart/form-data) —
   *  for locally-rendered images (e.g. a PtyShell screen PNG) that have no
   *  URL/file_id. Mirrors sendVoice's binary upload + per-chat gap so rapid
   *  captures in one turn don't trip the 1msg/sec limit. Returns undefined
   *  on failure — a capture must never throw into a running turn. */
  async sendPhotoBuffer(chatId: number, png: Buffer, opts: {
    caption?: string;
    threadId?: number;
  } = {}): Promise<{ messageId: number } | undefined> {
    const last = this.chatLastSentAt.get(chatId) ?? 0;
    const wait = Math.max(0, last + this.perChatGapMs - this.nowImpl());
    if (wait > 0) await new Promise<void>(r => setTimeout(r, wait));
    this.chatLastSentAt.set(chatId, this.nowImpl());
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (opts.caption) form.set('caption', opts.caption.slice(0, 1024));
    if (opts.threadId != null) form.set('message_thread_id', String(opts.threadId));
    // Copy into a plain ArrayBuffer — Blob rejects SharedArrayBuffer-backed views.
    const bytes = new ArrayBuffer(png.byteLength);
    new Uint8Array(bytes).set(png);
    form.set('photo', new Blob([bytes], { type: 'image/png' }), 'screen.png');
    const url = `https://api.telegram.org/bot${this.token}/sendPhoto`;
    try {
      const res = await this.fetchImpl(url, { method: 'POST', body: form });
      const payload = (await res.json()) as ApiResponse<{ message_id?: number }>;
      if (!payload.ok) { this.log(`sendPhotoBuffer failed: ${payload.description ?? 'unknown'}`); return undefined; }
      const mid = payload.result?.message_id;
      return typeof mid === 'number' ? { messageId: mid } : undefined;
    } catch (err) {
      this.log(`sendPhotoBuffer error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Download a file by file_id to a local path. Two-step per Bot API:
   *    1) POST /getFile?file_id=...  → { file_path, file_size, ... }
   *    2) GET  api.telegram.org/file/bot<TOKEN>/<file_path> → binary
   *  Returns the destination path + inferred metadata. Caller is
   *  responsible for unlink()-ing when done. */
  async downloadFile(fileId: string, destDir?: string): Promise<{
    localPath: string;
    fileName?: string;
    filePath: string;
    fileSize?: number;
  }> {
    const info = await this.apiCall<{ file_id: string; file_path?: string; file_size?: number }>(
      'getFile', { file_id: fileId },
    );
    if (!info || !info.file_path) throw new Error(`getFile: missing file_path for ${fileId}`);
    const binUrl = `https://api.telegram.org/file/bot${this.token}/${info.file_path}`;
    const res = await this.fetchImpl(binUrl);
    if (!res.ok) throw new Error(`download failed: status=${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const dir = destDir ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    const basename = info.file_path.split('/').pop() || `${randomUUID()}.bin`;
    const localPath = joinPath(dir, `${randomUUID()}-${basename}`);
    writeFileSync(localPath, buf);
    return { localPath, fileName: basename, filePath: info.file_path, fileSize: info.file_size };
  }

  async sendMessage(chatId: number, text: string, opts: {
    replyTo?: number;
    parseMode?: 'MarkdownV2' | 'HTML';
    threadId?: number;
    /** Treat `text` as markdown and convert to Telegram's HTML subset
     *  before sending. Mutually exclusive with `parseMode` — when
     *  markdown=true we drive parseMode ourselves, including the
     *  plain-text retry on parse errors. Default false keeps
     *  existing callers (refusal messages, error banners) untouched. */
    markdown?: boolean;
  } = {}): Promise<{ messageId: number } | void> {
    if (!text) return;

    if (opts.markdown && !opts.parseMode) {
      // Chunk the MARKDOWN at paragraph boundaries so each piece renders
      // well under Telegram's 4096-char HTML cap after tag inflation.
      // If HTML dispatch fails with a parse-entity error we retry the
      // original markdown chunk as plain text — the user still gets the
      // content, just without the formatting. openclaw uses the same
      // fallback (withTelegramHtmlParseFallback in its send.ts).
      const mdChunks = splitMarkdownForTelegram(text, this.maxChars);
      let lastId: number | undefined;
      for (const chunk of mdChunks) {
        const html = markdownToTelegramHtml(chunk);
        try {
          const r = await this.sendOne(chatId, html, {
            replyTo: opts.replyTo,
            threadId: opts.threadId,
            parseMode: 'HTML',
          });
          if (r?.messageId !== undefined) lastId = r.messageId;
        } catch (err: unknown) {
          if (!isTelegramParseEntityError(err)) throw err;
          const r = await this.sendOne(chatId, chunk, {
            replyTo: opts.replyTo,
            threadId: opts.threadId,
          });
          if (r?.messageId !== undefined) lastId = r.messageId;
        }
      }
      return lastId !== undefined ? { messageId: lastId } : undefined;
    }

    // Chunk defensively — LLM answers frequently exceed 4096 when code
    // blocks or transcripts are included. Returns the last chunk's
    // message_id so callers can edit-in-place if they want.
    const chunks = splitForTelegram(text, this.maxChars);
    let lastId: number | undefined;
    for (const chunk of chunks) {
      const r = await this.sendOne(chatId, chunk, opts);
      if (r?.messageId !== undefined) lastId = r.messageId;
    }
    return lastId !== undefined ? { messageId: lastId } : undefined;
  }

  /** Replace the contents of an existing message. Useful for
   *  "working…" → final-answer flows and progress counters that would
   *  otherwise spam the chat with N separate messages.
   *
   *  Telegram caps edits at 48 hours after the message was sent; our
   *  typical use is seconds so this is not a real constraint.
   *  Safely ignores "message is not modified" (400) errors that fire
   *  when the edit would be a no-op. */
  async editMessageText(chatId: number, messageId: number, text: string, opts: {
    parseMode?: 'MarkdownV2' | 'HTML';
    threadId?: number;
    /** Convert markdown → Telegram HTML before sending (mirrors the
     *  sendMessage option). On parse-entity error we retry the original
     *  markdown chunk as plain text — same fallback pattern. */
    markdown?: boolean;
  } = {}): Promise<void> {
    if (!text) return;
    // edit path: chunking here doesn't make sense (a single message
    // can only carry one body); truncate with an ellipsis so the user
    // sees SOMETHING rather than hitting a 400 for oversized input.
    const chunk = text.length > this.maxChars
      ? text.slice(0, this.maxChars - 4) + ' …'
      : text;

    if (opts.markdown && !opts.parseMode) {
      const html = markdownToTelegramHtml(chunk);
      try {
        await this.rawEditMessageText(chatId, messageId, html, { parseMode: 'HTML' });
        return;
      } catch (err: unknown) {
        if (!isTelegramParseEntityError(err)) throw err;
        // Fall back to plain text (original markdown chunk, unconverted).
      }
      await this.rawEditMessageText(chatId, messageId, chunk, {});
      return;
    }

    await this.rawEditMessageText(chatId, messageId, chunk, { parseMode: opts.parseMode });
  }

  private async rawEditMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parseMode?: 'MarkdownV2' | 'HTML' },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    await this.throttledCall<unknown>(chatId, 'editMessageText', body, {
      ignore: (err) =>
        typeof err?.description === 'string'
        && /message is not modified/i.test(err.description),
    });
  }

  /** §C5-enh reactions-as-status — 사용자 메시지에 이모지 리액션(👀 큐 → 👍/👎). 편집보다 저비용
   *  상태채널(hermes/openclaw 선례). emoji=null 이면 리액션 제거. Bot API 7.0+ setMessageReaction.
   *  fail-soft(리액션 실패가 배달을 막지 않음). */
  async setMessageReaction(chatId: number, messageId: number, emoji: string | null): Promise<void> {
    try {
      await this.throttledCall<unknown>(chatId, 'setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      });
    } catch (err: any) {
      this.log(`setMessageReaction failed: ${err?.message ?? String(err)}`);
    }
  }

  /** §C5-enh typing governor — sendChatAction("typing") 저비용 라이브 신호(첫 청크 전 liveness).
   *  ⚠️ anti-footgun: 401(봇이 차단/삭제) 시 영구 suspend 는 호출측 governor 담당. 여기선 순수
   *  1회 호출·throttle 미적용(chatAction 은 rate 관대). fail-soft. */
  async sendChatAction(chatId: number, action: string, opts: { threadId?: number } = {}): Promise<void> {
    await this.throttledCall<unknown>(chatId, 'sendChatAction', {
      chat_id: chatId,
      action,
      ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
    });
  }

  /** §C5-enh scroll-jump rotation — 옛 placeholder 삭제(post-new-then-delete). fail-soft
   *  (이미 삭제/권한없음 무시). */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.throttledCall<unknown>(chatId, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (err: any) {
      this.log(`deleteMessage failed: ${err?.message ?? String(err)}`);
    }
  }

  /** Clear an existing message's inline_keyboard. Used by HITL
   *  channels (β-1 dismiss polish · 2026-05-08) to take down the
   *  Yes/No buttons after a sibling channel won the race — leaves
   *  the message text intact but prevents stale taps. Telegram's
   *  editMessageReplyMarkup endpoint accepts an empty inline_keyboard
   *  array as the "remove buttons" sentinel. */
  async clearMessageReplyMarkup(chatId: number, messageId: number): Promise<void> {
    await this.throttledCall<unknown>(chatId, 'editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }, {
      ignore: (err) =>
        typeof err?.description === 'string'
        // No-op when the message was already edited / deleted /
        // unchanged — best-effort cleanup, never block the cancel.
        && (/message is not modified/i.test(err.description)
          || /message to edit not found/i.test(err.description)),
    });
  }

  /** Convenience: post an initial placeholder, then call `work()`;
   *  when it resolves, edit the placeholder with the final text. On
   *  error the placeholder gets an inline error line instead of a
   *  second message. Returns the edited message_id. */
  async sendWithEdit(
    chatId: number,
    placeholder: string,
    work: () => Promise<string>,
    opts: {
      replyTo?: number;
      parseMode?: 'MarkdownV2' | 'HTML';
      threadId?: number;
      errorPrefix?: string;
    } = {},
  ): Promise<{ messageId: number } | undefined> {
    const posted = await this.sendMessage(chatId, placeholder, opts);
    const mid = posted?.messageId;
    try {
      const finalText = await work();
      if (mid !== undefined) {
        await this.editMessageText(chatId, mid, finalText, {
          parseMode: opts.parseMode,
          threadId: opts.threadId,
        });
      } else {
        await this.sendMessage(chatId, finalText, opts);
      }
    } catch (err: any) {
      const line = `${opts.errorPrefix ?? 'Error'}: ${err?.message ?? String(err)}`;
      if (mid !== undefined) {
        try {
          await this.editMessageText(chatId, mid, line);
        } catch { /* edit failed — post a fresh error message */
          await this.sendMessage(chatId, line, opts);
        }
      } else {
        await this.sendMessage(chatId, line, opts);
      }
    }
    return mid !== undefined ? { messageId: mid } : undefined;
  }

  private async sendOne(chatId: number, text: string, opts: {
    replyTo?: number;
    parseMode?: 'MarkdownV2' | 'HTML';
    threadId?: number;
  }): Promise<{ messageId: number } | undefined> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.replyTo) body.reply_to_message_id = opts.replyTo;
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.threadId != null) body.message_thread_id = opts.threadId;
    const result = await this.throttledCall<{ message_id?: number }>(chatId, 'sendMessage', body);
    if (result && typeof result.message_id === 'number') {
      return { messageId: result.message_id };
    }
    return undefined;
  }

  /** Phase 8 (2026-04-30) — send a voice msg (.ogg Opus blob) via
   *  Bot API sendVoice. Uses multipart/form-data so we can upload the
   *  binary inline (Telegram also accepts a previously-uploaded
   *  file_id string, but for elanous-generated TTS we always have
   *  fresh bytes). Bypasses throttledCall — voice msgs are
   *  user-initiated, low frequency, and the multipart body shape
   *  doesn't fit the JSON-based throttle path. Per-chat gap is still
   *  enforced manually. */
  async sendVoice(chatId: number, voiceOgg: Buffer, opts: {
    replyTo?: number;
    threadId?: number;
    duration?: number;
    caption?: string;
  } = {}): Promise<{ messageId: number } | undefined> {
    // Per-chat gap mirror — keep telegram happy on rapid voice replies.
    const last = this.chatLastSentAt.get(chatId) ?? 0;
    const wait = Math.max(0, last + this.perChatGapMs - this.nowImpl());
    if (wait > 0) await this.sleepImpl(wait);
    this.chatLastSentAt.set(chatId, this.nowImpl());

    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (opts.replyTo !== undefined) form.set('reply_to_message_id', String(opts.replyTo));
    if (opts.threadId !== undefined) form.set('message_thread_id', String(opts.threadId));
    if (opts.duration !== undefined) form.set('duration', String(opts.duration));
    if (opts.caption) form.set('caption', opts.caption);
    // Copy into a freshly allocated ArrayBuffer so the BlobPart type
    // resolves to ArrayBuffer (Buffer's `.buffer` typing is wider —
    // ArrayBufferLike includes SharedArrayBuffer which Blob rejects).
    const blobBytes = new ArrayBuffer(voiceOgg.byteLength);
    new Uint8Array(blobBytes).set(voiceOgg);
    form.set(
      'voice',
      new Blob([blobBytes], { type: 'audio/ogg' }),
      'voice.ogg',
    );

    const url = `https://api.telegram.org/bot${this.token}/sendVoice`;
    const res = await this.fetchImpl(url, { method: 'POST', body: form });
    let payload: ApiResponse<{ message_id?: number }>;
    try {
      payload = (await res.json()) as ApiResponse<{ message_id?: number }>;
    } catch (err) {
      this.log(`sendVoice: invalid JSON response (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
    if (!payload.ok) {
      this.log(`sendVoice failed: ${payload.description ?? 'unknown'}`);
      return undefined;
    }
    const mid = payload.result?.message_id;
    return typeof mid === 'number' ? { messageId: mid } : undefined;
  }

  /** P1.4 file spill — upload a text body as a document via Bot API
   *  sendDocument. Mirrors `sendVoice`'s multipart/form-data binary
   *  upload (Telegram also accepts a file_id, but relayed tool output is
   *  always fresh bytes). Bypasses the JSON throttle path (same reason as
   *  sendVoice) but enforces the per-chat gap manually so rapid spills in
   *  one turn don't trip the 1msg/sec limit. Returns undefined on failure
   *  — a spill must never throw into a running turn. */
  async sendDocument(chatId: number, body: string | Buffer, filename: string, opts: {
    replyTo?: number;
    threadId?: number;
    caption?: string;
    mimeType?: string;
  } = {}): Promise<{ messageId: number } | undefined> {
    // Per-chat gap mirror — keep telegram happy on rapid document spills.
    const last = this.chatLastSentAt.get(chatId) ?? 0;
    const wait = Math.max(0, last + this.perChatGapMs - this.nowImpl());
    if (wait > 0) await this.sleepImpl(wait);
    this.chatLastSentAt.set(chatId, this.nowImpl());

    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (opts.replyTo !== undefined) form.set('reply_to_message_id', String(opts.replyTo));
    if (opts.threadId !== undefined) form.set('message_thread_id', String(opts.threadId));
    if (opts.caption) form.set('caption', opts.caption.slice(0, 1024));
    // Copy into a freshly allocated ArrayBuffer so the BlobPart type
    // resolves to ArrayBuffer (Buffer's `.buffer` typing is wider —
    // ArrayBufferLike includes SharedArrayBuffer which Blob rejects).
    const blobBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(blobBytes).set(bytes);
    form.set(
      'document',
      new Blob([blobBytes], { type: opts.mimeType ?? 'text/plain' }),
      filename,
    );

    const url = `https://api.telegram.org/bot${this.token}/sendDocument`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', body: form });
    } catch (err) {
      this.log(`sendDocument failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    let payload: ApiResponse<{ message_id?: number }>;
    try {
      payload = (await res.json()) as ApiResponse<{ message_id?: number }>;
    } catch (err) {
      this.log(`sendDocument: invalid JSON response (${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
    if (!payload.ok) {
      this.log(`sendDocument failed: ${payload.description ?? 'unknown'}`);
      return undefined;
    }
    const mid = payload.result?.message_id;
    return typeof mid === 'number' ? { messageId: mid } : undefined;
  }

  /** P1.4 · surface file spill — return a `FileSink` that uploads a body
   *  as a document into `chatId` (optionally forum `threadId`). Paired
   *  with `hitlConfirmChannelForChat` / `makeStreamer` so BOTH delegate
   *  paths (slash `/cc` via the streamer, NL `delegate_code_agent` via
   *  the daemon-tool ctx) spill overflowing tool bodies back into the
   *  originating chat. Fire-and-forget: the send is scheduled and its
   *  errors swallowed so a spill can't wedge the turn. */
  fileSinkForChat(chatId: number, threadId?: number): import('./channel/file-sink.js').FileSink {
    return {
      sendFile: (body: string, o: { ext: string; caption?: string; name?: string }): void => {
        const filename = o.name ?? `tool-output.${o.ext === 'diff' ? 'diff' : 'txt'}`;
        void this.sendDocument(chatId, body, filename, {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(o.caption ? { caption: o.caption } : {}),
        }).catch((err: unknown) => {
          this.log(`fileSink spill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      sendImage: (png: Buffer, o?: { caption?: string }): void => {
        void this.sendPhotoBuffer(chatId, png, {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(o?.caption ? { caption: o.caption } : {}),
        }).catch((err: unknown) => {
          this.log(`fileSink image spill failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
    };
  }

  /** T2-P6 — post a message with an inline keyboard. Each row is an
   *  array of buttons; each button has a label and a callback data
   *  payload. The data string arrives in onCallbackQuery() when the
   *  user taps. Telegram caps callback data at 64 bytes. */
  async sendInlineKeyboard(
    chatId: number,
    text: string,
    buttons: Array<Array<{ text: string; data: string }>>,
    opts: { replyTo?: number; threadId?: number } = {},
  ): Promise<{ messageId: number } | undefined> {
    const inline_keyboard = buttons.map(row => row.map(b => {
      // Telegram caps callback_data at 64 BYTES. Silently truncating here
      // once dropped a HITL decision token (`:yes`) past byte 64 and made
      // approval taps un-matchable — invisibly. Warn loudly so an
      // over-long id surfaces in logs instead of failing dead. (Byte
      // length, not char length — non-ASCII data can overrun earlier.)
      const bytes = Buffer.byteLength(b.data, 'utf8');
      if (bytes > 64) {
        this.log(`sendInlineKeyboard: callback_data ${bytes}B > 64B, TRUNCATED (button "${b.text}"): ${b.data.slice(0, 48)}…`);
      }
      return { text: b.text, callback_data: b.data.slice(0, 64) };
    }));
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard },
    };
    if (opts.replyTo) body.reply_to_message_id = opts.replyTo;
    if (opts.threadId != null) body.message_thread_id = opts.threadId;
    const result = await this.throttledCall<{ message_id?: number }>(chatId, 'sendMessage', body);
    if (result && typeof result.message_id === 'number') {
      return { messageId: result.message_id };
    }
    return undefined;
  }

  /** DEC-TG — replace a message's text AND its inline keyboard (empty rows remove the buttons). */
  async editMessageWithKeyboard(
    chatId: number,
    messageId: number,
    text: string,
    buttons: Array<Array<{ text: string; data: string }>>,
  ): Promise<void> {
    await this.throttledCall<unknown>(chatId, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.length > this.maxChars ? `${text.slice(0, this.maxChars - 2)} …` : text,
      reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))) },
    });
  }

  /** True while the long-poll loop runs — only a polling bot should push decision cards (nexus may hold a send-only bot). */
  isPolling(): boolean { return this.running; }

  /** T2-P6 — acknowledge a callback_query so Telegram clears the
   *  spinner next to the button the user tapped. Pass a `text` to
   *  flash a tiny toast on the user's device (≤200 chars). Returns
   *  nothing; errors are swallowed because acking is best-effort. */
  async answerCallbackQuery(
    callbackQueryId: string,
    opts: { text?: string; alert?: boolean } = {},
  ): Promise<void> {
    try {
      await this.apiCall<unknown>('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: opts.text,
        show_alert: opts.alert,
      });
    } catch (err) {
      this.log(`answerCallbackQuery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** T2-P6 — subscribe to callback_query updates. Returns an unsub
   *  function. The poller automatically includes callback_query in
   *  allowed_updates while at least one handler is registered. */
  onCallbackQuery(handler: TgCallbackHandler): () => void {
    this.callbackHandlers.add(handler);
    return () => { this.callbackHandlers.delete(handler); };
  }

  /** Subscribe to message_reaction updates (UX 에이전트 리액션 수신·👍/👎 간단 승인).
   *  The poller adds `message_reaction` to allowed_updates only while at least one
   *  handler is registered (default = none → 폴링 동작 불변·비파괴). Bot API 7.0+. */
  onMessageReaction(handler: TgReactionHandler): () => void {
    this.reactionHandlers.add(handler);
    return () => { this.reactionHandlers.delete(handler); };
  }

  /** Capture the NEXT plain-text message from `(chatId, threadId)` —
   *  the HITL question channel uses this for the "Other" free-form
   *  step. The captured message is routed to `resolver` (with `null`
   *  when the user typed a slash command instead) and is NOT processed
   *  as a normal turn. Returns an unregister fn; only one capture per
   *  chat+thread is active at a time (a new one replaces the old). */
  captureNextText(
    chatId: number,
    threadId: number | undefined,
    resolver: (text: string | null) => void,
  ): () => void {
    const key = `${chatId}:${threadId ?? ''}`;
    this.pendingTextCaptures.set(key, resolver);
    return () => {
      if (this.pendingTextCaptures.get(key) === resolver) {
        this.pendingTextCaptures.delete(key);
      }
    };
  }

  /** If a HITL "Other" text capture is pending for this chat, consume
   *  the message's text and return true (caller must NOT process it as
   *  a turn). Handled in the poll loop BEFORE the serialized turn chain
   *  so the reply isn't queued behind the very turn that's waiting for
   *  it (which would re-introduce the deadlock the turn chain fixes). A
   *  slash command resolves the capture with `null` (cancel). */
  private tryConsumeTextCapture(ctx: TgIncoming): boolean {
    if (!ctx.text || ctx.attachments.length > 0) return false;
    if (!this.isOwnerAllowed(ctx.userId)) return false;
    const key = `${ctx.chatId}:${ctx.threadId ?? ''}`;
    const capture = this.pendingTextCaptures.get(key);
    if (!capture) return false;
    this.pendingTextCaptures.delete(key);
    capture(ctx.text.startsWith('/') ? null : ctx.text);
    return true;
  }

  /** Surface-scoped HITL — return a `ConfirmChannel` that posts its
   *  Yes/No prompt into `chatId` (optionally forum `threadId`) and
   *  resolves when that chat's user taps. `/cc`-style delegation hands
   *  this to `runAcpTurn` so a sub-agent's permission / clarifying
   *  prompt lands back in the mission's originating chat rather than a
   *  global HITL bot. The underlying callback subscription is created
   *  once and shared across chats. */
  hitlConfirmChannelForChat(chatId: number, threadId?: number): ConfirmChannel {
    return this.ensureSurfaceHitl().confirmChannelForChat(chatId, threadId);
  }

  /** Surface-scoped multi-option HITL question channel bound to this
   *  chat. Paired with `hitlConfirmChannelForChat` so a delegated
   *  sub-agent's structured questions surface as inline-keyboard
   *  option buttons in the originating chat. */
  hitlQuestionChannelForChat(chatId: number, threadId?: number): QuestionChannel {
    return this.ensureSurfaceHitl().questionChannelForChat(chatId, threadId);
  }

  /** Eagerly build the surface HITL provider (idempotent). Registering
   *  its `onCallbackQuery` subscription up front means the poll loop
   *  requests `callback_query` updates from the very first `getUpdates`
   *  — so an in-turn HITL approval tap isn't delayed waiting for the
   *  subscription to appear mid-turn. Called by `botFromConfig`. */
  ensureSurfaceHitl(): TelegramSurfaceHitl {
    if (!this.surfaceHitl) this.surfaceHitl = createTelegramSurfaceHitl(this);
    return this.surfaceHitl;
  }

  /** Outbound API call with per-chat + global rate limiting and
   *  automatic 429 retry (respects the `retry_after` parameter
   *  Telegram returns on rate-limit hits). `ignore` lets callers
   *  swallow known-benign 400s like "message is not modified". */
  private async throttledCall<T>(
    chatId: number,
    method: string,
    body: Record<string, unknown>,
    opts: { ignore?: (err: any) => boolean } = {},
  ): Promise<T | undefined> {
    await this.waitForRateSlot(chatId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.apiCall<T>(method, body);
        this.recordSend(chatId);
        return r;
      } catch (err: any) {
        if (opts.ignore?.(err)) return undefined;
        const retry = err?.retryAfter;
        if (retry !== undefined && attempt < 2) {
          this.log(`telegram 429 (${method}) — sleeping ${retry}s then retrying`);
          await this.sleepImpl(retry * 1000);
          continue;
        }
        // 5xx / transient network: one short retry before surfacing.
        const code = (err?.errorCode ?? 0) as number;
        if ((code >= 500 || code === 0) && attempt < 2) {
          const backoff = 250 * (attempt + 1);
          this.log(`telegram ${method} transient (${code || 'net'}) — sleeping ${backoff}ms`);
          await this.sleepImpl(backoff);
          continue;
        }
        throw err;
      }
    }
    return undefined;
  }

  /** Block until the per-chat AND global rate-limit buckets allow the
   *  next send. Per-chat gate: at most 1 msg/sec/chat (we pad to
   *  900ms). Global gate: at most 28 msgs/sec across all chats (2
   *  msg/sec slack under Telegram's 30 cap). */
  private async waitForRateSlot(chatId: number): Promise<void> {
    // Per-chat
    const last = this.chatLastSentAt.get(chatId);
    if (last) {
      const since = this.nowImpl() - last;
      if (since < this.perChatGapMs) await this.sleepImpl(this.perChatGapMs - since);
    }
    // Global — prune events older than 1000ms and, if still at cap,
    // sleep the difference until the oldest event ages out.
    const now = this.nowImpl();
    while (this.globalWindow.length > 0 && now - this.globalWindow[0]! > 1000) {
      this.globalWindow.shift();
    }
    if (this.globalWindow.length >= this.globalMaxPerSec) {
      const oldest = this.globalWindow[0]!;
      const wait = 1000 - (this.nowImpl() - oldest) + 10;
      if (wait > 0) await this.sleepImpl(wait);
    }
  }

  private recordSend(chatId: number): void {
    const now = this.nowImpl();
    this.chatLastSentAt.set(chatId, now);
    this.globalWindow.push(now);
    // Keep the window bounded — prune aggressively here so long
    // runs don't accumulate stale timestamps.
    while (this.globalWindow.length > 0 && now - this.globalWindow[0]! > 1000) {
      this.globalWindow.shift();
    }
  }

  /** Main long-poll loop. Runs until stop() is called. */
  async start(): Promise<void> {
    this.running = true;
    this.log(`telegram bot starting (allowlist size ${this.allowedUsers.size})`);
    this.seatAskTimer = setInterval(() => {
      void deliverSeatAnswers(this.seatWorkDeps.askDeps!).catch((error) => this.log(`seat ask delivery failed: ${String(error)}`));
    }, 10_000);
    if (this.allowedUsers.size === 0) this.log('telegram.owner-gate empty-allowlist');

    // Publish the slash-command menu to Telegram. Clients pick up the
    // update automatically next time they open the chat — no user-side
    // install or restart required. Failure here is non-fatal: the bot
    // still processes `/commands` via the incoming-message dispatch
    // path, users just don't get the autocomplete.
    if (this.slashCommands.length > 0) {
      const audience = this.slashContext
        ? readBotAudience((this.slashContext.userConfig.raw?.telegram as { commandAudience?: unknown } | undefined)?.commandAudience)
        : botAudienceFor('telegram');
      const commands = filterBotCommands('telegram', this.slashCommands, audience);
      debug.log('telegram.command', 'menu-filtered', {
        total: this.slashCommands.length, shown: commands.length, ...audience,
      });
      try {
        const result = await this.apiCall<unknown>('setMyCommands', {
          commands: toTelegramBotCommands(commands),
        });
        debug.log('telegram.command', 'published', { success: true, result });
        this.log(`telegram: setMyCommands published (${String(result)})`);
      } catch (err: any) {
        const error = err?.message ?? String(err);
        debug.log('telegram.command', 'published', { success: false, error });
        this.log(`telegram setMyCommands failed (non-fatal): ${error}`);
      }
    }

    // Conflict-backoff state: when Telegram returns 409 it means
    // another /getUpdates poller is active on this token. Back off
    // exponentially (5s → 10s → 20s → 40s → 60s cap) until the
    // conflict clears. Log the first hit and every 10th subsequent
    // so the operator sees the state without being flooded.
    let conflictCount = 0;
    let conflictBackoffMs = 5_000;
    const CONFLICT_BACKOFF_CAP = 60_000;
    while (this.running) {
      try {
        await deliverSeatAnswers(this.seatWorkDeps.askDeps!);
        const wantCallbackQuery = this.callbackHandlers.size > 0;
        const wantReaction = this.reactionHandlers.size > 0;
        // allowed_updates 는 명시한 것만 받으므로 등록된 핸들러 종류만 추가(비파괴 — 핸들러
        // 없으면 종전 ['message']/['message','callback_query'] 그대로).
        const allowedUpdates: string[] = ['message'];
        if (wantCallbackQuery) allowedUpdates.push('callback_query');
        if (wantReaction) allowedUpdates.push('message_reaction');
        const updates = await this.apiCall<RawUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeoutSec,
          allowed_updates: allowedUpdates,
        });
        // A successful poll clears any conflict state — another
        // instance must have yielded (usually because the user killed
        // the other `elanous telegram run`).
        if (conflictCount > 0) {
          this.log(`telegram: conflict cleared after ${conflictCount} retries`);
          conflictCount = 0;
          conflictBackoffMs = 5_000;
        }
        for (const u of updates) {
          if (u.update_id >= this.offset) this.offset = u.update_id + 1;
          // T2-P6 — callback_query updates have no `message` — route
          // to subscribers before falling through to the message
          // parser.
          if (u.callback_query) {
            const cq = u.callback_query;
            if (!this.isOwnerAllowed(cq.from.id)) {
              // DEC-TG — a decision-card tap from someone else is the rehearsal's «refused» case; name it there too.
              if ((cq.data ?? '').startsWith('dec:')) debug.log('decisions.telegram', 'tap-refused', { platform: 'telegram', gate: 'owner-allowlist' }, { level: 'warn' });
              debug.log('telegram.owner-gate', 'refused', {
                kind: 'callback', reason: this.allowedUsers.size === 0 ? 'empty-allowlist' : 'not-allowed', userId: cq.from.id,
              });
              await this.answerCallbackQuery(cq.id, { text: '권한이 없습니다' });
              continue;
            }
            const payload: TgCallbackQuery = {
              id: cq.id,
              userId: cq.from.id,
              userName: cq.from.username ?? cq.from.first_name,
              chatId: cq.message?.chat.id,
              threadId: cq.message?.message_thread_id,
              messageId: cq.message?.message_id,
              data: cq.data ?? '',
            };
            for (const h of this.callbackHandlers) {
              try { await h(payload); } catch (err) {
                this.log(`callback handler error: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            continue;
          }
          // message_reaction updates (Bot API 7.0+) — route to reaction subscribers
          // (UX 에이전트 NORMALIZE). No `message`/`text`, so handle before the parser.
          if (u.message_reaction) {
            const mr = u.message_reaction;
            // 리액션도 미션 카드 흐름을 앞으로 민다(ux-reaction-router) — 소유자 것만 받는다. 익명(user 없음)은 거절.
            if (!mr.user || !this.isOwnerAllowed(mr.user.id)) {
              debug.log('telegram.owner-gate', 'refused', {
                kind: 'reaction', reason: this.allowedUsers.size === 0 ? 'empty-allowlist' : mr.user ? 'not-allowed' : 'anonymous', userId: mr.user?.id,
              });
              continue;
            }
            const payload: TgMessageReaction = {
              chatId: mr.chat.id,
              messageId: mr.message_id,
              ...(mr.user ? { userId: mr.user.id, ...(mr.user.username ?? mr.user.first_name ? { userName: mr.user.username ?? mr.user.first_name } : {}) } : {}),
              newReaction: mr.new_reaction ?? [],
            };
            for (const h of this.reactionHandlers) {
              try { await h(payload); } catch (err) {
                this.log(`reaction handler error: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            continue;
          }
          const incoming = parseUpdate(u);
          if (!incoming) continue;
          // Tag with THIS bot's id (token prefix) so session lookup is
          // scoped per channel — a private chat's chatId is the same user
          // id across every bot, so without this two bots' DMs merge.
          incoming.botId = this.botId;
          if (!this.isOwnerAllowed(incoming.userId)) {
            await this.refuseMessage(incoming);
            continue;
          }
          // HITL "Other" free-text: consume inline (before the turn
          // chain) so it isn't queued behind the turn awaiting it.
          if (this.tryConsumeTextCapture(incoming)) continue;
          // `/cancel` MUST bypass the serialized turnChain — otherwise it
          // queues BEHIND the very turn it wants to cancel and only fires
          // after that turn already ended (useless for a long-running NL
          // delegation / `/cc`). Handle it inline here so it aborts the
          // in-flight turn's controller immediately.
          if (incoming.text && /^\/cancel(@\w+)?\b/i.test(incoming.text.trim())) {
            void cancelAcpTurn(incoming.chatId, incoming.threadId)
              .then((hit) => this.sendMessage(
                incoming.chatId,
                hit ? '⏹ 취소 요청됨 — 진행 중 작업을 중단합니다.' : '_취소할 진행 중 작업이 없습니다._',
                { threadId: incoming.threadId, markdown: true },
              ))
              .catch((err) => this.log(`inline /cancel failed: ${err instanceof Error ? err.message : String(err)}`));
            continue;
          }
          // Run the turn on the serialized chain WITHOUT blocking the
          // poll loop — so `callback_query` updates (HITL approval taps)
          // keep being fetched while this turn is in flight. Turns still
          // execute one-at-a-time (chained); the loop just doesn't wait.
          this.turnChain = this.turnChain
            .then(() => this.handleIncoming(incoming))
            .catch((err) => {
              this.log(`telegram turn error: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      } catch (err: any) {
        const ec = (err?.errorCode ?? 0) as number;
        if (ec === 409) {
          // 409 Conflict — another poller is active. Exponential backoff.
          conflictCount++;
          if (conflictCount === 1 || conflictCount % 10 === 0) {
            this.log(
              `telegram: 409 Conflict (another poller active) — ` +
              `backoff ${conflictBackoffMs}ms, attempt #${conflictCount}`,
            );
          }
          if (!this.running) break;
          await this.sleepImpl(conflictBackoffMs);
          conflictBackoffMs = Math.min(CONFLICT_BACKOFF_CAP, conflictBackoffMs * 2);
          continue;
        }
        this.log(`telegram poll error: ${err?.message ?? String(err)}`);
        if (!this.running) break;
        // Non-conflict errors use the existing plain backoff.
        if (this.errorBackoffMs > 0) await this.sleepImpl(this.errorBackoffMs);
      }
    }
    // Drain any in-flight / queued turns so `stop()` (and tests that
    // `await bot.start()`) observe turns finishing before we return.
    await this.turnChain;
    this.log('telegram bot stopped');
  }

  stop(): void {
    this.running = false;
    if (this.seatAskTimer) clearInterval(this.seatAskTimer);
    this.seatAskTimer = null;
  }

  /** Download + normalize this message's attachments into the shape
   *  the ACP content-blocks module consumes. Called lazily by slash
   *  commands that want to forward photos / docs through /cc. Each
   *  download hits Telegram's getFile + file CDN (one RTT per file)
   *  so we skip this work entirely for text-only commands. */
  private async downloadCtxAttachments(ctx: TgIncoming): Promise<import('./acp/content-blocks.js').NormalizedAttachment[]> {
    if (ctx.attachments.length === 0) return [];
    const normalized: import('./acp/content-blocks.js').NormalizedAttachment[] = [];
    for (const att of ctx.attachments) {
      try {
        const { localPath, fileName, fileSize } = await this.downloadFile(att.fileId);
        normalized.push({
          name: att.fileName ?? fileName ?? localPath.split('/').pop()!,
          localPath,
          mimeType: att.mimeType,
          kind: att.kind,
          width: att.width,
          height: att.height,
          duration: att.duration,
          sizeBytes: att.fileSize ?? fileSize,
        });
      } catch (err: any) {
        this.log(`attachment download failed for ${att.kind} ${att.fileId}: ${err?.message ?? err}`);
        // Skip the failed one — partial attachment set is preferable
        // to aborting the whole turn.
      }
    }
    return normalized;
  }

  /** URL→skill auto-route reply (PLAN-url-triage-routing P3/P4). Runs the
   *  mapped skill (two-stage quick→detailed for summary, single-pass for
   *  absorb) and posts each stage as its own Telegram message so a fast
   *  quick summary lands before the slower detailed one. Uses a 👀/✅
   *  reaction as the low-cost status channel (no placeholder flicker).
   *  Returns true when it handled the turn; false → caller falls through
   *  to a normal LLM turn (fail-soft: skill missing / empty output). */
  private async runUrlRouteReply(ctx: TgIncoming, dec: UrlRouteDecision): Promise<boolean> {
    debug.log('telegram.url-route', 'fire', {
      chatId: ctx.chatId, kind: dec.kind, skill: dec.skill,
      absorb: dec.absorb, twoStage: dec.twoStage, url: dec.url,
    });
    // ── Immediate ack (openclaw/hermes ephemeral status lane) ──
    // A URL route runs ~30-60s. A reaction alone is too subtle — post an
    // explicit intent message right away ("빠른 요약부터 드릴게요…") so the
    // user knows it fired and what's coming. Reaction + typing keepalive
    // add liveness. All three are fail-soft and config-independent.
    const react = (emoji: string | null) => {
      if (ctx.messageId != null) void this.setMessageReaction(ctx.chatId, ctx.messageId, emoji);
    };
    const post = (text: string) =>
      this.sendMessage(ctx.chatId, text, { threadId: ctx.threadId, markdown: true });
    react('👀');
    await post(dec.absorb
      ? `🔗 링크 확인 — 지식 흡수 후 Obsidian 링크를 드리겠습니다. 잠시만요…`
      : `🔗 링크 확인 — 바로 빠른 요약부터 드리고, 이어서 상세 분석을 Obsidian 에 저장해 링크를 드리겠습니다. 잠시만요…`);
    // Typing keepalive — telegram's "typing…" expires ~5s, so re-send while
    // the (slow) skill runs. Cleared in finally.
    const typing = () => void this.sendChatAction(ctx.chatId, 'typing', { threadId: ctx.threadId });
    typing();
    const typingTimer = setInterval(typing, 4000);

    let posted = 0;
    let recorded = false;
    let result: Awaited<ReturnType<typeof runUrlRoute>>;
    try {
      result = await runUrlRoute(dec, {
        onStageDone: async (kind, text, meta) => {
          if (!recorded && (kind === 'detailed' || kind === 'absorb') && meta.obsidianPath) {
            recorded = true;
            try {
              recordRoutedLinkAbsorbed(effectiveInstanceRoot(), {
                source: 'telegram-bot', url: dec.url, notePath: meta.obsidianPath,
              });
            } catch { /* instance root lookup is best-effort too */ }
          }
          const t = (text ?? '').trim();
          if (!t) return;
          // ★ 공개 URL → 클릭 가능한 링크. legacy markdown 은 URL 내 `_` 를 이탤릭으로 파싱해 raw URL 이
          //   깨지므로, [텍스트](url) 로 감싸 markdownToTelegramHtml 이 <a href> 로 렌더하게 한다(클릭 가능).
          const linked = t.replace(/🌐\s*공개 링크:\s*(https?:\/\/\S+)/g, '🌐 [웹에서 열기]($1)');
          await post(linked);
          posted++;
        },
      });
    } finally {
      clearInterval(typingTimer);
    }

    if (result.ok && posted > 0) {
      react('✅');
      debug.log('telegram.url-route', 'done', { skill: dec.skill, stages: result.stages.length, posted });
      return true;
    }

    // Fail-soft. Nothing posted → tell the user we fell back, then let the
    // normal LLM turn answer (return false). Partial (posted mid-error) →
    // report the error but keep the turn owned so we don't double-answer.
    debug.log('telegram.url-route', 'fallback', { skill: dec.skill, ok: result.ok, posted, error: result.error });
    if (posted > 0) {
      react('✅');
      if (result.error) await post(`⚠️ 상세 단계 실패: ${result.error}`);
      return true;
    }
    react(null);
    return false;
  }

  /** `#현장` 캡션 사진·영상(이미지·영상 문서 포함)을 현장 폴더에 저장하고 한 줄로 답한다.
   *  처리했으면 true. 저장 규칙은 HTTP 입구와 같은 `saveFieldMedia` 다. */
  private async tryHandleFieldUpload(ctx: TgIncoming): Promise<boolean> {
    const media = [
      ...ctx.attachments.filter((a) => a.kind === 'photo'
        || (a.kind === 'document' && resolveFieldMime(a.mimeType, a.fileName ?? '') !== null)),
      ...(ctx.video ? [ctx.video] : []),
    ];
    if (media.length === 0) return false;
    const now = this.nowImpl();
    for (const [id, g] of this.fieldGroups) if (now - g.at > 10 * 60_000 && !g.timer) this.fieldGroups.delete(id);
    const tag = parseFieldCaption(ctx.text);
    const group = ctx.mediaGroupId ? this.fieldGroups.get(ctx.mediaGroupId) : undefined;
    if (!tag && !group) return false;
    const event = tag
      ? tag.event ?? defaultFieldEvent(
        this.fieldDefaultEventOpt ?? this.slashContext?.userConfig?.telegram?.fieldDefaultEvent, new Date(now))
      : group!.event;
    const captionMode = tag?.mode ?? group?.mode;
    const configMode = this.slashContext?.userConfig?.telegram?.fieldReelMode;
    const mode = captionMode ?? configMode ?? 'standard';
    const source = captionMode ? 'caption' : configMode ? 'config' : 'default';

    let count: number | null = null;
    let failure: string | null = null;
    try {
      const inputs = [];
      for (const att of media) {
        const downloaded = await this.downloadFile(att.fileId);
        try {
          inputs.push({
            originalName: att.fileName ?? downloaded.fileName ?? 'media',
            mimeType: att.mimeType ?? (att.kind === 'photo' ? 'image/jpeg' : undefined),
            bytes: new Uint8Array(readFileSync(downloaded.localPath)),
          });
        } finally {
          try { unlinkSync(downloaded.localPath); } catch { /* 이미 없음 */ }
        }
      }
      // 글(자막)은 캡션이 달린 항목에만 있다 — 앨범이면 첫 장에만 붙는다(MK 2026-09-30).
      const saved = saveFieldMedia(inputs, { rootDir: this.fieldRootDir(), event, device: 'telegram', ...(tag?.text ? { caption: tag.text } : {}) });
      count = saved.count;
      debug.log('telegram.field', 'reel-mode', { event, mode, source });
      scheduleFieldReel(saved.dir, {
        ...this.fieldReel,
        mode,
        notificationKey: `telegram:${this.botId}:${ctx.chatId}:${ctx.threadId ?? ''}:${ctx.mediaGroupId ?? ctx.messageId}`,
        onDone: async (result) => {
          const reply = { replyTo: ctx.messageId, threadId: ctx.threadId };
          if (result.ok && result.file) {
            const sent = await this.sendDocument(ctx.chatId, readFileSync(result.file), 'reel-9x16.mp4', {
              ...reply, mimeType: 'video/mp4', caption: `현장 영상 · ${event} · ${result.seconds}초${mode === 'instant' ? ' (즉석판)' : ''}`,
            });
            if (!sent) throw new Error('sendDocument failed');
            if (result.feed?.started) {
              await this.sendMessage(ctx.chatId, `인스타 피드 초안을 만드는 중 · ${event} — 1분쯤 뒤 앱 «게시 대기»에서 고치고 «최종 게시»를 누르면 됩니다(누르기 전엔 아무 데도 안 올라갑니다).`, reply);
            }
          } else {
            await this.sendMessage(ctx.chatId, `현장 영상 실패 · ${event} · ${result.error ?? 'render failed'}`, reply);
          }
        },
      });
      debug.log('field.upload', 'saved', { surface: 'telegram', files: inputs.length, count, album: !!ctx.mediaGroupId });
    } catch (err) {
      failure = err instanceof FieldUploadError ? err.code : 'download-failed';
      debug.log('field.upload', 'refused', { surface: 'telegram', reason: failure });
    }

    if (failure !== null) {
      await this.sendMessage(ctx.chatId, `현장 저장 실패 · ${event} · ${failure}`, { replyTo: ctx.messageId, threadId: ctx.threadId });
      return true;
    }
    const line = (n: number) => `현장 폴더에 저장 · ${event} · 지금 ${n}장`;
    if (!ctx.mediaGroupId) {
      await this.sendMessage(ctx.chatId, line(count!), { replyTo: ctx.messageId, threadId: ctx.threadId });
      return true;
    }
    // 앨범은 항목마다 답하지 않는다 — 마지막 항목 뒤 한 번(디바운스)만 최신 수로 답한다.
    const entry = group ?? { event, mode: tag?.mode, at: now, chatId: ctx.chatId, threadId: ctx.threadId, replyTo: ctx.messageId, count: 0 };
    if (group && tag?.mode) group.mode = tag.mode;
    entry.at = now;
    entry.count = count!;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.sendMessage(entry.chatId, line(entry.count), { replyTo: entry.replyTo, threadId: entry.threadId })
        .catch((e) => this.log(`field reply failed: ${e instanceof Error ? e.message : String(e)}`));
    }, 1500);
    (entry.timer as { unref?: () => void }).unref?.();
    this.fieldGroups.set(ctx.mediaGroupId, entry);
    return true;
  }

  private async handleIncoming(ctx: TgIncoming): Promise<void> {
    if (!this.isOwnerAllowed(ctx.userId)) {
      await this.refuseMessage(ctx);
      return;
    }
    this.noteUtterance(ctx);
    if (await this.handleFabricPlan(ctx)) return;
    // 현장 업로드 — `#현장` 캡션(또는 태그된 앨범의 나머지)의 사진·영상은 LLM 대신 현장 폴더로.
    if (await this.tryHandleFieldUpload(ctx)) return;
    if (await handleTelegramFieldNote(ctx, {
      rootDir: this.fieldRootDir(),
      download: (fileId) => this.downloadFile(fileId),
      reply: async (incoming, text) => { await this.sendMessage(incoming.chatId, text, { replyTo: incoming.messageId, threadId: incoming.threadId }); },
      engine: this.fieldNoteEngine, decodeAudio: this.fieldNoteDecodeAudio,
      now: () => new Date(this.nowImpl()),
    })) return;
    if (await maybeHandleCardPhoto(ctx, {
      isOwner: (userId) => this.isOwnerAllowed(userId),
      isFieldAlbum: (id) => this.fieldGroups.has(id),
      downloadFile: (fileId, dir) => this.downloadFile(fileId, dir),
      sendMessage: (chatId, text, opts) => this.sendMessage(chatId, text, opts),
      sendDocument: (chatId, body, filename, opts) => this.sendDocument(chatId, body, filename, opts),
      ...this.cardFollowupDeps,
    })) return;
    if (ctx.text.startsWith('@') || (ctx.isDm && ctx.text && !ctx.text.startsWith('/'))) {
      const reply = await handleTelegramSeatWork(ctx.text, {
        chatId: ctx.chatId, userId: ctx.userId, messageId: ctx.messageId, threadId: ctx.threadId, botId: ctx.botId,
      }, { ...this.seatWorkDeps, config: this.seatWorkDeps.config ?? this.slashContext?.userConfig });
      if (reply !== null) {
        await this.sendMessage(ctx.chatId, reply, { replyTo: ctx.messageId, threadId: ctx.threadId });
        return;
      }
    }
    // 영상은 `#현장` 저장 전용으로만 파싱한다 — 그 밖의 영상은 종전처럼 무시한다.
    if (ctx.video && ctx.attachments.length === 0) return;
    // Cascade-zyu U2 — capture utterance intent at update ingress.
    try {
      const { userIntentLogger } = await import('./user-intent/index.js');
      userIntentLogger().emit({
        surface: 'telegram',
        intent: {
          layer: 'utterance',
          kind: ctx.isDm ? 'telegram.utterance.dm_text' : 'telegram.utterance.group_text',
          target: { kind: 'message', id: String(ctx.messageId), label: String(ctx.chatId) },
          value: ctx.text,
        },
      });
    } catch { /* logging must never break the chat path */ }

    // ★ 미션 언급 추적(맥락-인지 revise·대표 2026-07-14) — 이 메시지가 apm_id 를 언급하면 이 방의
    //   "최근 논의 미션"으로 기록. 이후 id 없는 "개정해줘"가 이 미션을 recency 보다 우선 채택하도록.
    if (ctx.text && ctx.text.includes('apm_')) {
      try {
        const { recordChatMissionMentionsFromText } = await import('./autopilot/mission-chat-context.js');
        recordChatMissionMentionsFromText(ctx.chatId, ctx.text);
      } catch { /* fail-soft */ }
    }

    // Explicit directive ingress precedes mission/HITL text interceptors.
    if (ctx.text.startsWith('지시:') || ctx.text.startsWith('/directive ')) {
      try {
        const { addDirective } = await import('./steward/directive.js');
        const text = ctx.text.startsWith('지시:') ? ctx.text.slice('지시:'.length) : ctx.text.slice('/directive '.length);
        const result = await addDirective(text, { source: 'telegram', origin: { chatId: ctx.chatId, botId: ctx.botId, threadId: ctx.threadId } });
        await this.sendMessage(ctx.chatId, `${result.issue}: ${result.status}`, { replyTo: ctx.messageId, threadId: ctx.threadId });
      } catch {
        await this.sendMessage(ctx.chatId, '지시 등록 실패 — Linear 연결과 자격을 확인하세요.', { replyTo: ctx.messageId, threadId: ctx.threadId });
      }
      return;
    }

    // ★ 미션 정정 답장 가로채기(force_reply·대표 2026-07-12) — reply_to 가 정정요청이면
    //   runTurn(Q&A) 대신 재분해로. dynamic import 로 autopilot 결합 최소·fail-soft.
    if (ctx.replyToText && ctx.text.trim()) {
      try {
        const { tryInterceptMissionRevise } = await import('./autopilot/mission-hitl-callback.js');
        if (await tryInterceptMissionRevise(ctx, this)) return;
      } catch { /* fail-soft — 가로채기 실패 시 일반 처리로 폴백 */ }
    }

    // HITL question "Other" free-text capture (also handled inline in
    // the poll loop; this covers direct handleIncoming callers e.g.
    // tests). Consume the typed answer instead of starting a new turn.
    if (this.tryConsumeTextCapture(ctx)) return;

    // ★ 미션 정정 자연어 인텐트(NL 라우터·대표 2026-07-14) — force_reply 마커 없이 "이 미션
    //   개정해줘" 류 자유텍스트를 최근 활성 미션 대상으로 recommender->원탭 승인 카드. 오발 방지
    //   게이트(정정 동사+미션 언급+질문 아님) 통과 + 이 방 활성 미션 존재 시에만 하이재킹.
    if (ctx.text.trim()) {
      try {
        const hitl = await import('./autopilot/mission-hitl-callback.js');
        // ★ 미션 결정 인텐트(Layer 3) 먼저 — "이 아크 criterion 2는 arming 으로 미뤄" 류(revise 동사 제외라 상호배타).
        if (await hitl.tryInterceptMissionDecisionIntent(ctx, this)) return;
        if (await hitl.tryInterceptMissionReviseIntent(ctx, this)) return;
      } catch { /* fail-soft — 인텐트 라우팅 실패 시 일반 LLM 처리로 폴백 */ }
    }

    // Surface-unification v2 FU-2 (2026-05-11) — workflow-runtime tap.
    // Fan a normalized event to the daemon so telegramTrigger nodes can
    // dispatch independently of the LLM chat path. Best-effort: any sync
    // or async throw is logged + swallowed so the reply still flows.
    if (this.onTriggerTap) {
      const classify = classifyTelegramText(ctx.text);
      const evt: TgTriggerEvent = classify.kind === 'command'
        ? {
            kind: 'command',
            chat: String(ctx.chatId),
            user: String(ctx.userId),
            body: classify.body,
            command: classify.command,
            messageId: ctx.messageId,
            isDm: ctx.isDm,
          }
        : {
            kind: 'message',
            chat: String(ctx.chatId),
            user: String(ctx.userId),
            body: ctx.text,
            messageId: ctx.messageId,
            isDm: ctx.isDm,
          };
      try {
        const maybePromise = this.onTriggerTap(evt);
        if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
          (maybePromise as Promise<void>).catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            this.log(`telegram trigger tap failed: ${reason}`);
          });
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`telegram trigger tap failed: ${reason}`);
      }
    }

    // Phase 8 (2026-04-30) — voice attachment intake. When a voice
    // adapter is wired and the incoming msg has a `voice` attachment,
    // download the .ogg + transcribe via the adapter, then substitute
    // ctx.text with the transcript so slash / onMessage dispatch sees
    // the spoken words. `fromVoice` is captured for the reply branch
    // below so we can route through sendVoice when adapter.replyMode
    // resolves to 'voice'.
    let fromVoice = false;
    if (this.voiceAdapter && this.voiceAdapter.available) {
      const voiceAtt = ctx.attachments.find((a) => a.kind === 'voice');
      if (voiceAtt) {
        try {
          const downloaded = await this.downloadFile(voiceAtt.fileId);
          let oggBuf: Buffer | null = null;
          try {
            oggBuf = readFileSync(downloaded.localPath);
          } finally {
            try { unlinkSync(downloaded.localPath); } catch { /* ignore */ }
          }
          const result = await this.voiceAdapter.transcribeOgg(oggBuf);
          // Replace ctx.text with the transcript so downstream routing
          // (slash / onMessage) handles the spoken words as if typed.
          ctx = { ...ctx, text: result.transcript };
          fromVoice = true;
          this.log(`telegram voice: transcribed ${oggBuf.byteLength}B → "${result.transcript.slice(0, 80)}${result.transcript.length > 80 ? '…' : ''}"`);
        } catch (err) {
          this.log(`telegram voice transcribe failed: ${err instanceof Error ? err.message : String(err)}`);
          // Fall through with original ctx.text (typically caption or '').
        }
      }
    }

    if (fromVoice && ctx.text) {
      try {
        const { maybeHandleSpokenVoiceIntake } = await import('./intake-plane/adapters/voice-command.js');
        const spokenReply = await maybeHandleSpokenVoiceIntake({
          transcript: ctx.text,
          receivedAt: new Date().toISOString(),
          inputSource: {
            kind: 'voice',
            channel: 'telegram',
            surface: 'telegram-voice-message',
            mode: 'voice-message',
            transcriptSource: 'voice',
          },
          actor: {
            id: String(ctx.userId),
            ...(ctx.userName ? { display: ctx.userName } : {}),
          },
          channelContext: {
            chatId: String(ctx.chatId),
            ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
          },
        });
        if (spokenReply) {
          const reply = this.voiceAdapter?.available
            ? await this.voiceAdapter.generateReply(spokenReply, { fromVoice: true })
            : { text: spokenReply, voiceOgg: null };
          const fanoutText = selectTelegramFanoutText(reply.text);
          if (reply.voiceOgg) {
            await this.sendVoice(ctx.chatId, reply.voiceOgg, {
              replyTo: ctx.messageId,
              threadId: ctx.threadId,
              caption: fanoutText,
            });
          } else {
            await this.sendMessage(ctx.chatId, fanoutText, {
              replyTo: ctx.messageId,
              threadId: ctx.threadId,
            });
          }
          return;
        }
      } catch (err) {
        this.log(`telegram spoken-intake failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!fromVoice && ctx.text && !ctx.text.startsWith('/')) {
      try {
        const ambientMode = this.slashContext?.userConfig.intake.telegram.ambientCapture ?? 'off';
        if (ambientMode !== 'off') {
          const { maybeHandleTelegramAmbientMessage } = await import('./intake-plane/adapters/telegram-ambient.js');
          const ambientReply = await maybeHandleTelegramAmbientMessage({
            text: ctx.text,
            chatId: ctx.chatId,
            userId: ctx.userId,
            ...(ctx.userName ? { userName: ctx.userName } : {}),
            ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
            ambientCapture: ambientMode,
          });
          if (ambientReply) {
            await this.sendMessage(ctx.chatId, ambientReply, {
              replyTo: ctx.messageId,
              threadId: ctx.threadId,
            });
            return;
          }
        }
      } catch (err) {
        this.log(`telegram ambient-intake failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Slash-command routing. Parse without dispatching first so we
    // can split three cases:
    //   - match + !streaming → instant reply, no placeholder flicker
    //   - match + streaming  → placeholder + streamer path below,
    //                          but with the slash handler replacing
    //                          the LLM onMessage call
    //   - unknown            → friendly "Unknown command" reply
    //   - none               → fall through to the LLM path
    let slashParse: TgSlashParse = { kind: 'none' };
    const botsIntent = matchBotsIntent(ctx.text);
    const routinesIntent = matchRoutinesIntent(ctx.text);
    // 🪶⛔ 명부는 화면 또는 명명된 봇 상태 말에만 불러온다. 봇·루틴 목록은 명부 없이 먼저 끝낸다.
    const registryNeeded = !ctx.text.startsWith('/')
      && !botsIntent
      && !routinesIntent
      && needsPersonaRegistry(ctx.text);
    if (registryNeeded) await awaitGlobalPersonaLoad();
    const resolveBot = (word: string): string | null => {
      const persona = getGlobalPersonaRegistry().list()
        .find((candidate) => candidate.personaId.toLowerCase() === word.toLowerCase());
      return persona?.personaId ?? null;
    };
    // 📈⭐ 패턴 워드 자연어 → 슬래시. 차트와 화면의 기존 우선순위를 유지한다.
    const routedText = ctx.text.startsWith('/')
      ? ctx.text
      : (matchChartIntent(ctx.text, defaultKoreanResolver)
        ?? (registryNeeded ? matchScreenIntent(ctx.text, resolveBot) : null)
        ?? botsIntent
        ?? routinesIntent
        ?? (registryNeeded ? matchBotIntent(ctx.text, resolveBot) : null)
        ?? ctx.text);
    let slashCommandObservation: { token: string; argumentCount: number; startedAt: number } | undefined;
    if (routedText.startsWith('/')) {
      const [token = '', ...args] = routedText.trim().split(/\s+/);
      const startedAt = this.nowImpl();
      slashCommandObservation = { token, argumentCount: args.length, startedAt };
      const branch = this.slashCommands.length === 0
        ? 'no-command-list'
        : !this.slashContext
        ? 'no-context'
        : 'parse';
      if (branch !== 'parse') {
        debug.log('telegram.command', 'received', { token, argumentCount: args.length, branch });
        debug.log('telegram.command', 'handled', {
          token, result: `not-dispatched:${branch}`, durationMs: this.nowImpl() - startedAt,
        });
      }
      if (this.slashCommands.length > 0 && this.slashContext && routedText.startsWith('/')) {
        slashParse = parseTelegramSlash(routedText, this.slashCommands);
        if (slashParse.kind === 'unknown') {
          debug.log('telegram.command', 'received', { token, argumentCount: args.length, branch: 'unknown' });
          let result = 'unknown';
          try {
            await this.sendMessage(
              ctx.chatId,
              buildUnknownSlashReply(slashParse.name, this.slashCommands),
              { replyTo: ctx.messageId, threadId: ctx.threadId },
            );
          } catch (err: any) {
            result = 'unknown-reply-failed';
            this.log(`telegram unknown-slash reply failed: ${err?.message ?? err}`);
          } finally {
            debug.log('telegram.command', 'handled', {
              token, result, durationMs: this.nowImpl() - startedAt,
            });
          }
          return;
        }
        if (slashParse.kind === 'match' && !slashParse.cmd.streaming) {
          debug.log('telegram.command', 'received', { token, argumentCount: args.length, branch: 'match' });
          let result = 'handler-completed';
          let handlerCompleted = false;
          try {
            const reply = await slashParse.cmd.handler(slashParse.args, ctx, {
              userConfig: this.slashContext.userConfig,
              allCommands: this.slashCommands,
              sendButtons: async (text, buttons) => { await this.sendInlineKeyboard(ctx.chatId, text, buttons, { replyTo: ctx.messageId, threadId: ctx.threadId }); },
              downloadAttachments: () => this.downloadCtxAttachments(ctx),
              daemonBridge: this.slashContext.daemonBridge,
              hitlConfirmChannel: this.hitlConfirmChannelForChat(ctx.chatId, ctx.threadId),
              hitlQuestionChannel: this.hitlQuestionChannelForChat(ctx.chatId, ctx.threadId),
              fileSink: this.fileSinkForChat(ctx.chatId, ctx.threadId),
            });
            handlerCompleted = true;
            if (reply) {
              await this.sendMessage(ctx.chatId, reply, {
                replyTo: ctx.messageId, threadId: ctx.threadId, markdown: true,
              });
            }
          } catch (err: any) {
            result = handlerCompleted ? 'reply-send-failed' : 'handler-failed';
            try {
              await this.sendMessage(
                ctx.chatId,
                `Error running /${slashParse.cmd.name}: ${err?.message ?? err}`,
                { replyTo: ctx.messageId, threadId: ctx.threadId },
              );
            } catch {
              result = `${result}-error-reply-failed`;
            }
          } finally {
            debug.log('telegram.command', 'handled', {
              token, result, durationMs: this.nowImpl() - startedAt,
            });
          }
          return;
        }
        debug.log('telegram.command', 'received', {
          token, argumentCount: args.length, branch: 'streaming-match',
        });
      }
    }

    // ── Development-request routing observation (pre-LLM, no hand-off) ──
    // Measure conservative detector behavior before any routing transition.
    // This decision is intentionally discarded: the existing message path remains intact.
    if (slashParse.kind === 'none' && ctx.text && !ctx.text.startsWith('/')) {
      try {
        const cfg = getUserConfig().skills.devRequestRouting;
        observeDevRequestRouteFailSoft(ctx.text, cfg, { surface: 'telegram' });
      } catch (err) {
        try {
          debug.log('skills.dev-route', 'observation-error', {
            surface: 'telegram', error: (err as any)?.message ?? String(err),
          }, { level: 'error' });
        } catch {
          // Observability failures must not interrupt the existing chat path.
        }
      }
    }

    // ── URL→skill auto-route (interactive-only · PLAN-url-triage-routing P3) ──
    // A free-typed URL with no guard keyword auto-fires the mapped digest/
    // absorb skill (youtube→youtube-master · absorb→yt-vault · x/web/github→
    // omni-digest) instead of a plain LLM turn. Slash commands already
    // returned above; an active ACP delegation (coding session — a URL there
    // is a reference, not a digest target) yields to the brain. Fail-soft:
    // when the skill is missing/empty, handled=false → normal LLM turn runs.
    if (slashParse.kind === 'none' && ctx.text && !ctx.text.startsWith('/')) {
      const activeDeleg = this.slashContext
        ? getActiveDelegation(delegationChatKey(this.botId, ctx.chatId, ctx.threadId))
        : null;
      if (!activeDeleg) {
        const urlDec = detectUrlRoute(ctx.text, getUserConfig().skills.urlRouting);
        if (urlDec) {
          try {
            const frontInput = { text: ctx.text, surface: 'telegram' as const };
            const decision = classifyFrontInput(frontInput, { urlRouting: getUserConfig().skills.urlRouting });
            const absorbUrls = telegramAbsorbUrls(frontInput, decision);
            for (const url of absorbUrls) {
              const result = await scheduleIntakeEvent(effectiveInstanceRoot(), url, {
                eventMax: getUserConfig().intake.eventMax,
                post: async ({ url: link }) => {
                  const posted = await dispatchTaskCreate({
                    title: `흡수: ${link}`.slice(0, 80),
                    surface: { kind: 'llm-direct', prompt: `이 링크를 흡수하고 노트로 저장하세요: ${link}` },
                  });
                  if (!posted.taskId) throw new Error('intake event task not created');
                  return { taskId: posted.taskId };
                },
              });
              if (result.reply) await this.sendMessage(ctx.chatId, result.reply, { threadId: ctx.threadId, markdown: true });
            }
            if (absorbUrls.length) return;
          } catch (error) {
            debug.log('intake.event', 'failed', { reason: error instanceof Error ? error.name : 'unknown' });
          }
          const handled = await this.runUrlRouteReply(ctx, urlDec);
          if (handled) return;
        }
      }
    }

    // §C5 스트리밍 flip — sessionFabric.streaming.telegram ON + daemon-bound chat 이면 **옛
    // 스트리밍 경로(placeholder+streamer+finalizeReply)를 억제**하고 청크 fan-out sink 가 owner
    // 스트리밍/finalize 를 담당(핸들러 chunkProducer 가 primarySurfaces=['telegram'] 로 owner 배달).
    // 이중배달 방지의 짝(handler owner 비제외 ↔ dispatch 옛 경로 억제). 부재/비-daemon 이면 종전 경로.
    const dispatchBridge = this.slashContext?.daemonBridge as
      { resolveDaemonSessionForChat?: (chatId: number, threadId: number | undefined) => string | null } | undefined;
    const daemonBoundForFlip = (dispatchBridge?.resolveDaemonSessionForChat?.(ctx.chatId, ctx.threadId) ?? null) != null;
    // getUserConfig() = 데몬 config-dir(.elanous-test/prod)의 authoritative 런타임 config — sink 가
    // 쓰는 것과 동일(slashContext.userConfig 는 stale snapshot). 게이트는 config-only: 텔레그램
    // 세션은 항상 owner auto-subscribe 되므로 daemonBound 불요(그건 로그 정보용).
    const streamingCfgOn = getUserConfig().sessionFabric?.streaming?.telegram === true;
    const streamingFlip = streamingCfgOn;
    // §C5 관측 — 발화 경로 결정(제1원칙: 텔레그램 전송을 elanous 가 본다). category telegram.deliver.
    debug.log('telegram.deliver', 'route', {
      chatId: ctx.chatId, path: streamingFlip ? 'flip-fanout' : 'legacy', streamingCfgOn, daemonBound: daemonBoundForFlip,
    });
    // §C5-enh reactions-as-status — 턴 시작 👀(저비용 상태채널). 종료 👍/👎는 Bot API 허용 집합에 따른다.
    // https://core.telegram.org/bots/api#reactiontypeemoji — ✅/❌는 ReactionTypeEmoji에 없다.
    const reactionsOn = true;
    debug.log('telegram.deliver', 'reaction', { chatId: ctx.chatId, phase: 'start', emoji: '👀', on: reactionsOn });
    if (reactionsOn && ctx.messageId != null) void this.setMessageReaction(ctx.chatId, ctx.messageId, '👀');

    await this.maybeSendContextFirst(ctx);

    // Post a placeholder NOW so the user sees acknowledgement while
    // the LLM is thinking. The same message is then edited in-place
    // as tokens stream in — far better UX than dead air followed by
    // a single long message. (flip 시 sink 가 첫 청크에 메시지 posting.)
    let placeholderMid: number | undefined;
    if (!streamingFlip) {
      try {
        const posted = await this.sendMessage(
          ctx.chatId,
          '⏳ Working…',
          { replyTo: ctx.messageId, threadId: ctx.threadId },
        );
        placeholderMid = posted?.messageId;
      } catch (err: any) {
        // If we can't even post the placeholder, bail — the handler
        // will at least log and we skip the edit dance entirely.
        this.log(`telegram placeholder send failed: ${err?.message ?? String(err)}`);
      }
    }

    const streamer = (!streamingFlip && placeholderMid !== undefined)
      ? this.makeStreamer(ctx.chatId, placeholderMid, ctx.threadId)
      : undefined;

    // Turn start — used to decide whether the completion warrants a
    // fresh (push-notifying) message vs. a silent placeholder edit.
    const turnStartedAt = this.nowImpl();
    let streamingSlashResult: string | undefined;
    const recordStreamingSlashHandled = (result: string): void => {
      if (slashParse.kind === 'match' && slashParse.cmd.streaming && slashCommandObservation) {
        debug.log('telegram.command', 'handled', {
          token: slashCommandObservation.token,
          result,
          durationMs: this.nowImpl() - slashCommandObservation.startedAt,
        });
      }
    };

    try {
      // P1 — NL→ACP continuity: when this chat is in active delegation (set
      // after /cc·/cdx·/gem) and the message is plain NL (not a slash — those
      // were handled above, incl. /brain exit), continue the SAME ACP session
      // instead of falling to the brain. Only applies to slashContext-enabled
      // bots. Cleared on error so a broken continue doesn't trap the user.
      const delegationKey = delegationChatKey(this.botId, ctx.chatId, ctx.threadId);
      let activeBackend = (this.slashContext && ctx.text && !ctx.text.startsWith('/'))
        ? getActiveDelegation(delegationKey)
        : null;
      // Explicit surface intent OVERRIDES the auto-continue — the user's stated
      // routing wins. "self로 해줘" → brain; "claude로 …" → switch backend.
      // (Bug: active delegation used to hijack an explicit "self" request.)
      if (activeBackend) {
        const override = classifyDelegationOverride(ctx.text);
        if (override === 'self') {
          clearActiveDelegation(delegationKey); // yield to the brain until re-delegated
          activeBackend = null;
        } else if (override && override !== activeBackend) {
          setActiveDelegation(delegationKey, override); // switch backend
          activeBackend = override;
        }
      }

      // Observe the actual routing decision for plain-NL turns: self-brain
      // (anthropic/opus) vs an ACP delegate (codex/gemini/…). This is the
      // single fork that made "footer says opus but codex answered" invisible
      // to logs.db — now every NL turn records where it went (self-cognition §1).
      if (slashParse.kind !== 'match' || !slashParse.cmd.streaming) {
        debug.log('acp.delegation', 'route', {
          key: delegationKey,
          dispatch: activeBackend ? `acp-${activeBackend}` : 'self-brain',
          delegated: !!activeBackend,
          text: ctx.text?.slice(0, 60),
        });
      }

      // Streaming slash command match uses the handler from the
      // command registry; everything else routes to the bot's
      // onMessage (LLM turn). Both produce the same `reply` shape
      // so the finalize path is shared.
      const reply = slashParse.kind === 'match' && slashParse.cmd.streaming
        ? await (async () => {
            try {
              return await slashParse.cmd.handler(slashParse.args, ctx, {
                userConfig: this.slashContext!.userConfig,
                allCommands: this.slashCommands,
                sendButtons: async (text, buttons) => { await this.sendInlineKeyboard(ctx.chatId, text, buttons, { replyTo: ctx.messageId, threadId: ctx.threadId }); },
                streamer,
                downloadAttachments: () => this.downloadCtxAttachments(ctx),
                daemonBridge: this.slashContext!.daemonBridge,
                hitlConfirmChannel: this.hitlConfirmChannelForChat(ctx.chatId, ctx.threadId),
                hitlQuestionChannel: this.hitlQuestionChannelForChat(ctx.chatId, ctx.threadId),
                fileSink: this.fileSinkForChat(ctx.chatId, ctx.threadId),
              });
            } catch (err) {
              streamingSlashResult = 'handler-failed';
              throw err;
            }
          })()
        : activeBackend
        ? await (async () => {
            touchActiveDelegation(delegationKey);
            try {
              return await runAcpViaSlash(activeBackend, [ctx.text], ctx, {
                userConfig: this.slashContext!.userConfig,
                allCommands: this.slashCommands,
                sendButtons: async (text, buttons) => { await this.sendInlineKeyboard(ctx.chatId, text, buttons, { replyTo: ctx.messageId, threadId: ctx.threadId }); },
                streamer,
                downloadAttachments: () => this.downloadCtxAttachments(ctx),
                daemonBridge: this.slashContext!.daemonBridge,
                hitlConfirmChannel: this.hitlConfirmChannelForChat(ctx.chatId, ctx.threadId),
                hitlQuestionChannel: this.hitlQuestionChannelForChat(ctx.chatId, ctx.threadId),
              });
            } catch (err) {
              // A broken continue must not trap the user in ACP mode.
              clearActiveDelegation(delegationKey);
              throw err;
            }
          })()
        : await this.onMessage(ctx, streamer);
      // Drop any pending throttled edit in favor of the final value.
      streamer?.flushCancel();

      if (!reply) {
        // Handler stayed silent — but it may have edited the
        // placeholder. Leave whatever's there; only clean up if
        // nothing was ever streamed.
        if (streamer && !streamer.didEdit() && placeholderMid !== undefined) {
          try { await this.rawEditMessageText(ctx.chatId, placeholderMid, '(no response)', {}); }
          catch { /* ignore */ }
        }
        recordStreamingSlashHandled('completed');
        return;
      }

      // Phase 8 — voice reply branch. When the incoming msg was a
      // voice attachment AND the adapter resolves to a voice reply
      // (replyMode='voice', or 'auto' + fromVoice), synthesize and
      // send via sendVoice. The placeholder is edited to surface the
      // transcript text alongside the voice msg so users with mute on
      // can still read the reply.
      if (fromVoice && this.voiceAdapter && this.voiceAdapter.available) {
        try {
          const voiceReply = await this.voiceAdapter.generateReply(reply, { fromVoice: true });
          const fanoutText = selectTelegramFanoutText(voiceReply.text);
          if (voiceReply.voiceOgg) {
            await this.sendVoice(ctx.chatId, voiceReply.voiceOgg, {
              replyTo: ctx.messageId,
              threadId: ctx.threadId,
            });
            // Edit the placeholder to show the transcript text — gives
            // mute-on users a readable copy of the spoken reply.
            if (placeholderMid !== undefined) {
              try {
                await this.editMessageText(ctx.chatId, placeholderMid, fanoutText, {
                  threadId: ctx.threadId, markdown: true,
                });
              } catch { /* swallow — voice msg already sent */ }
            }
            recordStreamingSlashHandled('completed');
            return;
          }
          // voiceOgg null → fall through to text finalize (replyMode='text'
          // override, or ttsProvider missing). reply stays the same.
        } catch (err) {
          this.log(`telegram voice reply failed: ${err instanceof Error ? err.message : String(err)}`);
          // Fall through to text finalize so user gets *something*.
        }
      }

      // §C5 flip — 옛 최종 배달 억제(청크 fan-out sink.onFinal 이 담당). 비-flip 은 종전대로.
      if (!streamingFlip) {
        debug.log('telegram.deliver', 'legacy-finalize', { chatId: ctx.chatId, chars: reply.length });
        await this.finalizeReply(ctx, placeholderMid, reply, this.nowImpl() - turnStartedAt);
      } else {
        debug.log('telegram.deliver', 'flip-suppress-legacy', { chatId: ctx.chatId, chars: reply.length });
      }
      // §C5-enh reactions — 완료 👍 (Bot API ReactionTypeEmoji). fail-soft.
      debug.log('telegram.deliver', 'reaction', { chatId: ctx.chatId, phase: 'done', emoji: '👍', on: reactionsOn });
      if (reactionsOn && ctx.messageId != null) void this.setMessageReaction(ctx.chatId, ctx.messageId, '👍');
      recordStreamingSlashHandled('completed');
    } catch (err: any) {
      streamer?.flushCancel();
      recordStreamingSlashHandled(streamingSlashResult ?? 'post-processing-failed');
      // §C5-enh reactions — 실패 👎 (Bot API ReactionTypeEmoji).
      debug.log('telegram.deliver', 'reaction', { chatId: ctx.chatId, phase: 'fail', emoji: '👎', on: reactionsOn });
      if (reactionsOn && ctx.messageId != null) void this.setMessageReaction(ctx.chatId, ctx.messageId, '👎');
      this.log(`telegram handler error: ${err?.message ?? String(err)}`);
      const errLine = `Error: ${err?.message ?? 'handler failed'}`;
      try {
        if (placeholderMid !== undefined) {
          await this.rawEditMessageText(ctx.chatId, placeholderMid, errLine, {});
        } else {
          await this.sendMessage(ctx.chatId, errLine, {
            replyTo: ctx.messageId, threadId: ctx.threadId,
          });
        }
      } catch { /* give up quietly */ }
    }
  }

  /** Edit the placeholder with the final reply. If the reply fits in a
   *  single message, one edit; if it spills over, edit with the first
   *  chunk and send the remainder as new messages (no deleteMessage
   *  call — simpler and avoids a permissions question). */
  private async finalizeReply(
    ctx: TgIncoming,
    placeholderMid: number | undefined,
    reply: string,
    elapsedMs = 0,
  ): Promise<void> {
    const fanoutText = selectTelegramFanoutText(reply);
    const chunks = splitMarkdownForTelegram(fanoutText, this.maxChars);
    if (chunks.length === 0) return;

    if (placeholderMid === undefined) {
      // Fallback path: placeholder wasn't posted, send full reply fresh.
      await this.sendMessage(ctx.chatId, fanoutText, {
        replyTo: ctx.messageId, threadId: ctx.threadId, markdown: true,
      });
      return;
    }

    // Long turn (e.g. a /cc delegation, or a HITL-approved job) — the
    // user has likely walked away, and Telegram does NOT push-notify on
    // message EDITS. Editing the placeholder in place would leave the
    // completion silent ("승인 후 알림 없음"). So for long turns we deliver
    // the result as FRESH messages (which DO notify) and collapse the
    // placeholder to a pointer. Short turns keep the quiet edit-in-place
    // UX (the user is watching, no need to buzz).
    if (elapsedMs >= NOTIFY_AS_NEW_MSG_THRESHOLD_MS) {
      try {
        // The placeholder is anchored at the turn-START position, so it
        // sits ABOVE any mid-turn HITL "✓ 승인됨" ack. A "완료" here would
        // read as completion-before-approval; keep it a neutral downward
        // pointer — the actual completion is the fresh result message
        // below (after the ack), in correct chronological order.
        await this.editMessageText(ctx.chatId, placeholderMid, '⋯ 결과 ↓', {
          threadId: ctx.threadId, markdown: false,
        });
      } catch { /* marker is cosmetic — ignore */ }
      for (const chunk of chunks) {
        await this.sendMessage(ctx.chatId, chunk, {
          threadId: ctx.threadId, markdown: true,
        });
      }
      return;
    }

    // First chunk replaces the placeholder.
    await this.editMessageText(ctx.chatId, placeholderMid, chunks[0]!, {
      threadId: ctx.threadId, markdown: true,
    });
    // Remaining chunks (if any) go as fresh messages.
    for (let i = 1; i < chunks.length; i++) {
      await this.sendMessage(ctx.chatId, chunks[i]!, {
        threadId: ctx.threadId, markdown: true,
      });
    }
  }

  /** Build a throttled edit closure for a given placeholder message.
   *  Coalesces a burst of `edit(partial)` calls into one in-flight
   *  edit per chat, at most once per MIN_EDIT_GAP_MS. Later calls
   *  overwrite earlier pending partials so we always edit to the
   *  latest accumulated text. */
  private makeStreamer(
    chatId: number,
    messageId: number,
    threadId?: number,
  ): TgMessageStreamer & { flushCancel: () => void; didEdit: () => boolean } {
    // Partial-edit cap: Telegram's 4096 char limit applies to the HTML
    // payload, so we truncate well below it during streaming to leave
    // room for tag inflation. The final edit uses the full cap path.
    const PARTIAL_CAP = Math.min(3800, this.maxChars - 200);

    let pending: string | null = null;
    let inFlight = false;
    let lastSentAt = 0;
    let hasEdited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tryFlush = async (): Promise<void> => {
      if (cancelled || inFlight || pending === null) return;
      const now = this.nowImpl();
      const waitMs = Math.max(0, lastSentAt + this.streamEditGapMs - now);
      if (waitMs > 0) {
        if (!timer) {
          timer = setTimeout(() => { timer = null; void tryFlush(); }, waitMs);
        }
        return;
      }
      const toSend = pending;
      pending = null;
      inFlight = true;
      try {
        await this.editMessageText(chatId, messageId, toSend, {
          threadId, markdown: true,
        });
        hasEdited = true;
        lastSentAt = this.nowImpl();
      } catch (err: any) {
        // Edits can fail if the user deleted the placeholder or the
        // content collapsed to the same HTML after markdown conversion
        // (rawEditMessageText already ignores that). Log + keep going.
        this.log(`telegram stream edit failed: ${err?.message ?? String(err)}`);
      } finally {
        inFlight = false;
      }
      if (!cancelled && pending !== null) void tryFlush();
    };

    return {
      edit: (partialText: string) => {
        if (cancelled || !partialText) return;
        const clipped = partialText.length > PARTIAL_CAP
          ? partialText.slice(0, PARTIAL_CAP - 2) + ' …'
          : partialText;
        pending = clipped;
        void tryFlush();
      },
      flushCancel: () => {
        cancelled = true;
        pending = null;
        if (timer) { clearTimeout(timer); timer = null; }
      },
      didEdit: () => hasEdited,
      // P1.4 — spill an overflowing tool body as a document into this
      // streamer's chat. Reuses the message's chat/thread so the file
      // lands right beside the streamed transcript.
      sendFile: this.fileSinkForChat(chatId, threadId).sendFile,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

interface PhotoSize { file_id: string; file_size?: number; width: number; height: number }
interface VoiceLike { file_id: string; file_size?: number; mime_type?: string; duration?: number }
interface DocumentLike { file_id: string; file_size?: number; mime_type?: string; file_name?: string }
interface VideoLike { file_id: string; file_size?: number; mime_type?: string; file_name?: string; duration?: number }

interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
    text?: string;
    caption?: string;
    message_thread_id?: number;
    photo?: PhotoSize[];
    voice?: VoiceLike;
    audio?: VoiceLike;
    document?: DocumentLike;
    video?: VideoLike;
    media_group_id?: string;
    reply_to_message?: { text?: string; message_id?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; username?: string };
    message?: { message_id: number; message_thread_id?: number; chat: { id: number } };
    data?: string;
    chat_instance?: string;
  };
  // Bot API 7.0+ message_reaction update (UX 에이전트 리액션 수신·간단 승인 👍/👎).
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: { id: number; first_name?: string; username?: string };
    new_reaction?: { type: string; emoji?: string }[];
    old_reaction?: { type: string; emoji?: string }[];
  };
}

export interface TgCallbackQuery {
  id: string;
  userId: number;
  userName?: string;
  chatId?: number;
  threadId?: number;
  messageId?: number;
  data: string;
}

export type TgCallbackHandler = (q: TgCallbackQuery) => Promise<void> | void;

/** message_reaction 수신 payload — UX 에이전트 NORMALIZE(normalizeTelegramReaction)가 소비. */
export interface TgMessageReaction {
  chatId: number;
  messageId: number;
  userId?: number;
  userName?: string;
  newReaction: { type: string; emoji?: string }[];
}

export type TgReactionHandler = (r: TgMessageReaction) => Promise<void> | void;

/** Returns null only when the update has no recognized payload at all
 *  — i.e. it's a service update (new_chat_member, etc.) we want to
 *  skip. Attachment-only messages (a photo with no caption) DO
 *  return a valid TgIncoming with `text=''` and the media in
 *  `attachments`. */
export function parseUpdate(u: RawUpdate): TgIncoming | null {
  const m = u.message;
  if (!m || !m.from) return null;

  const attachments: TgIncomingAttachment[] = [];
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    // Telegram sends multiple resolutions — pick the largest (highest
    // total pixel count). Most bots just grab [-1] (server sends in
    // ascending size) but being explicit is safer.
    const largest = [...m.photo].sort((a, b) => (a.width * a.height) - (b.width * b.height)).pop()!;
    attachments.push({
      kind: 'photo',
      fileId: largest.file_id,
      fileSize: largest.file_size,
      width: largest.width,
      height: largest.height,
    });
  }
  if (m.voice) {
    attachments.push({
      kind: 'voice',
      fileId: m.voice.file_id,
      fileSize: m.voice.file_size,
      mimeType: m.voice.mime_type,
      duration: m.voice.duration,
    });
  }
  if (m.audio) {
    attachments.push({
      kind: 'audio',
      fileId: m.audio.file_id,
      fileSize: m.audio.file_size,
      mimeType: m.audio.mime_type,
      duration: m.audio.duration,
    });
  }
  if (m.document) {
    attachments.push({
      kind: 'document',
      fileId: m.document.file_id,
      fileSize: m.document.file_size,
      mimeType: m.document.mime_type,
      fileName: m.document.file_name,
    });
  }

  // 영상은 `#현장` 저장 전용 — 태그된 캡션이거나 앨범 항목일 때만 싣는다(그 밖의 영상은 종전처럼 무시).
  const video = m.video && (parseFieldCaption(m.caption) || m.media_group_id)
    ? {
        kind: 'document' as const,
        fileId: m.video.file_id,
        fileSize: m.video.file_size,
        mimeType: m.video.mime_type ?? 'video/mp4',
        fileName: m.video.file_name,
        duration: m.video.duration,
      }
    : undefined;

  // Skip updates with zero signal: no text AND no attachments.
  if (typeof m.text !== 'string' && attachments.length === 0 && !video) return null;

  const isDm = m.chat.type === 'private';
  return {
    updateId: u.update_id,
    chatId: m.chat.id,
    userId: m.from.id,
    userName: m.from.username || m.from.first_name,
    text: (typeof m.text === 'string' ? m.text : (m.caption ?? '')),
    messageId: m.message_id,
    threadId: m.message_thread_id,
    ...(typeof m.date === 'number' ? { receivedAt: new Date(m.date * 1000).toISOString() } : {}),
    isDm,
    isGroup: !isDm,
    attachments,
    ...(m.reply_to_message?.text ? { replyToText: m.reply_to_message.text } : {}),
    ...(m.media_group_id ? { mediaGroupId: m.media_group_id } : {}),
    ...(video ? { video } : {}),
  };
}

/** Split along paragraph/sentence boundaries when possible; otherwise
 *  hard-break at maxChars. */
export function splitForTelegram(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^[\s\n]+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Integration: run the bot wired to session-chat ───────────────────
//
// Convenience that builds an onMessage handler that maps chat+thread →
// persistent session and runs a full runTurn() per incoming message.
// Used by `elanous telegram` in Phase 7.

import { createSession, findSessionByTelegramChat, findTelegramSession } from './session/index.js';
import { makeChunkProducer } from './session/streaming/chunk-producer.js';
import { getUserConfig } from './user-config.js';
import { runTurn } from './session/chat.js';
import { submitIntent } from './intent-gate/gate.js';
import type { UserConfig } from './user-config.js';
import type { ContentBlock } from './llm.js';
import { extractPdf, extractDocx, extractXlsx, readText } from './extractors.js';
import { loadImageAsAttachment } from './image/utils.js';

/** Per-attachment processing result. Either a textual summary
 *  (inlined into the user prompt) or an image ContentBlock (sent
 *  multimodally). Voice/audio fall through as text summaries with
 *  the local path — transcription is explicitly out of scope. */
interface ProcessedAttachment {
  inlineText?: string;
  imageBlock?: ContentBlock;
  /** Path to clean up after the turn completes. */
  tempPath?: string;
}

/** Download a single Telegram attachment + materialize it. Handles:
 *   - photo       → resized image ContentBlock (base64)
 *   - document    → extract .pdf/.docx/.xlsx/.txt/.md to text; others
 *                   get a "path on disk" placeholder so the user/LLM
 *                   can reference them.
 *   - voice/audio → placeholder line with duration + local path.
 *                   (Whisper integration = future work.)
 *
 *  Errors downgrade to a placeholder instead of failing the whole
 *  turn — partial attachments still ship the text.
 */
async function processTelegramAttachment(
  bot: TelegramBot,
  att: TgIncomingAttachment,
  log: (msg: string) => void,
): Promise<ProcessedAttachment> {
  try {
    const { localPath, fileName } = await bot.downloadFile(att.fileId);
    const displayName = att.fileName ?? fileName ?? localPath;

    if (att.kind === 'photo') {
      const img = await loadImageAsAttachment(localPath);
      return {
        imageBlock: { type: 'image', mediaType: img.mediaType, base64: img.base64 },
        inlineText: `[photo ${att.width ?? '?'}×${att.height ?? '?'}]`,
        tempPath: localPath,
      };
    }

    if (att.kind === 'voice' || att.kind === 'audio') {
      const kindLabel = att.kind === 'voice' ? 'Voice message' : 'Audio';
      const dur = att.duration != null ? `${att.duration}s` : 'unknown duration';
      return {
        inlineText: `[${kindLabel}: ${dur}, mime ${att.mimeType ?? 'n/a'}, saved to ${localPath}. Transcription not available — user must provide text or a tool with STT capability.]`,
        // Keep the file around: the user may point a local skill at it.
        tempPath: undefined,
      };
    }

    // document
    const name = (displayName || '').toLowerCase();
    const mime = (att.mimeType || '').toLowerCase();
    const ext = name.split('.').pop() ?? '';
    let extracted: { text: string; truncated: boolean } | null = null;
    if (ext === 'pdf' || mime === 'application/pdf') {
      extracted = await extractPdf(localPath);
    } else if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      extracted = await extractDocx(localPath);
    } else if (ext === 'xlsx' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      extracted = await extractXlsx(localPath);
    } else if (ext === 'txt' || ext === 'md' || mime.startsWith('text/')) {
      extracted = await readText(localPath);
    }
    if (extracted) {
      const body = `[Document: ${displayName}]\n\`\`\`\n${extracted.text}\n\`\`\``;
      return { inlineText: body, tempPath: localPath };
    }
    return {
      inlineText: `[Document: ${displayName} (mime ${mime || 'unknown'}, ${att.fileSize ?? '?'} bytes, saved to ${localPath}). No extractor for this type — reference by path.]`,
    };
  } catch (err: any) {
    log(`attachment download/extract failed for ${att.kind} ${att.fileId}: ${err?.message ?? err}`);
    return { inlineText: `[${att.kind} attachment failed to load: ${err?.message ?? err}]` };
  }
}

function cleanupTempFiles(paths: (string | undefined)[]): void {
  for (const p of paths) {
    if (!p) continue;
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
}

export interface BotFromConfigOpts {
  userConfig: UserConfig;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  systemPrompt?: string;
  /** Test seam — override the session-chat turn executor. */
  runTurnImpl?: typeof runTurn;
  /** Maximum attachments processed per incoming message. Defensive cap
   *  against a flood of ~100 forwarded photos. Default 8 — Telegram's
   *  media-group limit is 10. */
  maxAttachments?: number;
  /** Extra slash commands appended after the default set. Useful for
   *  bot variants that want custom ops ("/digest", "/notes") without
   *  reimplementing the defaults. */
  extraSlashCommands?: TgSlashCommand[];
  /** Test seam — forwarded into the TelegramBot constructor. */
  telegramBotOpts?: Partial<TelegramBotOpts>;
  /** Tier 1 telegram fan-out arc — bridge to the running elanous
   *  daemon. When set, the bot handler:
   *    1. Asks `resolveDaemonSessionForChat` BEFORE the legacy TUI
   *       session lookup. A daemon-bound chat (via /resume <id>)
   *       routes through that sessionId.
   *    2. Calls `advanceCursorAfterTurn` after a turn completes so
   *       the boot catch-up doesn't replay turns the user already
   *       saw.
   *  The slash dispatcher forwards the same handle so /resume can
   *  call `setDaemonSessionForChat`. Caller wires the full
   *  TelegramAcpBridge instance — this opt is typed loosely
   *  here to avoid a telegram → telegram-bridge import cycle. */
  daemonBridge?: BotDaemonBridge;
}

/** Tier 1 telegram fan-out arc — minimal interface the bot needs
 *  from a TelegramAcpBridge. Defined here so telegram.ts doesn't
 *  import telegram-acp-bridge.ts (avoiding a cycle); the actual
 *  bridge implementation satisfies this shape structurally. */
export interface BotDaemonBridge {
  resolveDaemonSessionForChat(chatId: number, threadId: number | undefined): string | null;
  advanceCursorAfterTurn(chatId: number, threadId: number | undefined): Promise<void>;
  setDaemonSessionForChat(args: {
    chatId: number;
    threadId: number | undefined;
    sessionId: string;
    lastSeenMsgIdx: number;
  }): void;
}

/** Build a TelegramBot that persists every chat to a per-conversation
 *  session and replies with the LLM's output. Handles text AND
 *  photo/voice/document attachments: media are downloaded via
 *  Bot API getFile → downloaded locally → extracted (docs to text,
 *  images to base64 ContentBlock) → passed into runTurn multimodally. */
export function botFromConfig(opts: BotFromConfigOpts): TelegramBot {
  const tg = opts.userConfig.telegram;
  if (!tg.enabled) throw new Error('telegram disabled in user-config');
  const botToken = opts.telegramBotOpts?.token ?? resolveChannelBotToken('telegram', opts.userConfig)?.token;
  if (!botToken) throw new Error('telegram.botToken missing in user-config');
  const log = opts.log ?? (() => {});
  const cap = opts.maxAttachments ?? 8;
  const runTurnImpl = opts.runTurnImpl ?? runTurn;
  const tgDispatchMode = opts.userConfig.voice?.telegram?.dispatch ?? 'auto-reply';

  let botRef: TelegramBot;  // captured below; needed inside handler closure

  const handler: TgMessageHandler = async (ctx, streamer) => {
    if (tgDispatchMode === 'tui-bridge') {
      const trimmed = ctx.text.trim();
      if (!trimmed) return undefined;
      try {
        const { getDaemonInputHost } = require('./voice/daemon-input-host-singleton.js') as typeof import('./voice/daemon-input-host-singleton.js');
        const host = getDaemonInputHost();
        if (!host) {
          return 'tui-bridge not wired in this process. Start the dashboard in the same daemon process or switch `voice.telegram.dispatch` back to `auto-reply`.';
        }
        const landed = await host.dictateTranscript(trimmed);
        if (!landed) {
          return 'Dashboard input is not ready to accept dictated text right now.';
        }
        return '✓ Routed to the dashboard input.';
      } catch (err) {
        log(`telegram tui-bridge dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        return 'Failed to route text into the dashboard input.';
      }
    }

    // ── Narrow Waist 의도 게이트 (V2 · 2026-07-09) ──────────────────────────
    // 명시 마커("미션:" / "이건 미션이야" / "/mission")가 붙은 발화 = 미션 의도.
    // 게이트가 Mission(planning)을 생성하고 LLM 턴을 건너뛴 채 확인만 회신한다.
    // 마커 없으면 통과(passthrough) — 기존 Q&A/agent 동작 그대로. 미션 "생성"은
    // 실행이 아니라 의도 등록이므로 finance HARD RULE(주문 실행 금지)과 무관.
    // 설계: 내부 문서 `DESIGN-intent-narrow-waist-2026-07-09` §3·§8.
    {
      // ★ origin 전달 — 준비 완료 알림을 던진 그 대화창(main 봇+chatId)으로 되돌리기 위해
      //   (대표 지시 2026-07-11 채널 정정). 없으면 se-mission-prepare 가 report 폴백.
      const gate = await submitIntent({
        text: ctx.text, channel: 'telegram', source: 'human-intent',
        origin: { channel: 'telegram', chatId: ctx.chatId, ...(ctx.botId ? { botId: ctx.botId } : {}), ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}) },
      });
      if (gate.route === 'mission') {
        log(`[telegram] intent-gate: mission ${gate.missionId} (${gate.executionModel}) task=${gate.taskId ?? '-'} heavy=${gate.heavy ?? false} researchGate=${gate.needsResearchGate ?? false}`);
        const lines = [
          `🎯 미션 등록: ${gate.goal}`,
          `· 실행모델 ${gate.executionModel} (${gate.tier === 'heavy' ? '무거움' : '가벼움'})`,
        ];
        if (gate.needsResearchGate) {
          // ★ human-intent → 외부조사 보강 + 크기적응 분해 준비 중(백그라운드). 자동 실행 없음 —
          //   수렴점은 사람 확인(대표 지시 2026-07-11·과도한 노력/defer 판단 위해).
          if (gate.verifyDecompose) lines.push(`· 🧪 분해 검증 모드 — 외부조사 보강 + 멀티페이즈 분해까지만(실행 없음)`);
          else lines.push(`· 🔎 외부조사 보강${gate.heavy ? ' + 멀티페이즈 분해' : ''} 준비 중 (백그라운드·수십초~분)`);
          if (gate.inferredCron) lines.push(`· 추천 스케줄 ${gate.inferredCron}`);
          lines.push(`· 준비되면 PWA Autopilot → Missions 에서 플랜 검토 (trim/defer/교정 가능)`);
        } else if (gate.taskId) {
          lines.push(`· 자동 분해 완료 → 태스크 backlog(아직 실행 안 함)`);
          if (gate.inferredCron) lines.push(`· 추천 스케줄 ${gate.inferredCron}`);
          lines.push(`· 승인 대기 — PWA Autopilot → Missions 에서 "승인"하면 실행 시작`);
        } else {
          lines.push(`· PWA Autopilot → Missions 에서 확인·구체화하세요`);
        }
        lines.push(`· id ${gate.missionId}`);
        return lines.join('\n');
      }
    }

    // Tier 1 telegram fan-out arc — daemon session takes precedence
    // when /resume <id> bound this chat to a daemon-side session.
    // The bridge returns the daemon sessionId (e.g. elanous-session-3)
    // which the runTurnImpl attaches to directly. Falls through to
    // the legacy TUI session flow when no binding exists.
    const daemonSessionId = opts.daemonBridge?.resolveDaemonSessionForChat(ctx.chatId, ctx.threadId) ?? null;
    let chosenSessionId: string;
    let metaForSkillContext: ReturnType<typeof findSessionByTelegramChat> | null = null;
    if (daemonSessionId) {
      chosenSessionId = daemonSessionId;
    } else {
      // Bindings-first lookup: a CLI-started session that called
      // /telegram attach takes precedence over the legacy
      // source==='telegram' auto-session — that's what makes handoff
      // reach the same JSONL from both sides.
      let meta = findSessionByTelegramChat(ctx.chatId, ctx.threadId, ctx.botId);
      if (!meta) {
        meta = createSession({
          source: 'telegram',
          sourceKind: 'telegram',
          tgChatId: ctx.chatId,
          tgThreadId: ctx.threadId,
          tgBotId: ctx.botId,
          provider: opts.userConfig.llm.provider,
          model: opts.userConfig.llm.model ?? '',
          title: `tg:${ctx.userName ?? ctx.userId}`,
        });
      }
      metaForSkillContext = meta;
      chosenSessionId = meta.id;
    }
    void metaForSkillContext; // reserved for future skill-priming wire

    // Process attachments concurrently (capped). Text-kind summaries
    // get inlined; image blocks get passed as userImages.
    const processed: ProcessedAttachment[] = [];
    let processedSourceAttachments: TgIncomingAttachment[] = [];
    if (ctx.attachments.length > 0) {
      const batch = ctx.attachments.slice(0, cap);
      const results = await Promise.all(batch.map(a => processTelegramAttachment(botRef, a, log)));
      processed.push(...results);
      processedSourceAttachments = batch;
    }

    const imageBlocks: ContentBlock[] = processed
      .map(p => p.imageBlock)
      .filter((b): b is ContentBlock => !!b);
    const inlineTexts = processed
      .map(p => p.inlineText)
      .filter((t): t is string => !!t && !p_isImagePlaceholder(t));

    // Step 2 of platform-evolution arc — build NormalizedAttachment[]
    // for the daemon-bridge path. Each processed attachment that has
    // a tempPath becomes a normalized record with kind/dimensions/
    // mime preserved from the inbound TgIncomingAttachment. The bot's
    // botFromConfig caller pipes this into runTurnImpl.userAttachments;
    // the bridge forwards to DashboardSession.send.attachments which
    // calls buildAcpPrompt to fold them into the ACP ContentBlock[].
    const userAttachments: import('./acp/content-blocks.js').NormalizedAttachment[] = [];
    for (let i = 0; i < processed.length; i++) {
      const proc = processed[i]!;
      const src = processedSourceAttachments[i]!;
      if (!proc.tempPath) continue;
      const kind: import('./acp/content-blocks.js').NormalizedAttachment['kind'] =
        src.kind === 'photo' ? 'photo'
        : src.kind === 'voice' ? 'voice'
        : src.kind === 'audio' ? 'audio'
        : 'document';
      userAttachments.push({
        name: src.fileName ?? 'attachment',
        localPath: proc.tempPath,
        ...(src.mimeType ? { mimeType: src.mimeType } : {}),
        kind,
        ...(src.width ? { width: src.width } : {}),
        ...(src.height ? { height: src.height } : {}),
        ...(src.duration ? { duration: src.duration } : {}),
        ...(src.fileSize ? { sizeBytes: src.fileSize } : {}),
      });
    }
    // Photos: the text placeholder "[photo WxH]" is NOT inlined
    // (the ContentBlock speaks for itself).  Docs/voice/audio DO
    // get inlined.
    const userText = [ctx.text, ...inlineTexts].filter(Boolean).join('\n\n');

    // Accumulate streamed deltas so we can feed them to the Telegram
    // placeholder edit closure. Kept in this scope so the onDelta
    // closure stays thin. When no streamer is present (cron push,
    // tests), runTurn still runs to completion but we skip the edit
    // calls — the caller will receive the final text via return.
    let accumulated = '';
    // §C5 청크 producer tap(shadow·fail-soft·gated) — 이 턴의 델타/툴을 fanOutSessionChunk 로
    // 발화(옛 경로 owner 는 excludeKeys 로 제외 → 추가 스트리밍 구독자에만·배달 무변경). 턴 종료 시
    // 청크 parity(누적 vs 최종). 실 flip(owner 를 fan-out 으로 + 이 streamer 억제)은 대표 dogfood.
    // §C5 — authoritative config(getUserConfig·sink 와 동일). chunkProducer 는 **chosenSessionId**
    // (실제 턴 세션·auto-subscribe 로 owner 구독됨)로 — daemonSessionId 는 /resume 바인딩 때만 있음.
    const fabricCfg = getUserConfig().sessionFabric;
    const streamingFlip = fabricCfg?.streaming?.telegram === true;
    const chunkProducer = (chosenSessionId && (fabricCfg?.shadowFanout || streamingFlip))
      ? makeChunkProducer(chosenSessionId, {
          surface: 'telegram',
          // flip: owner 를 fan-out 으로(비제외). shadow: owner 제외(배달 무변경).
          ...(streamingFlip ? { primarySurfaces: ['telegram'] } : {}),
        })
      : null;
    // §C5 관측 — 청크 producer 발화 여부 + 세션. flip 진단 핵심.
    debug.log('telegram.deliver', 'chunk-producer', {
      created: !!chunkProducer, sessionId: chosenSessionId, streamingFlip,
      shadow: fabricCfg?.shadowFanout === true,
    });
    // P3 — self tool streaming. The native brain loop's Bash/Edit/Write were
    // invisible mid-turn (only text deltas streamed); ACP relayed tool/diff
    // live. Mirror that: render a compact tool-activity tail into the
    // placeholder as tools fire, so "실행 중 …" is visible like ACP.
    const toolLines: string[] = [];
    const renderProgress = (): string => {
      const tail = toolLines.length ? toolLines.slice(-6).join('\n') : '';
      if (!tail) return accumulated || '⏳ Working…';
      return `${accumulated}${accumulated ? '\n\n' : ''}${tail}`;
    };
    // Register a per-turn abort controller so `/cancel` can interrupt an
    // in-flight NL `delegate_code_agent` (which blocks elanous's brain via
    // clientSessionSend, a path `/cancel`'s cancelAcpTurn otherwise can't
    // reach). The signal is forwarded down to the delegate tool's ctx.
    const turnAbort = beginCancelableTurn(ctx.chatId, ctx.threadId);
    // M-UX 진행 카드(task#22 part2-A) — 하니스 페이즈 진행의 독립 카드 msgId(첫 push=send·이후 edit).
    // progressCardPending: send/edit 을 직렬화 — 첫 send 가 mid 세팅 전 다음 push 가 또 send 하는 레이스
    // (실기기 실증: plan→execute ~0.5s 간격에 mid 327·328 두 메시지) 방지. 한 카드로 edit-in-place.
    let progressCardMid: number | undefined;
    let progressCardPending: Promise<void> = Promise.resolve();
    try {
      const result = await runTurnImpl({
        userConfig: opts.userConfig,
        sessionId: chosenSessionId,
        userText: userText || '(attachment only)',
        systemPrompt: opts.systemPrompt,
        signal: turnAbort.signal,
        userImages: imageBlocks.length > 0 ? imageBlocks : undefined,
        // Surface-scoped HITL bound to THIS chat — the NL runTurnImpl
        // (makeTelegramAgentRunTurn) threads it into `delegate_code_agent`
        // so a delegated sub-agent's approval prompt lands back here.
        hitlConfirmChannel: botRef.hitlConfirmChannelForChat(ctx.chatId, ctx.threadId),
        ...(botRef.isOwnerAllowed(ctx.userId) ? { verifiedOwner: { id: `telegram:${ctx.userId}` } } : {}),
        hitlQuestionChannel: botRef.hitlQuestionChannelForChat(ctx.chatId, ctx.threadId),
        // P1.4 — surface file spill bound to THIS chat so the NL
        // `delegate_code_agent` path spills big diffs/stdout back here.
        hitlFileSink: botRef.fileSinkForChat(ctx.chatId, ctx.threadId),
        // M-UX 능동 전달자(task#22 part2-A) — 무거운 자율툴(RunDevHarness)의 P→E→R→D 페이즈 진행을 이
        // 챗의 진행 카드로 edit-in-place. tool.progress 만 소비(저빈도 페이즈 비트·도배 없음). push 판단은
        // 관측한다(제1원칙: 없으면 "왜 안 떴나" 디버깅 불가).
        // M-UX 능동 전달자(task#22 part2-A) — 하니스 P→E→R→D 페이즈 진행을 이 챗의 **독립 진행 카드**로.
        //   ⚠️ streamer(응답 스트리머)는 flip 모드(streaming.telegram)에선 undefined 라 게이트하면 안 됨
        //   (실기기 dogfood 실증 버그). 대신 botRef.sendMessage/editMessageText 로 별도 카드 — 응답
        //   placeholder/fan-out 무간섭·양 모드 동작. 첫 페이즈=send·이후=edit. push 판단 관측(제1원칙).
        emitFeedback: (env) => {
          if (env.kind !== 'tool.progress') return;
          const lines = env.payload?.lines;
          if (!Array.isArray(lines) || lines.length === 0) return;
          const text = lines.join('\n');
          const phase = env.phase ?? null;
          // 직렬화 — 직전 send/edit 완료 후 실행(첫 send 가 mid 세팅 → 다음은 edit). 레이스로 카드 도배 방지.
          progressCardPending = progressCardPending.then(async () => {
            try {
              if (progressCardMid === undefined) {
                const posted = await botRef.sendMessage(ctx.chatId, text, { threadId: ctx.threadId });
                progressCardMid = posted?.messageId;
              } else {
                await botRef.editMessageText(ctx.chatId, progressCardMid, text, { threadId: ctx.threadId });
              }
              debug.log('membrane.progress', 'push', { surface: 'telegram', phase, chars: text.length, mid: progressCardMid ?? null });
            } catch (e) {
              debug.log('membrane.progress', 'push-fail', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }, { level: 'error' });
            }
          });
        },
        // A — chat identity so a brain-initiated delegate arms active
        // delegation (NL follow-ups continue that backend).
        tgChat: { botId: ctx.botId, chatId: ctx.chatId, threadId: ctx.threadId },
        // Step 2 — daemon-bridge path consumes this; legacy in-process
        // runTurn ignores (uses userImages + inlineTexts instead).
        userAttachments: userAttachments.length > 0 ? userAttachments : undefined,
        onDelta: (streamer || chunkProducer)
          ? (delta: string) => {
              accumulated += delta;
              streamer?.edit(renderProgress());
              chunkProducer?.delta(delta);   // §C5 shadow 청크 tap(fail-soft)
            }
          : undefined,
        // P3 — surface native tool activity mid-turn (self parity with ACP's
        // live relay). Compact per-call line, marked ✓ on result.
        onToolCall: (streamer || chunkProducer)
          ? (call: { name: string; args?: Record<string, unknown> }) => {
              toolLines.push(`⚙️ ${call.name}${selfToolArgHint(call.args)} …`);
              streamer?.edit(renderProgress());
              chunkProducer?.tool(call.name, call.name, 'call');
            }
          : undefined,
        onToolResult: (streamer || chunkProducer)
          ? (call: { name: string }) => {
              const i = toolLines.findIndex(l => l.startsWith(`⚙️ ${call.name}`) && l.endsWith(' …'));
              if (i >= 0) toolLines[i] = toolLines[i].replace(/ …$/, ' ✓');
              streamer?.edit(renderProgress());
              chunkProducer?.tool(call.name, call.name, 'result');
            }
          : undefined,
      });
      // §C5 청크 producer 마감 — 라이브핸들 finalize + 청크 parity(누적 vs 최종). fail-soft.
      // flip 시 이게 owner 최종 배달(옛 finalizeReply 억제됨)이라 await 로 배달 보장.
      if (chunkProducer) { await chunkProducer.final(result.text || accumulated); }
      return result.text || accumulated;
    } finally {
      endCancelableTurn(ctx.chatId, ctx.threadId, turnAbort);
      // Tier 1 telegram fan-out arc — advance the per-chat cursor so
      // the next bot restart's boot catch-up doesn't re-emit the
      // turn just completed. Only fires for daemon-bound chats; the
      // legacy TUI session flow doesn't track a separate cursor.
      if (daemonSessionId && opts.daemonBridge) {
        opts.daemonBridge.advanceCursorAfterTurn(ctx.chatId, ctx.threadId)
          .catch((e) => log(`[telegram] advanceCursor failed: ${String(e)}`));
      }
      // Clean up temp files. Documents we leave alone when the user
      // might reference them by path — but for now, aggressively clean.
      cleanupTempFiles(processed.map(p => p.tempPath));
    }
  };

  // §3.3 (2026-04-30) — voice msg adapter wire. When the user has
  // declared voice.telegram in user-config (replyMode / voiceLanguage)
  // AND a daemon STT singleton is available, attach the adapter so
  // incoming Telegram voice msgs flow through STT → text dispatch →
  // (optionally) TTS → sendVoice. Lazy-loaded to avoid pulling
  // voice/* into bot consumers that don't use voice (zero-impact for
  // text-only Telegram setups).
  const voiceAdapter = buildTelegramVoiceAdapterFromConfig(opts.userConfig, opts.log);

  botRef = new TelegramBot({
    token: botToken,
    allowedUsers: tg.allowedUsers,
    homeChannel: tg.homeChannel,
    onMessage: handler,
    fetchImpl: opts.fetchImpl,
    log: opts.log,
    // Wire the default slash-command set — help / status / new / ping
    // / provider — plus a hook for consumers to extend (cron push,
    // tests). setMyCommands is called on bot.start() so clients
    // auto-pick-up the menu without any re-install.
    slashCommands: opts.extraSlashCommands
      ? [...defaultTelegramCommands(), ...opts.extraSlashCommands]
      : defaultTelegramCommands(),
    slashContext: {
      userConfig: opts.userConfig,
      ...(opts.daemonBridge !== undefined ? { daemonBridge: opts.daemonBridge } : {}),
    },
    ...(voiceAdapter ? { voiceAdapter } : {}),
    ...opts.telegramBotOpts,
  });
  // Register the surface-HITL callback subscription up front so the
  // poll loop requests `callback_query` from the first getUpdates —
  // in-turn approval taps then arrive without a mid-turn delay.
  botRef.ensureSurfaceHitl();
  // DEC-TG(대표 10-02) — decision cards on the MAIN bot only (other channel pollers carry other tokens). The ticker
  // itself sends only while this bot polls, so a send-only nexus bot never duplicates the standalone poller's cards.
  const mainToken = resolveChannelBotToken('telegram', opts.userConfig)?.token;
  if (mainToken && botToken === mainToken) {
    attachTelegramProjectButtons(botRef, opts.userConfig);
    if (opts.userConfig.raw?.decisions === undefined || (opts.userConfig.raw.decisions as { cards?: unknown }).cards !== false) {
      const bot = botRef;
      void import('./decisions/telegram-decision-cards.js')
        .then(({ attachTelegramDecisionCards }) => { attachTelegramDecisionCards(bot, opts.userConfig); })
        .catch((err: unknown) => log(`[telegram] decision cards not attached: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return botRef;
}

/** Phase 8 / §3.3 — build a TelegramVoiceAdapter from user-config when
 *  the user has wired voice.telegram. Returns undefined when:
 *    - voice.telegram has no settings (default behaviour preserved)
 *    - the daemon STT singleton hasn't been initialised
 *  When wired, picks up `voice.telegram.replyMode` / `voiceLanguage`
 *  and a TTS provider (when auto/voice replyMode + ttsProvider
 *  reachable). Errors during build degrade silently to undefined
 *  (text-only Telegram still works). */
export function buildTelegramVoiceAdapterFromConfig(
  cfg: UserConfig,
  log?: (msg: string) => void,
  testOpts?: {
    codec?: import('./voice/channel-adapters/telegram-voice-adapter.js').TelegramVoiceCodec;
  },
): import('./voice/channel-adapters/telegram-voice-adapter.js').TelegramVoiceAdapter | undefined {
  const tgVoice = cfg.voice?.telegram;
  if (!tgVoice || (
    tgVoice.dispatch === undefined
    && tgVoice.replyMode === undefined
    && tgVoice.voiceLanguage === undefined
  )) {
    return undefined;
  }
  try {
    const { createTelegramVoiceAdapter } = require('./voice/channel-adapters/telegram-voice-adapter.js') as typeof import('./voice/channel-adapters/telegram-voice-adapter.js');
    const { getDaemonSttProvider } = require('./voice/voice-rest-handler.js') as typeof import('./voice/voice-rest-handler.js');
    const { getDaemonTtsProvider } = require('./voice/voice-tts-singleton.js') as typeof import('./voice/voice-tts-singleton.js');
    const sttProvider = getDaemonSttProvider();
    if (!sttProvider) {
      log?.('telegram voice: STT provider not initialised — skipping adapter wire');
      return undefined;
    }
    const forcedReplyMode = tgVoice.dispatch === 'tui-bridge' ? 'text' : tgVoice.replyMode;
    const ttsProvider = getDaemonTtsProvider();
    const adapter = createTelegramVoiceAdapter({
      sttProvider,
      ...(forcedReplyMode ? { replyMode: forcedReplyMode } : {}),
      ...(ttsProvider ? { ttsProvider } : {}),
      ...(tgVoice.voiceLanguage ? { voiceLanguage: tgVoice.voiceLanguage } : {}),
      ...(testOpts?.codec ? { codec: testOpts.codec } : {}),
    });
    if (adapter.available) {
      log?.(`telegram voice: adapter wired (replyMode=${adapter.replyMode}${tgVoice.voiceLanguage ? `, lang=${tgVoice.voiceLanguage}` : ''})`);
    }
    return adapter;
  } catch (err) {
    log?.(`telegram voice: adapter wire failed (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/** True when the placeholder is the photo stub (which we don't inline
 *  since the ContentBlock is richer). Kept as a named predicate to
 *  avoid a cryptic regex sprinkled in the main flow. */
function p_isImagePlaceholder(text: string): boolean {
  return /^\[photo\s/.test(text);
}
