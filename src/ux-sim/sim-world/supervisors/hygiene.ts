// SIM-WORLD supervisors · hygiene and liveness — the LOOP-AGENT v2 bodies watchers-check · silence-watch (macrophage → delegates.ts)
// driven through the real shell (`tickAgent`) and the real cards, with fake subject worlds (no network · no real process ·
// no Math.random). Each scenario injects the subject events the body exists for and pins, with literal expectations
// (OPS-RULES 11 — never computed from product constants): it WOKE (level live · a `tick` case), PRODUCED the right
// reversible action (literal tokens), recorded the KPI line (literal name ⊕ value), stayed quiet toward its L0 on the
// in-policy path, and carded the literal L0 exactly once when a fault outlives escalate_after_min.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory, type AgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { createBody as createWatchers, type WatchersCheckDeps } from '../../../loop-agent/bodies/watchers-check.js';
import { createBody as createSilence, type SilenceDeps } from '../../../loop-agent/bodies/silence-watch.js';
import type { Beat } from '../../../kit/heartbeat/index.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T10:00:00Z');
const MIN = 60_000; // 출처: #40374 — one minute in ms (scenario clock unit, not a bound)
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

interface Ports { readonly ports: AgentPorts; readonly memory: AgentMemory; readonly posts: Array<{ key: string; to: string; body: string }>; readonly beats: string[] }
function fakePorts(stateRoot: string, id: string, supervisor: string): Ports {
  mkdirSync(stateRoot, { recursive: true });
  const memory = fileAgentMemory(stateRoot, id, supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = []; const beats: string[] = [];
  const ports: AgentPorts = {
    memory,
    post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 100 + posts.length; },
    beat(b) { beats.push(b.name); },
    llm: null,
  };
  return { ports, memory, posts, beats };
}

/** The four literal checks shared by every scenario (in-policy path). */
function checkInPolicy(tag: string, r: TickReport, p: Ports, want: { acted: readonly string[]; kpiText: string; l0: string }): string | null {
  if (r.level !== 'live') return `${tag}: level ${r.level} ≠ live`;
  const ticks = p.memory.cases(500).filter(c => c.kind === 'tick');
  if (!ticks.length) return `${tag}: no tick case`;
  for (const a of want.acted) if (!r.acted.includes(a)) return `${tag}: acted [${r.acted.join(', ')}] lacks ${a}`;
  if (!ticks[0]!.why.includes(want.kpiText)) return `${tag}: tick why «${ticks[0]!.why}» lacks «${want.kpiText}»`;
  const l0 = p.posts.filter(x => x.to === want.l0);
  if (l0.length) return `${tag}: in-policy path posted to L0 ${want.l0}: ${l0.map(x => x.key).join(', ')}`;
  return null;
}
function checkBreach(tag: string, p: Ports, l0: string): string | null {
  const cards = p.posts.filter(x => x.key.startsWith('kpi-breach:'));
  if (cards.length !== 1) return `${tag}: kpi-breach posts ${cards.length} ≠ 1`;
  if (cards[0]!.to !== l0) return `${tag}: kpi-breach went to ${cards[0]!.to} ≠ ${l0}`;
  return null;
}
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [ctx.seed, ctx.seed + 1, ctx.seed + 2];

// ── watchers-check world ─────────────────────────────────────────────────────────────────────────────────────────────
function watchersWorld(opts: { stubborn?: boolean }) {
  let clock = T0;
  const beat = (name: string, at: number, everyMin: number): Beat => ({ name, at: new Date(at).toISOString(), saw: 1, everyMin });
  const beats: Beat[] = [beat('loop:sup-b', T0 - 90 * MIN, 10), beat('trigger-tick', T0 - MIN, 2), beat('res-patrol', T0 - MIN, 5), beat('release-graph-tick', T0 - MIN, 2)];
  const alive = new Set(['trigger-tick', 'res-patrol', 'release-graph-tick']);
  const fired: string[] = [];
  const deps: WatchersCheckDeps = {
    beats: () => beats.slice(), sourceHead: () => null, cardIds: () => ['sup-a', 'sup-b'], triggerIds: () => new Set(),
    fire: argv => { fired.push(argv.join(' ')); if (!opts.stubborn && argv[1] === 'agent') { const n = `loop:${argv[2]}`; alive.add(n); beats.push(beat(n, clock, 10)); } return { ok: true, line: 'fired' }; },
  };
  const advance = (t: number) => { clock = t; for (const n of alive) beats.push(beat(n, t, n.startsWith('loop:') ? 10 : 2)); };
  return { deps, fired, advance };
}

// ── silence-watch world ──────────────────────────────────────────────────────────────────────────────────────────────
function silenceWorld(seed: number, opts: { deaf?: boolean }) {
  const pending = new Map<number, { id: number; from: string; to: string; at: number }>([
    [7001, { id: 7001, from: 'OP', to: 'TC', at: T0 - (45 + (seed % 7)) * MIN }],
    [7002, { id: 7002, from: 'LAND-GRAPH', to: 'RES', at: T0 - 120 * MIN }],
  ]);
  if (opts.deaf) pending.set(7003, { id: 7003, from: 'OP', to: 'REL', at: T0 - 90 * MIN });
  const rung: number[] = []; const bounced: Array<{ key: string; to: string }> = [];
  const deps: SilenceDeps = {
    overdue: (now, sla) => [...pending.values()].filter(m => now.getTime() - m.at >= sla * MIN).map(m => ({ id: m.id, from: m.from, to: m.to, ageMin: (now.getTime() - m.at) / MIN, summary: 'please accept or reject' })),
    readers: (_now, addrs) => new Map(addrs.map(a => [a, a !== 'RES'] as const)),
    stalled: () => [],
    ring: (to, id) => { rung.push(id); if (to !== 'REL') pending.delete(id); return true; },
    post: (key, to) => { if (bounced.some(b => b.key === key)) return null; bounced.push({ key, to }); return 500 + bounced.length; },
  };
  return { deps, rung, bounced };
}

