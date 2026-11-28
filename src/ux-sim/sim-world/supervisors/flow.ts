// SIM-WORLD supervisors · flow group (CEO 11-27 11:5x «감독자 일을 시뮬월드에서») — train-manager · release-rocket ·
// hand-steward on the LOOP-AGENT v2 shell, driven by injected subject events in a fresh state root per seed.
//
// Each scenario, per seed (ctx.seed, +1, +2):
//   ① in-policy path — the subject event (hot-file PR storm · rehearsal due and not started · idle hand ⊕ ready cell)
//      → tickAgent → WOKE (level live ⊕ a tick case) · PRODUCED the exact reversible action (literal token) · the KPI
//      line in the tick case (literal name ⊕ value) · no L0 post.
//   ② out-of-policy path — a fault the body cannot close (order write fails · publish never happens · hint write fails)
//      held past escalate_after_min → exactly one `kpi-breach:` post to the literal L0 seat.
// Expectations are literals (rule 11) — never computed from the bodies' constants or functions. Fake deps live here
// (no import from *.test.ts). No network · no real processes · no Math.random.
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { createBody as releaseRocketBody, type ReleaseRocketDeps, type ReleaseView, type RunView } from '../../../loop-agent/bodies/release-rocket.js';
import { createBody as handStewardBody, type Cell, type Hand, type HandStewardDeps, type Hint } from '../../../loop-agent/bodies/hand-steward.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

interface Post { readonly key: string; readonly to: string; readonly body: string }
interface Rig { readonly ports: AgentPorts; readonly posts: Post[]; readonly beats: string[]; readonly cases: () => Array<{ kind: string; why: string }> }

function rig(stateRoot: string, id: string, supervisor: string): Rig {
  const memory = fileAgentMemory(stateRoot, id, supervisor);
  const posts: Post[] = []; const beats: string[] = [];
  const ports: AgentPorts = {
    memory,
    post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 9000 + posts.length; },
    beat: b => { beats.push(b.name); },
    speak: () => {},
    llm: null,
  };
  return { ports, posts, beats, cases: () => memory.cases(500).map(c => ({ kind: c.kind, why: c.why })) };
}

/** Verdict on one in-policy tick: woke · produced · KPI line · no L0 post. Returns the mismatches. */
function inPolicy(r: TickReport, g: Rig, expect: { acted: readonly string[]; kpiText: string }): string[] {
  const bad: string[] = [];
  const tick = g.cases().filter(c => c.kind === 'tick').pop();
  if (r.level !== 'live') bad.push(`level ${r.level} ≠ live`);
  if (!tick) bad.push('no tick case');
  if (JSON.stringify(r.acted) !== JSON.stringify(expect.acted)) bad.push(`acted ${JSON.stringify(r.acted)} ≠ ${JSON.stringify(expect.acted)}`);
  if (tick && !tick.why.includes(expect.kpiText)) bad.push(`tick why «${tick.why}» lacks «${expect.kpiText}»`);
  const l0 = g.posts.filter(p => p.key.startsWith('kpi-breach:'));
  if (l0.length) bad.push(`in-policy L0 post ${l0.map(p => p.key).join(',')}`);
  return bad;
}
function outOfPolicy(g: Rig, seat: string): string[] {
  const l0 = g.posts.filter(p => p.key.startsWith('kpi-breach:'));
  if (l0.length !== 1) return [`kpi-breach posts ${l0.length} ≠ 1`];
  return l0[0]!.to === seat ? [] : [`kpi-breach to ${l0[0]!.to} ≠ ${seat}`];
}
const seeds = (ctx: SimWorldScenarioContext) => [ctx.seed, ctx.seed + 1, ctx.seed + 2];
const verdict = (ctx: SimWorldScenarioContext, id: string, bad: string[], data: Record<string, unknown>): SimWorldScenarioOutcome => {
  ctx.recorder.event(`sup:${id}`, { ...data, ok: bad.length === 0, bad });
  return bad.length ? { ok: false, reason: bad[0]!.split(' ')[0] ?? 'mismatch', diff: bad.join(' | ') } : { ok: true };
};
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000);

