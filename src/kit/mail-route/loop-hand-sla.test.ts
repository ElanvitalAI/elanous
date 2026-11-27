// GUARDIAN-HAND-SLA (0.3.38 P0) — a ✋ moved to a loop-agent address (GUARDIAN) never stays open past its SLA.
// Fixture = the live shape of #198743 (11-28 00:05 KST · TC-H-POOL-3 → GUARDIAN · DEPENDENCY_WAIT · sat 25–53 min).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { handClosedOn, readHandMail } from '../../msg/hand-raise-ladder.js';
import { BUILTIN_HAND_ROUTES_FILE, handRoutesFrom, readHandRoutes, sweepLoopHandSla } from './index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const store = (): MsgStore => { const d = mkdtempSync(join(tmpdir(), 'loop-hand-sla-')); dirs.push(d); return new MsgStore(join(d, 'messages.db')); };
const back = (s: MsgStore, id: number, min: number): void => { s.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - min * 60_000).toISOString(), id); };

/** The ✋ exactly as the live ledger holds #198743 (kind · intent · refs · body). */
const hand198743 = (block = 'blk-mwz45o10-1', reason = 'DEPENDENCY_WAIT', seat = 'TC-H-POOL-3') => ({
  from: seat, to: 'GUARDIAN', kind: 'request' as const, intent: 'decision' as const, needsAck: true, correlationId: block,
  refs: [`block:${block}`, `seat:${seat}`, 'pane:p4a370bfa', `reason:${reason}`, 'hand-root:env', 'hand-routed-from:TC', 'hand-ask:env:LLM-PHASE-BY-GUARDIAN-E4'],
  body: `[✋ NEED HUMAN · ${seat}] 기존 수집기 시간 초과로 rc와 영수가 확보되지 않았으며, TC에 기존 원격 실행의 자료 복구 담당선 연결을 요청함(#198742). 중복 시험 금지 유지. · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법`,
});

test('table: the built-in loopHands reads with no problems — GUARDIAN · 10 min · dependency/design back to the routed-from rung · else OP', () => {
  const t = readHandRoutes([BUILTIN_HAND_ROUTES_FILE]);
  expect(t.problems).toEqual([]);
  expect([...t.loopHands.receivers]).toEqual(['GUARDIAN']);
  expect(t.loopHands.slaMs).toBe(600_000);
  expect(t.loopHands.byReason).toEqual({ DEPENDENCY_WAIT: 'routed-from', HUMAN_DECISION: 'routed-from', OWNER_UNKNOWN: 'routed-from' });
  expect(t.loopHands.otherwise).toBe('OP');
  // an invalid taker is dropped with a reason; a missing section = no receivers (nothing moves)
  const bad = handRoutesFrom({ version: 1, loopHands: { receivers: ['GUARDIAN'], byReason: { X: 'not an address!' } } });
  expect(bad.problems).toEqual(['loopHands.byReason.X: not an address! is neither routed-from nor an address']);
  expect(handRoutesFrom({ version: 1 }).loopHands.receivers.size).toBe(0);
});

