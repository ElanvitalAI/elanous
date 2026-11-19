import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeatMailInbox, formatSeatMailPrompt, type SeatMailInboxStore, type SeatMailItem } from './seat-mail-boot.js';

/** 인메모리 가짜 원장 — listByRecipient(after) 는 cursor 초과만, advanceCursor 단조 위반 throw 재현. */
class FakeStore implements SeatMailInboxStore {
  messages: SeatMailItem[] = [];
  cursors = new Map<string, number>();
  acked: Array<{ recipient: string; id: number; status: string }> = [];
  closed = 0;
  getCursor(recipient: string): number { return this.cursors.get(recipient) ?? 0; }
  listByRecipient(recipient: string, after = 0, limit = 100): SeatMailItem[] { // 근거: #38057 — 실제 MsgStore.listByRecipient 계약 기본값을 그대로 반영한 스텁
    return this.messages.filter((m) => m.id > after).slice(0, limit);
  }
  advanceCursor(recipient: string, cursor: number): number {
    if (cursor < this.getCursor(recipient)) throw new Error('cursor exceeds the latest message ID');
    this.cursors.set(recipient, cursor);
    return cursor;
  }
  ackMessage(recipient: string, messageId: number, status: 'acked' | 'done' = 'acked'): boolean {
    this.acked.push({ recipient, id: messageId, status });
    return true;
  }
  close(): void { this.closed += 1; }
}

type Gate = { opened: boolean; reason?: string };
function makeDeps(store: FakeStore, gate: { mode: Gate[]; calls: Array<{ text: string; origin?: string; reason?: string }> }) {
  return {
    seat: 'OPC',
    msgPath: '/tmp/fake-messages.db',
    startTurnIfIdle: (input: string, opts: { origin?: string; reason?: string }) => {
      gate.calls.push({ text: input, origin: opts.origin, reason: opts.reason });
      const next = gate.mode.shift() ?? { opened: true };
      return next.opened
        ? { opened: true as const, turnId: 't1' }
        : { opened: false as const, reason: 'NotIdle' as const };
    },
    openStore: () => store,
    defer: (fn: () => void) => { fn(); },
  };
}

function items(...ids: number[]): SeatMailItem[] {
  return ids.map((id) => ({ id, from: 'OP', body: `우편 ${id}` }));
}

