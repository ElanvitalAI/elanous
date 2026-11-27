// SIM-WORLD supervisors · v3 agent.yaml (YAML-SUPERVISORS-DEF · 대표 11-27 12:0x «감독자들도 다 로직·정책 등을 yaml 로»):
//   SUP-V3-EQUIV          — every supervisor's agent.yaml lints clean, carries the v2 numbers (literal table below) and its step
//                           graph walks the v2 order; the same world ticked with the v2 card and with the agent.yaml gives the
//                           same reports and the same case kinds (5 seeds).
//   SUP-V3-POLICY-CHANGE  — a change in agent.yaml alone changes behaviour: churn_window_min 60 → 5 drops the train-manager KPI
//                           2 → 0; max_per_tick 3 → 0 leaves the plan unacted (5 seeds).
//   SUP-V3-LINT-REFUSES   — lint refuses a missing body policy · an unknown node kind · a non-portable path · a wake with both cron and condition; a
//                           refused agent.yaml falls back to the v2 card and carries one L0 card (5 seeds).
// Expectations are independent literals (rule 11).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LedgerRow, PrInfo } from '../../../land-graph/land-graph.js';
import { cardsRoot, loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { tickAgent, type AgentBody, type AgentPorts } from '../../../loop-agent/runtime.js';
import { cardFromCompiled, graphOf, lintSupervisor, supervisorDef, supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createBody as trainBody, type TrainManagerDeps } from '../../../loop-agent/bodies/train-manager.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [0, 1, 2, 3, 4].map(i => ctx.seed + i);
const T0 = Date.parse('2026-11-27T10:00:00Z');
const at = (min: number): Date => new Date(T0 + min * 60_000); // 출처: #v3 — minutes on the scenario clock (not a bound)
const REPO = resolve(import.meta.dir, '../../../..');
const ORG_TEXT = 'org:\n  duties:\n    landing: TC\n    escalation-parent: OP\n    resource-supervision: RES\n    release-supervision: OP\n    board: OP\n';

/** Literal v2 numbers per supervisor (body constants · card rights · KPI) — not read from the code. */
const V2: Readonly<Record<string, { kpi: string; target: number; max: number; cool: number; esc: number; body: Record<string, number>; l0: string }>> = {
  'run-supervisor': { kpi: 'zombie_runs', target: 0, max: 3, cool: 20, esc: 60, l0: 'TC', body: { pregate_zombie_min: 90, stale_record_min: 90, run_stall_min: 30, run_zombie_min: 120, run_window_h: 48 } },
  'run-doctor': { kpi: 're_success_ratio', target: 0.5, max: 4, cool: 30, esc: 120, l0: 'TC', body: { window_h: 24, settle_min: 60, retry_max_age_h: 6, loop_exception_min: 5, rail_window_min: 20, loop_normalize_attempts: 2, loop_case_sla_min: 60 } },
  autopsy: { kpi: 'unclassified_deaths', target: 0, max: 3, cool: 10, esc: 120, l0: 'OP', body: { window_h: 24, classify_batch: 50, cell_repeat: 3, cell_window_days: 7, cells_per_day: 2 } },
  macrophage: { kpi: 'orphans_over_2h', target: 0, max: 3, cool: 30, esc: 120, l0: 'RES', body: { recent_reap_min: 30 } },
  'watchers-check': { kpi: 'missing_heartbeats', target: 0, max: 5, cool: 30, esc: 30, l0: 'OP', body: { recent_min: 1440 } },
  'silence-watch': { kpi: 'unanswered_mail_past_sla', target: 0, max: 8, cool: 60, esc: 60, l0: 'OP', body: { sla_min: 30, lookback_h: 24 } },
  'train-manager': { kpi: 'hot_file_churn_refusals', target: 0, max: 3, cool: 30, esc: 90, l0: 'TC', body: { churn_window_min: 60 } },
  'release-rocket': { kpi: 'late_milestones', target: 0, max: 2, cool: 60, esc: 30, l0: 'OP', body: { grace_min: 15, waiver_window_min: 120 } },
  'hand-steward': { kpi: 'idle_hands_with_ready_cells', target: 0, max: 3, cool: 45, esc: 60, l0: 'OP', body: {} },
};

function ports(stateRoot: string, id: string, supervisor: string) {
  const posts: Array<{ key: string; to: string }> = [];
  const p: AgentPorts = { memory: fileAgentMemory(stateRoot, id, supervisor), post: (key, to) => { if (posts.some(x => x.key === key)) return null; posts.push({ key, to }); return posts.length; }, beat: () => undefined, llm: null };
  return { p, posts };
}
/** A deterministic toy body: `n` subjects, KPI = n, one action that closes one subject. */
function toyBody(n0: number): AgentBody {
  let n = n0;
  return {
    observe: () => ({ kpi: n, subjects: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'x', summary: 'x' })), facts: [] }),
    plan: (obs) => obs.subjects.map(s => ({ action: 'fix', target: s.id, why: 'x' })),
    actions: { fix: { describe: 'x', run: (t) => { n = Math.max(0, n - 1); return { ok: true, line: `${t} fixed` }; } } },
  };
}
function trainWorld(clock: { m: number }): TrainManagerDeps {
  const file = 'src/hot/a.ts';
  const prs: PrInfo[] = [40701, 40702, 40703].map(n => ({ number: n, head: `h${n}`, base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files: [file], headRef: `b${n}`, createdAt: '2026-11-27T05:00:00Z' }));
  const rows = (): LedgerRow[] => [
    { at: at(clock.m - 20).toISOString(), pr: 40703, head: 'old', mode: 'live', event: 'refused', cls: 'merge-conflict', why: 'x' },
    { at: at(clock.m - 10).toISOString(), pr: 40702, head: 'old', mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'x' },
  ];
  return { readLedger: rows, listPrs: async () => prs, policy: () => null, post: () => 1 };
}
/** A copy of graphs/loop-agents/<id> and graphs/triggers in a temp tree, with `edit` applied to agent.yaml. */
function editedPackage(base: string, id: string, edit: (yaml: string) => string): string {
  const root = mkdtempSync(join(base, 'pkg-'));
  mkdirSync(join(root, 'loop-agents'), { recursive: true });
  cpSync(join(cardsRoot(), id), join(root, 'loop-agents', id), { recursive: true });
  cpSync(join(REPO, 'graphs', 'triggers'), join(root, 'triggers'), { recursive: true });
  const p = join(root, 'loop-agents', id, 'agent.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
  return join(root, 'loop-agents');
}

// ── deeper verification (CEO 11-27 «v3 YAML 이 시뮬 월드에서 충분히 검증됐나») ─────────────────────────────────────────────
const ALL10 = ['autopsy', 'hand-steward', 'land-steward', 'macrophage', 'release-rocket', 'run-doctor', 'run-supervisor', 'silence-watch', 'train-manager', 'watchers-check'];
/** A fresh universe: only the agent packages and the trigger declarations, copied out of the repo. */
function freshUniverse(base: string): string {
  const root = mkdtempSync(join(base, 'fresh-'));
  mkdirSync(join(root, 'loop-agents'), { recursive: true });
  for (const id of ALL10) cpSync(join(cardsRoot(), id), join(root, 'loop-agents', id), { recursive: true });
  cpSync(join(REPO, 'graphs', 'triggers'), join(root, 'triggers'), { recursive: true });
  return join(root, 'loop-agents');
}
/** Seeded PRNG (the kernel's ctx.random is per scenario; this one is per agent × seed so worlds do not share a stream). */
function rng(seed: number): () => number { let x = (seed * 2654435761) >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
type Ev = 'quiet' | 'storm' | 'outage' | 'sub-down' | 'host-down';
/** A soak body: subjects per event · observe throws in an outage · the action throws when the sub-agent is down · KPI null when the host is down. */
function soakBody(ev: () => Ev, fixes: Map<string, number[]>, now: () => number): AgentBody {
  let open = new Set<string>();
  return {
    observe: () => {
      const e = ev();
      if (e === 'outage') throw new Error('ledger unreadable');
      if (e === 'storm') for (let i = 0; i < 6; i++) open.add(`t${Math.floor(now() / 600_000) % 50}-${i}`);
      if (e === 'host-down') return { kpi: null, subjects: [], facts: ['host down'] };
      return { kpi: open.size, subjects: [...open].map(id => ({ id, kind: 'x', summary: 'x' })), facts: [] };
    },
    plan: (obs) => obs.subjects.map(x => ({ action: 'fix', target: x.id, why: 'x' })),
    actions: { fix: { describe: 'x', run: (t) => { if (ev() === 'sub-down') throw new Error('sub-agent down'); fixes.set(t, [...(fixes.get(t) ?? []), now()]); open.delete(t); open = new Set(open); return { ok: true, line: `${t} fixed` }; } } },
  };
}

const deeper: readonly SimWorldScenario[] = [
  {
    id: 'SUP-V3-PORTABLE',
    title: 'all 10 agent packages copied into a fresh universe (packages + trigger declarations only) lint clean and tick once from the copy',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const fresh = freshUniverse(ctx.universeRoot);
        for (const id of ALL10) {
          const r = lintSupervisor(id, fresh);
          if (!r.ok || !r.compiled) return fail('fresh-lint', `seed ${seed} ${id}: ${r.errors.join(' · ')}`);
          if (id === 'land-steward') continue; // its tick is the land-graph body (graph/LA3-PORTABLE · #40441)
          const card = loadCard(id); const def = supervisorDef(card, fresh);
          if (!def.graph || def.refused) return fail('fresh-def', `seed ${seed} ${id}`);
          const root = join(ctx.universeRoot, `port-${id}-${seed}`); const { p } = ports(root, id, def.card.supervisor);
          const rep = await tickAgent({ ...def.card, rights: { ...def.card.rights, actions: ['fix'] } }, toyBody(1 + (seed % 3)), p, at(0), { graph: def.graph, ...(def.policies ? { policies: def.policies } : {}) });
          if (rep.level !== 'live' || !p.memory.cases(10).some(c => c.kind === 'tick')) return fail('fresh-tick', `seed ${seed} ${id}: ${JSON.stringify(rep).slice(0, 160)}`);
        }
      }
      ctx.recorder.event('sup:v3-portable', { agents: ALL10.length, seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-V3-SOAK',
    title: '24 h synthetic clock per supervisor (agent.yaml cadence) with storms · ledger outages · sub-agent down · host down: no double action inside cooldown · heartbeat every tick · L0 cards bounded by episodes',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        for (const id of Object.keys(V2)) {
          const r = lintSupervisor(id); const c = r.compiled!;
          const card = cardFromCompiled(loadCard(id), c); const toy = { ...card, rights: { ...card.rights, actions: ['fix'] } };
          const step = Math.max(5, c.wake.maxWaitMin ?? 10); const ticks = Math.floor(24 * 60 / step);
          const rand = rng(seed * 97 + id.length); let cur: Ev = 'quiet'; let clock = T0;
          const fixes = new Map<string, number[]>(); const beats: number[] = [];
          const root = join(ctx.universeRoot, `soak-${id}-${seed}`);
          const posts: Array<{ key: string; to: string }> = [];
          const p: AgentPorts = { memory: fileAgentMemory(root, id, card.supervisor), post: (key, to) => { if (posts.some(x => x.key === key)) return null; posts.push({ key, to }); return posts.length; }, beat: () => { beats.push(clock); }, llm: null };
          const body = soakBody(() => cur, fixes, () => clock);
          for (let i = 0; i < ticks; i++) {
            const x = rand(); cur = x < 0.55 ? 'quiet' : x < 0.75 ? 'storm' : x < 0.85 ? 'outage' : x < 0.93 ? 'sub-down' : 'host-down';
            clock = T0 + i * step * 60_000;
            await tickAgent(toy, body, p, new Date(clock), { graph: graphOf(c), policies: c.policies });
          }
          // no double action on one target inside the cooldown
          for (const [t, ts] of fixes) for (let k = 1; k < ts.length; k++) if (ts[k]! - ts[k - 1]! < card.rights.cooldownMin * 60_000) return fail('double-action', `${id} seed ${seed}: ${t} fixed twice within ${card.rights.cooldownMin} min`);
          // heartbeat continuous: one beat per tick (outage ticks beat with an error · never a silent tick)
          if (beats.length !== ticks) return fail('heartbeat-gap', `${id} seed ${seed}: ${beats.length} beats for ${ticks} ticks`);
          // L0 cards bounded: ≤ one kpi-breach card per breach episode · ≤ one subject-lost card per lost episode
          const cases = p.memory.cases(100_000);
          const episodes = cases.filter(x => x.kind === 'kpi-breach').length;
          const lostEp = cases.filter(x => x.kind === 'subject-lost').length;
          const breachCards = posts.filter(x => x.key.startsWith('kpi-breach:')).length;
          const lostCards = posts.filter(x => x.key.startsWith('subject-lost:')).length;
          if (breachCards > episodes || lostCards > lostEp) return fail('l0-flood', `${id} seed ${seed}: breach cards ${breachCards} > episodes ${episodes} or lost cards ${lostCards} > ${lostEp}`);
          if (posts.some(x => x.to !== card.supervisor)) return fail('wrong-l0', `${id} seed ${seed}`);
        }
      }
      ctx.recorder.event('sup:v3-soak', { agents: Object.keys(V2).length, seeds: 5, hours: 24 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-V3-POLICY-FAULT',
    title: 'per agent: one policy key deleted and one garbled → loud refusal ⊕ one L0 card ⊕ the v2 card keeps ticking (land-steward: refused, its plain body keeps landing)',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        for (const id of ALL10) {
          const text = readFileSync(join(cardsRoot(), id, 'agent.yaml'), 'utf8');
          // only the `policies:` block (a voice / budget number with the same indent is not a policy)
          const block = /^policies:.*\n((?:  .*\n|\s*\n)+)/mu.exec(text)?.[1] ?? '';
          const keys = [...block.matchAll(/^  ([a-z][a-z0-9_]*): -?\d/gmu)].map(m => m[1]!);
          if (!keys.length) return fail('no-policies', id);
          const key = keys[seed % keys.length]!;
          for (const [tag, edit] of [['deleted', (y: string) => y.replace(new RegExp(`^  ${key}: .*\\n`, 'mu'), '')], ['garbled', (y: string) => y.replace(new RegExp(`^  ${key}: .*$`, 'mu'), `  ${key}: lots`)]] as const) {
            const root = editedPackage(ctx.universeRoot, id, edit);
            const r = lintSupervisor(id, root);
            if (r.ok) return fail(`silent-${tag}`, `${id} seed ${seed}: ${key} ${tag} but lint ok`);
            if (id === 'land-steward') continue; // its own loader refuses and runs the plain body (graph/LA3-REFUSE · #40441)
            // the REAL tick entry (`eln loop agent <id> tick` → supervisorTick): refusal → one L0 card through ports.post → v2 card ticks
            const card = loadCard(id);
            const pr = join(ctx.universeRoot, `pf-${id}-${tag}-${seed}`); const { p, posts } = ports(pr, id, card.supervisor);
            const body = toyBody(2);
            const { def, report: rep } = await supervisorTick({ ...card, rights: { ...card.rights, actions: ['fix'] } }, body, p, at(0), root);
            if (!def.refused || def.graph || def.policies) return fail(`no-fallback-${tag}`, `${id} seed ${seed}`);
            if (rep.level !== 'live' || rep.acted.length === 0) return fail(`stopped-${tag}`, `${id} seed ${seed}: the v2 fallback did not act`);
            await supervisorTick({ ...card, rights: { ...card.rights, actions: ['fix'] } }, body, p, at(5), root); // a second wake: still one card
            const l0 = V2[id]!.l0;
            const cards = posts.filter(x => x.key.startsWith(`agent-yaml-refused:${id}:`));
            if (cards.length !== 1 || cards[0]!.to !== l0 || posts.length !== 1) return fail(`l0-card-${tag}`, `${id} seed ${seed}: posts ${JSON.stringify(posts)} (want exactly one agent-yaml-refused card to ${l0})`);
          }
        }
      }
      ctx.recorder.event('sup:v3-policy-fault', { agents: ALL10.length, seeds: 5 });
      return { ok: true };
    },
  },
];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-V3-EQUIV',
    title: 'nine agent.yaml lint clean · carry the v2 numbers and L0 · walk the v2 step order · same world ⇒ same reports with the v2 card and with the agent.yaml',
    async run(ctx) {
      const org = join(mkdtempSync(join(ctx.universeRoot, 'org-')), 'federation.yaml');
      writeFileSync(org, ORG_TEXT);
      for (const [id, want] of Object.entries(V2)) {
        const lint = lintSupervisor(id);
        if (!lint.ok || !lint.compiled) return fail('lint', `${id}: ${lint.errors.join(' · ')}`);
        for (const [k, v] of Object.entries(want.body)) if (lint.compiled.policies[k] !== v) return fail('policy-drift', `${id}.${k} = ${lint.compiled.policies[k]} (v2 ${v})`);
        const v2 = loadCard(id);
        const c3 = cardFromCompiled(v2, lint.compiled, org);
        const got = { kpi: c3.kpi.name, target: c3.kpi.target, max: c3.rights.maxPerTick, cool: c3.rights.cooldownMin, esc: c3.escalateAfterMin, l0: c3.supervisor };
        const exp = { kpi: want.kpi, target: want.target, max: want.max, cool: want.cool, esc: want.esc, l0: want.l0 };
        if (JSON.stringify(got) !== JSON.stringify(exp)) return fail('card-drift', `${id}: ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`);
        for (const seed of seedsOf(ctx)) {
          const n = 1 + (seed % 4);
          const rA = join(ctx.universeRoot, `eq-${id}-a${seed}`); const rB = join(ctx.universeRoot, `eq-${id}-b${seed}`);
          const a = ports(rA, id, v2.supervisor); const b = ports(rB, id, c3.supervisor);
          const bodyA = toyBody(n); const bodyB = toyBody(n);
          const toyA = { ...v2, rights: { ...v2.rights, actions: ['fix'] } }; const toyB = { ...c3, rights: { ...c3.rights, actions: ['fix'] } };
          for (let i = 0; i < 4; i++) {
            const ra = await tickAgent(toyA, bodyA, a.p, at(i * 31));
            const rb = await tickAgent(toyB, bodyB, b.p, at(i * 31), { graph: graphOf(lint.compiled), policies: lint.compiled.policies });
            const strip = (r: typeof ra) => JSON.stringify({ ...r, at: '' });
            if (strip(ra) !== strip(rb)) return fail('behaviour-drift', `${id} seed ${seed} tick ${i}: ${strip(ra).slice(0, 160)} ≠ ${strip(rb).slice(0, 160)}`);
          }
          const kinds = (p: AgentPorts) => p.memory.cases(200).map(x => x.kind).join(',');
          if (kinds(a.p) !== kinds(b.p)) return fail('case-drift', `${id} seed ${seed}`);
        }
      }
      ctx.recorder.event('sup:v3-equiv', { agents: Object.keys(V2).length, seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-V3-POLICY-CHANGE',
    title: 'agent.yaml alone changes behaviour: train-manager churn_window_min 60 → 5 drops its KPI 2 → 0 · max_per_tick 3 → 0 leaves the plan unacted',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const card = loadCard('train-manager');
        const base = lintSupervisor('train-manager').compiled!;
        const narrow = lintSupervisor('train-manager', editedPackage(ctx.universeRoot, 'train-manager', y => y.replace(/^  churn_window_min: 60/mu, '  churn_window_min: 5'))).compiled;
        const idle = lintSupervisor('train-manager', editedPackage(ctx.universeRoot, 'train-manager', y => y.replace(/^  max_per_tick: 3/mu, '  max_per_tick: 0'))).compiled;
        if (!narrow || !idle) return fail('edited-lint', `seed ${seed}`);
        const run = async (c: typeof base, tag: string) => {
          const clock = { m: 0 }; const root = join(ctx.universeRoot, `pc-${tag}-${seed}`); const { p } = ports(root, 'train-manager', 'TC');
          return tickAgent(cardFromCompiled(card, c), trainBody({ stateRoot: root, card }, trainWorld(clock)), p, at(0), { graph: graphOf(c), policies: c.policies });
        };
        const r0 = await run(base, 'base'); const r1 = await run(narrow, 'narrow'); const r2 = await run(idle, 'idle');
        if (r0.kpi !== 2 || r1.kpi !== 0) return fail('window-ignored', `seed ${seed}: kpi ${r0.kpi} → ${r1.kpi} (want 2 → 0)`);
        if (JSON.stringify(r0.acted) !== JSON.stringify(['propose-pin:lane:src/hot/a.ts']) || r2.acted.length !== 0 || r2.planned !== 0) return fail('cap-ignored', `seed ${seed}: base ${JSON.stringify(r0.acted)} · cap0 ${JSON.stringify(r2.acted)}`);
      }
      ctx.recorder.event('sup:v3-policy-change', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'SUP-V3-LINT-REFUSES',
    title: 'lint refuses a missing body policy · an unknown node kind · a non-portable path · a wake with both cron and condition; a refused agent.yaml runs the v2 card with one L0 card',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const cases: Array<[string, string, (y: string) => string, RegExp]> = [
          ['missing-policy', 'silence-watch', y => y.replace(/^  sla_min: 30.*\n/mu, ''), /needs policy sla_min/u],
          ['unknown-kind', 'autopsy', y => y.replace('kind: loop-agent.learn', 'kind: loop-agent.dream'), /unknown node kind loop-agent\.dream/u],
          ['non-portable', 'macrophage', y => y.replace(/^goal: .*$/mu, 'goal: "/Users/someone/orphans"'), /not portable/u],
          // YAML-SUPERVISORS-RUNTIME: the trigger shim has no wake of its own (no drift possible) — a wake with two kinds is refused
          ['two-wakes', 'run-doctor', y => y.replace(/^    condition:$/mu, "    cron: '*/5 * * * *'\n    condition:"), /exactly one of cron/u],
        ];
        for (const [tag, id, edit, re] of cases) {
          const root = editedPackage(ctx.universeRoot, id, edit);
          const r = lintSupervisor(id, root);
          if (r.ok || !r.errors.some(e => re.test(e))) return fail(`not-refused:${tag}`, `seed ${seed} ${id}: ok=${r.ok} errors ${JSON.stringify(r.errors).slice(0, 200)}`);
          // the REAL tick entry (supervisorTick — what `eln loop agent <id> tick` runs): one L0 card in the posts, v2 card ticks
          const card = loadCard(id);
          const { p, posts } = ports(join(ctx.universeRoot, `lr-${tag}-${seed}`), id, card.supervisor);
          const { def, report } = await supervisorTick({ ...card, rights: { ...card.rights, actions: ['fix'] } }, toyBody(1), p, at(0), root);
          if (!def.refused || def.graph || !def.refused.key.startsWith(`agent-yaml-refused:${id}:`)) return fail(`no-fallback:${tag}`, `seed ${seed} ${id}`);
          if (report.acted.length !== 1) return fail(`v2-not-ticking:${tag}`, `seed ${seed} ${id}: acted ${JSON.stringify(report.acted)}`);
          const l0 = V2[id]!.l0;
          if (posts.length !== 1 || posts[0]!.to !== l0 || !posts[0]!.key.startsWith(`agent-yaml-refused:${id}:`)) return fail(`l0-card:${tag}`, `seed ${seed} ${id}: posts ${JSON.stringify(posts)} (want exactly one agent-yaml-refused card to ${l0})`);
        }
      }
      ctx.recorder.event('sup:v3-lint-refuses', { seeds: 5 });
      return { ok: true };
    },
  },
  ...deeper,
];
