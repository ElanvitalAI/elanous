// ── Telegram report channel — send-only outbound (multi-channel, 2026-07-05) ──
//
// elanous's Q&A bot (homeChannel) and the report channel can be served by
// DIFFERENT bots (e.g. a report bot that already owns the user's report
// chat). This module resolves the report target from config and sends to
// it — reusing TelegramBot's chunking / markdown→HTML machinery via an
// INERT instance (constructor does not poll; only `start()` would).
//
// Send-only by design: no getUpdates, no onMessage handling. It exists so
// reports (cron digests, autonomous-loop output, trading alerts) route to
// the report channel while interactive Q&A stays on the main bot.

import { TelegramBot } from './telegram.js';
import { isOperationalKind, kindRouteTarget, logKindRouteFallback, mainHomeTarget } from './domains/telegram-kind-route.js';
export { DEFAULT_KIND_ROLES, roleForKind } from './domains/telegram-kind-route.js';
import { resolveChannelBotToken } from './channel-bot-token.js';
import type { UserConfig } from './user-config.js';
import { findSessionByTelegramChat, createSession, appendMessage } from './session/index.js';

/** Cross-surface memory — mirror an outbound report/alert into the
 *  RECEIVING channel's session transcript so a follow-up question in that
 *  same chat ("why did the regime change?") has the alert as context.
 *  Without this the alert lives only in surface_events (session_id NULL)
 *  and the follow-up answers from the session transcript, which — for the
 *  report bot — would otherwise be empty or (pre-multi-channel) the wrong,
 *  contaminated session. Bot-SCOPED via botId so it lands in the report
 *  channel's own session, never the default Q&A channel's. fail-soft:
 *  mirroring must never break delivery. */
function mirrorOutboundToSession(target: ReportTarget, text: string): void {
  try {
    const botId = target.botToken.split(':')[0] || undefined;
    let sess = findSessionByTelegramChat(target.chatId, undefined, botId);
    if (!sess) {
      sess = createSession({
        source: 'telegram', sourceKind: 'telegram',
        tgChatId: target.chatId, tgBotId: botId, title: `tg:${target.chatId}`,
      });
    }
    // Truncate — reports can be long; a bounded record is enough for
    // recall without ballooning the next turn's loaded history.
    appendMessage(sess.id, {
      role: 'assistant',
      content: text.length > 2000 ? text.slice(0, 2000) + '…' : text,
      ts: new Date().toISOString(),
    });
  } catch { /* fail-soft */ }
}

export interface ReportTarget {
  botToken: string;
  chatId: number;
}

/** Explicit role channels win. Without a role channel, operational kinds use the main bot's
 *  home when the legacy report channel uses another bot; same-bot reports and trading kinds
 *  keep the legacy report destination. Returns null when no safe target is configured. */
export function resolveReportTarget(cfg: UserConfig, kind?: string): ReportTarget | null {
  const routed = kindRouteTarget(cfg, kind);
  if (routed) return routed;
  const rc = cfg.telegram.reportChannel;
  const mainToken = resolveChannelBotToken('telegram', cfg).token;
  const sameBot = !!mainToken && !!rc && (rc.botToken ?? mainToken) === mainToken;
  if (isOperationalKind(kind) && !sameBot) {
    const home = mainHomeTarget(cfg);
    logKindRouteFallback(kind, home ? 'main-home' : 'none', sameBot);
    return home;
  }
  const botToken = rc?.botToken ?? mainToken;
  const target = rc && Number.isFinite(rc.chatId) && botToken ? { botToken, chatId: rc.chatId } : null;
  logKindRouteFallback(kind, target ? 'report-channel' : 'none', sameBot);
  return target;
}

export interface SendReportOpts {
  /** Render `text` as markdown → Telegram HTML. Default true (reports
   *  are formatted digests). */
  markdown?: boolean;
  /** DI seam for tests — passed through to the send-only TelegramBot. */
  fetchImpl?: typeof fetch;
  /** Purpose of the message — routes to a channel role (see `DEFAULT_KIND_ROLES`). */
  kind?: string;
}

/** Send a report to the configured report channel. Returns false (a
 *  no-op, never throws) when no report channel is configured, so callers
 *  can fire-and-forget without gating on config. Throws only on an actual
 *  Telegram API failure once a target exists. */
export async function sendTelegramReport(
  cfg: UserConfig,
  text: string,
  opts: SendReportOpts = {},
): Promise<boolean> {
  const target = resolveReportTarget(cfg, opts.kind);
  if (!target || !text) return false;
  const bot = new TelegramBot({
    token: target.botToken,
    allowedUsers: [],
    onMessage: async () => undefined,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  await bot.sendMessage(target.chatId, text, { markdown: opts.markdown ?? true });
  // Mirror into the report channel's session so a follow-up question in
  // that chat can recall this alert (Fix — was surface_events-only).
  mirrorOutboundToSession(target, text);
  return true;
}

/** Send a photo (URL) to the report channel — inert send-only bot(sendMessage 와
 *  동일 구성). No-op false when unconfigured. Throws only on API failure. A2. */
export async function sendReportPhoto(
  cfg: UserConfig,
  photoUrl: string,
  opts: { caption?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const target = resolveReportTarget(cfg);
  if (!target || !photoUrl) return false;
  const bot = new TelegramBot({
    token: target.botToken,
    allowedUsers: [],
    onMessage: async () => undefined,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  await bot.sendPhoto(target.chatId, photoUrl, opts.caption ? { caption: opts.caption } : {});
  return true;
}

/** Send a locally-rendered PNG buffer to the report channel via
 *  TelegramBot.sendPhotoBuffer(chatId, png, { caption }). No-op false when
 *  unconfigured. sendPhotoBuffer is itself fail-soft (undefined on API
 *  failure) — this adapter surfaces that as boolean. */
export async function sendReportPhotoBuffer(
  cfg: UserConfig,
  png: Buffer,
  opts: { caption?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const target = resolveReportTarget(cfg);
  if (!target || !png) return false;
  const bot = new TelegramBot({
    token: target.botToken,
    allowedUsers: [],
    onMessage: async () => undefined,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const result = await bot.sendPhotoBuffer(
    target.chatId,
    png,
    opts.caption ? { caption: opts.caption } : {},
  );
  return result != null;
}
