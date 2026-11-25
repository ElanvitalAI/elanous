import { describe, expect, test } from 'bun:test';
import { createExternalEventLedger, EXTERNAL_EVENT_LEDGER_CAP } from './external-event-ledger.js';

describe('external event ledger', () => {
  test('a received event is a miss until it is injected and handled', () => {
    const book = createExternalEventLedger();
    const received = book.receive({ id: 'm1', kind: 'mail', source: 'OP', at: 1 });
    expect(received).toMatchObject({ ok: true, row: { injectedAt: null, handledAt: null } });
    expect(book.missed().rows.map((row) => row.id)).toEqual(['m1']);
    expect(book.missed().count).toBe(1);
    expect(book.handle('m1', 2)).toBeNull();
    expect(book.inject('m1', 2)?.injectedAt).toBe(2);
    expect(book.missed(['m1'])).toMatchObject({ rows: [], count: 0, refused: 0 });
    expect(book.missed().rows).toHaveLength(1);
    expect(book.handle('m1', 3)?.handledAt).toBe(3);
    expect(book.missed()).toMatchObject({ rows: [], count: 0, refused: 0 });
  });

  test('the same id is received once', () => {
    const book = createExternalEventLedger();
    book.receive({ id: 'm1', kind: 'wakeup', source: 'timer', at: 1 });
    expect(book.receive({ id: 'm1', kind: 'wakeup', source: 'timer', at: 2 })).toEqual({ ok: false, reason: 'duplicate' });
    expect(book.rows()).toHaveLength(1);
    book.inject('m1', 3);
    book.handle('m1', 4);
    expect(book.missed()).toMatchObject({ rows: [], refused: 1, count: 1 });
  });

  test('inject and handle are one step each and cannot skip', () => {
    const book = createExternalEventLedger();
    book.receive({ id: 'g1', kind: 'graph-end', source: 'node', at: 1 });
    expect(book.inject('missing', 2)).toBeNull();
    book.inject('g1', 2);
    expect(book.inject('g1', 3)).toBeNull();
    book.handle('g1', 4);
    expect(book.handle('g1', 5)).toBeNull();
    expect(book.rows()[0]).toMatchObject({ injectedAt: 2, handledAt: 4 });
  });

  test('ten arrivals stay one book and the miss count is the unhandled rows', () => {
    const book = createExternalEventLedger();
    for (let i = 0; i < 10; i += 1) book.receive({ id: `e${i}`, kind: 'child-exit', source: 'pty', at: i });
    for (let i = 0; i < 10; i += 1) book.inject(`e${i}`, 100 + i);
    for (let i = 0; i < 9; i += 1) book.handle(`e${i}`, 200 + i);
    expect(book.rows()).toHaveLength(10);
    expect(book.missed(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']).rows.map((row) => row.id)).toEqual(['e9']);
    expect(book.missed().count).toBe(1);
  });

  test('a full book keeps the old rows and refuses the next id', () => {
    const book = createExternalEventLedger(2);
    expect(EXTERNAL_EVENT_LEDGER_CAP).toBe(1000);
    book.receive({ id: 'a', kind: 'mail', source: 'OP', at: 1 });
    book.receive({ id: 'b', kind: 'mail', source: 'OP', at: 2 });
    expect(book.receive({ id: 'c', kind: 'mail', source: 'OP', at: 3 })).toEqual({ ok: false, reason: 'full' });
    expect(book.rows().map((row) => row.id)).toEqual(['a', 'b']);
    book.inject('a', 4);
    book.handle('a', 5);
    book.inject('b', 6);
    book.handle('b', 7);
    expect(book.missed()).toMatchObject({ rows: [], refused: 1, count: 1 });
  });
});

describe('11-25 OP deaf — a long session never fills the book with finished rows', () => {
  test('a full book evicts its oldest handled row and accepts the next id', () => {
    const book = createExternalEventLedger(2);
    book.receive({ id: 'a', kind: 'mail', source: 'OP', at: 1 });
    book.inject('a', 2);
    book.handle('a', 3);
    book.receive({ id: 'b', kind: 'mail', source: 'OP', at: 4 });
    expect(book.receive({ id: 'c', kind: 'mail', source: 'OP', at: 5 })).toMatchObject({ ok: true, row: { id: 'c' } });
    expect(book.rows().map((row) => row.id)).toEqual(['b', 'c']);
    expect(book.missed()).toMatchObject({ refused: 0, count: 2 });
  });

  test('1001 handled notices in a row: the 1001st is still accepted (the incident was the 201st refused at the old cap 200)', () => {
    const book = createExternalEventLedger();
    for (let i = 1; i <= 1000; i += 1) {
      book.receive({ id: `q${i}`, kind: 'mail', source: 'OP', at: i });
      book.inject(`q${i}`, i);
      book.handle(`q${i}`, i);
    }
    expect(book.receive({ id: 'q1001', kind: 'mail', source: 'OP', at: 1001 })).toMatchObject({ ok: true });
    expect(book.rows()).toHaveLength(1000);
  });

  test('SEAT-QUEUE-CAPACITY — 1000 unhandled events all stay in the default book; only the 1001st is refused', () => {
    const book = createExternalEventLedger();
    for (let i = 1; i <= 1000; i += 1) {
      expect(book.receive({ id: `u${i}`, kind: 'mail', source: 'OP', at: i })).toMatchObject({ ok: true });
    }
    expect(book.rows()).toHaveLength(1000);
    expect(book.rows()[0]!.id).toBe('u1');
    expect(book.rows()[999]!.id).toBe('u1000');
    expect(book.receive({ id: 'u1001', kind: 'mail', source: 'OP', at: 1001 })).toEqual({ ok: false, reason: 'full' });
    expect(book.missed()).toMatchObject({ refused: 1, count: 1001 });
  });
});
