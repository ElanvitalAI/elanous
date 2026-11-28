// SIM — HAND-ROUTE-GUARDIAN-MISROUTE (0.3.39 P1 · live 11-28 12:23–14:43 KST). Nine TC-domain ✋ went to GUARDIAN and sat
// 38–113 min (hands frozen twice): the classifier words `guardian` / `approval` read «종료 영수 · 인증 주체 · 승인»,
// TOOL_DENIED went to env by code, and the loop-agent SLA re-route lived only in the steward graph's last node, which died
// at R1 for 14 ticks. Fixtures = the nine ✋ exactly as posted (body · refs) and Jev's answers to them under the shipped
// hand-routes.yaml (live replay 11-28 15:2x KST, 3 runs each — the lowest p of the three is used). Two engines per scene:
// A = the pure route (routeHandMail · loopHandTaker), B = the sender entrance (routeAtEntrance) into a real msg ledger and
// the SLA sweep as the steward, `msg hand beacon` and every TUI tick run it. Seeds 5. Expectations are literals (rule 11).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevResponse } from '../../decide/jev.js';
import { applyHandOutcome, buildFederationLadder, handClosedOn, readHandMail } from '../../msg/hand-raise-ladder.js';
import { MsgStore } from '../../msg/msg-store.js';
import {
  BUILTIN_HAND_ROUTES_FILE, cheapHandClassifier, loopHandTaker, readHandRoutes, routeAtEntrance, routeHandMail, sweepLoopHandSla,
  type HandRootClassifier,
} from './index.js';

const SEEDS = [1, 7, 42, 1127, 2026];
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const TABLE = readHandRoutes([BUILTIN_HAND_ROUTES_FILE]);
const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC-H-CX-3', 'TC-H-CX-4', 'TC-H-CX-6', 'TC-H-CX-7', 'TC-H-CC-2', 'TC-H-POOL-2', 'HAND-TUI-D'] }, { coordinator: 'JUD', seats: ['JUD-B'] }] });
const parentOf = (seat: string): string => ladder.parentOf(seat);

const TAIL = ' · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법';
interface Real { readonly id: number; readonly seat: string; readonly reason: string; readonly line: string; readonly word: string; readonly p: number }
/** The nine live ✋ (11-28) and Jev's answer under the shipped table. */
const NINE: readonly Real[] = [
  { id: 203970, seat: 'TC-H-CX-4', reason: 'DEPENDENCY_WAIT', word: 'policy', p: 0.92, line: 'TC/POOL-2 기존 단일 수행선 인계와 signer/trust-root 배치 책임·승인 및 결속 정책 결정이 필요하다.' },
  { id: 204051, seat: 'TC-H-CC-2', reason: 'DEPENDENCY_WAIT', word: 'runstate', p: 0.99, line: '최근 수행선 식별자와 원격 실행 종료 영수가 없어 기존 실행 주체의 상태 확인이 필요하다.' },
  { id: 204113, seat: 'TC-H-CX-4', reason: 'DEPENDENCY_WAIT', word: 'runstate', p: 0.99, line: '원 칸이 구 원격 실행 종료 전 중복 시험을 금지하며 과거 PID·runId와 종료 증거가 없어 TC의 기존 실행 확인이 필요하다.' },
  { id: 204182, seat: 'TC-H-POOL-2', reason: 'DEPENDENCY_WAIT', word: 'runstate', p: 0.88, line: 'TC에 칸 반환: 재기동 전 수행선 c0a98e23 결과·종료가 확인되지 않아 중복 실행 불가, 동일 HEAD 영수 회수 필요' },
  { id: 204216, seat: 'TC-H-CX-6', reason: 'HUMAN_DECISION', word: 'policy', p: 0.96, line: '상위 개발 지침은 기존 시험 기대값을 새 동작에 맞춰 수정하는 것을 금지합니다. TC 계약과 상충하는 기대의 승인된 처리 경로가 필요합니다.' },
  { id: 204425, seat: 'HAND-TUI-D', reason: 'TOOL_DENIED', word: 'policy', p: 0.93, line: '판정 손 패널 접근 거부로 생존·유휴 및 대기 중앙값을 검증할 관측 경로가 필요하며 OP #204423에 보고함.' },
  { id: 204672, seat: 'TC-H-CX-7', reason: 'DEPENDENCY_WAIT', word: 'policy', p: 0.95, line: 'CC-2 소유 서버 principal→seat 인증·인가 접합이 미구현이며 기존 양성 시험을 거부 시험으로 바꿔 완료 처리할 수 없음.' },
  { id: 204737, seat: 'TC-H-CX-3', reason: 'DEPENDENCY_WAIT', word: 'policy', p: 0.82, line: '#40666 공유 작업트리 보존·통지 실행 주체와 인가 경로에 관한 TC 응답이 필요하며 #204685로 구체 차단을 보고했습니다.' },
  { id: 204860, seat: 'TC-H-CX-6', reason: 'DEPENDENCY_WAIT', word: 'runstate', p: 0.97, line: 'VM P0 WIP-1 진행 중이며 #40577 기존 원격 실행 PID·실행 ID 및 종료 증거가 없어 병렬 시험 불가.' },
];
/** Resource ✋ (host down · credential expired · VM to start) and Jev's answer under the shipped table (same replay). */
const RESOURCE: readonly Real[] = [
  { id: 1, seat: 'TC-H-CX-2', reason: 'DEPENDENCY_WAIT', word: 'guardian', p: 0.99, line: 'minim5 호스트가 ssh 응답 없음(Connection timed out) — pregate 를 돌릴 원격 호스트가 내려가 있다.' },
  { id: 2, seat: 'TC-H-CX-4', reason: 'DEPENDENCY_WAIT', word: 'guardian', p: 1.0, line: 'codex 로그인 토큰이 만료되어(401 refresh token rejected) 재로그인 전에는 손이 아무것도 할 수 없다.' },
  { id: 6, seat: 'TC-H-CX-7', reason: 'TOOL_DENIED', word: 'guardian', p: 0.99, line: 'gh 인증 자격이 만료되어(gh auth status: token invalid) PR 을 만들 수 없다.' },
  { id: 5, seat: 'TC-H-CX-6', reason: 'HUMAN_DECISION', word: 'guardian', p: 0.81, line: 'aws1 VM 이 꺼져 있고 시작 권한이 없다 — 버스트 시험용 VM 가동이 필요하다.' },
];

