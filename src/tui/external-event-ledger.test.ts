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
    expect(EXTERNAL_EVENT_LEDGER_CAP).toBe(200);
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