// ── release-rocket: cut countdown ────────────────────────────────────────────────────────────────────────────────────
const RR_CLOCK = { rehearsalAt: '2026-11-27T13:00:00.000Z', cutAt: '2026-11-27T19:00:00.000Z', publishAt: '2026-11-27T21:00:00.000Z' };
const NO_RUN: RunView = { exists: false, done: false, hardStop: null, steps: {} };
function rrWorld(phase: 'rehearsal-due' | 'publish-stuck') {
  const state: { rehearsal: RunView; run: RunView } = phase === 'rehearsal-due'
    ? { rehearsal: NO_RUN, run: NO_RUN }
    : { rehearsal: { exists: true, done: true, hardStop: null, steps: {} }, run: { exists: true, done: false, hardStop: 'publish: npm 403', steps: { cut: 'done', publish: 'failed' } } };
  const started: string[] = []; const mails: Post[] = [];
  const deps: ReleaseRocketDeps = {
    readRelease: (): ReleaseView => ({ version: '0.3.40', published: false, clock: RR_CLOCK, clockSource: 'schedule', run: state.run, rehearsal: state.rehearsal,
      yellow: [{ id: 'REL-SIM-A', critical: true, why: 'P0' }, { id: 'REL-SIM-B', critical: false, why: 'P2' }] }),
    startRehearsal: v => { started.push(v); state.rehearsal = { exists: true, done: false, hardStop: null, steps: {} }; return { ok: true, line: `rehearsal ${v} created` }; },
    archiveRehearsal: () => null,
    post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 700 + mails.length; },
  };
  return { started, mails, deps };
}

// ── hand-steward: idle hand ⊕ unowned ready cell ─────────────────────────────────────────────────────────────────────
export const HS_NOW = '2026-11-27T10:00:00.000Z';
export function hsWorld(opts: { brokenHint?: boolean }) {
  const hands: Hand[] = [
    { seat: 'UX-H7', state: 'idle', since: plus(HS_NOW, -40).getTime() },
    { seat: 'JUD-B', state: 'idle', since: plus(HS_NOW, -90).getTime(), judge: true },
    { seat: 'TC-H2', state: 'working', cell: 'BUSY-1' },
  ];
  const cells: Cell[] = [
    { id: 'ELS-SIM-12', title: 'sim ready cell', status: 'yellow', priority: 'P0', paths: ['docs/sim.md'] },
    { id: 'UMB-SIM', title: 'umbrella', status: 'yellow', dispatchKind: 'umbrella', paths: [] },
    { id: 'BUSY-1', title: 'busy', status: 'yellow', owner: 'TC-H2', paths: [] },
  ];
  const hints: Record<string, Hint> = {}; const mails: Post[] = [];
  const deps: HandStewardDeps = {
    readHands: () => hands.slice(),
    readCells: () => ({ version: '0.3.40', cells: cells.slice() }),
    readHints: () => ({ ...hints }),
    hint: (cell, seat) => { if (opts.brokenHint) throw new Error('EACCES priority-order.json'); hints[cell] = { seat, until: plus(HS_NOW, 45).toISOString() }; },
    unhint: cell => { if (!hints[cell]) return false; delete hints[cell]; return true; },
    modelFor: () => ({ line: 'model: easy → openrouter/z-ai/glm-5.3 (docs/tests only)', tier: 'easy' }),
    post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 600 + mails.length; },
    wake: () => 'wake typed',
  };
  return { hints, mails, deps };
}

