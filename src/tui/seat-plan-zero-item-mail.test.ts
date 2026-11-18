// TURN-FIELD-BUG-3 — a mail the seat plan absorbs but cannot decompose (0 items) still gets its one turn.
// Live 11-18 capsule test universe (20261118-205927 · s1): mail #3 «capsule-tu sim-mail-c3b s1 C3 유휴 배출 …» arrived
// during a turn; the plan absorbed it at the turn end (receipt delivered · source plan), made no item, and the watcher —
// which skips anything the plan took (seat-message-receipts.ts takenMessageIds) — never offered it: no turn.
import { afterEach, describe, expect, test } from 'bun:test';
import { MsgStore, type Message } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { seatTaskQueueFromPromptQueue, wireSeatMailToPlan } from './seat-mail-boot.js';
import { seatMailMessageOf, type SeatMailMessageRead } from './seat-message-receipts.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';

const SEAT = 'SIM-SEAT-S1';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function world(withAdapter: boolean) {
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const adapter = withAdapter ? createSeatMailAdapter({ now: () => 1_000_000 }) : undefined;
  // production-faithful read: skip what was seen+ or what the plan took (seat-message-receipts.ts takenMessageIds)
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => {
    const taken = new Set(store.listReceipts({}).filter(r => r.recipient === SEAT)
      .filter(r => ['seen', 'accepted', 'rejected', 'done', 'expired'].includes(r.state) || r.source === 'plan')
      .map(r => r.messageId));
    return { seat: SEAT, messages: store.listByRecipient(SEAT, afterId).filter(m => !taken.has(m.id)).map(seatMailMessageOf) };
  };
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read, receipts: { record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); } } },
    ...(adapter ? { mailAdapter: adapter } : {}), onReadError: () => {}, log: () => {},
    timer: { set: () => 't', clear: () => {} }, retryTimer: { set: () => 1, clear: () => {} },
  });
  const ledger = { list: (r: string, after = 0) => store.listByRecipient(r, after) as Message[], getCursor: () => 0, getMessage: () => null };
  const plan = wireSeatMailToPlan(seatTaskQueueFromPromptQueue(queue), { seat: SEAT, ledger,
    ...(adapter ? { mailAdapter: adapter } : {}), recordReceipts: (inputs) => { for (const i of inputs) store.recordReceipt(i); } });
  const notices = () => queue.items.filter(item => item.kind === 'notice');
  return { store, queue, watcher, plan, notices };
}

for (const withAdapter of [false, true]) {
  describe(`TURN-FIELD-BUG-3 (${withAdapter ? 'C3 adapter on' : 'flag off'})`, () => {
    test('second idle mail lands during a turn, the plan absorbs it at the turn end with 0 items → it still opens exactly one turn', () => {
      const w = world(withAdapter);
      w.watcher.poll(); // baseline
      const first = w.store.post({ from: 'RES-SIM', to: SEAT, body: 'capsule-tu sim-mail-c3a s1 C3 유휴 배출 1' });
      w.watcher.poll();
      expect(w.notices().map(n => n.msgId)).toEqual([first.id]);
      w.queue.dequeue(); // turn 1 runs
      const second = w.store.post({ from: 'RES-SIM', to: SEAT, body: 'capsule-tu sim-mail-c3b s1 C3 유휴 배출 2' });
      w.watcher.noteTurnFinished(true);
      w.plan.absorb(); // settle → absorb, before the watcher's next 15s poll
      expect(w.plan.plan()).toEqual([]); // not a work request: no plan item
      w.watcher.poll();
      expect(w.notices().map(n => n.msgId)).toEqual([second.id]); // the second mail's own turn
      expect(w.store.listReceipts({ messageId: second.id }).some(r => r.source === 'plan')).toBe(false);
    });
  });
}

describe('JUD #38701 ⓑ — a mail folded into an existing plan item is the plan\'s (no second turn)', () => {
  for (const withAdapter of [false, true]) {
    test(`a second request about the same target folds into the active item: plan receipt 1 · no watcher notice (${withAdapter ? 'C3 adapter on' : 'flag off'})`, () => {
      const w = world(withAdapter);
      w.watcher.poll(); // baseline
      const first = w.store.post({ from: 'OP', to: SEAT, body: '#38007 merge 충돌 해소 시험 보고' });
      w.plan.absorb(); // boot absorb: the plan carries #38007
      expect(w.plan.plan().filter(item => item.status === 'active')).toHaveLength(1);
      const folded = w.store.post({ from: 'OP', to: SEAT, body: '#38007 시험 다시 보고' });
      w.plan.absorb(); // folds into the #38007 host
      expect(w.store.listReceipts({ messageId: folded.id }).filter(r => r.source === 'plan').map(r => r.state)).toEqual(['delivered']);
      w.watcher.poll();
      expect(w.notices().filter(n => n.msgId === folded.id || n.msgId === first.id)).toEqual([]); // no per-message notice: no double turn
    });
  }
});