async function ticks(body: AgentBody, id: string, p: Ports, n: number, stepMin: number, before?: (t: number) => void): Promise<TickReport[]> {
  const card = loadCard(id); const out: TickReport[] = [];
  for (let i = 0; i < n; i++) { const t = T0 + i * stepMin * MIN; before?.(t); out.push(await tickAgent(card, body, p.ports, new Date(t))); }
  return out;
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-WATCHERS-CHECK',
    title: 'watchers-check: a v2 card with no heartbeat and a DEAD supervisor are each restarted once; one that never comes back cards OP once',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const root = join(ctx.universeRoot, `s${seed}`, 'live');
        const w = watchersWorld({});
        const p = fakePorts(root, 'watchers-check', 'OP');
        const body = createWatchers({ stateRoot: root, card: loadCard('watchers-check') }, w.deps);
        const [r1, r2] = await ticks(body, 'watchers-check', p, 2, 5, t => { if (t > T0) w.advance(t); });
        ctx.recorder.event('sup:watchers-check', { seed, acted: r1!.acted, kpi: [r1!.kpi, r2!.kpi], fired: w.fired, posts: p.posts.map(x => x.key) });
        const bad = checkInPolicy(`seed ${seed}`, r1!, p, { acted: ['restart:loop:sup-a', 'restart:loop:sup-b'], kpiText: 'missing_heartbeats 2', l0: 'OP' });
        if (bad) return fail('in-policy', bad);
        if (w.fired.join(' | ') !== 'loop agent sup-a tick | loop agent sup-b tick') return fail('wrong-fire', `seed ${seed}: fired ${w.fired.join(' | ')}`);
        if (r2!.kpi !== 0) return fail('kpi-stuck', `seed ${seed}: second tick KPI ${r2!.kpi} ≠ 0`);
        const rootF = join(ctx.universeRoot, `s${seed}`, 'fault');
        const wf = watchersWorld({ stubborn: true });
        const pf = fakePorts(rootF, 'watchers-check', 'OP');
        await ticks(createWatchers({ stateRoot: rootF, card: loadCard('watchers-check') }, wf.deps), 'watchers-check', pf, 8, 5, t => { if (t > T0) wf.advance(t); });
        ctx.recorder.event('sup:watchers-check', { seed, fault: true, posts: pf.posts.map(x => `${x.to}:${x.key}`) });
        const b = checkBreach(`seed ${seed} fault`, pf, 'OP');
        if (b) return fail('escalation', b);
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-SILENCE-WATCH',
    title: 'silence-watch: a seat with requests past SLA is rung once; mail to an address with no reading body is noticed to its sender once a day; a seat that never decides cards OP once',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const root = join(ctx.universeRoot, `s${seed}`, 'live');
        const w = silenceWorld(seed, {});
        const p = fakePorts(root, 'silence-watch', 'OP');
        const body = createSilence({ stateRoot: root, card: loadCard('silence-watch') }, w.deps);
        const [r1, r2] = await ticks(body, 'silence-watch', p, 2, 5);
        ctx.recorder.event('sup:silence-watch', { seed, acted: r1!.acted, kpi: [r1!.kpi, r2!.kpi], rung: w.rung, bounced: w.bounced, posts: p.posts.map(x => x.key) });
        const bad = checkInPolicy(`seed ${seed}`, r1!, p, { acted: ['redeliver:TC', 'bounce:RES'], kpiText: 'unanswered_mail_past_sla 2', l0: 'OP' });
        if (bad) return fail('in-policy', bad);
        if (w.rung.join(',') !== '7001') return fail('wrong-ring', `seed ${seed}: rung ${w.rung.join(',')} ≠ 7001`);
        if (w.bounced.length !== 1 || w.bounced[0]!.to !== 'LAND-GRAPH' || w.bounced[0]!.key !== 'silence-bounce:RES:LAND-GRAPH:2026-11-27') return fail('wrong-bounce', `seed ${seed}: ${JSON.stringify(w.bounced)}`);
        if (r2!.kpi !== 0) return fail('kpi-stuck', `seed ${seed}: second tick KPI ${r2!.kpi} ≠ 0`);
        const rootF = join(ctx.universeRoot, `s${seed}`, 'fault');
        const wf = silenceWorld(seed, { deaf: true });
        const pf = fakePorts(rootF, 'silence-watch', 'OP');
        await ticks(createSilence({ stateRoot: rootF, card: loadCard('silence-watch') }, wf.deps), 'silence-watch', pf, 14, 5);
        ctx.recorder.event('sup:silence-watch', { seed, fault: true, rung: wf.rung, posts: pf.posts.map(x => `${x.to}:${x.key}`) });
        if (wf.rung.filter(id => id === 7003).length !== 1) return fail('re-ring', `seed ${seed}: 7003 rung ${wf.rung.filter(id => id === 7003).length} times ≠ 1`);
        const b = checkBreach(`seed ${seed} fault`, pf, 'OP');
        if (b) return fail('escalation', b);
      }
      return { ok: true };
    },
  },
];