describe('createSeatMailInbox — 턴 경계 자동 수신', () => {
  test('① 주입 턴에는 ack 안 함 — 다음 경계에서 커서 이후 미읽음 ack+advanceCursor(mustFix)', () => {
    const store = new FakeStore();
    store.messages = items(1, 2, 3);
    store.cursors.set('OPC', 2);
    const gate = { mode: [{ opened: true }], calls: [] as Array<{ text: string; origin?: string }> };
    const inbox = createSeatMailInbox(makeDeps(store, gate));
    inbox.noteTurnEnded();
    const calls = gate.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toContain('msg:3');
    expect(calls[0]!.text).not.toContain('msg:1');
    expect(calls[0]!.text).not.toContain('msg:2');
    expect(calls[0]!.origin).toBe('msg-wake');
    // 주입 시점(처리 전)에는 ack 도 커서 이동도 없다 — 처리 뒤 ack 계약.
    expect(store.acked).toEqual([]);
    expect(store.getCursor('OPC')).toBe(2);
    // 주입된 턴이 끝난 다음 경계에서 그때 주입했던 우편을 ack.
    store.messages = []; // 새 우편 없음 — 1단계 ack 만 일어난다.
    inbox.noteTurnEnded();
    expect(store.acked).toEqual([{ recipient: 'OPC', id: 3, status: 'acked' }]);
    expect(store.getCursor('OPC')).toBe(3);
    expect(calls.length).toBe(1); // 재주입 없음
    inbox.stop();
  });

  test('② 거부(NotIdle) 시 ack 안 함 · 커서 안 움직임 · 다음 경계에 같은 배치 재주입', () => {
    const store = new FakeStore();
    store.messages = items(5, 6);
    const gateMode: Gate[] = [{ opened: false, reason: 'NotIdle' }, { opened: true }];
    const calls: Array<{ text: string; origin?: string; reason?: string }> = [];
    const inbox = createSeatMailInbox({
      seat: 'OPC', msgPath: 'x',
      startTurnIfIdle: (input, opts) => {
        calls.push({ text: input, origin: opts.origin, reason: opts.reason });
        const next = gateMode.shift()!;
        return next.opened ? { opened: true, turnId: 't2' } : { opened: false, reason: 'NotIdle' };
      },
      openStore: () => store,
      defer: (fn) => { fn(); },
    });
    inbox.noteTurnEnded();
    expect(store.acked).toEqual([]);
    expect(store.getCursor('OPC')).toBe(0);
    inbox.noteTurnEnded();
    expect(calls.length).toBe(2);
    expect(calls[1]!.text).toContain('msg:5');
    expect(calls[1]!.text).toContain('msg:6');
    // 주입 성공 턴에도 즉시 ack 없음 — 다음 경계에 ack.
    expect(store.acked).toEqual([]);
    expect(store.getCursor('OPC')).toBe(0);
    store.messages = [];
    inbox.noteTurnEnded();
    expect(store.acked.length).toBe(2);
    expect(store.getCursor('OPC')).toBe(6);
    expect(calls.length).toBe(2);
    inbox.stop();
  });

  test('③ 성공 주입 → 다음 경계에서 전 건 ackMessage(acked) + advanceCursor(maxId)', () => {
    const store = new FakeStore();
    store.messages = items(10, 11, 12);
    const inbox = createSeatMailInbox({
      seat: 'OPC', msgPath: 'x',
      startTurnIfIdle: () => ({ opened: true, turnId: 't3' }),
      openStore: () => store,
      defer: (fn) => { fn(); },
    });
    const result = inbox.check();
    // 무장 없이 직접 check 는 no-op(⑤) — 먼저 무장.
    expect(result).toEqual({ delivered: false, count: 0 });
    inbox.noteTurnEnded();
    expect(store.acked).toEqual([]);
    expect(store.getCursor('OPC')).toBe(0);
    store.messages = [];
    inbox.noteTurnEnded();
    expect(store.acked).toEqual([
      { recipient: 'OPC', id: 10, status: 'acked' },
      { recipient: 'OPC', id: 11, status: 'acked' },
      { recipient: 'OPC', id: 12, status: 'acked' },
    ]);
    expect(store.getCursor('OPC')).toBe(12);
    // noteTurnEnded × 2 → check 2회 → finally close 정확히 2회 (0회는 미수신, 3회 이상은 재개방).
    expect(store.closed).toBe(2);
    inbox.stop();
  });

  test('④ 200자 초과 본문도 전문 주입 — 잘림으로 뒷부분 지시가 유실되지 않는다(mustFix ①)', () => {
    const store = new FakeStore();
    const tail = '끝까지-전달-마커';
    const body = 'X'.repeat(500) + tail;
    store.messages = [{ id: 30, from: 'OP', body }];
    const gate = { mode: [{ opened: true }], calls: [] as Array<{ text: string }> };
    const inbox = createSeatMailInbox(makeDeps(store, gate));
    inbox.noteTurnEnded();
    expect(gate.calls.length).toBe(1);
    expect(gate.calls[0]!.text).toContain(body); // 500자+마커 전문
    expect(gate.calls[0]!.text.endsWith(tail)).toBe(true);
    inbox.stop();
  });

  test('⑤ 무장 전 check 는 no-op (delivered=false, throw 없음)', () => {
    const store = new FakeStore();
    store.messages = items(20);
    const inbox = createSeatMailInbox({
      seat: 'OPC', msgPath: 'x',
      startTurnIfIdle: () => { throw new Error('must not be called'); },
      openStore: () => store,
      defer: (fn) => { fn(); },
    });
    expect(inbox.check()).toEqual({ delivered: false, count: 0 });
    expect(store.acked).toEqual([]);
    inbox.stop();
  });

  test('⑥ store open 실패 시 fail-soft (delivered=false, throw 없음) — pendingAck 도 유실 없이 보존', () => {
    const store = new FakeStore();
    store.messages = items(40);
    let fail = false;
    const gate = { mode: [{ opened: true }], calls: [] as Array<{ text: string }> };
    const inbox = createSeatMailInbox({
      ...makeDeps(store, gate),
      openStore: () => { if (fail) throw new Error('ECONNREFUSED'); return store; },
    });
    inbox.noteTurnEnded(); // 주입
    fail = true;
    store.messages = [];
    expect(() => { inbox.noteTurnEnded(); }).not.toThrow(); // ack 단계에서 store 실패
    expect(store.acked).toEqual([]);
    fail = false;
    inbox.noteTurnEnded(); // 다음 경계에서 pendingAck 재시도 → ack
    expect(store.acked).toEqual([{ recipient: 'OPC', id: 40, status: 'acked' }]);
    expect(store.getCursor('OPC')).toBe(40);
    inbox.stop();
  });

  test('포맷 스냅샷 — formatSeatMailPrompt', () => {
    expect(formatSeatMailPrompt('OPC', items(1, 2))).toBe(
      '[우편 수신] OPC 앞 2통(턴 경계 자동 수신 · 처리 뒤 ack) — 위부터 읽고 처리하세요:\n[from OP · info]\nmsg:1 · 우편 1\n\n[from OP · info]\nmsg:2 · 우편 2',
    );
    expect(formatSeatMailPrompt('OPC', [])).toBe(
      '[우편 수신] OPC 앞 0통(턴 경계 자동 수신 · 처리 뒤 ack) — 위부터 읽고 처리하세요:\n',
    );
  });

  test('SEAT-INBOX B1-C — 머리줄은 구조 칸(kind)에서 · 클래식 영수증 delivered(주입 턴) → seen(다음 경계)', () => {
    const store = new FakeStore();
    const receipts: Array<{ messageId: number; recipient: string; state: string; source: string }> = [];
    const withReceipts = Object.assign(store, {
      recordReceipt: (input: { messageId: number; recipient: string; state: string; source: string }) => {
        receipts.push({ messageId: input.messageId, recipient: input.recipient, state: input.state, source: input.source });
        return { recorded: false as const, reason: 'not-forward' as const, current: null };
      },
    });
    store.messages = [{ id: 50, from: 'OP', body: '결정 바람', kind: 'question' }];
    const gate = { mode: [{ opened: true }], calls: [] as Array<{ text: string }> };
    const inbox = createSeatMailInbox({ ...makeDeps(store, gate), openStore: () => withReceipts });
    inbox.noteTurnEnded();
    expect(gate.calls[0]!.text).toContain('[from OP · request]\nmsg:50 · 결정 바람');
    expect(receipts).toEqual([{ messageId: 50, recipient: 'OPC', state: 'delivered', source: 'dashboard-inbox' }]);
    store.messages = [];
    inbox.noteTurnEnded();
    expect(receipts.map(r => r.state)).toEqual(['delivered', 'seen']);
    expect(store.acked).toEqual([{ recipient: 'OPC', id: 50, status: 'acked' }]);
    inbox.stop();
  });
});