const body = (r: Real): string => `[✋ NEED HUMAN · ${r.seat}] ${r.line}${TAIL}`;
const refsOf = (r: Real, block: string): string[] => [`block:${block}`, `seat:${r.seat}`, 'pane:p0', `reason:${r.reason}`];
/** Jev as it answered: the recorded word at p, the rest spread on two others. */
const decideFor = (r: Real) => async (): Promise<JevResponse> => ({ model: 'jev-1.14.0', answers: { owner: { type: 'choice', probabilities: { [r.word]: r.p, decision: (1 - r.p) / 2, unclear: (1 - r.p) / 2 } } } });
const classifierFor = (r: Real): HandRootClassifier => (text) => cheapHandClassifier(text, { decide: decideFor(r), table: TABLE });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const store = (): MsgStore => { const d = mkdtempSync(join(tmpdir(), 'guardian-misroute-')); dirs.push(d); return new MsgStore(join(d, 'messages.db')); };
const back = (s: MsgStore, id: number, min: number, now: number): void => { s.db.query('UPDATE msg_messages SET created_at = ? WHERE id = ?').run(new Date(now - min * 60_000).toISOString(), id); };

/** Engine B: the sender entrance (CLI `msg post` · MsgPost) into a real ledger. */
async function postThroughEntrance(s: MsgStore, r: Real, to: string, block: string): Promise<{ id: number; to: string }> {
  const envelope = { from: r.seat, to, body: body(r), refs: refsOf(r, block) };
  await routeAtEntrance(envelope, { classifyHand: classifierFor(r), cells: null, table: TABLE, parentOf, isLive: () => true });
  const m = s.append({ from: envelope.from, to: envelope.to, kind: 'request', intent: 'decision', needsAck: true, correlationId: block, refs: envelope.refs, body: envelope.body });
  return { id: m.id, to: m.to };
}

