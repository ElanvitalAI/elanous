import { describe, expect, test } from 'bun:test';
import { createExternalEventLedger } from './external-event-ledger.js';
import { createNextTuiQueue } from './core/queue.js';
import { dispatchQueuedExternalEventOne } from './entry.js';
import {
  dispatchExternalEventOne,
  finishExternalEventOne,
  noteExternalEventOne,
  noticeOneDispatch,
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

  test('dispatch table: a new row starts the turn, a refusal wakes only a later item', () => {
    expect([
      ['new, more queued', noticeOneDispatch({ injected: true, remaining: 2 })],
      ['new, queue empty', noticeOneDispatch({ injected: true, remaining: 0 })],
      ['refused, more queued', noticeOneDispatch({ injected: false, remaining: 2 })],
      ['refused, queue empty', noticeOneDispatch({ injected: false, remaining: 0 })],
    ]).toEqual([
      ['new, more queued', { startTurn: true, wakeQueue: false }],
      ['new, queue empty', { startTurn: true, wakeQueue: false }],
      ['refused, more queued', { startTurn: false, wakeQueue: true }],
      ['refused, queue empty', { startTurn: false, wakeQueue: false }],
    ]);
  });

  test('two notices stay two rows, not one bundle', () => {
    const book = resetExternalEventOneWire();
    noteExternalEventOne({ id: 'a', text: 'one', source: 'seat-mail', occurredAt: 1 }, 10);
    noteExternalEventOne({ id: 'b', text: 'two', source: 'wakeup', occurredAt: 2 }, 20);
    expect(book.rows().map((row) => row.id)).toEqual(['a', 'b']);
    expect(book.rows().map((row) => row.kind)).toEqual(['mail', 'wakeup']);
  });

  test('entry follows the dispatch verdict: a refusal wakes a later item, a new row starts the turn', () => {
    resetExternalEventOneWire();
    const opened = {
      id: 'wire-1',
      text: 'one notice',
      source: 'seat-mail',
      occurredAt: 1,
      receivedAt: 10,
      injected: true,
      // This test never finishes the notice turn; entry keeps the finisher.
      finish: (): Promise<never> => Promise.reject(new Error('not finished in this test')),
    };
    const run = (injected: boolean, remaining: number) => {
      const calls: Array<[string, string]> = [];
      const keepOpenIds: string[] = [];
      dispatchExternalEventOne({
        opened,
        dispatch: noticeOneDispatch({ injected, remaining }),
        remaining,
        injectKey: () => { calls.push(['injectKey', opened.id]); },
        keepOpen: (one) => { keepOpenIds.push(one.id); },
        startChatTurn: (text, status) => { calls.push(['startChatTurn', `${text}|${status}`]); },
        log: (event) => { calls.push(['log', event]); },
      });
      return { calls, keepOpenIds };
    };
    expect(run(true, 2).calls).toEqual([
      ['log', 'queue-dispatched-notice'],
      ['startChatTurn', 'one notice|[notice · seat-mail] auto-submitted'],
    ]);
    expect(run(false, 2).calls).toEqual([
      ['log', 'queue-notice-not-injected'],
      ['injectKey', 'wire-1'],
    ]);
    expect(run(false, 0).calls).toEqual([['log', 'queue-notice-not-injected']]);
    const started = run(true, 0);
    expect(started.keepOpenIds).toEqual(['wire-1']);
    expect(started.calls).toEqual([
      ['log', 'queue-dispatched-notice'],
      ['startChatTurn', 'one notice|[notice · seat-mail] auto-submitted'],
    ]);
  });
});

/**
 * The real entry chain (dispatchQueuedExternalEventOne from entry.js): the
 * import failure alone is recovered through the common verdict, and the
 * dispatch verdict is followed through the leaf on the same chain. A
 * duplicate or an import failure wakes a later item; a new row starts the
 * notice turn; an exception after the import is not swallowed into a wake.
 */
