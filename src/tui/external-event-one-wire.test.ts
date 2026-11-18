import { describe, expect, test } from 'bun:test';
import { createExternalEventLedger } from './external-event-ledger.js';
import { createNextTuiQueue } from './core/queue.js';
import {
  finishExternalEventOne,
  noteExternalEventOne,
  openExternalEventOne,
  resetExternalEventOneWire,
} from './external-event-one-wire.js';

/** Independent of the product constants. A poll at 15s is on time; past 20s is late. */
const ON_TIME_WAIT_MS = 15_000;
const LATE_PAST_BOUND_MS = 20_000;

/**
 * Checklist: occurrence time (known · unknown) × duplicate (first · again)
 * × turn result (completed · failed). Each cell is its own test.
 * Expected waits are these literals, not a product constant or a render helper.
 */
describe('one external event receipt is not better than the real steps', () => {
  test('known time, first id, completed turn: on time only after handle', () => {
    const book = resetExternalEventOneWire();
    const occurredAt = 1_000;
    const receivedAt = occurredAt + ON_TIME_WAIT_MS;
    const noted = noteExternalEventOne(
      { id: 'mail-1', text: 'OP: one', source: 'seat-mail', occurredAt },
      receivedAt,
    );
    expect(noted.phase).toBe('injected');
    expect(noted.injected).toBe(true);
    expect(noted.receipt.ok).toBe(false);
    const handled = finishExternalEventOne({
      id: 'mail-1',
      occurredAt,
      at: receivedAt + 2,
      turnOk: true,
    });
    expect(handled.phase).toBe('handled');
    expect(handled.noted).toBe(true);
    expect(handled.receipt.ok).toBe(true);
    expect(handled.receipt.latencies).toEqual([
      { id: 'mail-1', waitMs: ON_TIME_WAIT_MS, withinBound: true },
    ]);
    const row = book.rows().find((item) => item.id === 'mail-1');
    expect(row?.receivedAt).toBe(receivedAt);
    expect(row?.injectedAt).toBe(receivedAt + 1);
    expect(row?.handledAt).toBe(receivedAt + 2);
  });

  test('verdict table: new is injected, duplicate and refused are not', () => {
    resetExternalEventOneWire();
    const fresh = noteExternalEventOne({ id: 'new-1', text: 'one', source: 'seat-mail', occurredAt: 1_000 }, 16_000);
    const again = noteExternalEventOne({ id: 'new-1', text: 'one again', source: 'seat-mail', occurredAt: 1_000 }, 17_000);
    const full = createExternalEventLedger(1);
    full.receive({ id: 'taken', kind: 'mail', source: 'already', at: 1 });
    resetExternalEventOneWire(full);
    const refused = noteExternalEventOne({ id: 'nope', text: 'no room', source: 'seat-mail', occurredAt: 1_000 }, 18_000);
    expect([
      ['new', fresh.injected, fresh.phase],
      ['duplicate', again.injected, again.phase],
      ['refused', refused.injected, refused.phase],
    ]).toEqual([
      ['new', true, 'injected'],
      ['duplicate', false, 'duplicate'],
      ['refused', false, 'refused'],
    ]);
    expect(full.rows().map((row) => row.id)).toEqual(['taken']);
  });

  test('unknown time, first id, completed turn: not ok', () => {
    resetExternalEventOneWire();
    const receivedAt = 16_000;
    noteExternalEventOne({ id: 'mail-unknown', text: 'OP: one', source: 'seat-mail' }, receivedAt);
    const handled = finishExternalEventOne({ id: 'mail-unknown', at: receivedAt + 2, turnOk: true });
    expect(handled.phase).toBe('handled');
    expect(handled.receipt.ok).toBe(false);
    expect(handled.receipt.latencies).toEqual([
      { id: 'mail-unknown', waitMs: null, withinBound: false },
    ]);
  });

  test('known time, first id, failed turn: not ok and not handled', () => {
    const book = resetExternalEventOneWire();
    const occurredAt = 1_000;
    const receivedAt = occurredAt + ON_TIME_WAIT_MS;
    noteExternalEventOne(
      { id: 'mail-fail', text: 'OP: one', source: 'seat-mail', occurredAt },
      receivedAt,
    );
    const handled = finishExternalEventOne({
      id: 'mail-fail',
      occurredAt,
      at: receivedAt + 2,
      turnOk: false,
    });
    expect(handled.noted).toBe(false);
    expect(handled.receipt.ok).toBe(false);
    expect(book.rows().find((item) => item.id === 'mail-fail')?.handledAt).toBeNull();
  });

  test('unknown time, first id, failed turn: not ok', () => {
    const book = resetExternalEventOneWire();
    noteExternalEventOne({ id: 'mail-unknown-fail', text: 'OP: one', source: 'seat-mail' }, 16_000);
    const handled = finishExternalEventOne({ id: 'mail-unknown-fail', at: 16_002, turnOk: false });
    expect(handled.receipt.ok).toBe(false);
    expect(handled.receipt.latencies).toEqual([
      { id: 'mail-unknown-fail', waitMs: null, withinBound: false },
    ]);
    expect(book.rows().find((item) => item.id === 'mail-unknown-fail')?.handledAt).toBeNull();
  });

  test('known time, duplicate id, completed turn: the copy is a failed receipt', () => {
    const book = resetExternalEventOneWire();
    const occurredAt = 1_000;
    const first = noteExternalEventOne(
      { id: 'mail-1', text: 'OP: one', source: 'seat-mail', occurredAt },
      occurredAt + ON_TIME_WAIT_MS,
    );
    const second = noteExternalEventOne(
      { id: 'mail-1', text: 'OP: one again', source: 'seat-mail', occurredAt },
      occurredAt + ON_TIME_WAIT_MS + 1_000,
    );
    expect(first.noted).toBe(true);
    expect(first.receipt.ok).toBe(false);
    expect(second.noted).toBe(false);
    expect(second.phase).toBe('duplicate');
    expect(second.receipt.ok).toBe(false);
    expect(book.rows()).toHaveLength(1);
    expect(book.missed().refused).toBe(1);
  });

  test('unknown time, duplicate id, completed turn: the copy is a failed receipt', () => {
    resetExternalEventOneWire();
    noteExternalEventOne({ id: 'mail-1', text: 'OP: one', source: 'seat-mail' }, 5_000);
    const second = noteExternalEventOne({ id: 'mail-1', text: 'OP: one again', source: 'seat-mail' }, 6_000);
    expect(second.phase).toBe('duplicate');
    expect(second.receipt.ok).toBe(false);
    expect(second.receipt.latencies).toEqual([
      { id: 'mail-1', waitMs: null, withinBound: false },
    ]);
  });

  test('known time, duplicate id, failed turn: still a failed receipt and one row', () => {
    const book = resetExternalEventOneWire();
    const occurredAt = 1_000;
    noteExternalEventOne(
      { id: 'mail-1', text: 'OP: one', source: 'seat-mail', occurredAt },
      occurredAt + ON_TIME_WAIT_MS,
    );
    const second = noteExternalEventOne(
      { id: 'mail-1', text: 'OP: one again', source: 'seat-mail', occurredAt },
      occurredAt + ON_TIME_WAIT_MS + 1,
    );
    expect(second.receipt.ok).toBe(false);
    const failed = finishExternalEventOne({ id: 'mail-1', occurredAt, turnOk: false });
    expect(failed.receipt.ok).toBe(false);
    expect(book.rows()).toHaveLength(1);
  });

  test('unknown time, duplicate id, failed turn: not ok', () => {
    resetExternalEventOneWire();
    noteExternalEventOne({ id: 'mail-1', text: 'OP: one', source: 'seat-mail' }, 5_000);
    const second = noteExternalEventOne({ id: 'mail-1', text: 'OP: again', source: 'seat-mail' }, 6_000);
    expect(second.phase).toBe('duplicate');
    expect(second.receipt.ok).toBe(false);
    const failed = finishExternalEventOne({ id: 'mail-1', turnOk: false });
    expect(failed.receipt.ok).toBe(false);
  });

  test('a poll past the bound is a receipt that is not ok', () => {
    resetExternalEventOneWire();
    const occurredAt = 1_000;
    const receivedAt = occurredAt + LATE_PAST_BOUND_MS + 1;
    noteExternalEventOne(
      { id: 'mail-late', text: 'OP: late', source: 'seat-mail', occurredAt },
      receivedAt,
    );
    const handled = finishExternalEventOne({ id: 'mail-late', occurredAt, at: receivedAt + 2, turnOk: true });
    expect(handled.receipt.ok).toBe(false);
    expect(handled.receipt.late).toEqual([
      { id: 'mail-late', waitMs: LATE_PAST_BOUND_MS + 1, withinBound: false },
    ]);
  });

  test('the idle door runs the entry wire: one dequeue, one open, finish only after the turn', async () => {
    const book = resetExternalEventOneWire();
    const queue = createNextTuiQueue({ log: () => {} });
    const occurredAt = 1_000;
    const receivedAt = occurredAt + ON_TIME_WAIT_MS;
    const item = queue.enqueueNotice('OP: one', 'seat-mail', { occurredAt });
    const handoff = queue.dequeue();
    if (handoff.kind !== 'submit') throw new Error('notice head expected');
    expect(handoff.itemKind).toBe('notice');
    expect(handoff.id).toBe(item.id);
    const opened = openExternalEventOne({
      id: handoff.id,
      text: handoff.text,
      source: handoff.source,
      ...(handoff.occurredAt === undefined ? {} : { occurredAt: handoff.occurredAt }),
      receivedAt,
    });
    expect(opened.injected).toBe(true);
    expect(opened.receivedAt).toBe(receivedAt);
    expect(opened.occurredAt).toBe(occurredAt);
    const row = book.rows().find((candidate) => candidate.id === item.id);
    expect(row?.receivedAt).toBe(receivedAt);
    expect(row?.injectedAt).toBe(receivedAt + 1);
    expect(row?.handledAt).toBeNull();
    const finished = await opened.finish(true);
    expect(finished.phase).toBe('handled');
    expect(finished.receipt.ok).toBe(true);
    expect(finished.receipt.latencies).toEqual([
      { id: item.id, waitMs: ON_TIME_WAIT_MS, withinBound: true },
    ]);
    const again = queue.dequeue();
    expect(again.kind).toBe('none');
    const copy = openExternalEventOne({
      id: handoff.id,
      text: handoff.text,
      source: handoff.source,
      occurredAt,
      receivedAt: receivedAt + 1_000,
    });
    expect(copy.injected).toBe(false);
    const copyReceipt = await copy.finish(true);
    expect(copyReceipt.receipt.ok).toBe(false);
    expect(book.rows()).toHaveLength(1);
  });

  test('two notices stay two rows, not one bundle', () => {
    const book = resetExternalEventOneWire();
    noteExternalEventOne({ id: 'a', text: 'one', source: 'seat-mail', occurredAt: 1 }, 10);
    noteExternalEventOne({ id: 'b', text: 'two', source: 'wakeup', occurredAt: 2 }, 20);
    expect(book.rows().map((row) => row.id)).toEqual(['a', 'b']);
    expect(book.rows().map((row) => row.kind)).toEqual(['mail', 'wakeup']);
  });
});
