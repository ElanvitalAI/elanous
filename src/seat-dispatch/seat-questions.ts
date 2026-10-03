import { join } from 'node:path';
import { openMsgStore, type Message } from '../msg/msg-store.js';

export const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
export type SeatId = typeof SEATS[number];

export function isSeatId(value: string): value is SeatId {
  return SEATS.some((seat) => seat === value);
}

function storeAt(root: string) { return openMsgStore(join(root, 'msg', 'messages.db')); }

// Keep the delivery receipt in the same SQLite transaction as the inbox message.
// An interrupted sender can retry without producing a second delivery.
function deliverOnce(root: string, key: string, envelope: { from: SeatId; to: SeatId; body: string; kind: string }): Message {
  const store = storeAt(root);
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS seat_dispatch_receipts (
      key TEXT PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE
    )`);
    return store.db.transaction(() => {
      const prior = store.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.created_at
        FROM seat_dispatch_receipts r JOIN msg_messages m ON m.id = r.message_id WHERE r.key = ?`)
        .get(key) as { id: number; sender: string; recipient: string; body: string; kind: string; created_at: string } | null;
      if (prior) {
        if (prior.sender !== envelope.from || prior.recipient !== envelope.to || prior.kind !== envelope.kind || prior.body !== envelope.body) {
          throw new Error('seat delivery retry changed its recorded message');
        }
        return { id: prior.id, from: prior.sender, to: prior.recipient, body: prior.body, kind: prior.kind, createdAt: prior.created_at };
      }
      const message = store.append(envelope);
      store.db.query('INSERT INTO seat_dispatch_receipts(key, message_id) VALUES (?, ?)').run(key, message.id);
      return message;
    })();
  } finally { store.close(); }
}

/** The message id is the durable correlation key; the caller's seat ledger records it as handled. */
export function askSeat(root: string, from: SeatId, to: SeatId, question: string, deliveryKey?: string): Message {
  if (from === to || !question.trim()) throw new Error('seat question requires another seat and nonempty text');
  const envelope = { from, to, body: question.trim(), kind: 'seat-question' };
  if (deliveryKey) return deliverOnce(root, deliveryKey, envelope);
  const store = storeAt(root);
  try { return store.append(envelope); }
  finally { store.close(); }
}

export function deliveredSeatQuestion(root: string, key: string): Message | null {
  const store = storeAt(root);
  try {
    const row = store.db.query(`SELECT m.id, m.sender, m.recipient, m.body, m.kind, m.created_at
      FROM seat_dispatch_receipts r JOIN msg_messages m ON m.id = r.message_id WHERE r.key = ?`)
      .get(key) as { id: number; sender: SeatId; recipient: SeatId; body: string; kind: string; created_at: string } | null;
    return row ? { id: row.id, from: row.sender, to: row.recipient, body: row.body, kind: row.kind, createdAt: row.created_at } : null;
  } catch (error) {
    if (String(error).includes('no such table: seat_dispatch_receipts')) return null;
    throw error;
  } finally { store.close(); }
}

export function seatQuestions(root: string, seat: SeatId): Message[] {
  const store = storeAt(root);
  try {
    const found: Message[] = [];
    let cursor = 0;
    while (true) {
      const batch = store.listByRecipient(seat, cursor, 1000);
      found.push(...batch.filter((message) => message.kind === 'seat-question' && isSeatId(message.from) && message.from !== seat));
      if (batch.length < 1000) break;
      cursor = batch[batch.length - 1]!.id;
    }
    return found;
  } finally { store.close(); }
}

export function answerSeat(root: string, question: Message, answer: string): Message {
  if (question.kind !== 'seat-question' || !isSeatId(question.to) || !isSeatId(question.from) || !answer.trim()) {
    throw new Error('invalid seat answer');
  }
  return deliverOnce(root, `answer:${question.id}`, {
    from: question.to, to: question.from, body: JSON.stringify({ questionId: question.id, answer: answer.trim() }), kind: 'seat-answer',
  });
}

export function hasSeatAnswer(root: string, question: Message): boolean {
  const store = storeAt(root);
  try {
    let cursor = 0;
    while (true) {
      const batch = store.listByRecipient(question.from, cursor, 1000);
      for (const message of batch) {
        if (message.kind !== 'seat-answer' || message.from !== question.to) continue;
        try { if ((JSON.parse(message.body) as { questionId?: unknown }).questionId === question.id) return true; }
        catch { /* unrelated malformed message */ }
      }
      if (batch.length < 1000) return false;
      cursor = batch[batch.length - 1]!.id;
    }
  } finally { store.close(); }
}
