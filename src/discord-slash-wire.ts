// ── Discord 네이티브 슬래시 wire (C3 · 2026-07-12) ────────────────────
//
// 세션 패브릭 아크 C트랙 C3: `/cc`·`/fork`·`/voice-join` 등을 디스코드
// 네이티브 슬래시로 등록해 자동완성 UX를 제공. sprint21의 레지스트리
// 프리미티브(slash-registry: bulkOverwriteGuild · slash-router:
// normalizeInteractionPayload)만 재사용하고, 페르소나/웹훅 쇼룸 런타임
// (sprint21-runtime — 호출처 0·휴면)은 끌고 오지 않는다.
//
// 라우팅 철학: 슬래시 인터랙션을 **기존 텍스트 명령 문장으로 합성**해
// 조립된 onMessage 파이프라인(보이스 디스패치 → 세션 명령 → ACP 위임
// → self 턴)에 그대로 흘린다 — 명령 의미론의 단일 출처 유지, 신규
// 핸들러 분기 0. 인터랙션은 3초 내 ACK가 필수라 type 4 즉답("처리 중")
// 후 실제 응답은 일반 채널 메시지로 잇는다.
//
// 보안: 인터랙션은 DiscordBot의 메시지 게이트(allowlist·채널스코프)를
// 우회해 도착하므로 여기서 allowlist를 직접 강제한다.

import type { UserConfig } from './user-config.js';
import { SLASH_COMMANDS } from './chat/index.js';
import type { DiscordBot, DcIncoming, DcMessageStreamer } from './discord.js';
import { makeCommandRest } from './discord/slash-registry.js';
import { normalizeInteractionPayload } from './discord/slash-router.js';
import type { SlashCommandSchema } from './discord/slash-types.js';
import { debug } from './debug/log.js';
import { gateDiscordSchemas, readBotAudience } from './maturity/bot-command-maturity.js';
import { buildBotSlashCatalog } from './maturity/bot-slash-catalog.js';
import { FEATURE_MATURITY } from './maturity/feature-maturity.js';
import { resolveChannelBotToken } from './channel-bot-token.js';

const REST_BASE = 'https://discord.com/api/v10';

/** C3 명령 세트 — 기존 텍스트 명령과 1:1. 옵션 값은 합성 문장의 인자로
 *  순서대로 이어붙는다 (`/cc prompt:빌드 고쳐줘` → `/cc 빌드 고쳐줘`). */
export const ELANOUS_SLASH_COMMANDS: readonly SlashCommandSchema[] = [
  { name: 'cc', description: 'Claude Code에 위임 (ACP 코딩 세션)', options: [
    { name: 'prompt', description: '지시문', type: 3, required: true },
    { name: 'file', description: '첨부 (이미지/문서 — 백엔드가 봄)', type: 11, required: false },
  ] },
  { name: 'cdx', description: 'Codex에 위임 (ACP 코딩 세션)', options: [
    { name: 'prompt', description: '지시문', type: 3, required: true },
    { name: 'file', description: '첨부 (이미지/문서 — 백엔드가 봄)', type: 11, required: false },
  ] },
  { name: 'gem', description: 'Gemini에 위임 (ACP 코딩 세션)', options: [
    { name: 'prompt', description: '지시문', type: 3, required: true },
    { name: 'file', description: '첨부 (이미지/문서 — 백엔드가 봄)', type: 11, required: false },
  ] },
  { name: 'brain', description: '브레인 모드로 복귀 (위임 해제)' },
  { name: 'now', description: '지금 판·칸·결정·자리·최근 맥락 보기', options: [
    { name: 'topic', description: '좁혀 볼 주제 (선택)', type: 3, required: false },
  ] },
  { name: 'sessions', description: '바인딩된 세션 목록' },
  { name: 'new', description: '새 세션으로 시작 (이전 대화 보존)' },
  { name: 'attach', description: '이 채널을 다른 세션에 연결', options: [
    { name: 'prefix', description: '세션 ID prefix', type: 3, required: true },
  ] },
  { name: 'fork', description: '현재 세션 포크 (타임트래블: before)', options: [
    { name: 'prefix', description: '포크할 세션 prefix (생략=현재)', type: 3, required: false },
    { name: 'before', description: 'N번째 사용자 발화 이전으로 (숫자)', type: 4, required: false },
  ] },
  { name: 'voice-join', description: '보이스 채널 참여', options: [
    { name: 'channel', description: '보이스 채널 ID (생략=자동)', type: 3, required: false },
  ] },
  { name: 'voice-leave', description: '보이스 채널 퇴장' },
  { name: 'voice-status', description: '보이스 연결 상태' },
] as const;

