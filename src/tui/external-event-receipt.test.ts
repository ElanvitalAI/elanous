import { describe, expect, test } from 'bun:test';
import { createExternalEventLedger } from './external-event-ledger.js';
import {
  externalEventLatency,
  externalEventLatencyFromLedger,
  externalEventZeroMissReceipt,
} from './external-event-receipt.js';

/** Independent of the product constants. 15s is the period, 20s is the bound. */
const POLL_PERIOD_MS = 15_000;
const POLL_BOUND_MS = 20_000;

describe('external event zero-miss receipt', () => {
  test('an idle poll inside the poll period with a handled row is a zero-miss receipt', () => {
    const book = createExternalEventLedger();
    const occurredAt = 1_000;
    const receivedAt = occurredAt + POLL_PERIOD_MS;
    book.receive({ id: 'm1', kind: 'mail', source: 'OP', at: receivedAt });
    book.inject('m1', receivedAt + 1);
    book.handle('m1', receivedAt + 2);
    const latency = externalEventLatencyFromLedger(book, { id: 'm1', occurredAt });
    expect(latency).toEqual({ id: 'm1', waitMs: POLL_PERIOD_MS, withinBound: true });
    const receipt = externalEventZeroMissReceipt({ ledger: book, samples: [{ id: 'm1', occurredAt }] });
    expect(receipt.ok).toBe(true);
    expect(receipt.late).toEqual([]);
    expect(receipt.missingIds).toEqual([]);
    expect(receipt.unknownIds).toEqual([]);
    expect(receipt.missed).toMatchObject({ rows: [], count: 0, refused: 0 });
  });

  test('delay uses the ledger row receivedAt, not a caller clock', () => {
    const book = createExternalEventLedger();
    const occurredAt = 1_000;
    book.receive({ id: 'm1', kind: 'mail', source: 'OP', at: occurredAt + POLL_BOUND_MS + 1 });
    book.inject('m1', occurredAt + POLL_BOUND_MS + 2);
    book.handle('m1', occurredAt + POLL_BOUND_MS + 3);
    const receipt = externalEventZeroMissReceipt({ ledger: book, samples: [{ id: 'm1', occurredAt }] });
    expect(receipt.latencies).toEqual([{ id: 'm1', waitMs: POLL_BOUND_MS + 1, withinBound: false }]);
    expect(receipt.ok).toBe(false);
    expect(receipt.late.map((row) => row.id)).toEqual(['m1']);
  });

  test('a ledger row absent from the sample is a miss', () => {
    const book = createExternalEventLedger();
    book.receive({ id: 'm1', kind: 'mail', source: 'OP', at: 2_000 });
    book.inject('m1', 2_001);
    book.handle('m1', 2_002);
    book.receive({ id: 'm2', kind: 'wakeup', source: 'timer', at: 2_100 });
    book.inject('m2', 2_101);
    book.handle('m2', 2_102);
    const receipt = externalEventZeroMissReceipt({
      ledger: book,
      samples: [{ id: 'm1', occurredAt: 1_000 }],
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.missingIds).toEqual(['m2']);
    expect(receipt.latencies.map((row) => row.id)).toEqual(['m1']);
  });

  test('a sample id that is not a ledger row is not a received event', () => {
    const book = createExternalEventLedger();
    book.receive({ id: 'm1', kind: 'mail', source: 'OP', at: 2_000 });
    book.inject('m1', 2_001);
    book.handle('m1', 2_002);
    expect(externalEventLatencyFromLedger(book, { id: 'ghost', occurredAt: 1_000 })).toBeNull();
    const receipt = externalEventZeroMissReceipt({
      ledger: book,
      samples: [
        { id: 'm1', occurredAt: 1_000 },
        { id: 'ghost', occurredAt: 1_000 },
      ],
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.unknownIds).toEqual(['ghost']);
    expect(receipt.latencies.map((row) => row.id)).toEqual(['m1']);
  });

  test('a poll at the period plus slack is on time, and one millisecond past the bound is late', () => {
    const book = createExternalEventLedger();
    const occurredAt = 1_000;
    const onTime = createExternalEventLedger();
    const onTimeAt = occurredAt + POLL_BOUND_MS;
    onTime.receive({ id: 'm0', kind: 'wakeup', source: 'timer', at: onTimeAt });
    onTime.inject('m0', onTimeAt);
    onTime.handle('m0', onTimeAt);
    const onTimeReceipt = externalEventZeroMissReceipt({ ledger: onTime, samples: [{ id: 'm0', occurredAt }] });
    expect(onTimeReceipt.ok).toBe(true);
    expect(onTimeReceipt.latencies).toEqual([{ id: 'm0', waitMs: POLL_BOUND_MS, withinBound: true }]);
    const receivedAt = occurredAt + POLL_BOUND_MS + 1;
    book.receive({ id: 'm1', kind: 'wakeup', source: 'timer', at: receivedAt });
    book.inject('m1', receivedAt);
    book.handle('m1', receivedAt);
    const latency = externalEventLatencyFromLedger(book, { id: 'm1', occurredAt });
    expect(latency?.withinBound).toBe(false);
    const receipt = externalEventZeroMissReceipt({ ledger: book, samples: [{ id: 'm1', occurredAt }] });
    expect(receipt.ok).toBe(false);
    expect(receipt.late.map((row) => row.id)).toEqual(['m1']);
  });

  test('a received row that is still waiting is not a zero-miss receipt', () => {
    const book = createExternalEventLedger();
    book.receive({ id: 'g1', kind: 'graph-end', source: 'node', at: 20 });
    const receipt = externalEventZeroMissReceipt({ ledger: book, samples: [{ id: 'g1', occurredAt: 10 }] });
    expect(receipt.ok).toBe(false);
    expect(receipt.missed.count).toBe(1);
    expect(receipt.missed.rows.map((row) => row.id)).toEqual(['g1']);
  });

  test('an empty sample is not a zero-miss receipt', () => {
    const book = createExternalEventLedger();
    expect(externalEventZeroMissReceipt({ ledger: book, samples: [] }).ok).toBe(false);
  });

  test('a clock that receives before the event existed is not inside the bound', () => {
    const latency = externalEventLatency({ id: 'c1', occurredAt: 100, receivedAt: 99 });
    expect(latency).toMatchObject({ waitMs: -1, withinBound: false });
  });
});
