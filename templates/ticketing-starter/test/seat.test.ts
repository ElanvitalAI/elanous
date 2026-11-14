import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { TicketingError, TicketingStore } from '../backend/db.js';

const config = { eventTitle: 'Test Concert', eventDate: '2027-04-18', venue: 'Hall', seatCount: 4 };

test('two users cannot sell the same seat; replay is stable across process restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ticketing-seat-'));
  const path = join(root, 'ticketing.sqlite');
  const first = new TicketingStore(path, config);
  try {
    expect(first.seats()).toHaveLength(4);
    expect(first.hold('user-a', ['s1-1-1']).seatIds).toEqual(['s1-1-1']);
    expect(() => first.hold('user-b', ['s1-1-1'])).toThrow(TicketingError);
    const issued = first.checkout('user-a', ['s1-1-1'], 'purchase-0001');
    expect(issued.replay).toBe(false);
    expect(issued.ticketIds).toHaveLength(1);
    expect(first.checkout('user-a', ['s1-1-1'], 'purchase-0001')).toMatchObject({
      orderId: issued.orderId, ticketIds: issued.ticketIds, replay: true,
    });
    expect(() => first.checkout('user-a', ['s1-1-2'], 'purchase-0001')).toThrow(TicketingError);
    expect(() => first.hold('user-b', ['s1-1-1'])).toThrow(TicketingError);
  } finally { first.close(); }
  const reopened = new TicketingStore(path, config);
  try {
    expect(reopened.tickets('user-a')).toHaveLength(1);
    expect(reopened.checkout('user-a', ['s1-1-1'], 'purchase-0001').orderId).toBe(
      reopened.tickets('user-a')[0]!.orderId);
    expect(reopened.seats()[0]?.status).toBe('sold');
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test('expired holds can be taken by another user; duplicate seat input is rejected', () => {
  const store = new TicketingStore(':memory:', config);
  try {
    store.hold('user-a', ['s1-1-2']);
    store.db.query('UPDATE seats SET hold_expires_at = ? WHERE id = ?').run(Date.now() - 1, 's1-1-2');
    expect(store.hold('user-b', ['s1-1-2']).seatIds).toEqual(['s1-1-2']);
    expect(() => store.hold('user-b', ['s1-1-2', 's1-1-2'])).toThrow(TicketingError);
  } finally { store.close(); }
});

test('failed seed rolls back concert and seats, then restart creates every seat', () => {
  const root = mkdtempSync(join(tmpdir(), 'ticketing-seed-'));
  const path = join(root, 'ticketing.sqlite');
  const seeded = new TicketingStore(path, config);
  seeded.close();
  const fixture = new Database(path);
  fixture.exec('DELETE FROM seats; DELETE FROM concerts');
  fixture.exec("CREATE TRIGGER fail_second_seat BEFORE INSERT ON seats WHEN NEW.id = 's1-1-2' BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END");
  fixture.close();
  try {
    expect(() => new TicketingStore(path, config)).toThrow('injected seed failure');
    const probe = new Database(path);
    expect((probe.query('SELECT COUNT(*) AS count FROM concerts').get() as { count: number }).count).toBe(0);
    expect((probe.query('SELECT COUNT(*) AS count FROM seats').get() as { count: number }).count).toBe(0);
    probe.exec('DROP TRIGGER fail_second_seat');
    probe.close();
    const resumed = new TicketingStore(path, config);
    try { expect(resumed.seats()).toHaveLength(config.seatCount); }
    finally { resumed.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restart fills missing legacy seed seats without changing sold seats', () => {
  const root = mkdtempSync(join(tmpdir(), 'ticketing-legacy-seed-'));
  const path = join(root, 'ticketing.sqlite');
  const first = new TicketingStore(path, config);
  first.db.query('DELETE FROM seats WHERE id = ?').run('s1-1-2');
  first.hold('user-a', ['s1-1-1']);
  first.checkout('user-a', ['s1-1-1'], 'legacy-seed-0001');
  first.close();
  try {
    const resumed = new TicketingStore(path, config);
    try {
      expect(resumed.seats()).toHaveLength(config.seatCount);
      expect(resumed.seats()[0]?.status).toBe('sold');
    } finally { resumed.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restart with fewer then more seats changes sellable capacity and keeps issued tickets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ticketing-resize-'));
  const path = join(root, 'ticketing.sqlite');
  const initial = new TicketingStore(path, { ...config, seatCount: 24 });
  initial.hold('user-a', ['s1-1-7']);
  const issued = initial.checkout('user-a', ['s1-1-7'], 'resize-sale-0001');
  initial.hold('user-b', ['s1-1-6']);
  initial.close();
  try {
    const reduced = new TicketingStore(path, { ...config, seatCount: 4 });
    try {
      expect(reduced.concert()).toMatchObject({ seatCount: 4 });
      expect(reduced.seats()).toHaveLength(4);
      expect(reduced.seats().every(seat => Number(seat.id.slice(5)) <= 4)).toBe(true);
      expect(() => reduced.hold('user-b', ['s1-1-6'])).toThrow(TicketingError);
      expect(() => reduced.checkout('user-b', ['s1-1-6'], 'resize-sale-0002')).toThrow(TicketingError);
      expect(reduced.checkout('user-a', ['s1-1-7'], 'resize-sale-0001')).toMatchObject({
        orderId: issued.orderId, ticketIds: issued.ticketIds, replay: true,
      });
      expect(() => reduced.checkout('user-a', ['s1-1-8'], 'resize-sale-0001')).toThrow(TicketingError);
      expect(reduced.tickets('user-a')).toMatchObject([{ id: issued.ticketIds[0], seatId: 's1-1-7' }]);
      expect((reduced.db.query('SELECT status FROM seats WHERE id = ?').get('s1-1-7') as { status: string }).status).toBe('sold');
      expect(reduced.db.query('SELECT id FROM seats WHERE id = ?').get('s1-1-6')).toBeNull();
    } finally { reduced.close(); }
    const expanded = new TicketingStore(path, { ...config, seatCount: 8 });
    try {
      expect(expanded.concert()).toMatchObject({ seatCount: 8 });
      expect(expanded.seats()).toHaveLength(8);
      expect(expanded.seats().find(seat => seat.id === 's1-1-6')?.status).toBe('free');
      expect(expanded.seats().find(seat => seat.id === 's1-1-7')?.status).toBe('sold');
      expect(expanded.tickets('user-a')).toHaveLength(1);
    } finally { expanded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
