// LOOP-EXCEPTION-WATCH — run-doctor's loop lane on the REAL runtime ⊕ the REAL kit/case-ledger (tmp root) with a fake trigger
// registry. Reconcile: 본다 → 정상화(사다리) → 다시 본다 → resolved, else escalated (one card) — never «seen» only.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm } from '../runtime.js';
import { readCases } from '../../kit/case-ledger/index.js';
import { createBody, type RunDoctorDeps } from './run-doctor.js';
import type { LoopExceptionDeps, LoopFault, LoopScan } from './loop-exceptions.js';

const T0 = Date.parse('2026-11-27T13:30:00Z');
const MIN = 60_000; // 출처: #40574 — 1 minute in ms (the scenario clock unit, not a bound)
const at = (m: number) => new Date(T0 + m * MIN);

/** A fake registry: one loop `release-traffic` (+ 2 healthy). `fail` = its next runs keep failing; `reason` = what the run leaves. */
function world(o: { failing: boolean; reason: string; railAtMin: number | null; failedAtMin: number }) {
  const root = mkdtempSync(join(tmpdir(), 'loopx-'));
  let status: string = 'exception'; let failAt = T0 + o.failedAtMin * MIN; let runN = 1;
  const retries: string[] = []; const posts: Array<{ key: string; to: string; body: string }> = [];
  const fault = (): LoopFault => ({ graphId: 'release-traffic', owner: 'OP', window: '2026-11-27T13:20', at: failAt, attempt: 2, runId: `run-${runN}`, error: null, node: 'tick', tail: o.reason });
  const loops: LoopExceptionDeps = {
    caseRoot: root,
    faults: (): LoopScan => ({ total: 3, faults: status === 'exception' ? [fault()] : [], status: { 'release-traffic': status, 'guardian-pulse': 'done', 'land-graph': 'done' } }),
    railAt: () => (o.railAtMin === null ? null : T0 + o.railAtMin * MIN),
    retry: (g, w) => { retries.push(`${g}@${w}`); status = 'retry-wait'; return { ok: true, line: `${g}@${w} re-armed` }; },
    post: (key, to, body) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 900 + posts.length; },
  };
  /** the registry's own run after a retry: done (normal) or exception again (with a new run id) */
  const settle = (m: number) => { if (status !== 'retry-wait') return; if (o.failing) { status = 'exception'; failAt = T0 + m * MIN; runN += 1; } else status = 'done'; };
  const deps: RunDoctorDeps = {
    redGates: () => [], greens: () => new Map(), failedRuns: () => [], hosts: () => [], inflight: () => false,
    diagnoses: () => [], writeDiagnosis: () => {}, recordRunVisit: () => {}, retries: () => [], retry: () => ({ ok: false, line: '' }), recordRetry: () => {},
    loops,
  };
  const card = loadCard('run-doctor');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const ports: AgentPorts = { memory, post: () => null, beat: () => {}, speak: () => {}, llm: null };
  return { root, card, memory, ports, deps, retries, posts, settle, body: createBody({ stateRoot: root, card }, deps) };
}

const cases = (root: string) => readCases(root, 'loop-exception');

