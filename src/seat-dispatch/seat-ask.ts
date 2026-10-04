import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { dispatchCeoTask, type CeoCommandDeps } from './ceo-commands.js';
import type { SeatId } from './seat-questions.js';

export type AskOrigin =
  | { channel: 'telegram'; chatId: number | string; messageId: number; threadId?: number; botId?: string }
  | { channel: 'discord'; channelId: string; messageId: string; threadId?: string }
  | { channel: 'pwa'; clientId: string }
  | { channel: 'tui'; clientId: string };

export const DEFAULT_ASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const parseSeatAsk = (text: string): string | null => /^\s*CTO\s*에게\s*물어봐(?:\s*[:：]\s*|\s+)(\S[\s\S]*)$/i.exec(text)?.[1]?.trim() ?? null;

interface AskRow { id: string; seat: string; origin: string; deadline: number; timeout_minutes: number; answer: string | null; answered_at: number | null }

function createTable(store: MsgStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS seat_asks (
    id TEXT PRIMARY KEY, seat TEXT NOT NULL, origin TEXT NOT NULL,
    deadline INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL DEFAULT 120, status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT, answered_at INTEGER
  ); CREATE TABLE IF NOT EXISTS seat_ask_outbox (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    claim_until INTEGER NOT NULL DEFAULT 0, claim_token TEXT
  )`);
  const askColumns = store.db.query('PRAGMA table_info(seat_asks)').all() as Array<{ name: string }>;
  if (!askColumns.some(({ name }) => name === 'answer')) store.db.exec('ALTER TABLE seat_asks ADD COLUMN answer TEXT');
  if (!askColumns.some(({ name }) => name === 'answered_at')) store.db.exec('ALTER TABLE seat_asks ADD COLUMN answered_at INTEGER');
  const columns = store.db.query('PRAGMA table_info(seat_ask_outbox)').all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'claim_until')) store.db.exec('ALTER TABLE seat_ask_outbox ADD COLUMN claim_until INTEGER NOT NULL DEFAULT 0');
  if (!columns.some(({ name }) => name === 'claim_token')) store.db.exec('ALTER TABLE seat_ask_outbox ADD COLUMN claim_token TEXT');
}

export interface SeatAskShadow {
  from: SeatId;
  to: SeatId;
  itemId: string;
  version: string;
  question: string;
}

/** Keep an internal seat-to-seat question in the existing ask ledger, without dispatching or queuing an outbox message. */
export function recordSeatAskShadow(root: string, ask: SeatAskShadow, now: number): boolean {
  if (ask.from === ask.to || !ask.itemId || !ask.question.trim() || !Number.isFinite(now)) throw new Error('invalid shadow seat ask');
  const id = `seat-loop:${createHash('sha256').update(JSON.stringify([ask.from, ask.to, ask.version, ask.itemId])).digest('hex')}`;
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try {
    createTable(store);
    const origin = JSON.stringify({ channel: 'seat-loop', from: ask.from, itemId: ask.itemId, version: ask.version, question: ask.question.trim() });
    return store.db.query("INSERT OR IGNORE INTO seat_asks (id, seat, origin, deadline, timeout_minutes, status) VALUES (?, ?, ?, ?, ?, 'shadow')")
      .run(id, ask.to, origin, now + DEFAULT_ASK_TIMEOUT_MS, Math.ceil(DEFAULT_ASK_TIMEOUT_MS / 60000)).changes === 1;
  } finally { store.close(); }
}

/** A TUI restart must keep the same return address as its prior questions. The instance's
 * message database owns this identity, so test and production instances cannot share it. */
export function getTuiSeatAskClientId(open: () => MsgStore = openMsgStore): string {
  const store = open();
  try {
    store.db.exec('CREATE TABLE IF NOT EXISTS seat_ask_clients (channel TEXT PRIMARY KEY, client_id TEXT NOT NULL)');
    store.db.query('INSERT OR IGNORE INTO seat_ask_clients (channel, client_id) VALUES (?, ?)').run('tui', randomUUID());
    return (store.db.query('SELECT client_id FROM seat_ask_clients WHERE channel = ?').get('tui') as { client_id: string }).client_id;
  } finally { store.close(); }
}

export interface SeatAskDeps {
  open?: () => MsgStore;
  now?: () => number;
  timeoutMs?: number;
  dispatch?: typeof dispatchCeoTask;
  send: (origin: AskOrigin, text: string) => Promise<void>;
  channel?: AskOrigin['channel'];
  clientId?: string;
  botId?: string;
}

/** Persist the return address before delivering through the /cto channel and seat inbox. */
export async function askSeat(text: string, origin: AskOrigin, command: CeoCommandDeps, deps: SeatAskDeps): Promise<string> {
  const body = parseSeatAsk(text);
  if (!body) throw new Error('not a CTO ask');
  const id = randomUUID();
  const timeout = deps.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('invalid seat ask timeout');
  const minutes = Math.ceil(timeout / 60000);
  const store = (deps.open ?? openMsgStore)();
  try {
    createTable(store);
    store.db.query('INSERT INTO seat_asks (id, seat, origin, deadline, timeout_minutes, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'TC', JSON.stringify(origin), (deps.now ?? Date.now)() + timeout, minutes, 'pending');
  } finally { store.close(); }
  try {
    const result = await (deps.dispatch ?? dispatchCeoTask)('TC', `질문: ${body}\n답장 요청: ${id}\n회신: elanous seat answer ${id} "<답>"`, command,
      { via: origin.channel, ref: `ask:${id}` });
    debug.log('seat.ask', 'sent', { seat: 'TC', id, via: origin.channel, channel: result.channel });
    return `CTO에게 물었습니다. 답을 기다립니다 (최대 ${minutes}분). 요청: ${id}${result.channel === 'failed' ? ` · 조율 채널 전송 실패: ${result.channelError}` : ''}`;
  } catch (error) {
    const failed = (deps.open ?? openMsgStore)();
    try { createTable(failed); failed.db.query('DELETE FROM seat_asks WHERE id = ?').run(id); }
    finally { failed.close(); }
    throw error;
  }
}

/** Record a seat reply in its original request row; delivery stays with the originating surface's worker. */
export function answerSeatAsk(id: string, text: string, deps: Pick<SeatAskDeps, 'open' | 'now'> = {}): void {
  const answer = text.trim();
  if (!answer) throw new Error('seat answer must not be empty');
  const store = (deps.open ?? openMsgStore)();
  try {
    createTable(store);
    const now = (deps.now ?? Date.now)();
    const updated = store.db.query(`UPDATE seat_asks SET answer = ?, answered_at = ?
      WHERE id = ? AND seat = 'TC' AND status = 'pending' AND answer IS NULL AND deadline > ?`)
      .run(answer, now, id, now);
    if (updated.changes !== 1) throw new Error(`seat ask not pending or deadline passed: ${id}`);
    debug.log('seat.ask', 'reply-recorded', { seat: 'TC', id });
  } finally { store.close(); }
}

/** Deliver recorded seat answers or expiration notices via the original surface. */
export async function deliverSeatAnswers(deps: SeatAskDeps): Promise<void> {
  const store = (deps.open ?? openMsgStore)();
  try {
    createTable(store);
    const pending = store.db.query("SELECT id, seat, origin, deadline, timeout_minutes, answer, answered_at FROM seat_asks WHERE status = 'pending'").all() as AskRow[];
    const decide = store.db.transaction((id: string, now: number): 'answered' | 'expired' | null => {
      const ask = store.db.query("SELECT id, seat, origin, deadline, timeout_minutes, answer, answered_at FROM seat_asks WHERE id = ? AND status = 'pending'").get(id) as AskRow | null;
      if (!ask) return null;
      // Retain compatibility with replies already posted to the existing seat mailbox.
      const reply = ask.answer === null ? store.db.query("SELECT id, body, created_at FROM msg_messages WHERE recipient = 'CEO' AND kind = 'seat-ask-reply' AND substr(body, 1, ?) = ? AND sender = ? ORDER BY id LIMIT 1")
        .get(id.length + 2, `${id}: `, ask.seat) as { id: number; body: string; created_at: string } | null : null;
      const answer = ask.answer !== null && ask.answered_at !== null && ask.answered_at < ask.deadline ? ask.answer
        : reply && Date.parse(reply.created_at) < ask.deadline ? reply.body.slice(id.length + 2).trim() : '';
      const status = answer ? 'answered' : now >= ask.deadline ? 'expired' : null;
      if (!status) return null;
      const text = status === 'answered' ? `CTO 답변 (${id}): ${answer}`
        : `CTO 미답 (${id}): 아직 답 없음 (${ask.timeout_minutes}분 경과).`;
      const updated = store.db.query("UPDATE seat_asks SET status = ? WHERE id = ? AND status = 'pending'").run(status, id);
      if (updated.changes !== 1) return null;
      store.db.query('INSERT INTO seat_ask_outbox (id, origin, text) VALUES (?, ?, ?)').run(id, ask.origin, text);
      return status;
    });
    for (const ask of pending) {
      const origin = JSON.parse(ask.origin) as AskOrigin;
      if (deps.channel && origin.channel !== deps.channel) continue;
      if ((origin.channel === 'pwa' || origin.channel === 'tui') && deps.clientId !== origin.clientId) continue;
      if (origin.channel === 'telegram' && origin.botId && origin.botId !== deps.botId) continue;
      const status = decide(ask.id, (deps.now ?? Date.now)());
      if (status) debug.log('seat.ask', status, { seat: ask.seat, id: ask.id, via: origin.channel });
    }
    const outbox = store.db.query("SELECT id, origin, text FROM seat_ask_outbox WHERE status = 'pending'").all() as Array<{ id: string; origin: string; text: string }>;
    for (const item of outbox) {
      const origin = JSON.parse(item.origin) as AskOrigin;
      if (deps.channel && origin.channel !== deps.channel) continue;
      if (origin.channel === 'telegram' && origin.botId && origin.botId !== deps.botId) continue;
      if (origin.channel === 'pwa') {
        if (deps.clientId === origin.clientId) await deps.send(origin, item.text);
        continue; // A browser poll is not a receipt; only its explicit acknowledgement consumes the answer.
      }
      if (origin.channel === 'tui' && deps.clientId !== origin.clientId) continue;
      const token = randomUUID();
      const now = Date.now();
      // SQLite's conditional write is the claim across concurrent bot loops and processes.
      const claimed = store.db.query(`UPDATE seat_ask_outbox SET claim_until = ?, claim_token = ?
        WHERE id = ? AND status = 'pending' AND claim_until <= ?`).run(now + 5 * 60_000, token, item.id, now);
      if (claimed.changes !== 1) continue;
      try {
        await deps.send(origin, item.text);
        store.db.query("UPDATE seat_ask_outbox SET status = 'sent', claim_token = NULL WHERE id = ? AND claim_token = ?").run(item.id, token);
      } catch (error) {
        store.db.query('UPDATE seat_ask_outbox SET claim_until = 0, claim_token = NULL WHERE id = ? AND claim_token = ?').run(item.id, token);
        throw error;
      }
    }
  } finally { store.close(); }
}

/** Confirm only this browser's displayed answers; polling alone never removes them. */
export function acknowledgeSeatAnswers(clientId: string, ids: string[], open: () => MsgStore = openMsgStore): void {
  const store = open();
  try {
    createTable(store);
    const ack = store.db.query("UPDATE seat_ask_outbox SET status = 'sent' WHERE id = ? AND origin = ? AND status = 'pending'");
    for (const id of ids) ack.run(id, JSON.stringify({ channel: 'pwa', clientId }));
  } finally { store.close(); }
}