async function ticks(card: ReturnType<typeof loadCard>, body: AgentBody, g: Rig, times: readonly Date[], before?: (t: Date) => void): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (const t of times) { before?.(t); out.push(await tickAgent(card, body, g.ports, t)); }
  return out;
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-RELEASE-ROCKET',
    title: 'release-rocket: rehearsal due 22:00 and not started at 22:20 → start-rehearsal; publish failed past 06:15 for 30 min → one card to OP',
    async run(ctx) {
      const bad: string[] = []; const seen: Record<string, unknown> = {};
      for (const seed of seeds(ctx)) {
        const card = loadCard('release-rocket');
        const a = rrWorld('rehearsal-due');
        const rootA = join(ctx.universeRoot, `s${seed}`, 'in');
        const ga = rig(rootA, 'release-rocket', 'OP');
        const [r] = await ticks(card, releaseRocketBody({ stateRoot: rootA, card }, a.deps), ga, [new Date('2026-11-27T13:20:00.000Z')]);
        bad.push(...inPolicy(r!, ga, { acted: ['start-rehearsal:0.3.40'], kpiText: 'late_milestones 1' }).map(b => `seed ${seed} in: ${b}`));
        if (JSON.stringify(a.started) !== '["0.3.40"]') bad.push(`seed ${seed} in: started ${JSON.stringify(a.started)} ≠ ["0.3.40"]`);
        if (a.mails.length !== 0) bad.push(`seed ${seed} in: unexpected mail ${a.mails.map(m => m.key).join(',')}`);
        // ② out-of-policy: publish failed (hard stop) — the rocket may not publish; 21:20 … 21:50Z
        const b = rrWorld('publish-stuck');
        const rootB = join(ctx.universeRoot, `s${seed}`, 'out');
        const gb = rig(rootB, 'release-rocket', 'OP');
        const rs = await ticks(card, releaseRocketBody({ stateRoot: rootB, card }, b.deps), gb, [20, 30, 40, 50, 60].map(m => plus(RR_CLOCK.publishAt, m)));
        bad.push(...outOfPolicy(gb, 'OP').map(x => `seed ${seed} out: ${x}`));
        if (rs.some(x => x.acted.length)) bad.push(`seed ${seed} out: acted ${rs.flatMap(x => x.acted).join(',')} on a late publish`);
        seen[`s${seed}`] = { acted: r!.acted, kpi: r!.kpi, l0Out: gb.posts.filter(p => p.key.startsWith('kpi-breach:')).map(p => p.to) };
      }
      return verdict(ctx, 'release-rocket', bad, seen);
    },
  },
  {
    id: 'SUP-HAND-STEWARD',
    title: 'hand-steward: UX-H7 idle 40 min ⊕ unowned P0 cell ELS-SIM-12 → assign (pull hint); an unwritable hint past 60 min → one card to OP',
    async run(ctx) {
      const bad: string[] = []; const seen: Record<string, unknown> = {};
      for (const seed of seeds(ctx)) {
        const card = loadCard('hand-steward');
        const a = hsWorld({});
        const rootA = join(ctx.universeRoot, `s${seed}`, 'in');
        const ga = rig(rootA, 'hand-steward', 'OP');
        const [r] = await ticks(card, handStewardBody({ stateRoot: rootA, card }, a.deps), ga, [new Date(HS_NOW)]);
        bad.push(...inPolicy(r!, ga, { acted: ['assign:ELS-SIM-12@UX-H7'], kpiText: 'idle_hands_with_ready_cells 1' }).map(b => `seed ${seed} in: ${b}`));
        if (a.hints['ELS-SIM-12']?.seat !== 'UX-H7') bad.push(`seed ${seed} in: hint ${JSON.stringify(a.hints)} ≠ ELS-SIM-12→UX-H7`);
        if (a.mails.length !== 1 || a.mails[0]!.to !== 'UX-H7' || !a.mails[0]!.body.includes('eln work next')) bad.push(`seed ${seed} in: pull mail ${JSON.stringify(a.mails.map(m => m.to))} ≠ UX-H7×1`);
        // ② out-of-policy: the hint cannot be written · the hand stays idle
        const b = hsWorld({ brokenHint: true });
        const rootB = join(ctx.universeRoot, `s${seed}`, 'out');
        const gb = rig(rootB, 'hand-steward', 'OP');
        await ticks(card, handStewardBody({ stateRoot: rootB, card }, b.deps), gb, [0, 20, 40, 60, 80].map(m => plus(HS_NOW, m)));
        bad.push(...outOfPolicy(gb, 'OP').map(x => `seed ${seed} out: ${x}`));
        seen[`s${seed}`] = { acted: r!.acted, kpi: r!.kpi, l0Out: gb.posts.filter(p => p.key.startsWith('kpi-breach:')).map(p => p.to) };
      }
      return verdict(ctx, 'hand-steward', bad, seen);
    },
  },
];
