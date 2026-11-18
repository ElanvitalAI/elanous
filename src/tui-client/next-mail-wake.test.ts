import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MAIL_TURN_MAX_CHARS, AGENT_MAIL_TURN_MAX_MESSAGES, agentMailTurnText, createNextMailWake, MAIL_WAKE_NO_ANSWER_LIMIT, IDLE_MAIL_RETRY_MS, IDLE_MAIL_WATCH_MS, ledgerRecordSeen, mailWakeSource } from './next-mail-wake.js';
import { logViewLines } from '../tui/chat/log-view.js';
import type { SerializedMessage } from '../session/index.js';
import { MsgStore, readUnreadSource } from '../msg/msg-store.js';

describe('next TUI seat mail → H2 gate', () => {
  test('does not read mail without a seat opt-in', () => {
    let reads = 0;
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: false, readUnread: () => { reads++; return { count: 1, maxId: 7 }; }, // Source: #36648 isolated fake mail fixture.
      startTurnIfIdle: () => ({ opened: true, turnId: 'auto-1' }),
    });
    wake.poll();
    expect(reads).toBe(0);
    wake.dispose();
  });

  test('retries H2 refusal, delivers once, and waits for a new mail id', () => {
    let attempts = 0; // Source: #36648 first refusal then retry fixture.
    let maxId = 7; // Source: #36648 initial fake mail id.
    const calls: string[] = [];
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: true, intervalMs: 60_000,
      readUnread: () => ({ count: 1, maxId }),
      startTurnIfIdle: (text, opts) => {
        calls.push(`${opts.origin}:${text}`);
        return ++attempts === 1 ? { opened: false, reason: 'HumanTyping', detail: 'buffer' }
          : { opened: true, turnId: `auto-${attempts}` };
      },
      log: () => {},
    });
    wake.poll();
    expect(calls).toHaveLength(1);
    wake.poll();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('msg-wake:[우편 깨움] R-TICKET 미읽음 1통');
    wake.confirmDelivery();
    wake.poll();
    expect(calls).toHaveLength(2);
    maxId = 8; // Source: #36648 subsequent fake mail id.
    wake.poll();
    expect(calls).toHaveLength(3);
    wake.dispose();
  });

  test('an idle refusal is retried before the watch period, then one turn opens (ELN-EXTERNAL-EVENTS ①)', () => {
    const FIRST_ATTEMPT = 0;
    const FAKE_MAIL_ID = 83_001; // Source: #38164 idle-watch fixture id, not a bound.
    let attempts = FIRST_ATTEMPT;
    const calls: string[] = [];
    const queued: Array<() => void> = [];
    const wake = createNextMailWake({
      seat: 'HAND-TUI-D', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS,
      readUnread: () => ({ count: 1, maxId: FAKE_MAIL_ID }),
      startTurnIfIdle: (text, opts) => {
        calls.push(`${opts.origin}:${opts.reason}:${text}`);
        return ++attempts === 1 ? { opened: false, reason: 'NotIdle', detail: 'turn-running' }
          : { opened: true, turnId: 'auto-2' };
      },
      scheduleRetry: (fn) => { queued.push(fn); return { cancel: () => {} }; },
      log: () => {},
    });
    wake.poll();
    expect(calls).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(IDLE_MAIL_RETRY_MS).toBeLessThan(IDLE_MAIL_WATCH_MS);
    queued[0]!();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('msg-wake:⇢ 우편 1통:[우편 깨움] HAND-TUI-D');
    wake.confirmDelivery();
    wake.poll();
    expect(calls).toHaveLength(2);
    wake.dispose();
  });

  test('Disabled, Cap and Superseded are not retried every second (ELN-EXTERNAL-EVENTS ①)', () => {
    const FAKE_MAIL_ID = 83_002; // Source: #38164 non-deferral fixture id, not a bound.
    const queued: Array<() => void> = [];
    const reasons = ['Disabled', 'Cap', 'Superseded'] as const;
    for (const reason of reasons) {
      queued.length = 0;
      const wake = createNextMailWake({
        seat: 'HAND-TUI-D', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS,
        readUnread: () => ({ count: 1, maxId: FAKE_MAIL_ID }),
        startTurnIfIdle: () => ({ opened: false, reason }),
        scheduleRetry: (fn) => { queued.push(fn); return { cancel: () => {} }; },
        log: () => {},
      });
      wake.poll();
      expect(queued).toHaveLength(0);
      wake.dispose();
    }
  });

  test('deleting opt-in stops reads and recreation admits new mail', () => {
    const home = mkdtempSync(join(tmpdir(), 'next-mail-optin-'));
    const seatDir = join(home, 'elanous-hq', 'seat-state', 'R-TICKET');
    const switchPath = join(seatDir, 'autowake');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(switchPath, 'on\n');
    let maxId = 7; // Source: #36648 initial fake mail id.
    let reads = 0;
    let opens = 0;
    const wake = createNextMailWake({ seat: 'R-TICKET', home, intervalMs: 60_000,
      readUnread: () => { reads++; return { count: 1, maxId }; },
      startTurnIfIdle: () => ({ opened: true, turnId: `auto-${++opens}` }), log: () => {} });
    try {
      wake.poll();
      wake.confirmDelivery();
      expect({ reads, opens }).toEqual({ reads: 1, opens: 1 });
      rmSync(switchPath);
      maxId = 8; // Source: #36648 subsequent fake mail id.
      wake.poll();
      expect({ reads, opens }).toEqual({ reads: 1, opens: 1 });
      writeFileSync(switchPath, 'on\n');
      wake.poll();
      expect({ reads, opens }).toEqual({ reads: 2, opens: 2 });
    } finally {
      wake.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ELN-SEAT-TURN-PACING — mail refused by the minimum interval opens once the gap has passed', () => {
  test('Cap with retryAt arms one retry for the remaining gap, not the 15s watch period', () => {
    const waits: number[] = [];
    let first = true;
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, log: () => {},
      readUnread: () => ({ count: 1, maxId: 7 }), // Source: #36648 isolated fake mail fixture
      startTurnIfIdle: () => {
        if (!first) return { opened: true, turnId: 'auto-1' };
        first = false;
        return { opened: false, reason: 'Cap', detail: 'pacing:min-interval', retryAt: Date.now() + IDLE_MAIL_WATCH_MS * 2 };
      },
      scheduleRetry: (fn, ms) => { waits.push(ms); queueMicrotask(fn); return { cancel: () => {} }; },
    });
    wake.poll();
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThan(IDLE_MAIL_WATCH_MS);
    wake.dispose();
  });
});