describe('the real entry chain: one chain, import failure recovered, verdict followed', () => {
  const recorder = () => {
    const calls: string[] = [];
    return {
      calls,
      onSeatMail: (id: string) => { calls.push(`plan:${id}`); },
      injectKey: () => { calls.push('injectKey'); },
      keepOpen: (opened: { readonly id: string }) => { calls.push(`keepOpen:${opened.id}`); },
      startChatTurn: (text: string, status: string) => { calls.push(`startChatTurn:${text}|${status}`); },
      log: (event: string) => { calls.push(`log:${event}`); },
    };
  };

  test('leaf import failure: no turn, a later item still wakes (the common verdict)', async () => {
    const r = recorder();
    const failedFields: Array<Record<string, unknown>> = [];
    await dispatchQueuedExternalEventOne({
      notice: { id: 'import-1', text: 'OP: one', source: 'seat-mail', occurredAt: 1_000, remaining: 2 },
      wire: Promise.reject(new Error('leaf did not load')),
      ...r,
      log: (event, fields) => { r.log(event); failedFields.push(fields); },
    });
    expect(r.calls).toEqual([
      'plan:import-1',
      'log:queue-notice-open-failed',
      'injectKey',
    ]);
    expect(failedFields).toEqual([{ source: 'seat-mail', id: 'import-1', remaining: 2, receipt: 'failed', error: 'Error: leaf did not load' }]);
  });

  test('leaf import failure with an empty queue behind: no turn, no wake', async () => {
    const r = recorder();
    await dispatchQueuedExternalEventOne({
      notice: { id: 'import-2', text: 'OP: one', remaining: 0 },
      wire: Promise.reject(new Error('leaf did not load')),
      ...r,
    });
    expect(r.calls).toEqual(['log:queue-notice-open-failed']);
  });

  test('real leaf, a new row: entry keeps the opened notice and starts the turn', async () => {
    resetExternalEventOneWire();
    const r = recorder();
    await dispatchQueuedExternalEventOne({
      notice: { id: 'entry-new-1', text: 'OP: one', source: 'seat-mail', occurredAt: 1_000, remaining: 0 },
      ...r,
    });
    expect(r.calls).toEqual([
      'plan:entry-new-1',
      'keepOpen:entry-new-1',
      'log:queue-dispatched-notice',
      'startChatTurn:OP: one|[notice · seat-mail] auto-submitted',
    ]);
  });

  test('real leaf, a duplicate: no turn, a later item wakes through the same verdict', async () => {
    const book = resetExternalEventOneWire();
    noteExternalEventOne({ id: 'entry-dup-1', text: 'OP: first', source: 'seat-mail', occurredAt: 1_000 }, 16_000);
    const r = recorder();
    await dispatchQueuedExternalEventOne({
      notice: { id: 'entry-dup-1', text: 'OP: again', source: 'seat-mail', occurredAt: 1_000, remaining: 3 },
      ...r,
    });
    expect(r.calls).toEqual([
      'plan:entry-dup-1',
      'log:queue-notice-not-injected',
      'injectKey',
    ]);
    // The duplicate did not borrow the first row: still one row, and it stays unhandled.
    expect(book.rows()).toHaveLength(1);
    expect(book.rows()[0]?.id).toBe('entry-dup-1');
    expect(book.rows()[0]?.handledAt).toBeNull();
  });

  test('CAPSULE-C2: a person took the door during the import — the notice is kept, the ledger never sees it', async () => {
    const book = resetExternalEventOneWire();
    const r = recorder();
    const kept: string[] = [];
    await dispatchQueuedExternalEventOne({
      notice: { id: 'door-held-1', text: 'OP: one', source: 'seat-mail', occurredAt: 1_000, remaining: 0 },
      ...r,
      held: () => false,
      onSuperseded: () => { kept.push('door-held-1'); },
      afterDispatch: () => { r.calls.push('afterDispatch'); },
    });
    expect(r.calls).toEqual(['plan:door-held-1', 'log:queue-notice-superseded']);
    expect(kept).toEqual(['door-held-1']);
    expect(book.rows()).toHaveLength(0);
  });

  test('CAPSULE-C2: the door still held — the turn starts, then the chain reports it is over', async () => {
    resetExternalEventOneWire();
    const r = recorder();
    await dispatchQueuedExternalEventOne({
      notice: { id: 'door-held-2', text: 'OP: two', source: 'seat-mail', occurredAt: 1_000, remaining: 0 },
      ...r,
      held: () => true,
      afterDispatch: () => { r.calls.push('afterDispatch'); },
    });
    expect(r.calls).toEqual([
      'plan:door-held-2',
      'keepOpen:door-held-2',
      'log:queue-dispatched-notice',
      'startChatTurn:OP: two|[notice · seat-mail] auto-submitted',
      'afterDispatch',
    ]);
  });

  test('CAPSULE-C2: import failure frees the door before the wake', async () => {
    const r = recorder();
    await dispatchQueuedExternalEventOne({
      notice: { id: 'door-held-3', text: 'OP: three', remaining: 1 },
      wire: Promise.reject(new Error('leaf did not load')),
      ...r,
      afterDispatch: () => { r.calls.push('afterDispatch'); },
    });
    expect(r.calls).toEqual(['log:queue-notice-open-failed', 'afterDispatch', 'injectKey']);
  });

  test('an exception after the import rejects the chain instead of becoming a wake', async () => {
    resetExternalEventOneWire();
    const calls: string[] = [];
    await expect(dispatchQueuedExternalEventOne({
      notice: { id: 'entry-crash-1', text: 'OP: one', source: 'seat-mail', occurredAt: 1_000, remaining: 2 },
      injectKey: () => { calls.push('injectKey'); },
      keepOpen: () => { calls.push('keepOpen'); },
      startChatTurn: () => { throw new Error('render defect'); },
      log: (event) => { calls.push(`log:${event}`); },
    })).rejects.toThrow('render defect');
    expect(calls).toEqual([
      'keepOpen',
      'log:queue-dispatched-notice',
    ]);
  });

  test('CAPSULE-C2-FU: startChatTurn throws — the chain rejects and afterDispatch still runs exactly once', async () => {
    resetExternalEventOneWire();
    const calls: string[] = [];
    await expect(dispatchQueuedExternalEventOne({
      notice: { id: 'entry-crash-2', text: 'OP: two', source: 'seat-mail', occurredAt: 1_000, remaining: 2 },
      injectKey: () => { calls.push('injectKey'); },
      keepOpen: () => { calls.push('keepOpen'); },
      startChatTurn: () => { throw new Error('render defect'); },
      log: (event) => { calls.push(`log:${event}`); },
      held: () => true,
      afterDispatch: () => { calls.push('afterDispatch'); },
    })).rejects.toThrow('render defect');
    expect(calls).toEqual([
      'keepOpen',
      'log:queue-dispatched-notice',
      'afterDispatch',
    ]);
  });
});

