import { debug } from '../debug/log.js';
import { listSubscriptions } from '../web-push/subscriptions.js';
import { sendPushToAll } from '../web-push/sender.js';
import { isIrreversible, type CardTransport, type CardView } from './decision-cards.js';
import { DecisionLedger, type DecisionEntry } from './decision-ledger.js';

/** How close a deadline must be for an otherwise reversible decision to ring the phone. */
export const WEB_PUSH_URGENT_WINDOW_MS = 24 * 3600_000;

export type WebPushUrgency = 'irreversible' | 'due-soon' | 'not-urgent' | 'due-unreadable';

/** Web push rings only for urgent decisions; an unreadable deadline is its own value (fail open, never folded into not-urgent). */
export function webPushUrgency(entry: DecisionEntry, now: Date): WebPushUrgency {
  if (isIrreversible(entry)) return 'irreversible';
  if (entry.dueAt !== undefined) {
    const due = Date.parse(entry.dueAt);
    if (!Number.isFinite(due)) return 'due-unreadable';
    if (due - now.getTime() <= WEB_PUSH_URGENT_WINDOW_MS) return 'due-soon';
  }
  return 'not-urgent';
}

const ID_IN_CARD = /^🗳 결정 요청 (D-\d{8}-\d+)(?: ·|\n)/;
const ID_IN_REMINDER = /^⏰ 기한 2시간 전 — (D-\d{8}-\d+) /;
const TITLE_LIMIT = 60;

export function webPushDecisionTransport(
  ledger: DecisionLedger,
  deps: { subscriptions?: typeof listSubscriptions; push?: typeof sendPushToAll } = {},
): CardTransport {
  const subscriptions = deps.subscriptions ?? listSubscriptions;
  const push = deps.push ?? sendPushToAll;
  const title = (prefix: string, name: string) => prefix + Array.from(name).slice(0, TITLE_LIMIT - Array.from(prefix).length).join('');
  const url = (id: string) => `/approvals?decision=${encodeURIComponent(id)}`;
  const tag = (id: string) => `decision-${id}`;
  return {
    platform: 'webpush',
    ownerChats: async () => subscriptions().length ? ['webpush'] : [],
    send: async (_chat, view: CardView) => {
      const id = ID_IN_CARD.exec(view.text)?.[1];
      if (!id || !subscriptions().length) return null;
      const entry = ledger.show(id);
      if (entry.status !== 'open') return null;
      const recommendation = 'skipped' in entry.recommendation ? '추천안 없음' : `추천안: ${entry.recommendation.option.toUpperCase()}`;
      const body = `${recommendation}${entry.dueAt ? ` · 기한: ${Number.isFinite(Date.parse(entry.dueAt)) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entry.dueAt)) : '읽을 수 없음'}` : ''}`;
      const result = await push({ title: title('대표 결정 · ', entry.title), body, url: url(id), tag: tag(id) });
      if (result.attempted) debug.log('decisions.webpush', 'card-sent', { id, delivered: result.delivered });
      return result.delivered ? { chat: 'webpush', message: id } : null;
    },
    edit: async (ref, _view) => {
      const id = ref.message;
      const entry = ledger.show(id);
      if (entry.status === 'open' || !subscriptions().length) return;
      const result = await push({ title: title('결정됨 · ', entry.title), url: url(id), tag: tag(id), data: { silent: true } });
      debug.log('decisions.webpush', 'card-closed', { id, delivered: result.delivered });
    },
    notify: async (_chat, text) => {
      const id = ID_IN_REMINDER.exec(text)?.[1];
      if (!id || !subscriptions().length) return;
      const entry = ledger.show(id);
      if (entry.status !== 'open') return;
      const result = await push({ title: title('기한 알림 · ', entry.title), body: `기한 2시간 전 · ${id}`, url: url(id), tag: tag(id) });
      debug.log('decisions.webpush', 'card-sent', { id, delivered: result.delivered });
    },
  };
}