test('replay: the nine live ✋ → TC (both engines) · posted to OP they still land at TC (the hand\'s coordinator)', async () => {
  const s = store();
  try {
    for (const r of NINE) {
      const a = await routeHandMail({ from: r.seat, to: 'TC', body: body(r), refs: refsOf(r, `blk-${r.id}`) }, classifierFor(r), { table: TABLE, parentOf });
      expect([r.id, a?.to]).toEqual([r.id, 'TC']);
      expect([r.id, (await postThroughEntrance(s, r, 'TC', `blk-${r.id}`)).to]).toEqual([r.id, 'TC']);
      expect([r.id, (await postThroughEntrance(s, r, 'OP', `blk-op-${r.id}`)).to]).toEqual([r.id, 'TC']);
    }
    expect(s.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'GUARDIAN'").get()).toEqual({ n: 0 });
  } finally { s.close(); }
});

test('narrow env rule: a `guardian` pick below rootMinProbability (0.65) is unclear → stays with TC; at 0.65 it goes to GUARDIAN', async () => {
  const at = (p: number): Real => ({ ...RESOURCE[0]!, p });
  expect((await routeHandMail({ from: 'TC-H-CX-2', to: 'TC', body: body(at(0.64)), refs: refsOf(at(0.64), 'b') }, classifierFor(at(0.64)), { table: TABLE, parentOf }))?.to).toBe('TC');
  expect((await routeHandMail({ from: 'TC-H-CX-2', to: 'TC', body: body(at(0.65)), refs: refsOf(at(0.65), 'b') }, classifierFor(at(0.65)), { table: TABLE, parentOf }))?.to).toBe('GUARDIAN');
  // a structured resource code is not gated: PROVIDER_ERROR → GUARDIAN with no classifier at all
  expect((await routeHandMail({ from: 'TC-H-CX-2', to: 'TC', body: 'x', refs: ['block:b', 'reason:PROVIDER_ERROR'] }, null, { table: TABLE, parentOf }))?.to).toBe('GUARDIAN');
});

test('defaultOwner coordinator never moves a ✋ up or sideways: TC → OP keeps OP · a hand under OP that wrote to TC keeps TC', async () => {
  const design = { word: 'decision', p: 0.9 } as const;
  const r = (seat: string): Real => ({ id: 9, seat, reason: 'HUMAN_DECISION', line: 'which layout for the board', ...design });
  expect((await routeHandMail({ from: 'TC', to: 'OP', body: body(r('TC')), refs: refsOf(r('TC'), 'b') }, classifierFor(r('TC')), { table: TABLE, parentOf }))?.to).toBe('OP');
  expect((await routeHandMail({ from: 'HAND-ELN-MSG', to: 'TC', body: body(r('HAND-ELN-MSG')), refs: refsOf(r('HAND-ELN-MSG'), 'b') }, classifierFor(r('HAND-ELN-MSG')), { table: TABLE, parentOf }))?.to).toBe('TC');
  expect((await routeHandMail({ from: 'TC-H-CX-4', to: 'OP', body: body(r('TC-H-CX-4')), refs: refsOf(r('TC-H-CX-4'), 'b') }, classifierFor(r('TC-H-CX-4')), { table: TABLE, parentOf }))?.to).toBe('TC');
});

describe.each(SEEDS)('seed %i', (seed) => {
  test('scene 1 · TC-domain ✋ → TC (engine A = pure route · engine B = entrance into a ledger)', async () => {
    const r0 = rng(seed);
    const s = store();
    try {
      for (let i = 0; i < 6; i++) {
        const r = pick(r0, NINE);
        const to = pick(r0, ['TC', 'OP'] as const);
        const a = await routeHandMail({ from: r.seat, to, body: body(r), refs: refsOf(r, `blk-${seed}-${i}`) }, classifierFor(r), { table: TABLE, parentOf });
        const b = await postThroughEntrance(s, r, to, `blk-${seed}-${i}`);
        expect([r.id, to, a?.to, b.to]).toEqual([r.id, to, 'TC', 'TC']);
      }
    } finally { s.close(); }
  });

  test('scene 2 · resource ✋ (host down · credential expired) → GUARDIAN (both engines)', async () => {
    const r0 = rng(seed);
    const s = store();
    try {
      for (let i = 0; i < 4; i++) {
        const r = pick(r0, RESOURCE);
        const a = await routeHandMail({ from: r.seat, to: 'TC', body: body(r), refs: refsOf(r, `res-${seed}-${i}`) }, classifierFor(r), { table: TABLE, parentOf });
        const b = await postThroughEntrance(s, r, 'TC', `res-${seed}-${i}`);
        expect([r.id, a?.to, b.to]).toEqual([r.id, 'GUARDIAN', 'GUARDIAN']);
      }
    } finally { s.close(); }
  });

  test('scene 3 · ✋ at GUARDIAN unconsumed ≥ 10 min → TC exactly once, whichever carrier runs first (TUI · steward · beacon CLI)', () => {
    const r0 = rng(seed);
    const now = Date.parse('2026-11-28T05:00:00.000Z');
    const s = store();
    try {
      const r = pick(r0, NINE);
      const waited = 10 + Math.floor(r0() * 104); // 10 … 113 min (the live range)
      // the live misrouted shape: moved TC → GUARDIAN by the old table
      const h = s.append({ from: r.seat, to: 'GUARDIAN', kind: 'request', intent: 'decision', needsAck: true, correlationId: `blk-sla-${seed}`,
        refs: [...refsOf(r, `blk-sla-${seed}`), 'hand-root:env', 'hand-routed-from:TC', 'hand-ask:env:*'], body: body(r) });
      back(s, h.id, waited, now);
      // engine A — the pure taker and the shadow sweep
      expect(loopHandTaker({ reason: r.reason, refs: [], receiver: 'GUARDIAN', blockedSeat: r.seat }, TABLE.loopHands, 'OP', parentOf)).toBe('TC');
      expect(sweepLoopHandSla(s, { nowMs: now, live: false, table: TABLE, parentOf }).moved.map((m) => m.to)).toEqual(['TC']);
      // engine B — the carriers in a seeded order; the first moves it, the rest find it closed
      const carriers = [
        () => sweepLoopHandSla(s, { nowMs: now, hq: 'OP', table: TABLE, parentOf, involving: 'TC' }),          // TC's TUI tick
        () => sweepLoopHandSla(s, { nowMs: now, hq: 'OP', table: TABLE, parentOf, involving: r.seat }),        // the hand's TUI tick
        () => sweepLoopHandSla(s, { nowMs: now, hq: 'OP', table: TABLE, parentOf }),                           // steward x · msg hand beacon
      ];
      const order = [...carriers.keys()].sort(() => r0() - 0.5);
      const moved = order.map((k) => carriers[k]!().moved.length);
      expect(moved.reduce((a, b) => a + b, 0)).toBe(1);
      const fwd = s.db.query("SELECT recipient, sender, body FROM msg_messages WHERE refs_json LIKE '%hand-loop-sla%'").all() as { recipient: string; sender: string; body: string }[];
      expect(fwd.map((f) => [f.recipient, f.sender])).toEqual([['TC', 'GUARDIAN']]);
      expect(fwd[0]!.body).toStartWith(`[✋ ESCALATED · GUARDIAN → TC · no outcome in ${waited}m]`);
      expect(handClosedOn(s, readHandMail(s, h.id)!)).toBe('escalated');
      // a TUI of an unrelated seat never touches it
      expect(sweepLoopHandSla(s, { nowMs: now + 60_000, table: TABLE, parentOf, involving: 'UX' }).moved).toEqual([]);
    } finally { s.close(); }
  });

  test('scene 4 · an already-resolved ✋ at GUARDIAN → no re-route (resolve outcome · or a plain reply)', () => {
    const r0 = rng(seed);
    const now = Date.parse('2026-11-28T05:00:00.000Z');
    const s = store();
    try {
      const r = pick(r0, NINE);
      const h = s.append({ from: r.seat, to: 'GUARDIAN', kind: 'request', intent: 'decision', needsAck: true, correlationId: `blk-done-${seed}`,
        refs: [...refsOf(r, `blk-done-${seed}`), 'hand-root:env', 'hand-routed-from:TC'], body: body(r) });
      back(s, h.id, 20 + Math.floor(r0() * 90), now);
      if (r0() < 0.5) {
        applyHandOutcome(s, { msgId: h.id, action: 'resolve', actor: 'GUARDIAN', text: 'owner TC · 17:00 까지', owner: 'TC', deadline: '2026-11-28T08:00:00Z' },
          { ladder, now: () => now, raiseDecision: () => {} });
      } else {
        s.post({ from: 'GUARDIAN', to: r.seat, replyTo: h.id, body: 'TC 기존 수행선 c0a98e23 rc=0 · 영수 PREGATE-GREEN/40480' });
      }
      expect(sweepLoopHandSla(s, { nowMs: now, table: TABLE, parentOf }).moved).toEqual([]);
      expect(sweepLoopHandSla(s, { nowMs: now, table: TABLE, parentOf, involving: 'TC' }).moved).toEqual([]);
      expect(s.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE refs_json LIKE '%hand-loop-sla%'").get()).toEqual({ n: 0 });
    } finally { s.close(); }
  });
});
