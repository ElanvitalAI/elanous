import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { loadSession } from '../session/index.js';
import { createWishCard } from './wish-card.js';
import { replyToWishCard, type WishReplySinks } from './wish-reply.js';

const roots: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('card id + line routes to the persisted Telegram chat/thread, PWA session and Linear issue; TUI sends nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-replies-'));
  roots.push(root);
  const store = new CardStore(root);
  const calls: unknown[] = [];
  const sinks: WishReplySinks = {
    telegram: async (target, text) => { calls.push(['telegram', target, text]); },
    pwa: async (id, text) => { calls.push(['pwa', id, text]); },
    linear: async (id, text) => { calls.push(['linear', id, text]); },
  };
  try {
    const tg = createWishCard({ text: 'tg', source: 'telegram', ref: '42:9', replyTo: { surface: 'telegram', chatId: '42', threadId: '3', botId: 'bot-1' } }, store);
    const pwa = createWishCard({ text: 'web', source: 'pwa', ref: 'request-1', replyTo: { surface: 'pwa', sessionId: 'session-1' } }, store);
    const linear = createWishCard({ text: 'issue', source: 'linear', ref: 'UX-1', replyTo: { surface: 'linear', issueId: 'issue-uuid' } }, store);
    const tui = createWishCard({ text: 'terminal', source: 'tui', ref: 'cli-1' }, store);
    await replyToWishCard(tg.cardId, '곧 확인합니다', store, sinks);
    await replyToWishCard(pwa.cardId, '접수됐습니다', store, sinks);
    await replyToWishCard(linear.cardId, '반영했습니다', store, sinks);
    await replyToWishCard(tui.cardId, '전달하지 않음', store, sinks);
    expect(calls).toEqual([
      ['telegram', { surface: 'telegram', chatId: '42', threadId: '3', botId: 'bot-1' }, '곧 확인합니다'],
      ['pwa', 'session-1', '접수됐습니다'],
      ['linear', 'issue-uuid', '반영했습니다'],
    ]);
    await expect(replyToWishCard('missing', '한 줄', store, sinks)).rejects.toThrow('소원 카드를 찾을 수 없습니다');
    await expect(replyToWishCard(tg.cardId, '두\n줄', store, sinks)).rejects.toThrow('회신은 한 줄');
  } finally { store.close(); }
});

test('default PWA sink writes the reply into the named conversation session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-pwa-reply-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  try {
    const { cardId } = createWishCard({ text: 'PWA 요청', source: 'pwa', ref: 'request-2', replyTo: { surface: 'pwa', sessionId: 'web-session-2' } }, store);
    await replyToWishCard(cardId, '작업 카드가 만들어졌습니다', store);
    expect(loadSession('web-session-2')?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'assistant', content: '작업 카드가 만들어졌습니다' },
    ]);
  } finally { store.close(); }
});
