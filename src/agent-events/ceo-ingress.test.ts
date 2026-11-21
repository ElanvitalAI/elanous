// CEO-CHANNEL-INGRESS ②③ — RED first. ② a CEO message is injected into the OP seat's eln session as an agent event
// (front of the current turn — the sink IS the session's turn input), ③ receipts are real only: 👀 when the session
// consumes the frame (not when it is queued), ⏰ red after 30 s without 👀, RES takeover after 5 min without ✅.
// Design: ~/elanous-hq/seat-state/OP/OP-CHANNEL-INGRESS-1121.md §② §③.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CEO_ESCALATION_TEXT, CEO_RECEIPT_GLYPH, createCeoIngress, createCeoIngressListener, parseCeoIngressFrame,
  socketCeoSink, type CeoClock, type CeoEnvelope, type CeoIngressFrame, type CeoReceipt, type CeoSessionSink, type CeoSource,
} from './ceo-ingress.js';
import { sendFrameOverSocket } from './transport.js';

class FakeClock implements CeoClock {
  private nowMs = 0;
  private order = 0;
  private due: { at: number; order: number; run: () => void; dead: boolean }[] = [];
  now(): number { return this.nowMs; }
  after(ms: number, run: () => void): unknown {
    this.due.push({ at: this.nowMs + ms, order: this.order++, run, dead: false });
    return this.due.length - 1;
  }
  cancel(handle: unknown): void { const h = this.due[handle as number]; if (h) h.dead = true; }
  advance(ms: number): void {
    this.nowMs += ms;
    const fire = this.due.filter((d) => !d.dead && d.at <= this.nowMs).sort((a, b) => (a.at - b.at) || (a.order - b.order));
    for (const d of fire) { d.dead = true; d.run(); }
  }
  pending(): number { return this.due.filter((d) => !d.dead).length; }
}

class RecordingSink implements CeoSessionSink {
  readonly frames: CeoIngressFrame[] = [];
  send(frame: CeoIngressFrame): void { this.frames.push(frame); }
}

const ceoEnvelope = (over: Partial<CeoEnvelope> = {}): CeoEnvelope => ({
  source: 'telegram', sender: 'CEO-TG-1', threadId: 'tg-9', messageId: 'm-1', text: '지금 착지 몇 개?',
  ...over,
});

const setup = (clock: FakeClock) => {
  const op = new RecordingSink();
  const res = new RecordingSink();
  const statuses: { id: string; receipt: CeoReceipt }[] = [];
  const ingress = createCeoIngress({
    ws: 'HQ', allowedSenders: ['CEO-TG-1'],
    sessions: (seat) => (seat === 'OP' ? op : seat === 'RES' ? res : undefined),
    clock, onStatus: (source, threadId, messageId, receipt) => statuses.push({ id: `${source}::${threadId}::${messageId}`, receipt }),
  });
  return { ingress, op, res, statuses, clock };
};

// ⑴ 대표 글 투입 → OP 세션 에이전트 이벤트 수신 (턴 맨 앞) — and NOT 👀 yet: the frame reached the session sink, the
// receipt stays 'pending' until the session consumes it (③: 우편함/전달 ≠ 본 것).
test('a CEO message is injected into the OP session sink as a ceo-message event, and the receipt stays pending until the session consumes it', () => {
  const clock = new FakeClock();
  const { ingress, op, res, statuses } = setup(clock);
  const submitted = ingress.submit(ceoEnvelope());
  expect(submitted).toEqual({ ok: true, messageId: 'm-1' });
  expect(op.frames.length).toBe(1);                                  // exactly one agent event into the OP session
  expect(op.frames[0].event).toEqual({ kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 'tg-9', messageId: 'm-1', text: '지금 착지 몇 개?' });
  expect(op.frames[0].op).toBe('ceo');                                // the #39370 wire conventions, reverse direction
  expect(res.frames.length).toBe(0);                                  // RES only on escalation
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('pending');                      // no 👀 for a mere delivery
  expect(statuses).toEqual([{ id: 'telegram::tg-9::m-1', receipt: 'pending' }]);
});

