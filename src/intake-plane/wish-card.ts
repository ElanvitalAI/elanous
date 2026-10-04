import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';

export function createWishCard(
  { text, source, ref }: { text: string; source: 'telegram' | 'pwa' | 'tui'; ref: string },
  store: CardStore = new CardStore(),
): { cardId: string; title: string; created: boolean } {
  const title = text.trim().split(/\r?\n/, 1)[0]!.trim().slice(0, 80);
  if (!title) throw new Error('소원 글을 입력하세요');
  if (!ref?.trim()) throw new Error('소원 참조가 필요합니다');
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
        source, ref, title: card.title, text: sameRequest ? text : null, at: new Date().toISOString(),
        ...(old ? { recovered: true } : {}), ...(sameRequest ? {} : { mismatch: true }),
      }),
    });
    if (!sameRequest) debug.log('intake.wish', 'recovered-mismatch', { source, cardId: card.id });
  }
  debug.log('intake.wish', created ? 'created' : 'duplicate', { source, cardId: card.id });
  return { cardId: card.id, title: card.title, created };
}