test('#198743 shape: DEPENDENCY_WAIT at GUARDIAN past 10 min → re-routed once to TC (its routed-from rung) · original closes as escalated', () => {
  const s = store();
  try {
    const h = s.append(hand198743());
    back(s, h.id, 12);
    const shadow = sweepLoopHandSla(s, { live: false });
    expect(shadow.moved.map((m) => [m.msgId, m.from, m.to])).toEqual([[h.id, 'GUARDIAN', 'TC']]);
    expect(s.db.query('SELECT COUNT(*) AS n FROM msg_messages').get()).toEqual({ n: 1 }); // shadow writes nothing

    const r = sweepLoopHandSla(s);
    expect(r.moved).toHaveLength(1);
    const fwd = s.getMessage(r.moved[0]!.mailId!)!;
    expect(fwd.to).toBe('TC');
    expect(fwd.from).toBe('GUARDIAN');
    expect(fwd.kind).toBe('request');
    expect(fwd.refs).toContain(`hand-escalated-from:${h.id}`);
    expect(fwd.refs).toContain('reason:DEPENDENCY_WAIT');
    expect(fwd.refs).toContain('block:blk-mwz45o10-1');
    expect(fwd.refs).toContain('seat:TC-H-POOL-3');
    expect(fwd.refs).toContain('hand-loop-sla');
    expect(fwd.body).toStartWith('[✋ ESCALATED · GUARDIAN → TC · no outcome in 12m]');
    expect(fwd.body).toContain('GUARDIAN has no ✋ responder');
    expect(handClosedOn(s, readHandMail(s, h.id)!)).toBe('escalated');
    // idempotent: the next tick (or a second steward) moves nothing
    expect(sweepLoopHandSla(s).moved).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'TC'").get()).toEqual({ n: 1 });
  } finally { s.close(); }
});

test('SLA edges: young ✋ waits · answered ✋ untouched · env-only reason → left to the HQ beacon card · same cause = one forward', () => {
  const s = store();
  try {
    const young = s.append(hand198743('blk-young'));
    back(s, young.id, 4);
    const replied = s.append(hand198743('blk-replied', 'DEPENDENCY_WAIT', 'TC-H-POOL-1'));
    back(s, replied.id, 20);
    s.post({ from: 'GUARDIAN', to: 'TC-H-POOL-1', replyTo: replied.id, body: 'minim5 run 4417 rc=0 · receipt PREGATE-GREEN/40480' });
    const env = s.append(hand198743('blk-env', 'TOOL_DENIED', 'TC-H-CX-7'));
    back(s, env.id, 15);
    const a = s.append(hand198743('blk-a', 'DEPENDENCY_WAIT', 'TC-H-CC-2'));
    const b = s.append(hand198743('blk-b', 'DEPENDENCY_WAIT', 'TC-H-CC-2'));
    back(s, a.id, 30); back(s, b.id, 25);
    const r = sweepLoopHandSla(s);
    expect(r.moved.map((m) => [m.msgId, m.to, m.members])).toEqual([[a.id, 'TC', 2]]);
    expect(r.toBeacon.map((m) => [m.msgId, m.to])).toEqual([[env.id, 'OP']]);
    const fwd = s.getMessage(r.moved[0]!.mailId!)!;
    expect(fwd.refs).toContain(`hand-escalated-from:${b.id}`); // the repeat closes with the lead
    expect(handClosedOn(s, readHandMail(s, b.id)!)).toBe('escalated');
    expect(handClosedOn(s, readHandMail(s, young.id)!)).toBeNull();
    expect(handClosedOn(s, readHandMail(s, env.id)!)).toBeNull(); // the beacon (same tick, after this sweep) cards it
  } finally { s.close(); }
});

test('no routed-from ref (✋ sent straight to GUARDIAN) → the else taker; a ✋ to a non-loop address is never touched', () => {
  const s = store();
  try {
    const direct = s.append({ ...hand198743('blk-direct'), refs: ['block:blk-direct', 'seat:TC-H-POOL-3', 'reason:DEPENDENCY_WAIT'] });
    const atTc = s.append({ ...hand198743('blk-tc'), to: 'TC' });
    back(s, direct.id, 11); back(s, atTc.id, 40);
    const r = sweepLoopHandSla(s);
    expect(r.moved).toEqual([]);
    expect(r.toBeacon.map((m) => [m.msgId, m.to])).toEqual([[direct.id, 'OP']]);
    const custom = handRoutesFrom({ version: 1, loopHands: { receivers: ['GUARDIAN'], else: 'TC' } });
    expect(sweepLoopHandSla(s, { table: custom }).moved.map((m) => [m.msgId, m.to])).toEqual([[direct.id, 'TC']]);
  } finally { s.close(); }
});