describe('MSG-SOURCE: the mail-wake turn names one agent sender (ledger fields only)', () => {
  const ledger = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-wake-source-'));
    const path = join(dir, 'messages.db');
    return { dir, path, store: new MsgStore(path) };
  };

  test('all unread from OP → agent from with intent · due · newest id; the turn carries it', () => {
    const { dir, path, store } = ledger();
    try {
      const first = store.post({ from: 'OP', to: 'TC', body: 'first', intent: 'info' });
      const last = store.post({ from: 'OP', to: 'TC', body: 'second', intent: 'request', deadlineAt: '2026-11-18T03:00:00.000Z', doneWhen: 'receipt' });
      const source = readUnreadSource('TC', path);
      expect(source).toEqual({ seat: 'OP', intent: 'request', latestId: last.id, deadlineAt: '2026-11-18T03:00:00.000Z',
        messages: [{ id: first.id, body: 'first' }, { id: last.id, body: 'second' }] });
      expect(mailWakeSource(source, () => '12:00')).toEqual({ kind: 'agent', seat: 'OP', msgId: String(last.id), intent: 'request', due: '12:00' });
      const opts: unknown[] = [];
      const texts: string[] = [];
      const wake = createNextMailWake({ seat: 'TC', enabled: true, intervalMs: 60_000, log: () => {},
        readUnread: () => ({ count: 2, maxId: last.id }), readSource: (seat) => readUnreadSource(seat, path), formatDue: () => '12:00',
        recordSeen: ledgerRecordSeen(path),
        startTurnIfIdle: (text, o) => { texts.push(text); opts.push(o); return { opened: true, turnId: 'auto-1' }; } });
      wake.poll();
      expect(opts[0]).toMatchObject({ origin: 'msg-wake', from: { kind: 'agent', seat: 'OP', intent: 'request', due: '12:00' } });
      // #38203 REVIEW ①: under OP's head only what OP wrote — the bodies, oldest first, no harness instruction.
      expect(texts[0]).toBe('first\n\nsecond');
      const drawn = logViewLines([{ role: 'user', content: texts[0]!, ts: '2026-11-17T00:00:00Z', from: (opts[0] as { from: SerializedMessage['from'] }).from } as SerializedMessage], 60)
        .map(line => Bun.stripANSI(line).trimEnd()).filter(Boolean);
      expect(drawn).toEqual([`⇢ OP · request · due 12:00 · #${last.id}`, '  first', '  second']);
      // #38203 REVIEW-1 ①: starting the turn marks nothing; only an answered turn marks its bodies seen (⊕ compat ack).
      wake.confirmDelivery();
      expect(store.unreadCount('TC')).toBe(2);
      wake.noteTurnFinished(true);
      expect(store.unreadCount('TC')).toBe(0);
      expect(store.listReceipts({ messageId: first.id }).map(r => `${r.state}:${r.source}`)).toEqual(['posted:ledger', 'seen:tui-mail-wake']);
      wake.dispose();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('mixed senders or a system sender → no agent from (the turn stays system)', () => {
    const { dir, path, store } = ledger();
    try {
      store.post({ from: 'OP', to: 'TC', body: 'a' });
      const newest = store.post({ from: 'RES', to: 'TC', body: 'b' });
      expect(readUnreadSource('TC', path)).toBeNull();
      store.post({ from: 'OP', to: 'JUD', body: 'c', origin: { kind: 'system', seat: 'OP' } });
      expect(readUnreadSource('JUD', path)).toBeNull();
      expect(readUnreadSource('NOBODY', path)).toBeNull();
      expect(mailWakeSource(null)).toBeUndefined();
      const opts: Array<Record<string, unknown>> = [];
      const wake = createNextMailWake({ seat: 'TC', enabled: true, intervalMs: 60_000, log: () => {},
        readUnread: () => ({ count: 2, maxId: newest.id }), readSource: (seat) => readUnreadSource(seat, path),
        startTurnIfIdle: (_text, o) => { opts.push(o as unknown as Record<string, unknown>); return { opened: true, turnId: 'auto-1' }; } });
      wake.poll();
      expect(opts[0]!.from).toBeUndefined();
      // No agent attribution → the harness instruction (as before), and no seen is written.
      wake.dispose();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

test('#38203 REVIEW ①: a message landing between the two reads drops the attribution — no OP head over a mismatched batch', () => {
  const texts: string[] = [];
  const opts: Array<Record<string, unknown>> = [];
  const wake = createNextMailWake({ seat: 'TC', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, log: () => {},
    readUnread: () => ({ count: 2, maxId: 9 }), // Source: #36648 isolated fake mail fixture
    readSource: () => ({ seat: 'OP', intent: 'request', latestId: 8, messages: [{ id: 8, body: 'older batch' }] }),
    recordSeen: () => { throw new Error('no seen without agent bodies'); },
    startTurnIfIdle: (text, o) => { texts.push(text); opts.push(o as unknown as Record<string, unknown>); return { opened: true, turnId: 'auto-1' }; } });
  wake.poll();
  wake.confirmDelivery();
  wake.noteTurnFinished(true);
  expect(opts[0]!.from).toBeUndefined();
  expect(texts[0]).toContain('[우편 깨움] TC 미읽음 2통');
  wake.dispose();
});

describe('#38203 REVIEW-1 — no mail is lost to a turn that never answered; one turn has a size budget', () => {
  test('① a mail turn that fails or is cancelled before any answer marks nothing seen and wakes again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-wake-lost-'));
    const path = join(dir, 'messages.db');
    const store = new MsgStore(path);
    try {
      const posted = store.post({ from: 'OP', to: 'TC', body: 'do X', intent: 'info' });
      const opened: string[] = [];
      let now = 1_000_000;
      const wake = createNextMailWake({ seat: 'TC', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, log: () => {}, now: () => now,
        readUnread: () => ({ count: store.unreadCount('TC'), maxId: posted.id }), readSource: (seat) => readUnreadSource(seat, path),
        recordSeen: ledgerRecordSeen(path),
        startTurnIfIdle: (text) => { opened.push(text); return { opened: true, turnId: `auto-${opened.length}` }; } });
      wake.poll();
      wake.confirmDelivery();
      wake.noteTurnFinished(false); // aborted right after start
      expect(store.unreadCount('TC')).toBe(1);
      expect(store.listReceipts({ messageId: posted.id }).map(r => r.state)).toEqual(['posted']);
      wake.poll(); // backing off (#38219 REVIEW-2 ①) — not on the very next tick
      expect(opened).toEqual(['do X']);
      now += IDLE_MAIL_WATCH_MS;
      wake.poll(); // the same batch wakes again
      expect(opened).toEqual(['do X', 'do X']);
      wake.confirmDelivery();
      wake.noteTurnFinished(true);
      expect(store.unreadCount('TC')).toBe(0);
      wake.poll();
      expect(opened).toHaveLength(2);
      wake.dispose();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('② newest 20 bodies / 8k characters per turn, then «외 n건»; a single long body is never cut', () => {
    const many = Array.from({ length: AGENT_MAIL_TURN_MAX_MESSAGES + 5 }, (_, i) => ({ id: i + 1, body: `m${i + 1}` }));
    const text = agentMailTurnText({ messages: many });
    expect(text.startsWith('(외 5건')).toBe(true);
    expect(text.endsWith(`m${many.length}`)).toBe(true);
    expect(text).not.toContain('\n\nm5\n\n');
    const half = 'x'.repeat(AGENT_MAIL_TURN_MAX_CHARS / 2);
    const big = agentMailTurnText({ messages: [{ id: 1, body: half }, { id: 2, body: half }, { id: 3, body: half }] });
    expect(big.startsWith('(외 1건')).toBe(true);
    const huge = 'y'.repeat(AGENT_MAIL_TURN_MAX_CHARS * 2);
    expect(agentMailTurnText({ messages: [{ id: 1, body: 'old' }, { id: 2, body: huge }] })).toBe(`(외 1건 — 앞선 우편은 eln msg list 로)\n\n${huge}`);
  });
});

describe('#38204 REVIEW ① — the opened mail-wake turn records delivered exactly once', () => {
  test('opened → recordDelivered(seat, maxId, turnId) once · same batch again → not again · refused → never', () => {
    const calls: Array<[string, number, string]> = [];
    let maxId = 7; // Source: #36648 isolated fake mail fixture
    let refuse = false;
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, log: () => {},
      readUnread: () => ({ count: 1, maxId }),
      recordDelivered: (seat, id, turnId) => { calls.push([seat, id, turnId]); },
      startTurnIfIdle: () => refuse ? { opened: false, reason: 'Disabled' } : { opened: true, turnId: `auto-${maxId}` },
    });
    wake.poll();
    expect(calls).toEqual([['R-TICKET', 7, 'auto-7']]);
    wake.confirmDelivery();
    wake.poll(); // same batch: nothing new is opened or recorded
    expect(calls).toHaveLength(1);
    maxId += 1;
    refuse = true;
    wake.poll(); // a refused open never claims delivery
    expect(calls).toHaveLength(1);
    refuse = false;
    wake.poll();
    expect(calls).toEqual([['R-TICKET', 7, 'auto-7'], ['R-TICKET', 8, 'auto-8']]);
    wake.dispose();
  });
});

describe('#38219 REVIEW-2 ① — a mail turn that keeps ending with no answer backs off and then gives the batch up', () => {
  test('watch × 2^(n-1) between tries · gave-up after the limit · a new message starts fresh', () => {
    let now = 1_000_000;
    let maxId = 7; // Source: #36648 isolated fake mail fixture
    const opened: number[] = [];
    const events: string[] = [];
    const wake = createNextMailWake({
      seat: 'R-TICKET', enabled: true, intervalMs: IDLE_MAIL_WATCH_MS, now: () => now,
      log: (event) => { events.push(event); },
      readUnread: () => ({ count: 1, maxId }),
      startTurnIfIdle: () => { opened.push(maxId); return { opened: true, turnId: `auto-${opened.length}` }; },
    });
    const failOnce = () => { wake.poll(); wake.confirmDelivery(); wake.noteTurnFinished(false); };
    failOnce();
    expect(opened).toHaveLength(1);
    wake.poll(); // immediately: backing off
    expect(opened).toHaveLength(1);
    now += IDLE_MAIL_WATCH_MS - 1;
    wake.poll();
    expect(opened).toHaveLength(1);
    now += 1;
    failOnce(); // 2nd try at +watch
    expect(opened).toHaveLength(2);
    now += IDLE_MAIL_WATCH_MS; // 2nd wait is watch × 2 — not yet
    wake.poll();
    expect(opened).toHaveLength(2);
    for (let n = 2; n < MAIL_WAKE_NO_ANSWER_LIMIT; n++) { now += IDLE_MAIL_WATCH_MS * 2 ** (n - 1); failOnce(); }
    expect(opened).toHaveLength(MAIL_WAKE_NO_ANSWER_LIMIT);
    expect(events).toContain('gave-up');
    now += IDLE_MAIL_WATCH_MS * 2 ** MAIL_WAKE_NO_ANSWER_LIMIT;
    wake.poll(); // given up: this batch never opens again
    expect(opened).toHaveLength(MAIL_WAKE_NO_ANSWER_LIMIT);
    maxId += 1; // new mail starts fresh
    wake.poll();
    expect(opened).toHaveLength(MAIL_WAKE_NO_ANSWER_LIMIT + 1);
    wake.dispose();
  });
});