describe('createSeatMailInbox — §2b 박동(heartbeat) 배선', () => {
  test('① 주입 heartbeat: alivePath에 JSON beat 즉시 1회 기록(pid·host·beatAt) + stop() no-throw', () => {
    const store = new FakeStore();
    const gate = { mode: [] as Gate[], calls: [] as Array<{ text: string }> };
    const dir = mkdtempSync(join(tmpdir(), 'seat-inbox-hb-'));
    const p = join(dir, 'inbox.alive');
    try {
      const inbox = createSeatMailInbox({ ...makeDeps(store, gate), heartbeat: { alivePath: p, host: 'h1', intervalMs: 60_000, sessionId: 'sess-t1' } });
      const raw = readFileSync(p, 'utf8');
      const beat = JSON.parse(raw) as { pid: number; host: string; sessionId: string; beatAt: string };
      expect(beat.pid).toBe(process.pid);
      expect(beat.host).toBe('h1');
      expect(beat.sessionId).toBe('sess-t1');
      expect(typeof beat.beatAt).toBe('string');
      expect(() => { inbox.stop(); }).not.toThrow();
      // stop 뒤 재기록 없음 — 60s interval이라 시험 중 반복은 없고, stop이 예외 없이 타이머를 정리한다.
      expect(readFileSync(p, 'utf8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('② 미주입: heartbeat 필드 없이도 생성·stop no-throw(회귀) — 파일 시스템에 아무 것도 쓰지 않는다', () => {
    const store = new FakeStore();
    const gate = { mode: [] as Gate[], calls: [] as Array<{ text: string }> };
    const inbox = createSeatMailInbox(makeDeps(store, gate));
    expect(inbox.check()).toEqual({ delivered: false, count: 0 });
    expect(() => { inbox.stop(); }).not.toThrow();
  });
});

describe('createSeatMailInbox — §2b 박동 sessionId 부재 방어(OP #93799)', () => {
  test('③ getSessionId 가 빈 값을 주면 박동을 쓰지 않고 이유(no-session-id)를 기록한다', () => {
    const store = new FakeStore();
    const gate = { mode: [] as Gate[], calls: [] as Array<{ text: string }> };
    const dir = mkdtempSync(join(tmpdir(), 'seat-inbox-hb-nosession-'));
    const p = join(dir, 'inbox.alive');
    const logged: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    try {
      const inbox = createSeatMailInbox({
        ...makeDeps(store, gate),
        log: (category, event, data) => { logged.push({ category, event, data }); },
        heartbeat: { alivePath: p, host: 'h1', intervalMs: 60_000, getSessionId: () => null },
      });
      expect(existsSync(p)).toBe(false); // 빈 id로는 박동 파일이 생기지 않는다
      const skip = logged.find(l => l.event === 'heartbeat-skipped-no-session-id');
      expect(skip).toBeDefined();
      expect(skip!.category).toBe('tui.seat-mail-inbox');
      expect(skip!.data).toEqual({ reason: 'no-session-id', path: p, host: 'h1' });
      expect(() => { inbox.stop(); }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