describe('11-25 OP deaf — a not-injected notice never stalls silently', () => {
  const runOnce = (refusal: 'duplicate' | 'full' | undefined, remaining: number) => {
    const calls: string[] = [];
    dispatchExternalEventOne({
      opened: {
        id: 'deaf-1', text: 'mail body', source: 'seat-mail', receivedAt: 1, injected: false,
        ...(refusal === undefined ? {} : { refusal }),
        finish: (): Promise<never> => Promise.reject(new Error('not finished in this test')),
      },
      dispatch: noticeOneDispatch({ injected: false, remaining }),
      remaining,
      injectKey: () => { calls.push('injectKey'); },
      keepOpen: () => { calls.push('keepOpen'); },
      startChatTurn: (text, status) => { calls.push(`start:${text}|${status}`); },
      log: (event, fields) => { calls.push(`log:${event}:${JSON.stringify(fields)}`); },
    });
    return calls;
  };

  test('a full ledger still starts the turn (forced ledger-full)', () => {
    resetExternalEventOneWire();
    expect(runOnce('full', 0)).toEqual([
      'log:queue-notice-forced-turn:{"source":"seat-mail","reason":"ledger-full","streak":1,"remaining":0}',
      'keepOpen',
      'log:queue-dispatched-notice:{"source":"seat-mail","remaining":0}',
      'start:mail body|[notice · seat-mail] auto-submitted',
    ]);
  });

  test('not injected wakes the next item; the third in a row forces the turn, then the streak restarts', () => {
    resetExternalEventOneWire();
    expect(runOnce('duplicate', 4)).toEqual([
      'log:queue-notice-not-injected:{"source":"seat-mail","remaining":4,"streak":1,"refusal":"duplicate"}',
      'injectKey',
    ]);
    expect(runOnce('duplicate', 3)).toEqual([
      'log:queue-notice-not-injected:{"source":"seat-mail","remaining":3,"streak":2,"refusal":"duplicate"}',
      'injectKey',
    ]);
    expect(runOnce('duplicate', 2)).toEqual([
      'log:queue-notice-forced-turn:{"source":"seat-mail","reason":"not-injected-streak","streak":3,"remaining":2}',
      'keepOpen',
      'log:queue-dispatched-notice:{"source":"seat-mail","remaining":2}',
      'start:mail body|[notice · seat-mail] auto-submitted',
    ]);
    expect(runOnce('duplicate', 1)).toEqual([
      'log:queue-notice-not-injected:{"source":"seat-mail","remaining":1,"streak":1,"refusal":"duplicate"}',
      'injectKey',
    ]);
  });

  test('the verdict itself: full → start, streak 3 → start, streak 2 → wake only', () => {
    expect(noticeOneDispatch({ injected: false, remaining: 0, refusal: 'full' })).toEqual({ startTurn: true, wakeQueue: false, forced: 'ledger-full' });
    expect(noticeOneDispatch({ injected: false, remaining: 5, streak: 3 })).toEqual({ startTurn: true, wakeQueue: false, forced: 'not-injected-streak' });
    expect(noticeOneDispatch({ injected: false, remaining: 5, streak: 2 })).toEqual({ startTurn: false, wakeQueue: true });
  });
});
