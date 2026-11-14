import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export interface ConcertConfig {
  eventTitle: string;
  eventDate: string;
  venue: string;
  seatCount: number;
  sampleFields?: string[];
}

type SeatRow = {
  id: string;
  status: 'free' | 'held' | 'sold';
  held_by: string | null;
  hold_expires_at: number | null;
  sold_to: string | null;
};

type OrderRow = { id: string; user_id: string; seat_ids_json: string };

export class TicketingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class TicketingStore {
  readonly db: Database;

  constructor(path: string, readonly config: ConcertConfig) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS concerts (id TEXT PRIMARY KEY, title TEXT NOT NULL, event_date TEXT NOT NULL, venue TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS seats (id TEXT PRIMARY KEY, concert_id TEXT NOT NULL REFERENCES concerts(id), status TEXT NOT NULL CHECK(status IN (\'free\',\'held\',\'sold\')), held_by TEXT, hold_expires_at INTEGER, sold_to TEXT)',
      'CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, concert_id TEXT NOT NULL REFERENCES concerts(id), user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, seat_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key))',
      'CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), seat_id TEXT NOT NULL UNIQUE REFERENCES seats(id), user_id TEXT NOT NULL)',
    ].join(';') + ';');
    try {
      this.db.transaction(() => {
        this.db.query('INSERT OR IGNORE INTO concerts VALUES (?, ?, ?, ?)').run(
          'demo-concert', config.eventTitle, config.eventDate, config.venue);
        this.db.query('UPDATE concerts SET title = ?, event_date = ?, venue = ? WHERE id = ?').run(
          config.eventTitle, config.eventDate, config.venue, 'demo-concert');
        // Source: a reduced configuration retires unsold seats but keeps issued tickets and their sold seat rows.
        this.db.query("DELETE FROM seats WHERE concert_id = ? AND status <> 'sold' AND CAST(substr(id, 6) AS INTEGER) > ?")
          .run('demo-concert', config.seatCount);
        const insert = this.db.query('INSERT OR IGNORE INTO seats (id, concert_id, status) VALUES (?, ?, ?)');
        for (let index = 1; index <= config.seatCount; index++) insert.run('s1-1-' + index, 'demo-concert', 'free');
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  concert(): object {
    return { id: 'demo-concert', title: this.config.eventTitle, date: this.config.eventDate,
      venue: this.config.venue, seatCount: this.config.seatCount,
      sampleFields: this.config.sampleFields ?? [] };
  }

  seats(): SeatRow[] {
    const now = Date.now();
    return (this.db.query('SELECT id, status, held_by, hold_expires_at, sold_to FROM seats WHERE concert_id = ? AND CAST(substr(id, 6) AS INTEGER) <= ? ORDER BY rowid')
      .all('demo-concert', this.config.seatCount) as SeatRow[])
      .map(seat => seat.status === 'held' && (seat.hold_expires_at ?? 0) <= now
        ? { ...seat, status: 'free', held_by: null, hold_expires_at: null } : seat);
  }

  hold(userId: string, seatIds: string[]): { seatIds: string[]; expiresAt: number } {
    const ids = validatedSeatIds(seatIds, this.config.seatCount);
    const expiresAt = Date.now() + 120_000;
    this.db.transaction(() => {
      for (const id of ids) {
        const seat = this.db.query('SELECT id, status, held_by, hold_expires_at, sold_to FROM seats WHERE id = ?').get(id) as SeatRow | null;
        if (!seat) throw new TicketingError(404, 'seat not found');
        if (seat.status === 'sold' || (seat.status === 'held' && (seat.hold_expires_at ?? 0) > Date.now() && seat.held_by !== userId))
          throw new TicketingError(409, 'seat unavailable');
      }
      const update = this.db.query('UPDATE seats SET status = ?, held_by = ?, hold_expires_at = ? WHERE id = ?');
      for (const id of ids) update.run('held', userId, expiresAt, id);
    }).immediate();
    return { seatIds: ids, expiresAt };
  }

  checkout(userId: string, seatIds: string[], idempotencyKey: string):
    { orderId: string; ticketIds: string[]; seatIds: string[]; syntheticPayment: true; replay: boolean } {
    const ids = validatedSeatIds(seatIds);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey))
      throw new TicketingError(400, 'valid Idempotency-Key required');
    return this.db.transaction(() => {
      const existing = this.db.query('SELECT id, user_id, seat_ids_json FROM orders WHERE user_id = ? AND idempotency_key = ?')
        .get(userId, idempotencyKey) as OrderRow | null;
      if (existing) {
        if (existing.seat_ids_json !== JSON.stringify(ids)) throw new TicketingError(409, 'idempotency key reused with different seats');
        const tickets = this.db.query('SELECT id FROM tickets WHERE order_id = ? ORDER BY seat_id').all(existing.id) as Array<{ id: string }>;
        return { orderId: existing.id, ticketIds: tickets.map(ticket => ticket.id), seatIds: ids,
          syntheticPayment: true as const, replay: true };
      }
      assertConfiguredSeatIds(ids, this.config.seatCount);
      for (const id of ids) {
        const seat = this.db.query('SELECT id, status, held_by, hold_expires_at, sold_to FROM seats WHERE id = ?').get(id) as SeatRow | null;
        if (!seat) throw new TicketingError(404, 'seat not found');
        if (seat.status !== 'held' || seat.held_by !== userId || (seat.hold_expires_at ?? 0) <= Date.now())
          throw new TicketingError(409, 'active hold required');
      }
      const orderId = randomUUID();
      this.db.query('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run(
        orderId, 'demo-concert', userId, idempotencyKey, JSON.stringify(ids), Date.now());
      const ticketIds: string[] = [];
      const insertTicket = this.db.query('INSERT INTO tickets VALUES (?, ?, ?, ?)');
      const sellSeat = this.db.query('UPDATE seats SET status = ?, held_by = NULL, hold_expires_at = NULL, sold_to = ? WHERE id = ?');
      for (const id of ids) {
        const ticketId = randomUUID();
        insertTicket.run(ticketId, orderId, id, userId);
        sellSeat.run('sold', userId, id);
        ticketIds.push(ticketId);
      }
      return { orderId, ticketIds, seatIds: ids, syntheticPayment: true as const, replay: false };
    }).immediate();
  }

  tickets(userId: string): Array<{ id: string; seatId: string; orderId: string }> {
    return (this.db.query('SELECT id, seat_id, order_id FROM tickets WHERE user_id = ? ORDER BY rowid')
      .all(userId) as Array<{ id: string; seat_id: string; order_id: string }>)
      .map(row => ({ id: row.id, seatId: row.seat_id, orderId: row.order_id }));
  }
}

function validatedSeatIds(value: unknown, seatCount?: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8
    || value.some(id => typeof id !== 'string' || !/^s1-1-[1-9][0-9]*$/u.test(id)))
    throw new TicketingError(400, 'seatIds must contain one through eight seat IDs');
  const ids = [...value].sort();
  if (new Set(ids).size !== ids.length) throw new TicketingError(400, 'duplicate seatIds');
  if (seatCount !== undefined) assertConfiguredSeatIds(ids, seatCount);
  return ids;
}

function assertConfiguredSeatIds(ids: string[], seatCount: number): void {
  if (ids.some(id => Number(id.slice(5)) > seatCount))
    throw new TicketingError(400, 'seatIds exceed configured seat count');
}