/** The native wire keeps its original schemas (including options); only new catalog
 * entries use the core registry's description and the unsupported response. */
export function discordWireCatalog() {
  return buildBotSlashCatalog({
    surface: 'discord', coreCommands: SLASH_COMMANDS, maturity: FEATURE_MATURITY,
    handledCommands: ELANOUS_SLASH_COMMANDS,
  });
}

/** SlashInteraction → 기존 텍스트 명령 문장 합성. */
export function synthesizeCommandText(
  commandName: string,
  options: ReadonlyMap<string, string | number | boolean>,
): string {
  switch (commandName) {
    case 'fork': {
      const parts = ['!fork'];
      const prefix = options.get('prefix');
      const before = options.get('before');
      if (typeof prefix === 'string' && prefix.trim()) parts.push(prefix.trim());
      if (before !== undefined) parts.push(`before:${before}`);
      return parts.join(' ');
    }
    case 'voice-join': {
      const ch = options.get('channel');
      return typeof ch === 'string' && ch.trim() ? `!voice-join ${ch.trim()}` : '!voice-join';
    }
    case 'voice-leave': return '!voice-leave';
    case 'voice-status': return '!voice-status';
    case 'sessions': return '!sessions';
    case 'now': {
      const topic = options.get('topic');
      return typeof topic === 'string' && topic.trim() ? `!now ${topic.trim()}` : '!now';
    }
    case 'new': return '!new';
    case 'attach': return `!attach ${String(options.get('prefix') ?? '').trim()}`;
    case 'brain': return '!brain';
    case 'cc': case 'cdx': case 'gem':
      return `!${commandName} ${String(options.get('prompt') ?? '').trim()}`;
    default:
      return `!${commandName}`;
  }
}

export interface DiscordSlashWireDeps {
  userConfig: UserConfig;
  /** The COMPOSED onMessage pipeline (voice dispatch → session cmds →
   *  delegation → self turn) — single source of command semantics. */
  handleMessage: (ctx: DcIncoming, streamer?: DcMessageStreamer) => Promise<string | void>;
  getBot: () => DiscordBot | null;
  allowedUsers: readonly string[];
  /** discord-test scope — only serve interactions from this channel. */
  channelScope?: string;
  log?: (msg: string) => void;
  __fetchImpl?: typeof fetch;
}

export interface DiscordSlashWire {
  /** Register the command set (guild-scoped — instant propagation).
   *  Discovers appId + guilds via REST. Idempotent (bulk overwrite). */
  registerCommands(): Promise<void>;
  /** Attach to DiscordBotOpts.onInteraction. */
  onInteraction(raw: Record<string, unknown>): Promise<void>;
}

