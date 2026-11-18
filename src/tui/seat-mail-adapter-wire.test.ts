// CAPSULE-C3 PR-b — the seat's one mail owner wired into the notice watcher (1a) and the plan absorb (flag on only).
// Real createNextTuiQueue ⊕ :memory: ledger ⊕ fake clock; poll() is called directly (no 15s timer).
import { afterEach, describe, expect, test } from 'bun:test';
import { MsgStore, type Message } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { seatTaskQueueFromPromptQueue, wireSeatMailToPlan } from './seat-mail-boot.js';
import { seatMailMessageOf, type SeatMailMessageRead } from './seat-message-receipts.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';

const SEAT = 'TC-H-CC-4';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(opts: { failRead?: () => boolean } = {}) {
  let at = 1_000_000;
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {} });
  const adapter = createSeatMailAdapter({ now: () => at });
  const logs: Array<[string, Record<string, unknown>]> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let arrived = 0;
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => {
    if (opts.failRead?.()) throw new Error('database is locked');
    return { seat: SEAT, messages: store.listByRecipient(SEAT, afterId).map(seatMailMessageOf) };
  };
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read, receipts: { record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); } } },
    mailAdapter: adapter,
    onArrived: () => { arrived += 1; },
    onReadError: () => {},
    log: (event, data) => { logs.push([event, data]); },
    timer: { set: () => 'poll-timer', clear: () => {} },
    retryTimer: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {} },
  });
  const notices = () => queue.items.filter((item) => item.kind === 'notice').map((item) => item.msgId);
  const states = (id: number) => store.listReceipts({ messageId: id }).map((r) => r.state);
  return { store, queue, adapter, watcher, logs, timers, notices, states, arrived: () => arrived,
    advance: (ms: number) => { at += ms; } };
}

describe('CAPSULE-C3 notice watcher ⊕ adapter — failed turns back off', () => {
  test('a failed turn does NOT requeue at once; the poll after 15s does; the second failure gives up (unseen)', () => {
    const f = fixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'TC', to: SEAT, body: '칸 C3', intent: 'request' });
    f.watcher.poll();
    expect(f.queue.dequeue().kind).toBe('submit');
    f.watcher.noteTurnFinished(false, 'failed'); // «Codex 인증에 실패했습니다»
    expect(f.notices()).toEqual([]);
    f.advance(14_999);
    f.watcher.poll();
    expect(f.notices()).toEqual([]);
    f.advance(1);
    f.watcher.poll();
    expect(f.notices()).toEqual([posted.id]);
    expect(f.queue.dequeue().kind).toBe('submit');
    f.watcher.noteTurnFinished(false, 'failed');
    f.advance(60_000);
    f.watcher.poll();
    expect(f.notices()).toEqual([]);
    expect(f.states(posted.id)).toEqual(['posted', 'delivered']);
    // 출처: #38483 — one retry, so a mail is given up on its second unanswered turn
    expect(f.logs.filter(([event]) => event === 'seat-mail-gave-up')).toEqual([['seat-mail-gave-up', { msgId: posted.id, seat: SEAT, attempts: 2 }]]);
  });

  test('a completed turn with no answer is not «responded» even if the caller says so: not seen, backs off as a failure', () => {
    const f = fixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'OP', to: SEAT, body: '지시' });
    f.watcher.poll();
    f.queue.dequeue();
    f.watcher.noteTurnFinished(false, 'responded');
    expect(f.states(posted.id)).toEqual(['posted', 'delivered']);
    expect(f.adapter.owner(posted.id)).toBe('notice');
    expect(f.notices()).toEqual([]); // parked for the back-off, not re-queued at once
  });

  test('a cancelled turn is not a failure: the mail is back at once, and three cancels never give it up', () => {
    const f = fixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'OP', to: SEAT, body: '지시' });
    f.watcher.poll();
    for (let round = 0; round < 3; round += 1) {
      expect(f.queue.dequeue().kind).toBe('submit');
      f.watcher.noteTurnFinished(false, 'cancelled');
      expect(f.notices()).toEqual([posted.id]);
    }
    expect(f.queue.dequeue().kind).toBe('submit');
    f.watcher.noteTurnFinished(true);
    expect(f.states(posted.id)).toEqual(['posted', 'delivered', 'seen']);
    expect(f.adapter.owner(posted.id)).toBe('done');
  });

  test('two failed turns open the circuit: mail that lands during the outage waits parked, then queues once', () => {
    const f = fixture();
    f.watcher.poll();
    for (const body of ['a', 'b']) {
      f.store.post({ from: 'OP', to: SEAT, body });
      f.watcher.poll();
      f.queue.dequeue();
      f.watcher.noteTurnFinished(false, 'failed');
    }
    expect(f.adapter.circuitOpen('notice')).toBe(true);
    const during = f.store.post({ from: 'JUD', to: SEAT, body: 'during outage' });
    const before = f.arrived();
    f.watcher.poll();
    expect(f.notices()).toEqual([]);
    expect(f.arrived()).toBe(before); // no knock for parked mail
    f.watcher.poll();
    expect(f.notices()).toEqual([]); // a second poll does not see it as new either
    f.advance(30_000);
    f.watcher.poll();
    expect(f.notices()).toContain(during.id);
    expect(f.notices().filter((id) => id === during.id)).toHaveLength(1);
  });
});

