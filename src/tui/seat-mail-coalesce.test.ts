// SEAT-MAIL-COALESCE-NOTICE — seat mail reaches a turn as ONE digest; info mail opens no turn of its own and is acked
// per id after the digest turn; a mail is re-injected at most once. Expected values are literals (rule 11).
// Synthesis: real MsgStore (:memory:) ⊕ real createNextTuiQueue ⊕ real watcher ⊕ real adapter; the door is the
// entry.ts split in miniature (autoDispatchCount → drainNotices → seatMailBundleText → noteTurnFinished).
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiQueue } from './core/queue.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js';
import { isInfoSeatMail, seatMailBundleText, seatMailDigestLine } from './seat-mail-digest.js';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';
import { seatMailMessageOf, type SeatMailMessageRead } from './seat-message-receipts.js';
import { createSeatMailAdapter } from './turn-events/mail-adapter.js';

const SEAT = 'OPX';
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); setSystemTime(); });

describe('classification and digest text', () => {
  test('info kinds are passive; kind-less, request, decision and urgent mail are not', () => {
    expect(isInfoSeatMail({ id: 1, sender: 'TC', body: 'landed', kind: 'info' })).toBe(true);
    expect(isInfoSeatMail({ id: 2, sender: 'TC', body: 'ok', kind: 'ack' })).toBe(true);
    expect(isInfoSeatMail({ id: 3, sender: 'JUD', body: 'r', kind: 'receipt' })).toBe(true);
    expect(isInfoSeatMail({ id: 4, sender: 'JUD', body: 'r', kind: 'receipts' })).toBe(true);
    expect(isInfoSeatMail({ id: 5, sender: 'REL', body: 'r', kind: 'retro' })).toBe(true);
    expect(isInfoSeatMail({ id: 6, sender: 'REL', body: 'r', kind: 'retro-report' })).toBe(true);
    expect(isInfoSeatMail({ id: 7, sender: 'TC', body: 'do this' })).toBe(false);
    expect(isInfoSeatMail({ id: 8, sender: 'TC', body: 'do this', kind: null, intent: 'info' })).toBe(false);
    expect(isInfoSeatMail({ id: 9, sender: 'TC', body: 'x', kind: 'request' })).toBe(false);
    expect(isInfoSeatMail({ id: 10, sender: 'TC', body: 'x', kind: 'info', intent: 'decision' })).toBe(false);
    expect(isInfoSeatMail({ id: 11, sender: 'TC', body: 'x', kind: 'info', intent: 'request' })).toBe(false);
    expect(isInfoSeatMail({ id: 12, sender: 'TC', body: '🔴 host down', kind: 'info' })).toBe(false);
    expect(isInfoSeatMail({ id: 13, sender: 'TC', body: 'x', kind: 'alert' })).toBe(false);
    expect(isInfoSeatMail({ id: 14, sender: 'TC', body: 'x', kind: 'approval' })).toBe(false);
  });

  test('a digest line keeps id · from · kind · the first 120 body chars, whitespace folded', () => {
    expect(seatMailDigestLine({ id: 42, sender: 'TC', body: 'PR  #1\nlanded', kind: 'info' })).toBe('#42 · TC · info · PR #1 landed');
    expect(seatMailDigestLine({ id: 43, sender: 'MK', body: 'plain' })).toBe('#43 · MK · - · plain');
    const long = 'a'.repeat(130);
    expect(seatMailDigestLine({ id: 44, sender: 'UX', body: long, kind: 'ack' })).toBe(`#44 · UX · ack · ${'a'.repeat(120)}…`);
  });

  test('bundle text: one digest block (header + one line per mail), then action bodies only, then other notices', () => {
    const text = seatMailBundleText([
      { text: 'BODY-1', source: 'seat-mail', msgId: 1, digest: '#1 · TC · request · fix it' },
      { text: 'BODY-2', source: 'seat-mail', msgId: 2, digest: '#2 · JUD · info · passed', passive: true },
      { text: 'BODY-3', source: 'seat-mail', msgId: 3, digest: '#3 · REL · - · cut now' },
      { text: 'capsule done', source: 'capsule-done' },
    ]);
    expect(text).toBe([
      '[seat-mail digest] 3 mails — 2 need action · 1 info (every mail listed here is acked automatically after this turn)\n'
        + '- #1 · TC · request · fix it\n- #2 · JUD · info · passed\n- #3 · REL · - · cut now',
      'BODY-1', 'BODY-3', 'capsule done',
    ].join('\n\n'));
  });

  test('a single action mail keeps its plain text; a single info mail is still a digest', () => {
    expect(seatMailBundleText([{ text: 'BODY-1', source: 'seat-mail', msgId: 1, digest: '#1 · TC · - · x' }])).toBe('BODY-1');
    expect(seatMailBundleText([{ text: 'BODY-2', source: 'seat-mail', msgId: 2, digest: '#2 · TC · ack · ok', passive: true }]))
      .toBe('[seat-mail digest] 1 mails — 0 need action · 1 info (every mail listed here is acked automatically after this turn)\n- #2 · TC · ack · ok');
  });
});