export function buildDiscordSlashWire(deps: DiscordSlashWireDeps): DiscordSlashWire {
  const log = deps.log ?? ((m: string): void => { console.log(m); });
  const fetchImpl = deps.__fetchImpl ?? fetch;
  const token = resolveChannelBotToken('discord', deps.userConfig)?.token.trim() ?? '';

  async function registerCommands(): Promise<void> {
    if (!token) { log('[slash] no bot token — skip registration'); return; }
    const auth = { headers: { Authorization: `Bot ${token}` } };
    const app = await (await fetchImpl(`${REST_BASE}/applications/@me`, auth)).json() as { id?: string };
    if (!app.id) { log('[slash] application id unresolved — skip'); return; }
    const guilds = await (await fetchImpl(`${REST_BASE}/users/@me/guilds`, auth)).json() as Array<{ id: string }>;
    const rest = makeCommandRest({ token, ...(deps.__fetchImpl ? { fetchImpl: deps.__fetchImpl } : {}) });
    const audience = readBotAudience((deps.userConfig.raw?.discord as { commandAudience?: unknown } | undefined)?.commandAudience);
    const catalog = discordWireCatalog();
    const handled = new Map(ELANOUS_SLASH_COMMANDS.map((schema) => [schema.name, schema]));
    const allSchemas: SlashCommandSchema[] = catalog.commands.map((entry) => {
      const original = handled.get(entry.name);
      if (original) return original;
      const { name, description } = entry;
      return { name, description };
    });
    const { schemas, hidden } = gateDiscordSchemas(allSchemas, audience);
    debug.log('discord.command', 'menu-filtered', { total: allSchemas.length, shown: schemas.length - hidden, ...audience });
    for (const g of Array.isArray(guilds) ? guilds : []) {
      const registered = await rest.bulkOverwriteGuild(app.id, g.id, schemas);
      log(`[slash] registered ${registered.length} commands in guild ${g.id}`);
    }
  }

  async function ack(interactionId: string, interactionToken: string, content: string): Promise<void> {
    try {
      await fetchImpl(`${REST_BASE}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 4, data: { content } }),
      });
    } catch (err) {
      if (debug.enabled)
        debug.log('discord.slash', 'ack.failed', { err: String(err) }, { level: 'error' });
    }
  }

  /** ATTACHMENT(type 11) 옵션의 실체는 `data.resolved.attachments`에
   *  담겨 온다 — DcAttachment 형태로 정규화해 합성 ctx에 실으면 C2의
   *  downloadDcAttachments 경로가 그대로 처리한다 (/cc file:이미지). */
  function resolvedAttachments(raw: Record<string, unknown>): DcIncoming['attachments'] {
    const res = (raw.data as { resolved?: { attachments?: Record<string, unknown> } } | undefined)
      ?.resolved?.attachments;
    if (!res || typeof res !== 'object') return [];
    const out: DcIncoming['attachments'] = [];
    for (const v of Object.values(res)) {
      const a = v as { id?: unknown; filename?: unknown; size?: unknown; url?: unknown; content_type?: unknown; width?: unknown; height?: unknown };
      if (typeof a?.url !== 'string' || !a.url) continue;
      out.push({
        id: String(a.id ?? ''),
        filename: typeof a.filename === 'string' ? a.filename : 'file',
        size: typeof a.size === 'number' ? a.size : 0,
        url: a.url,
        ...(typeof a.content_type === 'string' ? { contentType: a.content_type } : {}),
        ...(typeof a.width === 'number' ? { width: a.width } : {}),
        ...(typeof a.height === 'number' ? { height: a.height } : {}),
      });
    }
    return out;
  }

  async function onInteraction(raw: Record<string, unknown>): Promise<void> {
    const it = normalizeInteractionPayload(raw);
    if (!it) return;
    // Allowlist — interactions bypass the bot's message gates.
    if (!deps.allowedUsers.includes(it.userId)) {
      await ack(it.id, it.token, '⛔ 허용되지 않은 사용자입니다.');
      return;
    }
    if (deps.channelScope && it.channelId !== deps.channelScope) {
      await ack(it.id, it.token, `이 봇은 <#${deps.channelScope}> 채널 전용입니다.`);
      return;
    }
    const unsupported = discordWireCatalog().unsupportedReply(it.commandName);
    if (unsupported) { await ack(it.id, it.token, unsupported); return; }
    const text = synthesizeCommandText(it.commandName, it.options);
    const attachments = resolvedAttachments(raw);
    await ack(it.id, it.token, `▶ \`${text}\`${attachments.length ? ` (+첨부 ${attachments.length})` : ''}`);
    const ctx: DcIncoming = {
      channelId: it.channelId,
      userId: it.userId,
      ...(it.userName ? { userName: it.userName } : {}),
      text,
      messageId: `slash-${it.id}`,
      isDm: !it.guildId,
      attachments,
      raw: it.guildId ? { guild_id: it.guildId } : {},
    } as DcIncoming;
    try {
      const reply = await deps.handleMessage(ctx);
      if (typeof reply === 'string' && reply.trim()) {
        await deps.getBot()?.sendMessage(it.channelId, reply);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[slash] ${it.commandName} failed: ${msg}`);
      try { await deps.getBot()?.sendMessage(it.channelId, `⚠️ /${it.commandName} 실패: ${msg}`); }
      catch { /* best-effort */ }
    }
  }

  return { registerCommands, onInteraction };
}
