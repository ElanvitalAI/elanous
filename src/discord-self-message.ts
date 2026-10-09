// ── Discord self-turn message handler — shared by discord-test + nexus (M4b) ──
//
// PLAN-multi-surface-pty-shell M4b: the discord mirror of telegram's
// onMessage brain path, including the ACP interweaving stack:
//
//   · `/cc <p>` `/cdx <p>` `/gem <p>` — explicit delegation to Claude
//     Code / Codex / Gemini over ACP (text-parsed; discord native slash
//     stays with the sprint21 registry).
//   · active delegation — after a delegate turn (explicit slash OR a
//     brain-initiated NL `delegate_code_agent`), plain NL follow-ups
//     continue the SAME backend session. `classifyDelegationOverride`
//     lets an explicit "self로/claude로" override the auto-continue;
//     `/brain` exits back to the brain.
//   · carry-in — a delegation's first prompt gets the recent-chat
//     digest; a continued backend gets the DELTA since it last ran
//     (interleaved self / other-backend turns), via
//     buildAcpContextPreambleForSession on the channel session.
//   · self turn — everything else runs makeDiscordAgentRunTurn (M4a):
//     terminal 4종 + fileSinkForChannel screenshots + footer.
//
// Consumed by BOTH the isolated `elanous discord-test` runner and the
// production nexus trigger bot (runTurnImpl injection) so the two stay
// congruent by construction. The DiscordBot's own gates (DM-only +
// guildTextChannels + allowlist) run BEFORE this handler; `channelScope`
// adds the test runner's belt-and-braces channel filter.
//
// C1+C2 (2026-07-12) closed the M4b scope notes: attachments ARE now
// normalized into the ACP turn (downloadDcAttachments → image/audio/
// document content blocks), and backend QUESTIONs surface as button
// components via questionChannelFor (PERMISSION stays auto-approved —
// QUESTION-only philosophy).

import type { UserConfig } from './user-config.js';
import type { runTurn } from './session/chat.js';
import type { DiscordBot, DcMessageHandler, DcIncoming, DcMessageStreamer } from './discord.js';
import {
  createSession,
  appendMessage,
  findSessionByDiscordChannel,
  attachDiscordBinding,
  detachDiscordBinding,
  listBoundSessions,
  resolveSessionId,
  forkSessionById,
  autoSubscribeOldPath,
} from './session/index.js';
import { buildToolTraceMessage } from './session/chat.js';
import { runAcpTurn } from './acp/turn-runner.js';
import { globalAcpSessionStore } from './acp/session-store.js';
import { canonicalizeBackendId } from './acp/backend-registry.js';
import {
  delegationChatKey,
  getActiveDelegation,
  setActiveDelegation,
  touchActiveDelegation,
  clearActiveDelegation,
  classifyDelegationOverride,
} from './acp/active-delegation.js';
import { buildAcpContextPreambleForSession } from './telegram-commands.js';
import { executionFooter } from './telegram-exec-footer.js';
import { debug } from './debug/log.js';
import { makeChunkProducer } from './session/streaming/chunk-producer.js';
import { getUserConfig } from './user-config.js';
import { detectCard, runCardFollowup, NotACardError } from './card-followup/core.js';
import { localOcrText } from './telegram-card-followup.js';
import type { runGraph } from './graph-runner/runner.js';
import { readSlashContextNow, renderContextFirstNow, renderTelegramNow } from './context-bus/context-now-surfaces.js';
import { contextNow, type ContextNowDeps } from './context-bus/context-now.js';
import { createContextFirstGate, renderContextFirst } from './context-bus/context-first.js';
import { telegramLoopsStatus, type LoopsSources } from './telegram-loops-command.js';
import { botUnavailableSlashReply, deriveTuiSlashAvailability, type TuiSlashAvailability } from './maturity/tui-slash-availability.js';

const SLASH_FOCUS_TURNS_DEFAULT = 8;