describe('run-doctor loop lane (LOOP-EXCEPTION-WATCH · reconcile)', () => {
  test('restart casualty (failed 3 min after a rail) → one registry retry → normal again → case resolved · no card', async () => {
    const w = world({ failing: false, reason: '{"outcome":"fail","why":"set node-b pregateSlots 2→0 failed"}', railAtMin: -3, failedAtMin: 0 });
    const r1 = await tickAgent(w.card, w.body, w.ports, at(6));
    expect(r1.acted).toEqual(['retry-loop:loop:release-traffic@2026-11-27T13:20']);
    expect(w.retries).toEqual(['release-traffic@2026-11-27T13:20']);
    expect(cases(w.root).map(c => c.state)).toEqual(['acting']);
    w.settle(8);
    await tickAgent(w.card, w.body, w.ports, at(40));
    expect(cases(w.root).map(c => c.state)).toEqual(['resolved']);
    expect(w.posts).toEqual([]);
  });
  test('persistent without a reason → ① retry ② retry (reason captured) → still exception → one card to the owner saying no-reason · escalated · no more cards', async () => {
    const w = world({ failing: true, reason: '', railAtMin: null, failedAtMin: 0 });
    await tickAgent(w.card, w.body, w.ports, at(6)); w.settle(7);   // ① first failure of the day → normalize
    await tickAgent(w.card, w.body, w.ports, at(37)); w.settle(38); // ② continue the ladder
    const r3 = await tickAgent(w.card, w.body, w.ports, at(68));    // ladder exhausted (2) → escalate
    expect(w.retries.length).toBe(2);
    expect(r3.acted).toEqual(['card-loop-owner:loop:release-traffic@2026-11-27T13:20']);
    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.to).toBe('OP');
    expect(w.posts[0]!.body).toContain('런 run-3 · 실패 노드 tick');
    expect(w.posts[0]!.body).toContain('이유 출력 없음(no-reason)');
    expect(w.posts[0]!.body).toContain('정상화 2번');
    const c = cases(w.root)[0]!;
    expect([c.state, c.history.map(h => h.state)]).toEqual(['escalated', ['detected', 'acting', 'acting', 'escalated']]);
    expect(w.memory.cases(100).some(x => x.kind === 'act' && x.why.includes('no-reason'))).toBe(true);
    await tickAgent(w.card, w.body, w.ports, at(120));
    expect(w.posts.length).toBe(1); // escalated: the owner has it, no repeat
  });
  test('out of policy (same loop already failed today · not a rail window) → no retry, one card at once', async () => {
    const w = world({ failing: true, reason: 'boom', railAtMin: null, failedAtMin: 0 });
    // an earlier case of the same loop today
    const kit = await import('../../kit/case-ledger/index.js');
    kit.openCase(w.root, { domain: 'loop-exception', id: 'loop:release-traffic@2026-11-27T08:00', subject: 'earlier', owner: 'OP', slaMin: 60, by: 'RUN-DOCTOR', why: 'earlier' }, at(-300));
    kit.moveCase(w.root, 'loop-exception', 'loop:release-traffic@2026-11-27T08:00', 'resolved', { by: 'RUN-DOCTOR', why: 'normal again' }, at(-250));
    const r = await tickAgent(w.card, w.body, w.ports, at(6));
    expect(w.retries).toEqual([]);
    expect(r.acted).toEqual(['card-loop-owner:loop:release-traffic@2026-11-27T13:20']);
    expect(w.posts[0]!.body).toContain('출력 끝: boom');
  });
  test('SLA: a retry that never comes back to normal is escalated after loop_case_sla_min', async () => {
    const w = world({ failing: false, reason: 'x', railAtMin: -1, failedAtMin: 0 });
    await tickAgent(w.card, w.body, w.ports, at(6)); // retry → retry-wait, never settles
    await tickAgent(w.card, w.body, w.ports, at(40));
    expect(w.posts).toEqual([]);
    const r = await tickAgent(w.card, w.body, w.ports, at(70)); // 70 min since detection > 60
    expect(r.acted).toEqual(['card-loop-owner:loop:release-traffic@2026-11-27T13:20']);
    expect(cases(w.root)[0]!.state).toBe('escalated');
  });
  test('voice «루프 예외 지금 몇 개?» answers from the facts (fake LLM)', async () => {
    const w = world({ failing: true, reason: '', railAtMin: null, failedAtMin: 0 });
    let seen = '';
    const llm: VoiceLlm = { async complete(_s, user) { seen = user; const m = /루프 예외 (\d+)/u.exec(user); const u = /미정상화 사건 (\d+)/u.exec(user); return { model: 'fake', text: JSON.stringify({ reply: `루프 예외 ${m?.[1] ?? '?'}개 · 미정상화 사건 ${u?.[1] ?? '?'}`, actions: [] }) }; } };
    const v = await voiceAgent({ card: w.card, body: w.body, ports: { ...w.ports, llm }, now: at(7) }, { id: 1, from: 'OP', body: '루프 예외 지금 몇 개?', at: at(7).toISOString(), channel: 'mail', thread: 'mail' });
    expect(seen).toContain('루프 ok 2/3 · 루프 예외 1: release-traffic 7분 (이유 없음) · 미정상화 사건 1');
    expect(v.reply.split('\n')[0]).toBe('루프 예외 1개 · 미정상화 사건 1');
  });
});