// ⑷ 👀는 이벤트 수신 시점에만 — ackSeen (the session took the frame into its turn input) is the only thing that turns 👀 on.
test('eyes come only when the session consumes the frame — and the three-step reactions map seen/answering/answered', () => {
  const clock = new FakeClock();
  const { ingress, op, statuses } = setup(clock);
  ingress.submit(ceoEnvelope());
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('pending');                      // delivered ≠ seen
  expect(ingress.ackSeen('telegram', 'tg-9', 'm-1')).toBe(true);                          // the OP session received it as turn input
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('seen');
  expect(CEO_RECEIPT_GLYPH.seen).toBe('👀');
  clock.advance(30_000);                                              // 👀 arrived in time → no red
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('seen');
  expect(ingress.markAnswering('telegram', 'tg-9', 'm-1')).toBe(true);                    // ⚙️ OP is writing the answer
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('answering');
  expect(CEO_RECEIPT_GLYPH.answering).toBe('⚙️');
  expect(ingress.markAnswered('telegram', 'tg-9', 'm-1')).toBe(true);                     // ✅ answer sent
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('answered');
  expect(CEO_RECEIPT_GLYPH.answered).toBe('✅');
  expect(statuses.map((s) => s.receipt)).toEqual(['pending', 'seen', 'answering', 'answered']);
  expect(op.frames.length).toBe(1);
});

// ⑵ from=OP 위장 — a frame claiming to be OP (or any non-CEO identity) is discarded before it ever reaches the OP sink.
test('a forged sender (from=OP) is discarded — sender must be a CEO on the allow-list', () => {
  const clock = new FakeClock();
  const { ingress, op, res } = setup(clock);
  expect(ingress.submit(ceoEnvelope({ sender: 'OP' }))).toEqual({ ok: false, reason: 'sender not in ceo allow-list' });
  expect(ingress.submit(ceoEnvelope({ sender: 'RES' }))).toEqual({ ok: false, reason: 'sender not in ceo allow-list' });
  expect(op.frames.length).toBe(0);
  expect(res.frames.length).toBe(0);
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBeUndefined();                      // discarded: nothing tracked, no timers armed
  expect(clock.pending()).toBe(0);
});

// ⑶ 허용 목록 밖 sender — a real external id that is simply not the CEO is discarded too, and so is a bad envelope.
test('a sender outside the allow-list is discarded, and a malformed envelope never arms the SLA', () => {
  const clock = new FakeClock();
  const { ingress, op } = setup(clock);
  expect(ingress.submit(ceoEnvelope({ sender: 'CEO-TG-2' }))).toEqual({ ok: false, reason: 'sender not in ceo allow-list' });
  expect(ingress.submit(ceoEnvelope({ source: 'slack' as unknown as CeoSource }))).toEqual({ ok: false, reason: 'unknown source' }); // 적대 source — 형은 허용 목록 유지, 런타임이 CEO_SOURCES 밖을 거부(r1 changed-tsc TS2322 수리)
  expect(ingress.submit(ceoEnvelope({ messageId: '' }))).toEqual({ ok: false, reason: 'envelope needs messageId' });
  expect(ingress.submit(ceoEnvelope({ threadId: '' }))).toEqual({ ok: false, reason: 'envelope needs threadId' });
  expect(ingress.submit(ceoEnvelope({ text: '' }))).toEqual({ ok: false, reason: 'envelope needs text' });
  expect(ingress.submit('not an envelope')).toEqual({ ok: false, reason: 'not an envelope' });
  expect(op.frames.length).toBe(0);
  expect(clock.pending()).toBe(0);
});

// ⑸ 30초 무👀 → 빨강 (가짜 시계): one tick before the deadline stays pending; the deadline turns the waiting message red.
test('thirty seconds without eyes turns the CEO-waiting message red (injected clock)', () => {
  const clock = new FakeClock();
  const { ingress, op, statuses } = setup(clock);
  ingress.submit(ceoEnvelope());
  clock.advance(29_999);
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('pending');
  clock.advance(1);
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('pending-red');
  expect(statuses.map((s) => s.receipt)).toEqual(['pending', 'pending-red']);
  expect(CEO_RECEIPT_GLYPH['pending-red']).toBe('🔴');
  expect(op.frames.length).toBe(1);                                   // red is a receipt state, not a re-injection
});

// ⑹ 5분 무✅ → 같은 스레드에 «⏰ OP 무응답 5분 · RES 대신 받음» + RES 탭에 같은 이벤트 전달.
test('five minutes without a ✅ hands the same event to RES plus the ⏰ notice in the same thread', () => {
  const clock = new FakeClock();
  const { ingress, res, statuses } = setup(clock);
  ingress.submit(ceoEnvelope());
  ingress.ackSeen('telegram', 'tg-9', 'm-1');                                             // seen: the 30 s red never fires
  clock.advance(299_999);
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('seen');
  clock.advance(1);                                                   // 5 min since submit, no ✅
  expect(ingress.status('telegram', 'tg-9', 'm-1')).toBe('res-took-over');
  expect(CEO_ESCALATION_TEXT).toBe('⏰ OP 무응답 5분 · RES 대신 받음');
  expect(res.frames.length).toBe(2);
  expect(res.frames[0].event).toEqual({ kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 'tg-9', messageId: 'm-1', text: '지금 착지 몇 개?' });
  expect(res.frames[1].event).toEqual({ kind: 'ceo-escalation', threadId: 'tg-9', messageId: 'm-1', text: '⏰ OP 무응답 5분 · RES 대신 받음' });
  expect(statuses.map((s) => s.receipt)).toEqual(['pending', 'seen', 'res-took-over']);
});