describe('CAPSULE-C3 notice watcher ⊕ adapter — ledger read errors', () => {
  test('«database is locked» → read again in 1s, then 2s (one timer at a time); a good read resets to 1s', () => {
    let failing = true;
    const f = fixture({ failRead: () => failing });
    f.watcher.start();
    expect(f.watcher.poll()).toEqual({ kind: 'read-error' });
    expect(f.watcher.poll()).toEqual({ kind: 'read-error' }); // a retry is already armed: no second timer
    expect(f.timers.map((t) => t.ms)).toEqual([1_000]);
    f.timers[0]!.fn();
    expect(f.timers.map((t) => t.ms)).toEqual([1_000, 2_000]);
    failing = false;
    f.timers[1]!.fn();
    failing = true;
    f.watcher.poll();
    expect(f.timers.map((t) => t.ms)).toEqual([1_000, 2_000, 1_000]);
    f.watcher.stop();
  });
});

describe('CAPSULE-C3 one owner across the watcher and the plan (D9 · #87012)', () => {
  function planFixture() {
    const f = fixture();
    const port = seatTaskQueueFromPromptQueue(f.queue);
    const ledger = {
      list: (recipient: string, after = 0) => f.store.listByRecipient(recipient, after) as Message[],
      getCursor: () => 0,
      getMessage: () => null,
    };
    const plan = wireSeatMailToPlan(port, { seat: SEAT, ledger, mailAdapter: f.adapter });
    return { ...f, plan };
  }

  test('the plan absorbed the mail at boot: the watcher\'s first poll queues no second notice for it', () => {
    const f = planFixture();
    const posted = f.store.post({ from: 'TC', to: SEAT, body: '칸 CAPSULE-C3 구현 후 시험하고 보고' });
    f.plan.absorb();
    expect(f.adapter.owner(posted.id)).toBe('plan');
    const planNotices = f.queue.items.filter((item) => item.kind === 'notice').length;
    expect(planNotices).toBe(1); // the active plan item
    expect(f.watcher.poll()).toEqual({ kind: 'messages', msgIds: [] });
    expect(f.queue.items.filter((item) => item.kind === 'notice')).toHaveLength(1);
    expect(f.logs).toContainEqual(['seat-mail-dedupe-hit', { seat: SEAT, msgId: posted.id, owner: 'plan' }]);
  });

  test('JUD #38580 ⓐ — the watcher queued the notice, then the plan absorbs BEFORE that turn: no second item, one notice', () => {
    const f = planFixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'TC', to: SEAT, body: '칸 CAPSULE-C3 구현 후 시험하고 보고' });
    f.watcher.poll();
    expect(f.notices()).toEqual([posted.id]); // queued, not yet taken by a turn (still unseen in the ledger)
    f.plan.absorb(); // e.g. another turn settled first
    expect(f.plan.plan()).toEqual([]);
    expect(f.queue.items.filter((item) => item.kind === 'notice').map((item) => item.msgId ?? null)).toEqual([posted.id]);
    expect(f.adapter.owner(posted.id)).toBe('notice');
  });

  test('JUD #38626 ⓐ — the watcher\'s notice is cancelled before its turn, then the plan absorbs: the plan carries the mail', () => {
    const f = planFixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'TC', to: SEAT, body: '칸 CAPSULE-C3 구현 후 시험하고 보고' });
    f.watcher.poll();
    const notice = f.queue.items.find((item) => item.kind === 'notice')!;
    expect(notice.msgId).toBe(posted.id);
    f.queue.cancel(notice.id, 'person'); // dropped before any turn — the watcher's claim must be released
    f.plan.absorb();
    expect(f.adapter.owner(posted.id)).toBe('plan');
    expect(f.queue.items.filter((item) => item.kind === 'notice')).toHaveLength(1); // the plan item's notice — not lost
  });

  test('the watcher carried the mail first: absorb at the turn end does not plan it again', () => {
    const f = planFixture();
    f.watcher.poll();
    const posted = f.store.post({ from: 'TC', to: SEAT, body: '칸 CAPSULE-C3 구현 후 시험하고 보고' });
    f.watcher.poll();
    expect(f.notices()).toEqual([posted.id]);
    f.queue.dequeue();
    f.watcher.noteTurnFinished(true);
    f.plan.absorb();
    expect(f.plan.plan()).toEqual([]);
    expect(f.queue.items.filter((item) => item.kind === 'notice')).toEqual([]);
  });
});