/** C2 (2026-07-12) — DcAttachment → NormalizedAttachment (텔레그램
 *  downloadAttachments 동형). Discord CDN URL은 만료 토큰이 박힌 공개
 *  URL이라 bot.downloadAttachment가 로컬 파일로 내려받고, ACP
 *  content-blocks 계층이 이미지/오디오/문서 블록으로 변환한다. 실패한
 *  첨부는 건너뛰되 로그로 가시화(부분 성공 허용). */
async function downloadDcAttachments(
  bot: DiscordBot,
  attachments: readonly import('./discord.js').DcAttachment[],
  log: (msg: string) => void,
): Promise<import('./acp/content-blocks.js').NormalizedAttachment[]> {
  const out: import('./acp/content-blocks.js').NormalizedAttachment[] = [];
  for (const a of attachments) {
    try {
      const { localPath } = await bot.downloadAttachment(a);
      const ct = a.contentType ?? '';
      const kind: import('./acp/content-blocks.js').NormalizedAttachment['kind'] =
        ct.startsWith('image/') ? 'photo'
          : ct.startsWith('audio/') ? (a.durationSecs !== undefined ? 'voice' : 'audio')
            : ct ? 'document' : 'unknown';
      out.push({
        name: a.filename,
        localPath,
        kind,
        sourceUrl: a.url,
        ...(ct ? { mimeType: ct } : {}),
        ...(a.width !== undefined ? { width: a.width } : {}),
        ...(a.height !== undefined ? { height: a.height } : {}),
        ...(a.durationSecs !== undefined ? { duration: a.durationSecs } : {}),
        ...(a.size !== undefined ? { sizeBytes: a.size } : {}),
      });
    } catch (err) {
      log(`attachment download failed (${a.filename}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Text-command parse: `/cc build X` → {backend:'claude', prompt:'build X'}.
 *  `/brain` exits active delegation. `!cc` etc. are equivalent aliases —
 *  the discord client intercepts `/` for its native slash palette (our
 *  text commands aren't registered there), so `!` is the friction-free
 *  spelling. Exported for tests. */
export function parseDiscordAcpCommand(text: string):
  | { kind: 'delegate'; backend: 'claude' | 'codex' | 'gemini'; prompt: string }
  | { kind: 'brain' }
  | null {
  const m = /^[/!](cc|cdx|gem|brain)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[1] === 'brain') return { kind: 'brain' };
  const backend = m[1] === 'cc' ? 'claude' : m[1] === 'cdx' ? 'codex' : 'gemini';
  return { kind: 'delegate', backend, prompt: (m[2] ?? '').trim() };
}

export interface DiscordSelfMessageDeps {
  userConfig: UserConfig;
  /** The self turn (makeDiscordAgentRunTurn(cfg)). Injected so the test
   *  runner and production wire share this handler verbatim. */
  runTurnImpl: typeof runTurn;
  /** Late-bound bot ref — fileSinkForChannel needs the constructed bot,
   *  which is constructed WITH this handler (circular otherwise). */
  getBot: () => DiscordBot | null;
  /** Only handle messages in this channel (discord-test). Absent ⇒
   *  handle whatever passed the bot's own gates (production: DMs). */
  channelScope?: string;
  /** C1 (2026-07-12) — per-channel AskUserQuestion channel factory
   *  (discord-question-channel runtime). When present, delegated ACP
   *  turns surface backend QUESTIONs as button components in the
   *  originating channel. Absent ⇒ delegate runs fully unattended
   *  (legacy). */
  questionChannelFor?: (channelId: string) => import('./hitl/question.js').QuestionChannel;
  log?: (msg: string) => void;
  cardFollowupDeps?: { ocrText?: (path: string) => Promise<string | null>; runGraph?: typeof runGraph; rootDir?: () => string };
  nowDeps?: ContextNowDeps;
  /** Override the clock for the context-first gate in isolated message-path tests. */
  contextFirstNow?: () => number;
  loopsSources?: LoopsSources;
  /** Override the TUI slash projection for isolated message-path tests. */
  tuiSlashAvailability?: readonly TuiSlashAvailability[];
}

/** Compose the full discord self+interweave onMessage handler. */
export function buildDiscordSelfOnMessage(deps: DiscordSelfMessageDeps): DcMessageHandler {
  const log = deps.log ?? ((): void => {});
  const cfg = deps.userConfig;
  const contextFirstGate = createContextFirstGate({ now: deps.contextFirstNow ?? Date.now });
  const maybeSendContextFirst = async (channelId: string): Promise<void> => {
    if (!contextFirstGate.take(channelId) || cfg.discord?.contextFirst === false) return;
    try {
      await deps.getBot()?.sendMessage(channelId, renderContextFirst(contextNow, deps.nowDeps, renderContextFirstNow));
    } catch (err) {
      log(`discord context-first failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // C2+ (2026-07-12 dogfood): 디스코드 첨부는 메시지 단위라 "사진 먼저,
  // !cdx 명령은 다음 메시지" 패턴에서 위임 턴이 빈손이 된다. 채널별로
  // 마지막 첨부를 기억해 두고, 첨부 없는 위임 명령이 2분 내 같은
  // 사용자의 직전 첨부를 자동 채택한다 (텔레그램의 사진+캡션 UX 근사).
  const RECENT_ATTACHMENT_TTL_MS = 2 * 60 * 1000;
  const recentAttachments = new Map<string, { atts: DcIncoming['attachments']; userId: string; ts: number }>();
  const rememberAttachments = (ctx: DcIncoming): void => {
    if (ctx.attachments.length > 0) {
      recentAttachments.set(ctx.channelId, { atts: ctx.attachments, userId: ctx.userId, ts: Date.now() });
    }
  };
  const adoptRecentAttachments = (ctx: DcIncoming): DcIncoming['attachments'] => {
    if (ctx.attachments.length > 0) return ctx.attachments;
    const rec = recentAttachments.get(ctx.channelId);
    if (!rec || rec.userId !== ctx.userId) return [];
    if (Date.now() - rec.ts > RECENT_ATTACHMENT_TTL_MS) return [];
    return rec.atts;
  };
  // One session per channel — PERSISTED via bindings.discord (S1 ·
  // 2026-07-12, 텔레그램 동형). The Map is only a per-process cache
  // over the index lookup; on restart findSessionByDiscordChannel
  // rebinds the channel to its live session instead of minting a new
  // one (이전에는 메모리 Map뿐이라 재시작마다 세션 고아화).
  const sessionByChannel = new Map<string, string>();
  const ensureChannelSession = (ctx: DcIncoming): string => {
    const cached = sessionByChannel.get(ctx.channelId);
    if (cached) return cached;
    const bound = findSessionByDiscordChannel(ctx.channelId);
    if (bound) {
      // ⚠️ 재사용 세션 discord 구독 보장(멱등) — 구 세션(binding 은 있으나 subscribers 누락)이
      // 재사용되면 attachDiscordBinding(구독 등록 지점)이 재실행 안 돼 fan-out 대상 0 → C5 flip
      // 무배달. 여기서 autoSubscribeOldPath 를 멱등 호출해 discord 구독자를 보장한다(2026-07-16 실측).
      autoSubscribeOldPath(bound.id);
      sessionByChannel.set(ctx.channelId, bound.id);
      return bound.id;
    }
    const id = createSession({
      source: 'discord',
      origin: 'dc',
      provider: cfg.llm.provider,
      model: cfg.llm.model ?? '',
      title: `dc:${ctx.userName ?? ctx.userId}`,
    }).id;
    const guildId = typeof ctx.raw.guild_id === 'string' ? ctx.raw.guild_id : undefined;
    try { attachDiscordBinding(id, ctx.channelId, guildId); }
    catch (err) {
      // Conflict should be impossible (lookup above just missed) but a
      // race with another process must not break the turn.
      log(`discord binding attach failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    sessionByChannel.set(ctx.channelId, id);
    return id;
  };

  /** S1 session commands — `!sessions`·`!new`·`!attach <prefix>` (and
   *  `/` spellings). Returns a reply string, or null when the message
   *  is not a session command (falls through to delegation/self). */
  const handleSessionCommand = (ctx: DcIncoming): string | null => {
    const m = /^[/!](sessions|new|clear|reset|attach|fork)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(ctx.text.trim());
    if (!m) return null;
    const cmd = m[1] === 'clear' || m[1] === 'reset' ? 'new' : m[1];
    if (cmd === 'fork') {
      // S2 — fork the current channel session (or an explicit prefix)
      // and REBIND this channel to the fork: "여기서부터 갈라져서 계속".
      // S3 — `before:N` 토큰이 있으면 N번째 사용자 발화 이전으로 타임트래블.
      const tokens = [m[2], m[3]].filter((t): t is string => !!t);
      const beforeTok = tokens.find((t) => /^before:\d+$/i.test(t));
      const beforeUser = beforeTok ? Number(beforeTok.split(':')[1]) : undefined;
      const prefixTok = tokens.find((t) => t !== beforeTok);
      let sourceId: string | null = null;
      if (prefixTok) {
        try { sourceId = resolveSessionId(prefixTok); }
        catch (err) { return `⚠️ ${err instanceof Error ? err.message : String(err)}`; }
        if (!sourceId) return `세션을 찾을 수 없습니다: \`${prefixTok}\``;
      } else {
        sourceId = findSessionByDiscordChannel(ctx.channelId)?.id
          ?? sessionByChannel.get(ctx.channelId) ?? null;
        if (!sourceId) return '포크할 세션이 없습니다 — 먼저 대화를 시작하거나 `!fork <prefix>`로 지정하세요.';
      }
      const fork = forkSessionById(sourceId, beforeUser !== undefined ? { beforeUser } : {});
      if (!fork) return `세션을 찾을 수 없습니다: \`${sourceId.slice(0, 8)}\``;
      const current = findSessionByDiscordChannel(ctx.channelId);
      if (current) { try { detachDiscordBinding(current.id); } catch { /* noop */ } }
      const guildId = typeof ctx.raw.guild_id === 'string' ? ctx.raw.guild_id : undefined;
      try { attachDiscordBinding(fork.meta.id, ctx.channelId, guildId); }
      catch (err) { return `⚠️ 포크는 생성됐으나 바인딩 실패: ${err instanceof Error ? err.message : String(err)}`; }
      sessionByChannel.set(ctx.channelId, fork.meta.id);
      clearActiveDelegation(delegationChatKeyFor(ctx));
      return `⑂ 세션 \`${sourceId.slice(0, 8)}\`를 포크 → \`${fork.meta.id.slice(0, 8)}\` (${fork.messages.length}개 턴 복사). 이 채널은 이제 포크에서 이어집니다 — 원본 복귀는 \`!attach ${sourceId.slice(0, 8)}\`.`;
    }
    if (cmd === 'sessions') {
      const bound = listBoundSessions();
      if (bound.length === 0) return '바인딩된 세션이 없습니다.';
      const lines = bound.slice(0, 15).map((s) => {
        const here = s.bindings?.discord?.channelId === ctx.channelId ? '▸ ' : '  ';
        const chans = [
          s.bindings?.cli ? 'tui' : null,
          s.bindings?.telegram ? `tg:${s.bindings.telegram.chatId}` : null,
          s.bindings?.discord ? `dc:${s.bindings.discord.channelId.slice(-6)}` : null,
        ].filter(Boolean).join('·');
        return `${here}\`${s.id.slice(0, 8)}\` ${s.title.slice(0, 40)} — ${s.origin ?? s.source} [${chans}] (${s.messageCount}msg)`;
      });
      return `**바인딩된 세션 ${bound.length}개**\n${lines.join('\n')}\n\n\`!attach <prefix>\`로 이 채널을 다른 세션에 연결 · \`!new\`로 새로 시작`;
    }
    if (cmd === 'new') {
      const bound = findSessionByDiscordChannel(ctx.channelId);
      sessionByChannel.delete(ctx.channelId);
      clearActiveDelegation(delegationChatKeyFor(ctx));
      if (!bound) return '🆕 새 세션으로 시작합니다 (기존 바인딩 없음).';
      try { detachDiscordBinding(bound.id); } catch { /* index row gone — same outcome */ }
      return `🆕 새 세션으로 시작합니다. 이전 대화는 \`${bound.id.slice(0, 8)}\`에 보존됨 — \`!attach ${bound.id.slice(0, 8)}\`로 복귀 가능.`;
    }
    // attach <prefix>
    const prefix = m[2];
    if (!prefix) return '사용법: `!attach <세션ID prefix>` — 목록은 `!sessions`';
    let targetId: string;
    try {
      const resolved = resolveSessionId(prefix);
      if (!resolved) return `세션을 찾을 수 없습니다: \`${prefix}\``;
      targetId = resolved;
    } catch (err) {
      return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    }
    const current = findSessionByDiscordChannel(ctx.channelId);
    if (current?.id === targetId) return `이미 이 세션(\`${targetId.slice(0, 8)}\`)에 연결돼 있습니다.`;
    if (current) { try { detachDiscordBinding(current.id); } catch { /* noop */ } }
    const guildId = typeof ctx.raw.guild_id === 'string' ? ctx.raw.guild_id : undefined;
    try {
      attachDiscordBinding(targetId, ctx.channelId, guildId);
    } catch (err) {
      return `⚠️ attach 실패: ${err instanceof Error ? err.message : String(err)}`;
    }
    sessionByChannel.set(ctx.channelId, targetId);
    clearActiveDelegation(delegationChatKeyFor(ctx));
    return `🔗 이 채널을 세션 \`${targetId.slice(0, 8)}\`에 연결했습니다 — 다음 턴부터 그 맥락으로 이어집니다.`;
  };
  const delegationChatKeyFor = (ctx: DcIncoming): string => delegationChatKey('dc', ctx.channelId);

  /** Explicit or continued ACP delegation turn (interweaving core). */
  const runDiscordAcpTurn = async (
    backendKey: string,
    promptText: string,
    ctx: DcIncoming,
    streamer: DcMessageStreamer | undefined,
    sessionId: string,
  ): Promise<string> => {
    const slashLabel = backendKey === 'claude' ? 'cc' : backendKey === 'codex' ? 'cdx' : backendKey === 'gemini' ? 'gem' : backendKey;
    // C2 — attachment-only turns allowed (사진만 올리고 캡션 `/cc` — 텔레그램 동형).
    if (!promptText && ctx.attachments.length === 0) return `Usage: /${slashLabel} <prompt>`;
    // Carry-in — fresh backend session gets the recent-chat digest;
    // continued session gets the delta since its last activity, so a
    // `/cc → self → /cc` handoff stays seamless (텔레그램 동형).
    const acpRec = globalAcpSessionStore().getRecord(ctx.channelId, canonicalizeBackendId(backendKey));
    const preamble = acpRec
      ? buildAcpContextPreambleForSession(sessionId, { sinceTs: acpRec.updatedAt })
      : buildAcpContextPreambleForSession(sessionId);
    // Breadcrumb the delegated job into the channel session so the
    // brain's next NL turn can recall it (runAcpTurn writes only the
    // backend's own ACP session).
    appendMessage(sessionId, {
      role: 'user',
      content: `/${slashLabel} ${promptText}`.trim(),
      ts: new Date().toISOString(),
    });
    streamer?.edit(`⏳ ${slashLabel.toUpperCase()} 세션 준비 중… (첫 턴은 세션 로드로 수십 초 걸릴 수 있음)`);
    debug.log('discord.acp.turn', 'start', { backendKey, channelId: ctx.channelId, chars: promptText.length });
    const focusTurns = cfg.acp?.slashMaxTurns ?? SLASH_FOCUS_TURNS_DEFAULT;
    // C2 — normalize discord attachments into the ACP turn (이미지/
    // 오디오/문서 콘텐츠 블록). C2+: 이 메시지에 첨부가 없으면 2분 내
    // 같은 사용자의 직전 첨부를 채택 ("사진 먼저, 명령은 다음 메시지").
    const bot = deps.getBot();
    const effectiveAttachments = adoptRecentAttachments(ctx);
    if (effectiveAttachments.length > 0 && ctx.attachments.length === 0) {
      log(`adopting ${effectiveAttachments.length} recent attachment(s) for /${slashLabel}`);
    }
    const acpAttachments = bot && effectiveAttachments.length > 0
      ? await downloadDcAttachments(bot, effectiveAttachments, log)
      : [];
    const { text, stopReason, model } = await runAcpTurn({
      backendId: backendKey,
      promptText: preamble + promptText,
      chatId: ctx.channelId,
      ...(streamer ? { streamer } : {}),
      focusTurns,
      ...(acpAttachments.length > 0 ? { attachments: acpAttachments } : {}),
      // C1 — backend QUESTIONs render as discord buttons in this
      // channel (PERMISSION stays auto-approved — QUESTION-only 철학).
      ...(deps.questionChannelFor
        ? { hitlQuestionChannels: [deps.questionChannelFor(ctx.channelId)] }
        : {}),
    });
    const base = stopReason === 'cancelled'
      ? text + '\n\n_⏹ cancelled_'
      : stopReason !== 'end_turn'
        ? text + `\n\n_(stop: ${stopReason})_`
        : text;
    // Persist reply + structured tool trace so a follow-up self turn
    // can surface what the delegate did (기억 패리티 — 텔레그램 동형).
    try { appendMessage(sessionId, buildToolTraceMessage(`acp:${backendKey}`, promptText, text)); } catch { /* non-fatal */ }
    try {
      appendMessage(sessionId, { role: 'assistant', content: base, ts: new Date().toISOString() });
    } catch { /* non-fatal */ }
    debug.log('discord.acp.turn', 'done', { backendKey, stopReason, chars: text.length });
    return `${base}\n\n${executionFooter({ delegatedBackend: backendKey, ...(model ? { model } : {}) })}`;
  };

  return async (ctx, streamer) => {
    if (deps.channelScope && ctx.channelId !== deps.channelScope) return undefined;
    contextFirstGate.note(ctx.channelId);
    // Voice text commands pass the guild gate for the voice adapter's
    // sake — never route them into the LLM turn (legacy behavior).
    if (/^\/voice-(join|leave|status)\b/.test(ctx.text.trim())) return undefined;
    const nowCommand = /^[/!]now(?:\s+([\s\S]*))?$/.exec(ctx.text.trim());
    if (nowCommand) {
      const args = nowCommand[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
      return renderTelegramNow(readSlashContextNow(args, deps.nowDeps));
    }
    if (/^[/!]loops$/.test(ctx.text.trim())) return telegramLoopsStatus([], deps.loopsSources);
    if (/^[/!]loops\s+\S/.test(ctx.text.trim())) return telegramLoopsStatus(['extra'], deps.loopsSources);
    if (!ctx.text.trim() && ctx.attachments.length === 1 && ctx.attachments[0]!.contentType?.startsWith('image/')) {
      const photo = ctx.attachments[0]!;
      if (detectCard({ width: photo.width, height: photo.height, ocrText: null }).decision !== 'skip') {
        const bot = deps.getBot();
        if (bot) {
          let imagePath: string;
          let ocrText: string | null;
          try {
            imagePath = (await bot.downloadAttachment(photo)).localPath;
            ocrText = await (deps.cardFollowupDeps?.ocrText ?? localOcrText)(imagePath);
          } catch {
            return '명함을 읽지 못했습니다';
          }
          if (detectCard({ width: photo.width, height: photo.height, ocrText }).decision === 'card') {
            try {
              const result = await runCardFollowup({ imagePath, ocrText,
                ...(deps.cardFollowupDeps?.runGraph ? { runGraph: deps.cardFollowupDeps.runGraph } : {}),
                ...(deps.cardFollowupDeps?.rootDir ? { rootDir: deps.cardFollowupDeps.rootDir() } : {}),
              });
              for (const reply of result.replies) await bot.sendMessage(ctx.channelId, reply);
              return streamer ? '명함 정리를 완료했습니다.' : undefined;
            } catch (error) {
              if (!(error instanceof NotACardError)) return '명함을 읽지 못했습니다';
            }
          }
        }
      }
    }
    // S1 session commands (!sessions·!new·!attach) — before delegation
    // and self-turn routing, mirroring telegram's command precedence.
    const sessionReply = handleSessionCommand(ctx);
    if (sessionReply !== null) {
      log(`session cmd: ${ctx.text.trim().slice(0, 40)}`);
      return sessionReply;
    }
    const slashName = /^\/([a-z0-9_-]{1,32})(?:\s|$)/i.exec(ctx.text.trim())?.[1]?.toLowerCase();
    if (slashName) {
      const entry = (deps.tuiSlashAvailability ?? deriveTuiSlashAvailability()).find(({ name }) => name === slashName);
      const unavailable = botUnavailableSlashReply(entry, 'discord');
      if (unavailable) return unavailable;
    }
    const cmd = parseDiscordAcpCommand(ctx.text);
    if (!cmd && !/^[!/]/.test(ctx.text.trim())) await maybeSendContextFirst(ctx.channelId);
    log(`◀ ${ctx.userName ?? ctx.userId}: ${ctx.text.slice(0, 80)}${ctx.attachments.length ? ` (+첨부 ${ctx.attachments.length})` : ''}`);
    debug.log('discord.self.turn', 'inbound', { channelId: ctx.channelId, chars: ctx.text.length, attachments: ctx.attachments.length });
    // C2+ — 첨부 기억(사진만 먼저 올리는 패턴 지원). 명령 여부와 무관.
    rememberAttachments(ctx);
    const sessionId = ensureChannelSession(ctx);
    const delegationKey = delegationChatKey('dc', ctx.channelId);

    // 1) Explicit text commands — /cc·/cdx·/gem delegate, /brain exits.
    if (cmd?.kind === 'brain') {
      clearActiveDelegation(delegationKey);
      return '🧠 브레인 모드로 복귀했습니다 (active delegation 해제).';
    }
    if (cmd?.kind === 'delegate') {
      try {
        const reply = await runDiscordAcpTurn(cmd.backend, cmd.prompt, ctx, streamer, sessionId);
        setActiveDelegation(delegationKey, cmd.backend);
        return reply;
      } catch (err) {
        clearActiveDelegation(delegationKey);
        const reason = err instanceof Error ? err.message : String(err);
        debug.log('discord.acp.turn', 'error', { backendKey: cmd.backend, message: reason }, { level: 'error' });
        return `⚠️ /${cmd.backend} delegation failed: ${reason}`;
      }
    }

    // 2) Active delegation — NL follow-ups continue the bound backend;
    //    an explicit surface signal ("self로"·"claude로") overrides.
    let activeBackend = ctx.text ? getActiveDelegation(delegationKey) : null;
    if (activeBackend) {
      const override = classifyDelegationOverride(ctx.text);
      if (override === 'self') {
        clearActiveDelegation(delegationKey);
        activeBackend = null;
      } else if (override && override !== activeBackend) {
        setActiveDelegation(delegationKey, override);
        activeBackend = override;
      }
    }
    if (activeBackend) {
      touchActiveDelegation(delegationKey);
      try {
        return await runDiscordAcpTurn(activeBackend, ctx.text, ctx, streamer, sessionId);
      } catch (err) {
        // A broken continue must not trap the user in ACP mode.
        clearActiveDelegation(delegationKey);
        const reason = err instanceof Error ? err.message : String(err);
        debug.log('discord.acp.turn', 'error', { backendKey: activeBackend, message: reason }, { level: 'error' });
        return `⚠️ ${activeBackend} continue failed (브레인으로 복귀): ${reason}`;
      }
    }

    // 3) Self turn (M4a) — streaming progress mirrors telegram's
    //    placeholder-edit pattern (text deltas + ⚙️ tool-activity tail).
    let accumulated = '';
    const toolLines: string[] = [];
    const renderProgress = (): string => {
      const tail = toolLines.length ? toolLines.slice(-6).join('\n') : '';
      if (!tail) return accumulated || '⏳ Working…';
      return `${accumulated}${accumulated ? '\n\n' : ''}${tail}`;
    };
    // §C5 디스코드 청크 producer tap(텔레그램 동형). shadow OR streaming.discord 시 발화. flip
    // (streaming.discord)이면 primarySurfaces=['discord'] 로 owner 를 fan-out 배달(옛 경로 억제는
    // discord.ts dispatch). config 는 getUserConfig(데몬 config-dir·authoritative).
    const dcFabric = getUserConfig().sessionFabric;
    const dcStreamingFlip = dcFabric?.streaming?.discord === true;
    const chunkProducer = (dcFabric?.shadowFanout || dcStreamingFlip)
      ? makeChunkProducer(sessionId, { surface: 'discord', ...(dcStreamingFlip ? { primarySurfaces: ['discord'] } : {}) })
      : null;
    debug.log('discord.deliver', 'chunk-producer', { created: !!chunkProducer, sessionId, streamingFlip: dcStreamingFlip, shadow: dcFabric?.shadowFanout === true });
    try {
      const bot = deps.getBot();
      const result = await deps.runTurnImpl({
        userConfig: cfg,
        sessionId,
        userText: ctx.text || '(attachment only)',
        // NL delegate arming key (M4b) — a brain-initiated
        // delegate_code_agent binds follow-ups to that backend.
        dcChannel: { channelId: ctx.channelId },
        // Screenshot / file-spill channel — PtyShellScreenshot PNGs and
        // oversized tool bodies attach into THIS discord channel (M2).
        ...(bot ? { hitlFileSink: bot.fileSinkForChannel(ctx.channelId) } : {}),
        onDelta: (streamer || chunkProducer)
          ? (delta: string) => { accumulated += delta; streamer?.edit(renderProgress()); chunkProducer?.delta(delta); }
          : undefined,
        onToolCall: (streamer || chunkProducer)
          ? (call: { name: string }) => { toolLines.push(`⚙️ ${call.name} …`); streamer?.edit(renderProgress()); chunkProducer?.tool(call.name, call.name, 'call'); }
          : undefined,
        onToolResult: (streamer || chunkProducer)
          ? (call: { name: string }) => {
              const i = toolLines.findIndex(l => l.startsWith(`⚙️ ${call.name}`) && l.endsWith(' …'));
              if (i >= 0) toolLines[i] = toolLines[i]!.replace(/ …$/, ' ✓');
              streamer?.edit(renderProgress());
              chunkProducer?.tool(call.name, call.name, 'result');
            }
          : undefined,
      });
      log(`▶ reply ${result.text?.length ?? 0} chars (session ${sessionId})`);
      debug.log('discord.self.turn', 'outbound', { sessionId, chars: result.text?.length ?? 0 });
      // §C5 flip — 청크 producer 마감(owner 최종 배달·await). fail-soft.
      if (chunkProducer) { await chunkProducer.final(result.text || accumulated); }
      return result.text || accumulated || '(no response)';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`✖ turn failed: ${reason}`);
      debug.log('discord.self.turn', 'error', { message: reason }, { level: 'error' });
      return `⚠️ turn failed: ${reason}`;
    }
  };
}
