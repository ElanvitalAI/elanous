// JUD-B 113279·113280·113271·113284 — real watcher ⊕ adapter ⊕ real queue ⊕ isolated MsgStore, with a recordDone spy:
// cancel / partial answer → no done · no seen · back in the queue; completed → seen 1 · done 1; mail carried mid-turn is
// settled by that turn's outcome (never a silent loss, never a re-notice loop).
import { afterEach, describe, expect, test } from 'bun:test';
import { MsgStore, type Message } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { seatTaskQueueFromPromptQueue, wireSeatMailToPlan } from './seat-mail-boot.js';
import { seatMailMessageOf, type SeatMailMessageRead } from './seat-message-receipts.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';

const SEAT = 'TC-H-CC-5';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  let at = 2_000_000;
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const adapter = createSeatMailAdapter({ now: () => at });
  const doneCalls: number[] = [];
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => ({ seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(seatMailMessageOf) });
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read, receipts: {
      record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); },
      recordDone: (input) => { doneCalls.push(input.messageId); },
    } },
    mailAdapter: adapter,
    onArrived: () => {},
    onReadError: () => {},
    log: () => {},
    timer: { set: () => 'poll-timer', clear: () => {} },
    retryTimer: { set: () => 1, clear: () => {} },
  });
  const notices = () => queue.items.filter((item) => item.kind === 'notice').map((item) => item.msgId);
  const states = (id: number) => store.listReceipts({ messageId: id }).map((r) => r.state);
  const arrive = () => {
    watcher.poll();
    const posted = store.post({ from: 'OP', to: SEAT, body: '지시' });
    watcher.poll();
    return posted;
  };
  return { store, queue, adapter, watcher, doneCalls, notices, states, arrive, advance: (ms: number) => { at += ms; } };
}

describe('JUD-B 113279 — real cancel → outcome → persisted receipt / done', () => {
  test('cancelled turn with partial output: done 0 · no seen · back in the queue', () => {
    const f = fixture();
    const posted = f.arrive();
    expect(f.queue.dequeue().kind).toBe('submit');
    f.watcher.noteTurnFinished(true, 'cancelled');
    expect(f.doneCalls).toEqual([]);
    expect(f.states(posted.id)).toEqual(['posted', 'delivered']);
    expect(f.notices()).toEqual([posted.id]);
  });

  test('completed turn: seen 1 · done 1 · nothing re-queued', () => {
    const f = fixture();
    const posted = f.arrive();
    expect(f.queue.dequeue().kind).toBe('submit');
    f.watcher.noteTurnFinished(true, 'responded');
    expect(f.doneCalls).toEqual([posted.id]);
    expect(f.states(posted.id).filter((state) => state === 'seen')).toHaveLength(1);
    expect(f.notices()).toEqual([]);
  });
});

describe('JUD-B 113271 — mail carried into a running turn (mid-turn-carried cancel)', () => {
  test('the carrying turn fails: the mail is not lost — it comes back after the back-off', () => {
    const f = fixture();
    const posted = f.arrive();
    const notice = f.queue.items.find((item) => item.kind === 'notice')!;
    f.queue.cancel(notice.id, 'mid-turn-carried'); // the turn drained it into its model input
    f.watcher.noteTurnFinished(false, 'failed');
    expect(f.doneCalls).toEqual([]);
    f.advance(15_000);
    f.watcher.poll();
    expect(f.notices()).toEqual([posted.id]);
  });

  test('the carrying turn completes: acked once (seen 1 · done 1), never re-noticed', () => {
    const f = fixture();
    const posted = f.arrive();
    const notice = f.queue.items.find((item) => item.kind === 'notice')!;
    f.queue.cancel(notice.id, 'mid-turn-carried');
    f.watcher.noteTurnFinished(true, 'responded');
    expect(f.doneCalls).toEqual([posted.id]);
    expect(f.states(posted.id).filter((state) => state === 'seen')).toHaveLength(1);
    f.advance(60_000);
    f.watcher.poll();
    expect(f.notices()).toEqual([]);
  });

  test('a person cancel (not carried) still releases the claim and acks nothing', () => {
    const f = fixture();
    const posted = f.arrive();
    const notice = f.queue.items.find((item) => item.kind === 'notice')!;
    f.queue.cancel(notice.id, 'person');
    f.watcher.noteTurnFinished(true, 'responded');
    expect(f.doneCalls).toEqual([]);
    expect(f.adapter.owner(posted.id)).toBeNull();
  });

  test('order: the carrying turn settles first, then the plan absorbs at the turn end — the plan does not plan it again', () => {
    const f = fixture();
    const port = seatTaskQueueFromPromptQueue(f.queue);
    const ledger = { list: (recipient: string, after = 0) => f.store.listByRecipient(recipient, after) as Message[], getCursor: () => 0, getMessage: () => null };
    const plan = wireSeatMailToPlan(port, { seat: SEAT, ledger, mailAdapter: f.adapter });
    const posted = f.arrive();
    const notice = f.queue.items.find((item) => item.kind === 'notice')!;
    f.queue.cancel(notice.id, 'mid-turn-carried');
    f.watcher.noteTurnFinished(true, 'responded');
    plan.absorb();
    expect(plan.plan()).toEqual([]);
    expect(f.adapter.owner(posted.id)).toBe('done');
    expect(f.notices()).toEqual([]);
  });
});