// ⑺ 답 완료(✅) → RES 대행 중단 · 타이머 정리. Both variants: ✅ before the takeover (nothing ever reaches RES) and ✅ after
// the takeover (RES is told to stop).
test('a ✅ answer clears every timer — RES never takes over; a late ✅ after the takeover tells RES to stop', () => {
  const clock = new FakeClock();
  const clean = setup(clock);
  clean.ingress.submit(ceoEnvelope());
  clean.ingress.ackSeen('telegram', 'tg-9', 'm-1');
  clean.ingress.markAnswered('telegram', 'tg-9', 'm-1');
  expect(clean.ingress.status('telegram', 'tg-9', 'm-1')).toBe('answered');
  clock.advance(600_000);
  expect(clean.res.frames.length).toBe(0);                            // ✅ in time: RES never involved
  expect(clock.pending()).toBe(0);                                    // 타이머 정리
  expect(clean.statuses.map((s) => s.receipt)).toEqual(['pending', 'seen', 'answered']);

  const late = setup(new FakeClock());
  late.ingress.submit(ceoEnvelope({ messageId: 'm-2' }));
  late.ingress.ackSeen('telegram', 'tg-9', 'm-2');
  late.clock.advance(300_000);                                        // RES already took over
  expect(late.res.frames.length).toBe(2);
  late.ingress.markAnswered('telegram', 'tg-9', 'm-2');                                   // OP answered anyway → stop the RES takeover
  expect(late.res.frames.length).toBe(3);
  expect(late.res.frames[2].event).toEqual({ kind: 'ceo-takeover-cancel', threadId: 'tg-9', messageId: 'm-2' });
  expect(late.ingress.status('telegram', 'tg-9', 'm-2')).toBe('answered');
  late.clock.advance(600_000);
  expect(late.res.frames.length).toBe(3);                             // nothing further, no re-escalation
  expect(late.clock.pending()).toBe(0);
});

// ⑻ 중복 messageId — a retry of the same channel message is injected exactly once.
test('a duplicate messageId is injected once and rejected on the retry', () => {
  const clock = new FakeClock();
  const { ingress, op } = setup(clock);
  expect(ingress.submit(ceoEnvelope())).toEqual({ ok: true, messageId: 'm-1' });
  expect(ingress.submit(ceoEnvelope())).toEqual({ ok: false, reason: 'duplicate message in this conversation' });
  expect(ingress.submit(ceoEnvelope({ text: '다른 글' }))).toEqual({ ok: false, reason: 'duplicate message in this conversation' });
  expect(op.frames.length).toBe(1);
  expect(clock.pending()).toBe(2);                                    // exactly one red + one escalate timer
});

