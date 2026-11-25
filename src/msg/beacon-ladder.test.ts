// BEACON-LADDER sim world — tonight's (11-25 20:5x) exact ✋ shape: 4 ✋ at TC, RES dormant, TC «HOLD 유지» as resolve.
// Independent literals · real temp ledger · injected clock (ledger created_at is wall time).
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, type MessageEnvelope } from './msg-store.js';
import { applyHandOutcome, beaconHands, beaconLine, buildFederationLadder, dedupeHands, openHands, sweepHandRaises, type CeoCard } from './hand-raise-ladder.js';

const root = mkdtempSync(join(tmpdir(), 'beacon-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
let n = 0;
const T0 = Date.parse('2026-11-25T11:51:00.000Z');
const mins = (n: number): number => n * 60 * 1000;
const ladder = buildFederationLadder({ spaces: [
  { coordinator: 'TC', seats: ['TC', 'HAND-ELN-ELS-API', 'TC-H-CX-6'] },
  { coordinator: 'OP', seats: ['OP'] },
] });

const hand = (from: string, block: string, reason: string, body: string, extra: string[] = []): MessageEnvelope => ({
  from, to: 'TC', kind: 'request', intent: 'decision', correlationId: block, body: `[✋ NEED HUMAN · ${from}] ${body}`,
  refs: [`block:${block}`, `seat:${from}`, 'pane:p1', `reason:${reason}`, ...extra],
});

function world(dormantSeats: string[] = ['RES']) {
  const store = new MsgStore(join(root, `w${++n}.db`));
  const cards: CeoCard[] = [];
  const logs: string[] = [];
  setSystemTime(new Date(T0));
  const deps = { ladder, now: () => Date.now(), raiseDecision: (c: CeoCard) => { cards.push(c); }, log: (e: string) => { logs.push(e); }, dormantSeats };
  const toOp = (): string[] => (store.db.query("SELECT body FROM msg_messages WHERE recipient = 'OP' ORDER BY id").all() as { body: string }[]).map((r) => r.body);
  const toSeat = (seat: string): string[] => (store.db.query('SELECT body FROM msg_messages WHERE recipient = ? ORDER BY id').all(seat) as { body: string }[]).map((r) => r.body);
  return { store, cards, logs, deps, toOp, toSeat, at: (ms: number) => setSystemTime(new Date(T0 + ms)) };
}

function tonight(w: ReturnType<typeof world>) {
  const a = w.store.append(hand('HAND-ELN-ELS-API', 'blk-12', 'DEPENDENCY_WAIT', 'RES 작업별 전용 checkout·쓰기 경계·슬롯 승인과 동일 SHA 실패 원문이 모두 필요함.'));
  const b = w.store.append(hand('TC-H-CX-6', 'blk-7', 'APPROVAL_PENDING', 'TC #167087: 기존 writer 인계와 OP·RES 승인 영수 및 명시적 HOLD 해제 전 편집 금지.'));
  const c = w.store.append(hand('HAND-ELN-ELS-API', 'blk-13', 'DEPENDENCY_WAIT', 'RES 작업별 전용 checkout·쓰기 경계·슬롯 승인과 동일 SHA 실패 원문이 모두 필요하다.'));
  const d = w.store.append(hand('HAND-ELN-ELS-API', 'blk-14', 'DEPENDENCY_WAIT', 'RES 작업별 승인과 동일 SHA 실패 원문이 모두 필요하며 원격 접근·복사·시험은 HOLD다.'));
  const holdText = '다른 방법: RES 수행선에서 승인 영수를 연결해 주세요. 확보 전 원격 접근·복사·시험 HOLD 유지';
  // LEADER-HAND-CONTRACT — the door now refuses this resolve; tonight's ledger still holds the legacy row, so write it raw.
  expect(() => applyHandOutcome(w.store, { msgId: a.id, action: 'resolve', text: holdText }, w.deps)).toThrow(/refused/);
  w.store.append({ from: 'TC', to: 'HAND-ELN-ELS-API', kind: 'reply', intent: 'decision', replyTo: a.id,
    refs: ['hand-outcome:resolve', `hand-of:${a.id}`, `hand-msg:${a.id}`], body: `[✋ RESOLVED · TC] ${holdText}` });
  return { a, b, c, d };
}

test('tonight: TC «HOLD 유지» resolve keeps the ✋ open; 4 ✋ dedupe to 2 (×3 · ×1)', () => {
  const w = world();
  const { a } = tonight(w);
  w.at(mins(1));
  const opens = openHands(w.store, { now: Date.now(), ladder });
  expect(opens.map((h) => h.id)).toContain(a.id);
  expect(opens.length).toBe(4);
  expect(dedupeHands(opens).map((g) => [g.lead.blockedSeat, g.repeat])).toEqual([['HAND-ELN-ELS-API', 3], ['TC-H-CX-6', 1]]);
});

test('tonight: one beacon tick → one OP card per group (with TC last reply + cause), dormant auto-answer to each blocked seat', () => {
  const w = world();
  tonight(w);
  w.at(mins(2));
  const r = beaconHands(w.store, w.deps);
  expect(r.fired.map((f) => [f.seat, f.why])).toEqual([['HAND-ELN-ELS-API', 'awaited seat RES is dormant'], ['TC-H-CX-6', 'awaited seat RES is dormant']]);
  const op = w.toOp();
  expect(op.length).toBe(2);
  expect(op[0]).toStartWith('[✋ BEACON · TC → OP] HAND-ELN-ELS-API blocked (DEPENDENCY_WAIT · ×3) — awaited seat RES is dormant');
  expect(op[0]).toContain('TC last reply: [✋ RESOLVED · TC] 다른 방법');
  expect(w.toSeat('HAND-ELN-ELS-API').at(-1)).toStartWith('[✋ auto-answer · OP] RES absorbed — no approval will come from that tab. Use the policy path: eln res policy');
  // members close as escalated; the TC count drops to 0, OP holds 2; a second tick writes nothing.
  expect(openHands(w.store, { now: Date.now(), ladder }).map((h) => h.receiver)).toEqual(['OP', 'OP']);
  expect(beaconHands(w.store, w.deps).fired).toEqual([]);
  expect(w.toOp().length).toBe(2);
  expect(beaconLine(r)).toBe('✋ open 2 · oldest 0m · escalated 2 · leader SLA: median – · with-owner 0% (0/0) · HOLD refused 1');
});

test('OP unresolved 10 min: non-CEO category goes to CLAUDE-OP coach, no CEO card', () => {
  const w = world();
  tonight(w);
  w.at(mins(2));
  beaconHands(w.store, w.deps);
  w.at(mins(13));
  const done = sweepHandRaises(w.store, w.deps);
  expect(done.map((d) => d.to)).toEqual(['CLAUDE-OP', 'CLAUDE-OP']);
  expect(w.cards).toEqual([]);
});

test('edge: leader resolves properly (owner + deadline) → no escalation', () => {
  const w = world([]);
  const m = w.store.append(hand('TC-H-CX-6', 'blk-9', 'APPROVAL_PENDING', 'need a slot'));
  applyHandOutcome(w.store, { msgId: m.id, action: 'resolve', text: 'HOLD until the slot frees', owner: 'TC', deadline: '2026-11-25T13:00:00Z' }, w.deps);
  w.at(mins(30));
  expect(beaconHands(w.store, w.deps).fired).toEqual([]);
  expect(sweepHandRaises(w.store, w.deps)).toEqual([]);
  expect(w.toOp()).toEqual([]);
});

test('edge: normal ✋ resolved by the leader never reaches OP', () => {
  const w = world([]);
  const m = w.store.append(hand('TC-H-CX-6', 'blk-10', 'APPROVAL_PENDING', 'need a decision'));
  applyHandOutcome(w.store, { msgId: m.id, action: 'resolve', text: 'go with option A' }, w.deps);
  w.at(mins(30));
  expect(beaconHands(w.store, w.deps).fired).toEqual([]);
  expect(w.toOp()).toEqual([]);
});

test('edge: urgent ✋ reaches the OP card on the next tick; the hand itself never mailed OP', () => {
  const w = world([]);
  w.store.append(hand('TC-H-CX-6', 'blk-11', 'APPROVAL_PENDING', 'secret leaked in log', ['urgency:security']));
  expect(w.toOp()).toEqual([]);
  w.at(mins(1));
  const r = beaconHands(w.store, w.deps);
  expect(r.fired.map((f) => f.why)).toEqual(['urgency security']);
  expect(w.toOp().length).toBe(1);
});

test('edge: normal ✋ under 10 min, single, no dormant seat → waits at the leader', () => {
  const w = world([]);
  w.store.append(hand('TC-H-CX-6', 'blk-15', 'APPROVAL_PENDING', 'need a decision'));
  w.at(mins(9));
  expect(beaconHands(w.store, w.deps).fired).toEqual([]);
  w.at(mins(10));
  expect(beaconHands(w.store, w.deps).fired.map((f) => f.why)).toEqual(['open 10m at TC']);
});

test('edge: ✋ flood (6 same cause) → one OP card ×6', () => {
  const w = world([]);
  for (let i = 0; i < 6; i++) w.store.append(hand('HAND-ELN-ELS-API', `blk-f${i}`, 'DEPENDENCY_WAIT', `same wait ${i}`));
  const r = beaconHands(w.store, w.deps);
  expect(r.fired.map((f) => f.repeat)).toEqual([6]);
  expect(w.toOp().length).toBe(1);
});

test('edge: OP absent (down) → the card goes to the CLAUDE-OP coach', () => {
  const w = world(['RES', 'OP']);
  tonight(w);
  beaconHands(w.store, w.deps);
  expect(w.toOp()).toEqual([]);
  expect(w.toSeat('CLAUDE-OP').length).toBe(2);
});

// BEACON-FLOOD (11-25 21:4x · ~180 mails to OP in 15 min after #40151): the backlog reopened by the HOLD rule.
test('flood: 140 open ✋ at TC + 22 at JUD from before install → sweep mails OP 0 times · beacon ≤ 2 cards to OP', () => {
  const fed = buildFederationLadder({ spaces: [
    { coordinator: 'TC', seats: ['TC', 'TC-H-1', 'TC-H-2'] },
    { coordinator: 'JUD', seats: ['JUD', 'JUD-H-1'] },
    { coordinator: 'OP', seats: ['OP'] },
  ] });
  const w = world([]);
  const deps = { ...w.deps, ladder: fed };
  for (let i = 0; i < 140; i += 1) {
    w.store.append({ from: i % 2 ? 'TC-H-1' : 'TC-H-2', to: 'TC', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN] wait for approval ${i}`,
      refs: [`block:tc-${i}`, `seat:${i % 2 ? 'TC-H-1' : 'TC-H-2'}`, 'reason:APPROVAL_PENDING'] });
  }
  for (let i = 0; i < 22; i += 1) {
    w.store.append({ from: 'JUD-H-1', to: 'JUD', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN] judge input ${i}`,
      refs: [`block:jud-${i}`, 'seat:JUD-H-1', 'reason:DEPENDENCY_WAIT'] });
  }
  w.at(mins(101));
  expect(sweepHandRaises(w.store, deps)).toEqual([]);
  expect(w.toOp().length).toBe(0);
  const r = beaconHands(w.store, deps);
  expect(r.fired.length).toBe(2);
  const op = w.toOp();
  expect(op.length).toBe(2);
  expect(op[0]).toContain('140 old ✋');
  expect(op[1]).toContain('22 old ✋');
  // next ticks: nothing more (members closed as escalated by the backlog card)
  w.at(mins(102));
  sweepHandRaises(w.store, deps);
  beaconHands(w.store, deps);
  expect(w.toOp().length).toBe(2);
  expect(w.toSeat('TC').filter((b) => b.includes('auto-escalated')).length).toBe(0);
});

test('flood: rate cap — 5 fresh causes in one tick → 3 cards to OP, the rest wait for the next window', () => {
  const w = world([]);
  for (let i = 0; i < 5; i += 1) {
    w.store.append({ from: 'TC-H-CX-6', to: 'TC', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN] cause ${i}`,
      refs: [`block:c-${i}`, 'seat:TC-H-CX-6', `reason:R${i}`, 'urgency:urgent'] });
  }
  w.at(mins(1));
  expect(beaconHands(w.store, w.deps).fired.length).toBe(3);
  expect(beaconHands(w.store, w.deps).fired.length).toBe(0);
  w.at(mins(12));
  expect(beaconHands(w.store, w.deps).fired.length).toBe(2);
  expect(w.toOp().length).toBe(5);
});
