// DEC-TG — 텔레그램 운반(운영 봇 DM). 판단은 decision-cards.ts 에 있고 여기는 «보내고·고치고·누름을 넘긴다»만 한다.
// ⛔ 카드는 «폴링하는» 본 봇만 보낸다(넥서스가 폴링 없는 봇을 따로 세울 수 있다 — 두 번 가면 안 된다).
import type { TelegramBot, TgCallbackQuery } from '../telegram.js';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { DECISION_DATA_PREFIX, DecisionCardService, ghPrReplier, type CardTransport, type CardView } from './decision-cards.js';

const TICK_MS = 20_000;
let current: DecisionCardService | null = null;

/** The running Telegram card service (for the `/decisions` command), or null when none is attached. */
export function telegramDecisionService(): DecisionCardService | null { return current; }

function buttons(view: CardView): Array<Array<{ text: string; data: string }>> {
  return view.buttons.map((row) => row.map((b) => ({ text: b.label, data: b.data })));
}

/** Owner = `decisions.telegramOwnerId` when set, else the first allowlisted user (the bot owner). */
export function telegramDecisionOwner(cfg: UserConfig): string | null {
  const raw = (cfg.raw?.decisions as { telegramOwnerId?: unknown } | undefined)?.telegramOwnerId;
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
    debug.log('decisions.telegram', 'owner-source', { platform: 'telegram', source: 'config' });
    return String(raw);
  }
  const first = cfg.telegram.allowedUsers[0];
  debug.log('decisions.telegram', 'owner-source', { platform: 'telegram', source: 'default-first', allowlist: cfg.telegram.allowedUsers.length }, cfg.telegram.allowedUsers.length > 1 ? { level: 'warn' } : undefined);
  return typeof first === 'number' ? String(first) : null;
}

export function telegramTransport(bot: Pick<TelegramBot, 'sendInlineKeyboard' | 'editMessageWithKeyboard' | 'sendMessage'>, owner: string): CardTransport {
  return {
    platform: 'telegram',
    ownerChats: async () => [owner],
    send: async (chat, view) => {
      const sent = await bot.sendInlineKeyboard(Number(chat), view.text, buttons(view));
      return sent ? { chat, message: String(sent.messageId) } : null;
    },
    edit: async (ref, view) => { await bot.editMessageWithKeyboard(Number(ref.chat), Number(ref.message), view.text, buttons(view)); },
    notify: async (chat, text) => { await bot.sendMessage(Number(chat), text); },
  };
}

export interface AttachOptions { tickMs?: number; service?: DecisionCardService }

/** Wire cards onto a bot: callback taps, memo capture, and a ticker that runs only while this bot polls. Returns a stop fn. */
export function attachTelegramDecisionCards(bot: TelegramBot, cfg: UserConfig, opts: AttachOptions = {}): () => void {
  const owner = telegramDecisionOwner(cfg);
  if (!owner) {
    debug.log('decisions.telegram', 'not-attached', { platform: 'telegram', reason: 'no-owner' });
    return () => undefined;
  }
  const replyTarget = (cfg.raw?.decisions as { replyGhPr?: unknown } | undefined)?.replyGhPr;
  const service = opts.service ?? new DecisionCardService({
    transport: telegramTransport(bot, owner),
    ownerIds: [owner],
    ...(typeof replyTarget === 'string' && replyTarget ? { replyToRaiser: ghPrReplier(replyTarget) } : {}),
  });
  current = service;
  const unsubscribe = bot.onCallbackQuery(async (q: TgCallbackQuery) => {
    if (!q.data.startsWith(DECISION_DATA_PREFIX)) return;
    const outcome = await service.tap(String(q.userId), q.data);
    const where = q.chatId !== undefined && q.messageId !== undefined ? { chat: q.chatId, message: q.messageId } : null;
    switch (outcome.kind) {
      case 'refused': await bot.answerCallbackQuery(q.id, { text: '권한이 없습니다' }); return;
      case 'ignored': case 'unknown': await bot.answerCallbackQuery(q.id, { text: '알 수 없는 결정입니다' }); return;
      case 'memo-requested': {
        // The next text in a GROUP could come from another allow-listed member — capture only in the owner's private chat.
        if (q.chatId === undefined || q.chatId !== q.userId) {
          debug.log('decisions.telegram', 'memo-refused', { platform: 'telegram', reason: 'not-private-chat' });
          await bot.answerCallbackQuery(q.id, { text: '메모는 개인 대화에서만 달 수 있습니다' });
          return;
        }
        await bot.answerCallbackQuery(q.id, { text: outcome.toast });
        {
          const id = /^dec:([^:]+):memo$/.exec(q.data)?.[1];
          await bot.sendMessage(q.chatId, `📝 ${id} 메모를 한 줄로 보내 주세요(취소: /cancel).`);
          bot.captureNextText(q.chatId, undefined, (text) => {
            if (text && id) void service.setNote(String(q.userId), id, text).then((view) => {
              if (view && q.chatId !== undefined) void bot.sendMessage(q.chatId, '메모를 달았습니다 — 카드에서 선택지를 누르면 함께 기록됩니다.');
            });
          });
        }
        return;
      }
      default:
        await bot.answerCallbackQuery(q.id, { text: outcome.toast, ...(outcome.kind === 'confirm' ? { alert: true } : {}) });
        // decided: the service already edited every card it sent; confirm/cancel/closed: edit the tapped one.
        if (outcome.kind !== 'decided' && where) await bot.editMessageWithKeyboard(where.chat, where.message, outcome.view.text, buttons(outcome.view)).catch(() => undefined);
    }
  });
  const timer = setInterval(() => {
    if (!bot.isPolling()) return;
    void service.tick().catch((error: unknown) => {
      debug.log('decisions.telegram', 'tick-failed', { reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }, { level: 'warn' });
    });
  }, opts.tickMs ?? TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  debug.log('decisions.telegram', 'attached', { platform: 'telegram', reply: typeof replyTarget === 'string' && Boolean(replyTarget) });
  return () => { clearInterval(timer); unsubscribe(); if (current === service) current = null; };
}
