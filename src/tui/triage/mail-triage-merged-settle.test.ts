// MAIL-TRIAGE-TASKQUEUE — real watcher ⊕ adapter ⊕ real queue ⊕ in-memory MsgStore: a status delta merged into an open
// task leaves the queue as `triage-merged`, is acked as absorbed (seen 1 · done 1 · ack 1), and is never re-noticed.
import { afterEach, expect, test } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import { createNextTuiQueue } from '../core/queue.js';
import { createSeatMailArrivalWatcher, type SeatMailArrivalInfo } from '../seat-mail-arrival.js';
import { seatMailMessageOf, type SeatMailMessageRead } from '../seat-message-receipts.js';
import { createSeatMailAdapter } from '../turn-events/mail-adapter.js';
import { createMailTriageWire } from './mail-triage-wire.js';

const SEAT = 'TC-H-CC-5';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('a merged status delta is absorbed without a turn; the request it joined stays queued', () => {
  let at = 3_000_000;
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const adapter = createSeatMailAdapter({ now: () => at });
  const doneCalls: number[] = [];
  const acks: number[] = [];
  const passedOn: number[] = [];
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => ({ seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(seatMailMessageOf) });
  const removeQueuedNotice = (match: { source: string; msgId: number; reason: string }): number => {
    const wanted = queue.items.filter((item) => item.kind === 'notice' && item.source === match.source && item.msgId === match.msgId);
    for (const item of wanted) queue.cancel(item.id, match.reason);
    return wanted.length;
  };
  const triage = createMailTriageWire({ removeQueuedNotice, ledgerOptions: { now: () => at } });
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read, receipts: {
      record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); },
      recordDone: (input) => { doneCalls.push(input.messageId); },
      ack: (input) => { acks.push(input.messageId); },
    } },
    mailAdapter: adapter,
    onArrived: (arrivals?: readonly SeatMailArrivalInfo[]) => { for (const one of triage.filterArrivals(arrivals) ?? []) if (one.msgId !== undefined) passedOn.push(one.msgId); },
    onReadError: () => {},
    log: () => {},
    timer: { set: () => 'poll-timer', clear: () => {} },
    retryTimer: { set: () => 1, clear: () => {} },
  });
  watcher.poll();
  const request = store.post({ from: 'OP', to: SEAT, body: 'land PR 40036', kind: 'request', refs: ['pr:40036'] });
  watcher.poll();
  const delta = store.post({ from: 'JUD', to: SEAT, body: 'pregate still running', kind: 'status', refs: ['pr:40036'] });
  watcher.poll();
  const noticeIds = queue.items.filter((item) => item.kind === 'notice' && item.status === 'queued').map((item) => item.msgId);
  expect(noticeIds).toEqual([request.id]);
  expect(passedOn).toEqual([request.id]);
  expect(doneCalls).toEqual([delta.id]);
  expect(acks).toEqual([delta.id]);
  expect(store.listReceipts({ messageId: delta.id }).map((row) => row.state).filter((state) => state === 'seen')).toEqual(['seen']);
  expect(adapter.owner(delta.id)).toBe('done');
  at += 60_000;
  watcher.poll();
  expect(queue.items.filter((item) => item.kind === 'notice' && item.status === 'queued').map((item) => item.msgId)).toEqual([request.id]);
});