// ② over the real wire — the els side pushes over the same #39370 transport conventions (one JSON frame per line, one
// JSON answer line), the core side hosts the ceo socket. The consumer (the eln session) turns the frame into turn input
// and acks — 👀 is real. A hostile frame ends as one answer line, never a crash.
test('host→core push works over a real socket, and the session consumer acks seen; hostile frames are answered, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceo-ingress-'));
  const socketPath = join(dir, 'ceo.sock');
  const consumed: CeoIngressFrame[] = [];
  const clock = new FakeClock();
  const holder: { ingress?: ReturnType<typeof createCeoIngress> } = {};
  const listener = await createCeoIngressListener({
    socketPath,
    authSecret: 'tab-secret-1',
    onFrame: (frame) => {
      consumed.push(frame);
      if (frame.event.kind === 'ceo-message') holder.ingress?.ackSeen(frame.event.source, frame.event.threadId, frame.event.messageId);
    },
  });
  try {
    const op = socketCeoSink({ socketPath, ws: 'HQ', pane: 'p-op', authSecret: 'tab-secret-1' });
    const res = new RecordingSink();
    holder.ingress = createCeoIngress({
      ws: 'HQ', allowedSenders: ['CEO-TG-1'], sessions: (seat) => (seat === 'OP' ? op : seat === 'RES' ? res : undefined), clock,
    });
    holder.ingress.submit(ceoEnvelope());
    const deadline = Date.now() + 5_000;
    while (consumed.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(consumed.length).toBe(1);
    expect(consumed[0].ws).toBe('HQ');
    expect(consumed[0].pane).toBe('p-op');
    expect(consumed[0].event.kind).toBe('ceo-message');
    expect(holder.ingress.status('telegram', 'tg-9', 'm-1')).toBe('seen');                 // ② full loop: push → session consumed → 👀
    const hostile = await sendFrameOverSocket(socketPath, { get op() { throw new Error('boom'); } } as never);
    expect(hostile.exitCode).toBe(1);                                 // answered with a refusal, the listener lives on
    const second = await sendFrameOverSocket(socketPath, { op: 'ceo', v: 99, ws: 'HQ', seq: 9, at: 1, event: { kind: 'nope' } } as never);
    expect(second.exitCode).toBe(0);                                  // unknown version/kind → ignored, but answered so the sender moves on
    holder.ingress.submit(ceoEnvelope({ messageId: 'm-3', text: '둘째 글' }));
    const deadline2 = Date.now() + 5_000;
    while (consumed.length === 1 && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 10));
    expect(consumed.length).toBe(2);                                  // still alive after the hostile frames
  } finally {
    await listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The frame parser mirrors protocol.ts: hostile input never escapes as a throw, unknown versions/kinds are ignorable.
test('parseCeoIngressFrame never throws on hostile input and bounds its reasons', () => {
  const hostile = { get op() { throw new Error('boom'); } };
  expect(() => parseCeoIngressFrame(hostile)).not.toThrow();
  expect(parseCeoIngressFrame(hostile)).toEqual({ ok: false, ignore: false, reason: 'frame could not be read' });
  expect(parseCeoIngressFrame('junk')).toEqual({ ok: false, ignore: false, reason: 'not a ceo frame' });
  expect(parseCeoIngressFrame({ op: 'ceo', v: 2, ws: 'HQ', seq: 1, at: 1, event: { kind: 'ceo-message' } })).toEqual({ ok: false, ignore: true, reason: 'unknown protocol version 2' });
  expect(parseCeoIngressFrame({ op: 'ceo', v: 1, ws: 'HQ', seq: 1, at: 1, event: { kind: 'nope' } })).toEqual({ ok: false, ignore: true, reason: 'unknown ceo event kind nope' });
  const good = parseCeoIngressFrame({ op: 'ceo', v: 1, ws: 'HQ', pane: 'p1', seq: 1, at: 5, event: { kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 't', messageId: 'm', text: 'x' } });
  expect(good.ok).toBe(true);
  if (good.ok) expect(good.frame.event).toEqual({ kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 't', messageId: 'm', text: 'x' });
});

// ── JUD hold(15:58) #39407 mustFix ①② — RED first (OP OPS-RULES §35: 시뮬 장치·합성 이벤트·실패 먼저) ──────────────
// ① 생산자 인증·목적지 권한: the listener must authenticate the els producer and authorize the frame destination
//    BEFORE the frame ever reaches the turn-input hook (the session's turn door). A frame without a producer
//    signature is refused — the sender allowlist in submit is another component's check, not this door's.
// ② 대화 키: pending state and receipts must be keyed by source + authenticated conversation identity
//    (threadId) + messageId TOGETHER — a bare messageId collides across conversations.
test('① JUD hold — an unauthenticated frame never reaches the turn-input hook: the listener refuses it (fail-closed), onFrame stays untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceo-auth-red-'));
  const socketPath = join(dir, 'ceo.sock');
  const consumed: CeoIngressFrame[] = [];
  const listener = await createCeoIngressListener({ socketPath, onFrame: (frame) => { consumed.push(frame); } });
  try {
    // a well-formed ceo frame with NO producer authentication → refused, the turn-input hook is never called
    const bare = await sendFrameOverSocket(socketPath, {
      op: 'ceo', v: 1, ws: 'HQ', seq: 1, at: 1,
      event: { kind: 'ceo-message', source: 'telegram', sender: 'CEO-TG-1', threadId: 'tg-9', messageId: 'm-auth', text: 'x' },
    } as never);
    expect(bare.exitCode).toBe(1);
    expect(consumed.length).toBe(0);
  } finally {
    await listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② JUD hold — the same messageId in another conversation is NOT a duplicate: source+threadId+messageId are tracked independently', () => {
  const clock = new FakeClock();
  const { ingress, op } = setup(clock);
  const a = ingress.submit(ceoEnvelope());                                                        // telegram tg-9 m-1
  const b = ingress.submit(ceoEnvelope({ threadId: 'tg-7', text: '다른 대화 같은 번호' }));           // telegram tg-7 m-1
  const c = ingress.submit(ceoEnvelope({ source: 'discord', threadId: 'dc-1', text: '디스코드' }));    // discord dc-1 m-1
  expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);                                          // RED: b/c are 'duplicate messageId' today
  expect(op.frames.length).toBe(3);                                                                // RED: 1 today
  expect(clock.pending()).toBe(6);                                                                 // three red + three escalate timers, one pair per message (advance 전 — 발화 없이 잔여 전량)
});
