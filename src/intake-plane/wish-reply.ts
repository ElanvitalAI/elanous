import { commentLinearIssue } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { appendMessage, adoptSession } from '../session/index.js';
import { CardStore } from '../task-cards/card-store.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';
import { getUserConfig } from '../user-config.js';
import type { WishReplyTarget } from './wish-card.js';

export interface WishReplySinks {
  telegram: (target: Extract<WishReplyTarget, { surface: 'telegram' }>, text: string) => Promise<void>;
  pwa: (sessionId: string, text: string) => Promise<void>;
  linear: (issueId: string, text: string) => Promise<void>;
}

const defaultSinks: WishReplySinks = {
  telegram: async (target, text) => {
    const cfg = getUserConfig();
    const primary = resolveChannelBotToken('telegram', cfg).token;
    const token = !target.botId || primary.split(':')[0] === target.botId
      ? primary
      : cfg.telegram.channels?.find(channel => channel.botToken?.split(':')[0] === target.botId)?.botToken;
    if (!token) throw new Error('Telegram 회신 봇 토큰이 없습니다');
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target.chatId, text, ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}) }),
      });
    } catch {
      throw new Error('Telegram 회신 요청에 실패했습니다');
    }
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error('Telegram 회신에 실패했습니다');
  },
  pwa: async (sessionId, text) => {
    adoptSession(sessionId, { source: 'pwa', origin: 'pwa' });
    appendMessage(sessionId, { role: 'assistant', content: text, ts: new Date().toISOString() });
  },
  linear: async (issueId, text) => {
    const apiKey = await getSecretAsync('connector.linear.apiKey');
    if (!apiKey) throw new Error('Linear 키가 없습니다');
    await commentLinearIssue({ apiKey, issueId, body: text });
  },
};

/** A later workflow needs only the card id and one line; the original intake section owns the destination. */
export async function replyToWishCard(cardId: string, line: string, store?: CardStore, sinks: WishReplySinks = defaultSinks): Promise<void> {
  if (!line.trim() || line.includes('\n') || line.includes('\r')) throw new Error('회신은 한 줄이어야 합니다');
  const owned = !store;
  const cards = store ?? new CardStore();
  try {
    const card = cards.getCard(cardId);
    if (!card) throw new Error(`소원 카드를 찾을 수 없습니다: ${cardId}`);
    const section = card.sections.find(item => item.key === 'intake:wish:0');
    if (!section) throw new Error(`소원 회신 대상이 없습니다: ${cardId}`);
    const { replyTo } = JSON.parse(section.content) as { replyTo?: WishReplyTarget };
    if (!replyTo || typeof replyTo !== 'object' || !('surface' in replyTo)) throw new Error(`소원 회신 대상이 없습니다: ${cardId}`);
    switch (replyTo.surface) {
      case 'telegram': await sinks.telegram(replyTo, line); return;
      case 'pwa': await sinks.pwa(replyTo.sessionId, line); return;
      case 'linear': await sinks.linear(replyTo.issueId, line); return;
      case 'tui': return;
      default: throw new Error(`알 수 없는 소원 회신 대상: ${cardId}`);
    }
  } finally {
    if (owned) cards.close();
  }
}

/** FLOW1 원장 약속 이름(TC 21:15) — FLOW1a 가 동적 import 로 부른다. 동작은 replyToWishCard 와 같다. */
export async function sendCardReply(cardId: string, text: string): Promise<void> {
  return replyToWishCard(cardId, text);
}
