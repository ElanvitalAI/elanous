// SIM-WORLD supervisors · LOOP-EXCEPTION-WATCH (대표 11-27 «1. 본다 2. 문제가 있을 경우 정상화를 한다») — the 22:21 release-traffic
// exception replayed on the REAL run-doctor body ⊕ runtime ⊕ kit/case-ledger with a fake trigger registry:
//   A: the loop failed 3 min after a rail → one registry retry → its next run is done → the case is resolved (no card).
//   B: the loop keeps failing → ① retry ② retry → still exception → ONE card to the owner (run id · node · the reason the
//      run left) → escalated · the guardian KPI «미정상화 사건» and the OP world card line carry it until it is normal.
// Expectations are independent literals (rule 11).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentPorts } from '../../../loop-agent/runtime.js';
import { createBody, type RunDoctorDeps } from '../../../loop-agent/bodies/run-doctor.js';
import type { LoopExceptionDeps, LoopScan } from '../../../loop-agent/bodies/loop-exceptions.js';
import { readCases, unnormalizedCases } from '../../../kit/case-ledger/index.js';
import { planGuardian } from '../../../guardian-agent/body.js';
import { renderLensLines, type LensFacts } from '../../../op-world/world-lens.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T13:21:58Z');
const MIN = 60_000; // 출처: #40574 — 1 minute in ms (the scenario clock unit, not a bound)
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
/** The simulated loop (a fixture name in the sim universe — the 11-27 22:21 case). */
const LOOP = 'release-traffic';
const WHY = '{"outcome":"fail","why":"fail: set node-b pregateSlots 2→0 failed · phase reserve"}';

function world(root: string, failing: boolean) {
  mkdirSync(root, { recursive: true });
  let status = 'exception'; let failAt = T0; let runN = 1;
  const retries: string[] = []; const posts: Array<{ key: string; to: string; body: string }> = [];
  const loops: LoopExceptionDeps = {
    caseRoot: root,
    faults: (): LoopScan => ({ total: 15, faults: status === 'exception' ? [{ graphId: LOOP, owner: 'OP', window: '2026-11-27T13:20', at: failAt, attempt: 2, runId: `rt-${runN}`, error: null, node: 'tick', tail: WHY }] : [],
      status: { [LOOP]: status } }),
    railAt: () => T0 - 3 * MIN, // rail 95: els kickstart 3 min before the failure
    retry: (g, w) => { retries.push(`${g}@${w}`); status = 'retry-wait'; return { ok: true, line: 're-armed' }; },
    post: (key, to, body) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return posts.length; },
  };
  const settle = (m: number) => { if (status !== 'retry-wait') return; if (failing) { status = 'exception'; failAt = T0 + m * MIN; runN += 1; } else status = 'done'; };
  const deps: RunDoctorDeps = { redGates: () => [], greens: () => new Map(), failedRuns: () => [], hosts: () => [], inflight: () => false,
    diagnoses: () => [], writeDiagnosis: () => {}, recordRunVisit: () => {}, retries: () => [], retry: () => ({ ok: false, line: '' }), recordRetry: () => {}, loops };
  const card = loadCard('run-doctor');
  const ports: AgentPorts = { memory: fileAgentMemory(root, card.id, card.supervisor), post: () => null, beat: () => {}, speak: () => {}, llm: null };
  return { card, ports, retries, posts, settle, body: createBody({ stateRoot: root, card }, deps), state: () => status };
}

