import { expect, test } from 'bun:test';
import { createMailTriageWire } from './mail-triage-wire.js';
import type { SeatMailArrivalInfo } from '../seat-mail-arrival.js';

const arrival = (msgId: number, fields: Partial<SeatMailArrivalInfo> = {}): SeatMailArrivalInfo => ({ msgId, seat: 'OP', sender: 'TC', text: `notice ${msgId}`, ...fields });

test('a status delta for an open PR leaves the queue as triage-merged and opens no turn; the rest flow on', () => {
  const removed: Array<{ source: string; msgId: number; reason: string }> = [];
  const wire = createMailTriageWire({ removeQueuedNotice: (match) => { removed.push(match); return 1; }, ledgerOptions: { now: () => 1 } });
  const kept = wire.filterArrivals([
    arrival(1, { kind: 'request', refs: ['pr:40036'] }),
    arrival(2, { kind: 'status', refs: ['pr:40036'] }),
    arrival(3, { kind: 'announce', refs: ['announce:a1'] }),
    arrival(4, { kind: 'request', intent: 'decision', refs: ['block:b-9'] }),
  ]);
  expect(kept?.map((one) => one.msgId)).toEqual([1, 3, 4]);
  expect(removed).toEqual([{ source: 'seat-mail', msgId: 2, reason: 'triage-merged' }]);
  expect(wire.verdictOf(2)).toMatchObject({ cls: 'D', key: 'pr:40036', merged: true });
  expect(wire.verdictOf(4)?.cls).toBe('A');
});

test('a merged mail whose notice is already gone is passed on (never lost)', () => {
  const wire = createMailTriageWire({ removeQueuedNotice: () => 0, ledgerOptions: { now: () => 1 } });
  wire.filterArrivals([arrival(1, { kind: 'request', refs: ['cell:A-1'] })]);
  expect(wire.filterArrivals([arrival(2, { kind: 'heartbeat', refs: ['cell:A-1'] })])?.map((one) => one.msgId)).toEqual([2]);
});

test('arrivals without a msgId and an undefined list pass through untouched', () => {
  const wire = createMailTriageWire({ removeQueuedNotice: () => 1, ledgerOptions: { now: () => 1 } });
  expect(wire.filterArrivals(undefined)).toBe(undefined);
  const plain: SeatMailArrivalInfo = { seat: 'OP', text: 'count-mode notice' };
  expect(wire.filterArrivals([plain])).toEqual([plain]);
});
