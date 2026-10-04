import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';
import { recordWishBenchmarkSampleSafely } from './wish-benchmark-ledger.js';

export type WishReplyTarget =
  | { surface: 'telegram'; chatId: string; threadId?: string; botId?: string }
  | { surface: 'pwa'; sessionId: string }
  | { surface: 'linear'; issueId: string }
  | { surface: 'tui' };

/** `intake:reply:0` 섹션 꼴 — surface ⊕ 표면 안 주소(텔레그램 대화 · PWA 세션 · Linear 이슈 · TUI 없음). */
export function replySection(target: WishReplyTarget): { surface: WishReplyTarget['surface']; address: string | null } {
  switch (target.surface) {
    case 'telegram': return { surface: 'telegram', address: target.threadId ? `${target.chatId}:${target.threadId}` : target.chatId };
    case 'pwa': return { surface: 'pwa', address: target.sessionId };
    case 'linear': return { surface: 'linear', address: target.issueId };
    case 'tui': return { surface: 'tui', address: null };
  }
}

export type WishInput = {
  text: string;
  source: WishReplyTarget['surface'];
  ref: string;
  replyTo?: WishReplyTarget;
};

function replyTarget(input: WishInput): WishReplyTarget {
  if (input.replyTo) {
    if (input.replyTo.surface !== input.source) throw new Error('소원 출처와 회신 대상이 다릅니다');
    return input.replyTo;
  }
  switch (input.source) {
    case 'telegram': return { surface: 'telegram', chatId: input.ref.split(':', 1)[0]! };
    case 'pwa':
    case 'linear': throw new Error('소원 회신 대상을 명시하세요');
    case 'tui': return { surface: 'tui' };
  }
}

export function createWishCard(
  { text, source, ref, replyTo }: WishInput,
  store: CardStore = new CardStore(),
): { cardId: string; title: string; created: boolean } {
  const title = text.trim().split(/\r?\n/, 1)[0]!.trim().slice(0, 80);
  if (!title) throw new Error('소원 글을 입력하세요');
  if (!ref?.trim()) throw new Error('소원 참조가 필요합니다');
  const target = replyTarget({ text, source, ref, replyTo });
  if (target.surface === 'telegram' && !/^-?\d+$/.test(target.chatId)
    || target.surface === 'pwa' && !target.sessionId.trim()
    || target.surface === 'linear' && !target.issueId.trim()) throw new Error('소원 회신 대상이 필요합니다');
  const goalId = `wish:${source}:${ref}`;
  const old = store.listCards().find(card => card.goalId === goalId);
  const card = old ?? store.createCard({ goalId, title });
  const hasIntakeSection = card.sections.some(section => section.key === 'intake:wish:0');
  const created = !old && !hasIntakeSection;
  // A prior attempt may have created the card but stopped before writing its intake section. The card's first
  // title wins: a retry with the same ref but a different request must not put a contradicting body on it
  // (review must-fix) — keep the first title and record only that the retried text did not match.
  if (!hasIntakeSection) {
    const sameRequest = !old || title === card.title;
    store.appendSection(card.id, {
      key: 'intake:wish:0',
      owner: 'steward',
      content: JSON.stringify({
        source, ref, replyTo: target, title: card.title, text: sameRequest ? text : null, at: new Date().toISOString(),
        ...(old ? { recovered: true } : {}), ...(sameRequest ? {} : { mismatch: true }),
      }),
    });
    if (!sameRequest) debug.log('intake.wish', 'recovered-mismatch', { source, cardId: card.id });
  }
  // FLOW1 원장 약속(TC 21:15): 회신 주소를 `intake:reply:0 {surface, address}` 로도(원장 섹션 허용 목록상 `intake` 아래) 남긴다 — FLOW1a 는 이 꼴을 읽고
  // 보내기는 `sendCardReply(cardId, text)` 만 부른다(wish-reply.ts). 원천은 위 intake 섹션의 replyTo 그대로.
  if (!card.sections.some(section => section.key === 'intake:reply:0')) {
    store.appendSection(card.id, { key: 'intake:reply:0', owner: 'steward', content: JSON.stringify(replySection(target)) });
  }
  const originalIntake = store.getCard(card.id)?.sections.find(section => section.key === 'intake:wish:0');
  if (originalIntake) {
    const first = JSON.parse(originalIntake.content) as { source: WishInput['source']; text: string | null; at: string };
    if (first.text !== null) recordWishBenchmarkSampleSafely({ cardId: card.id, at: first.at, surface: first.source, text: first.text });
  }
  debug.log('intake.wish', created ? 'created' : 'duplicate', { source, cardId: card.id });
  return { cardId: card.id, title: card.title, created };
}