const lensWith = (loops: LensFacts['loops']): LensFacts => ({ at: new Date(T0).toISOString(), board: null, prevBoard: null, land: null, pool: null, mail: null, hands: null, commitments: null, holds: null, supervisors: null, loops, world: null, unmeasured: [] } as unknown as LensFacts);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-LOOP-EXCEPTION',
    title: 'run-doctor reconciles trigger exceptions: a rail casualty is normalized by one retry (resolved · no card) · a persistent one climbs the ladder (2 retries) then ONE owner card with run id, node and reason · guardian «미정상화 사건» and the OP world card carry it',
    async run(ctx) {
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2, ctx.seed + 3, ctx.seed + 4]) {
        // A — rail casualty → normal again
        const ra = join(ctx.universeRoot, `lx-a${seed}`);
        const a = world(ra, false);
        await tickAgent(a.card, a.body, a.ports, new Date(T0 + (6 + seed) * MIN));
        a.settle(8 + seed);
        await tickAgent(a.card, a.body, a.ports, new Date(T0 + (40 + seed) * MIN));
        const ca = readCases(ra, 'loop-exception');
        ctx.recorder.event('sup:loop-exception', { seed, path: 'rail-retry', retries: a.retries, states: ca.map(c => c.state), posts: a.posts.length });
        if (JSON.stringify(a.retries) !== '["release-traffic@2026-11-27T13:20"]') return fail('A-retry', `seed ${seed}: retries ${JSON.stringify(a.retries)}`);
        if (JSON.stringify(ca.map(c => c.history.map(h => h.state))) !== '[["detected","acting","resolved"]]') return fail('A-case', `seed ${seed}: ${JSON.stringify(ca.map(c => c.history.map(h => h.state)))}`);
        if (a.posts.length) return fail('A-card', `seed ${seed}: posts ${JSON.stringify(a.posts)}`);
        // B — persistent → ladder → one card with the reason → escalated
        const rb = join(ctx.universeRoot, `lx-b${seed}`);
        const b = world(rb, true);
        await tickAgent(b.card, b.body, b.ports, new Date(T0 + 6 * MIN)); b.settle(7);
        await tickAgent(b.card, b.body, b.ports, new Date(T0 + 37 * MIN)); b.settle(38);
        await tickAgent(b.card, b.body, b.ports, new Date(T0 + 50 * MIN));
        await tickAgent(b.card, b.body, b.ports, new Date(T0 + (90 + seed) * MIN));
        const cb = readCases(rb, 'loop-exception');
        ctx.recorder.event('sup:loop-exception', { seed, path: 'persistent', retries: b.retries.length, states: cb.map(c => c.history.map(h => h.state)), posts: b.posts.map(p => p.to) });
        if (b.retries.length !== 2) return fail('B-ladder', `seed ${seed}: ${b.retries.length} retries (want 2)`);
        if (JSON.stringify(b.posts.map(p => p.to)) !== '["OP"]') return fail('B-card', `seed ${seed}: posts to ${JSON.stringify(b.posts.map(p => p.to))} (want exactly one to OP)`);
        const body = b.posts[0]!.body;
        for (const want of ['루프 release-traffic 예외', '런 rt-3 · 실패 노드 tick', 'set node-b pregateSlots 2→0 failed', '정상화 2번', 'eln loop trigger retry release-traffic --window 2026-11-27T13:20'])
          if (!body.includes(want)) return fail('B-card-body', `seed ${seed}: card lacks «${want}»: ${body.slice(0, 300)}`);
        if (JSON.stringify(cb.map(c => c.history.map(h => h.state))) !== '[["detected","acting","acting","escalated"]]') return fail('B-case', `seed ${seed}: ${JSON.stringify(cb.map(c => c.history.map(h => h.state)))}`);
        // guardian KPI ⊕ OP world card: escalated is still «미정상화» until the loop is normal
        const u = unnormalizedCases(rb, new Date(T0 + 100 * MIN));
        const g = planGuardian({ now: new Date(T0 + 100 * MIN), probes: [], procs: new Map(), registry: new Map(), ready: null, hands: null, cases: u ? { open: u.open, overdue: u.overdue } : null });
        if (g.kpi.unnormalized !== 1) return fail('guardian-kpi', `seed ${seed}: unnormalized ${String(g.kpi.unnormalized)} (want 1)`);
        const line = renderLensLines(lensWith({ total: 15, exceptions: [{ id: 'release-traffic', at: new Date(T0 + 38 * MIN).toISOString() }], unnormalized: u?.open ?? null }), new Date(T0 + 100 * MIN), null).find(l => l.startsWith('- Loops'));
        if (line !== '- Loops: ok 14/15 · exception: release-traffic 1h02m · 미정상화 사건 1 (target 0) [src: eln loop trigger list · eln loop agent run-doctor status]')
          return fail('world-card', `seed ${seed}: «${line}»`);
      }
      return { ok: true };
    },
  },
];