describe('idle door: debounce and info-only arrivals', () => {
  test('three idle arrivals inside the window knock once; info-only arrivals knock never; busy info is not carried', () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let knocks = 0;
    let busy = false;
    const carried: string[] = [];
    const onArrived = seatMailOnArrived({
      busy: () => busy, injectKey: () => { knocks += 1; }, queueWake: 'wake',
      enqueueMidTurn: (event) => { carried.push(event.id); return true; },
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    });
    onArrived([{ msgId: 1, seat: SEAT, text: 'a' }]);
    onArrived([{ msgId: 2, seat: SEAT, text: 'b' }]);
    onArrived([{ msgId: 3, seat: SEAT, text: 'c', passive: true }]);
    expect(scheduled.map((s) => s.ms)).toEqual([3_000]);
    expect(knocks).toBe(0);
    scheduled[0]!.fn();
    expect(knocks).toBe(1);
    onArrived([{ msgId: 4, seat: SEAT, text: 'd', passive: true }, { msgId: 5, seat: SEAT, text: 'e', passive: true }]);
    expect(scheduled).toHaveLength(1);
    busy = true;
    onArrived([{ msgId: 6, seat: SEAT, text: 'f', passive: true }, { msgId: 7, seat: SEAT, text: 'g' }]);
    expect(carried).toEqual(['7']);
  });
});

function world() {
  const store = new MsgStore(':memory:');
  stores.push(store);
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const adapter = createSeatMailAdapter();
  const acks: number[] = [];
  const logs: string[] = [];
  const read = (_cwd: string, afterId: number): SeatMailMessageRead => ({
    seat: SEAT, messages: store.listByRecipient(SEAT, afterId, 1000).map(seatMailMessageOf), unreadTotal: store.unreadCount(SEAT),
  });
  const watcher = createSeatMailArrivalWatcher('/h', queue, {
    messages: { read, receipts: {
      record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); },
      ack: (input) => { acks.push(input.messageId); store.ackMessage(input.recipient, input.messageId); },
    } },
    mailAdapter: adapter, onReadError: () => {}, log: (event) => { logs.push(event); }, turnLifeLog: () => {},
    timer: { set: () => 'poll-timer', clear: () => {} },
  });
  const turns: string[] = [];
  /** The entry.ts door in miniature: idle ∧ something actionable → ONE bundle turn that answers. */
  const runDoor = (): void => {
    for (let guard = 0; guard < 50; guard += 1) {
      watcher.poll();
      if (queue.autoDispatchCount === 0) return;
      const bundle = queue.drainNotices();
      if (bundle.kind !== 'notices') return;
      turns.push(seatMailBundleText(bundle.notices));
      watcher.noteTurnFinished(true, 'responded');
    }
  };
  return { store, queue, watcher, turns, acks, logs, runDoor };
}

describe('synthesis — 30-mail burst on an idle seat', () => {
  test('30 mails (10 request · 20 info) → 1 digest turn (queue cap 100 · SEAT-QUEUE-CAPACITY CEO 11-25 · was 2 turns at cap 20) · all 30 acked by id after the turns that carried them (MSG-FILTERS-RELAX)', () => {
    const w = world();
    w.watcher.poll(); // baseline
    const ids: number[] = [];
    for (let i = 1; i <= 30; i += 1) {
      const action = i % 3 === 0;
      ids.push(w.store.post({ from: 'TC', to: SEAT, body: `mail ${i}`, ...(action ? { kind: 'request' } : { kind: 'info' }) }).id);
    }
    w.runDoor();
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0]!.startsWith('[seat-mail digest] 30 mails — 10 need action · 20 info')).toBe(true);
    const infoIds = ids.filter((_, index) => (index + 1) % 3 !== 0);
    const actionIds = ids.filter((_, index) => (index + 1) % 3 === 0);
    expect([...w.acks].sort((a, b) => a - b)).toEqual(ids);
    // Every mail (info AND request) whose body rode a completed digest turn carries a `seen` receipt and is acked by id.
    expect(actionIds.map((id) => w.store.messageStatus(SEAT, id))).toEqual(Array.from({ length: 10 }, () => 'acked'));
    expect(actionIds.map((id) => w.store.listReceipts({ messageId: id }).map((r) => r.state).includes('seen'))).toEqual(Array.from({ length: 10 }, () => true));
    expect(infoIds.map((id) => w.store.messageStatus(SEAT, id))).toEqual(Array.from({ length: 20 }, () => 'acked'));
    expect(w.store.unreadCount(SEAT)).toBe(0);
    expect(w.logs.filter((event) => event === 'seat-mail-info-acked')).toHaveLength(20);
    expect(w.logs.filter((event) => event === 'seat-mail-turn-acked')).toHaveLength(10);
    // nothing comes back: the seat is quiet after the one digest turn
    w.runDoor();
    expect(w.turns).toHaveLength(1);
  });

  test('info-only mail on an idle seat opens no turn before 10 min (SEAT-REPLY-DELTA-ONLY ② ⊕ SEAT-MAIL-PASSIVE-DEFAULT), then exactly one digest turn that acks them', () => {
    const T0 = new Date('2026-11-23T22:40:00Z').getTime();
    setSystemTime(new Date(T0));
    const w = world();
    w.watcher.poll();
    for (let i = 1; i <= 5; i += 1) w.store.post({ from: 'JUD', to: SEAT, body: `receipt ${i}`, kind: 'receipt' });
    w.runDoor();
    expect(w.turns).toHaveLength(0);
    expect(w.queue.count).toBe(5);
    setSystemTime(new Date(T0 + 599_999));
    w.runDoor();
    expect(w.turns).toHaveLength(0);
    setSystemTime(new Date(T0 + 600_000));
    w.runDoor();
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0]!.startsWith('[seat-mail digest] 5 mails — 0 need action · 5 info')).toBe(true);
    expect(w.store.unreadCount(SEAT)).toBe(0);
  });

  test('a mail whose turn fails is re-injected once, then given up (left unread)', () => {
    let at = 1_000_000;
    const store = new MsgStore(':memory:');
    stores.push(store);
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const logs: string[] = [];
    const watcher = createSeatMailArrivalWatcher('/h', queue, {
      messages: { read: (_c, after) => ({ seat: SEAT, messages: store.listByRecipient(SEAT, after).map(seatMailMessageOf) }),
        receipts: { record: (input) => { store.recordReceipt({ ...input, source: 'tui-queue' }); } } },
      mailAdapter: createSeatMailAdapter({ now: () => at }), onReadError: () => {}, log: (event) => { logs.push(event); },
      turnLifeLog: () => {}, timer: { set: () => 't', clear: () => {} },
    });
    watcher.poll();
    store.post({ from: 'OP', to: SEAT, body: 'do it', kind: 'request' });
    let turns = 0;
    for (let round = 0; round < 7; round += 1) {
      watcher.poll();
      if (queue.drainNotices().kind === 'notices') {
        turns += 1;
        watcher.noteTurnFinished(false, round % 2 === 0 ? 'failed' : 'cancelled');
      }
      at += 300_000;
    }
    expect(turns).toBe(2);
    expect(logs.filter((event) => event === 'seat-mail-requeued')).toHaveLength(1);
    expect(logs.filter((event) => event === 'seat-mail-gave-up')).toHaveLength(1);
    expect(store.unreadCount(SEAT)).toBe(1);
  });
});

describe('SEAT-MAIL-PASSIVE-DEFAULT — passive lines are short and fold by sender', () => {
  test('a passive digest line keeps 24 body chars', () => {
    expect(seatMailDigestLine({ id: 7, sender: 'TC-H1', body: 'abcdefghijklmnopqrstuvwxyz0123', kind: 'notice' }, 24)).toBe('#7 · TC-H1 · notice · abcdefghijklmnopqrstuvwx…');
  });
  test('2+ passive mails from one sender fold into one line at the first one\'s place; action lines stay as they are', () => {
    const text = seatMailBundleText([
      { text: 'P1', source: 'seat-mail', msgId: 11, passive: true, digest: '#11 · TC-H1 · status · a', mail: { sender: 'TC-H1', digestBodyAt: 23 } },
      { text: 'Q', source: 'seat-mail', msgId: 12, digest: '#12 · UX · question · go?', mail: { sender: 'UX', digestBodyAt: 22 } },
      { text: 'P2', source: 'seat-mail', msgId: 13, passive: true, digest: '#13 · TC-H1 · - · b', mail: { sender: 'TC-H1', digestBodyAt: 18 } },
      { text: 'P3', source: 'seat-mail', msgId: 14, passive: true, digest: '#14 · JUD · notice · c', mail: { sender: 'JUD', digestBodyAt: 21 } },
    ]);
    expect(text).toBe([
      '[seat-mail digest] 4 mails — 1 need action · 3 info (every mail listed here is acked automatically after this turn)\n'
        + '- TC-H1 ×2 · #11 status · #13 -\n- #12 · UX · question · go?\n- #14 · JUD · notice · c',
      'Q',
    ].join('\n\n'));
  });
});
