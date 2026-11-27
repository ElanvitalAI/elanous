// SIM-WORLD graph · LOOP-AGENT-V3-SMART (대표 11-27 12:5x «루프 에이전트 v3 = 스마트함 · 지금 시작» · measured: loop agents mail,
// receivers act on 0 · 9 agents silent · OP inbound 83/h).
// The devices are the REAL code paths: agent.yaml lint (src/loop-agent/v3/agent-yaml.ts) → smartConfig → beginSmart (reflect ·
// learn · promote) → plan / judge → record → save over the real file store (<universe>/…/v3/); land-steward's real stewardTick
// over the real land graph; judge-butler's real post wrapper (src/judge-butler/smart.ts). Only the outside is synthetic:
// receivers (seeded act rates — two silent), item arrivals, the clock, the router.
//   LA3S-FASTER   same seeded event stream, agent with v3 hook nodes vs the same YAML without them (seeds 1–5): v3 reaches the
//                 backlog target (v2 never / later) and sends fewer unacted mails
//   LA3S-DEDUPE   one lesson per pattern key across many reflections · lesson cap · knowhow promotion once (marker) · cap total
//   LA3S-LLM      ambiguous plan → LLM judgment node; router absent / throwing / garbage / over budget → deterministic fallback
//   LA3S-POLICY   YAML-only changes alter planning: a costly escalate-l0 → fold-digest instead · lesson_repeat_min 3 → 5 switches later
//   LA3S-AGENTS   land-steward (repo agent.yaml) over 8 ticks: lines → lesson → one L0 card → quiet (v2 keeps speaking) ·
//                 judge-butler wrapper: a silent HOLD owner goes to the L0 directly after 2 unacted proposals (seeds 1–5)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lintAgentYaml } from '../../../loop-agent/v3/agent-yaml.js';
import { nodeKind } from '../../../loop-agent/v3/node-kinds.js';
import { beginSmart, fileSmartStore, judge, lessonMarker, plan, type KnowhowSink, type Router, type SmartConfig, smartConfig } from '../../../loop-agent/v3/smart.js';
import { stewardTick, type StewardPorts } from '../../../land-steward/agent.js';
import { fileMemory, loadCards } from '../../../land-steward/memory.js';
import { loadButlerSmart, smartButlerPorts } from '../../../judge-butler/smart.js';
import type { ButlerPorts, ButlerView } from '../../../judge-butler/body.js';
import { copyPkg, deps, hx, MIN, NOW, orgFile, rng, v2Cards, type World } from './loop-agent-v3.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const SEEDS = [1, 2, 3, 4, 5];
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

// ── a synthetic «nudge» agent: one agent.yaml, with and without the hook nodes ─────────────────────────────────────
const SIM_KIND = 'sim.nudge-body';
const agentYaml = (o: { hooks?: boolean; repeat?: number; costL0?: number; margin?: number } = {}): string => `apiVersion: elanous/loop-agent@3
manifest: { name: nudger, version: 0.1.0, requires: { executor: loop-agent@3.1, kits: [kpi], node_kinds: [${SIM_KIND}, gate${o.hooks === false ? '' : ', reflect, plan, learn-knowhow'}], facts: [] }, provides: { agent: nudger, kpis: [backlog] } }
identity: { id: nudger, soul: soul.md }
soul: { purpose: keep the backlog under target, values: [one nudge per owner], do_not: [mail storms], voice: short, serves: [TC] }
supervisor: { duty: landing }
policies:
  backlog_max: 4
  act_grace_min: 20
  lesson_repeat_min: ${o.repeat ?? 3}
  reflect_window_min: 60
  lesson_cap: 12
  knowhow_promote_min: 2
  knowhow_cap: 5
  plan_ambiguity_margin: ${o.margin ?? 0.05}
  unacted_penalty: 0.25
  plan_llm_per_hour: 2
  cost_mail: 0.05
  cost_l0: ${o.costL0 ?? 0.15}
  cost_fold: 0
kpis: [{ name: backlog, at_most: $policies.backlog_max }]
wake: { trigger: { condition: { predicate: { kind: state-changed, parts: [{ file: '{stateRoot}/sim/wake' }] } } } }
body:
  entry_node: tick
  terminal_nodes: [done]
  nodes:
    - { node_id: tick, kind: ${SIM_KIND} }
    - { node_id: done, kind: gate }
${o.hooks === false ? '' : `    - { node_id: reflect, kind: reflect, optional: true }
    - { node_id: plan, kind: plan, optional: true }
    - { node_id: learn, kind: learn-knowhow, optional: true }
`}  edges: [{ from: tick, map: { ok: done } }]
actions:
  - { id: mail, channel: mail, target: receiver, serves: [backlog], cost: $policies.cost_mail, default: true }
  - { id: escalate-l0, channel: mail, target: l0, serves: [backlog], cost: $policies.cost_l0 }
  - { id: fold-digest, channel: none, target: none, serves: [], cost: $policies.cost_fold }
budget: { llm_turns_per_hour: 2 }
`;
function compile(dir: string, yaml: string): { cfg: SmartConfig | null; errors: string[] } {
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'soul.md'), '# nudger\n');
  const r = lintAgentYaml(yaml, dir, { nodeKindOk: k => k === SIM_KIND || nodeKind(k) !== null });
  return { cfg: r.compiled ? smartConfig(r.compiled) : null, errors: r.errors };
}

const RECEIVERS = ['A', 'B', 'C', 'D', 'E'];
const TICK_MIN = 10; const NUDGE_EVERY = 3; const HORIZON = 36; const LAG_MIN = 10;
/** Acted or not is a property of (seed, key, receiver) — identical whatever path the agent took (same event stream). */
const roll = (seed: number, key: string, to: string): number => parseInt(createHash('sha256').update(`${seed}|${key}|${to}`).digest('hex').slice(0, 8), 16) / 0xffffffff;
function actRates(seed: number): Record<string, number> {
  const r = rng(seed * 31 + 7); const out: Record<string, number> = { L0: 0.9 };
  RECEIVERS.forEach((x, i) => { out[x] = i === seed % 5 || i === (seed + 2) % 5 ? 0 : 0.7 + r() * 0.25; }); // two silent receivers
  return out;
}
interface StreamResult { firstMetTick: number | null; mails: number; unacted: number; escalations: number; folds: number; firstSwitchTick: number | null; lessons: number; endBacklog: number }

/** One run of the stream. cfg = null → the v2 agent (always the YAML default action). */
function runStream(seed: number, cfg: SmartConfig | null, home: string): StreamResult {
  const r = rng(seed * 7919 + 1); const p = actRates(seed);
  const backlog: Record<string, number> = Object.fromEntries(RECEIVERS.map(x => [x, 3]));
  const truth = new Map<string, { acted: boolean; at: number; for: string }>();
  const resolvedKeys = new Set<string>();
  const store = fileSmartStore(home);
  const out: StreamResult = { firstMetTick: null, mails: 0, unacted: 0, escalations: 0, folds: 0, firstSwitchTick: null, lessons: 0, endBacklog: 0 };
  for (let t = 0; t < HORIZON; t++) {
    const nowMs = NOW + t * TICK_MIN * MIN; const now = new Date(nowMs);
    for (const x of RECEIVERS) if (r() < 0.5) backlog[x]!++;
    for (const [k, v] of truth) if (v.acted && !resolvedKeys.has(k) && nowMs >= v.at + LAG_MIN * MIN) { backlog[v.for] = 0; resolvedKeys.add(k); }
    const total = RECEIVERS.reduce((m, x) => m + backlog[x]!, 0);
    if (total <= 4 && out.firstMetTick === null) out.firstMetTick = t;
    const s = cfg ? beginSmart({ cfg, store, now, l0: 'L0', knowhow: null, readings: [{ name: 'backlog', value: total }],
      outcome: row => { const tr = truth.get(row.key); return tr ? (nowMs >= tr.at + LAG_MIN * MIN ? tr.acted : false) : null; } }) : null;
    if (t % NUDGE_EVERY === 0) for (const x of RECEIVERS) {
      if (!backlog[x]) continue;
      const ch = s ? s.choose({ intent: 'nudge', to: x, kpis: ['backlog'] }) : { action: 'mail', to: x };
      const key = `nudge:${x}:${t}`;
      if (ch.action !== 'mail' && out.firstSwitchTick === null) out.firstSwitchTick = t;
      if (ch.action === 'fold-digest') out.folds++;
      else {
        out.mails++; if (ch.action === 'escalate-l0') out.escalations++;
        const acted = roll(seed, key, ch.to) < p[ch.to]!;
        truth.set(key, { acted, at: nowMs, for: x });
        if (!acted) out.unacted++;
      }
      s?.record({ intent: 'nudge', action: ch.action, to: ch.to, key, kpi: 'backlog', base: total });
    }
    s?.save();
    if (s) out.lessons = s.lessons.filter(l => l.status === 'active').length;
  }
  out.endBacklog = RECEIVERS.reduce((m, x) => m + backlog[x]!, 0);
  return out;
}

const memKnowhow = (): KnowhowSink & { items: string[] } => {
  const items: string[] = [];
  return { items, text: () => items.join('\n'), add: (it) => { items.push(it.title); return `K-SIM-${String(items.length).padStart(3, '0')}`; } };
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'LA3S-FASTER',
    title: 'same seeded stream, v3 hook nodes vs none (seeds 1–5): v3 reaches the backlog target sooner and sends fewer unacted mails',
    async run(ctx) {
      const rows: unknown[] = [];
      for (const seed of SEEDS) {
        const v3 = compile(join(ctx.universeRoot, `f-${seed}`, 'pkg3'), agentYaml());
        const v2 = compile(join(ctx.universeRoot, `f-${seed}`, 'pkg2'), agentYaml({ hooks: false }));
        if (!v3.cfg || v2.errors.length || v2.cfg) return fail('sim-yaml', JSON.stringify({ v3: v3.errors, v2: v2.errors, v2cfg: !!v2.cfg }));
        const a = runStream(seed, null, join(ctx.universeRoot, `f-${seed}`, 'home2'));
        const b = runStream(seed, v3.cfg, join(ctx.universeRoot, `f-${seed}`, 'home3'));
        if (b.unacted >= a.unacted) return fail('unacted-not-reduced', `seed ${seed}: v2 ${JSON.stringify(a)} · v3 ${JSON.stringify(b)}`);
        if (b.firstMetTick === null || (a.firstMetTick !== null && b.firstMetTick >= a.firstMetTick)) return fail('kpi-not-faster', `seed ${seed}: v2 ${a.firstMetTick} · v3 ${b.firstMetTick}`);
        if (!b.escalations || b.lessons < 2) return fail('no-learning', `seed ${seed}: ${JSON.stringify(b)}`);
        rows.push({ seed, v2: { met: a.firstMetTick, mails: a.mails, unacted: a.unacted, backlog: a.endBacklog }, v3: { met: b.firstMetTick, mails: b.mails, unacted: b.unacted, l0: b.escalations, lessons: b.lessons, backlog: b.endBacklog } });
      }
      ctx.recorder.event('la3s:faster', { rows });
      return { ok: true };
    },
  },
  {
    id: 'LA3S-DEDUPE',
    title: 'one lesson per pattern key over many reflections · lesson cap · knowhow promotion once per lesson (marker) · knowhow cap',
    async run(ctx) {
      const { cfg } = compile(join(ctx.universeRoot, 'pkg'), agentYaml());
      if (!cfg) return fail('sim-yaml', 'no cfg');
      for (const seed of SEEDS) {
        const home = join(ctx.universeRoot, `d-${seed}`); const store = fileSmartStore(home); const kh = memKnowhow();
        const n = 14 + seed; // receivers that never act — more patterns than the lesson cap (12)
        for (let t = 0; t < 12; t++) {
          const now = new Date(NOW + t * 40 * MIN);
          const s = beginSmart({ cfg, store, now, l0: 'L0', knowhow: kh, readings: [{ name: 'backlog', value: 50 }], outcome: () => false });
          for (let i = 0; i < n; i++) s.record({ intent: 'nudge', action: 'mail', to: `R${i}`, key: `k${t}:${i}`, kpi: 'backlog', base: 50 });
          s.save();
        }
        const lessons = store.lessons();
        const keys = lessons.map(l => l.key);
        if (new Set(keys).size !== keys.length) return fail('lesson-duplicated', `seed ${seed}: ${keys.length} rows ${new Set(keys).size} keys`);
        if (lessons.filter(l => l.status === 'active').length !== 12) return fail('lesson-cap', `seed ${seed}: ${lessons.length}`);
        if (kh.items.length !== 5 || new Set(kh.items).size !== 5) return fail('knowhow-cap-or-dup', `seed ${seed}: ${JSON.stringify(kh.items)}`);
        // a fresh install that already has the knowhow (marker present) never promotes it twice
        const store2 = fileSmartStore(join(home, 'again'));
        store2.writeLessons(lessons.map(l => ({ ...l, promoted: undefined as unknown as string })).filter(l => kh.items.some(x => x.includes(lessonMarker(l.key)))).map(({ promoted: _p, ...l }) => l));
        const s2 = beginSmart({ cfg, store: store2, now: new Date(NOW + 20 * 40 * MIN), l0: 'L0', knowhow: kh, readings: [], outcome: () => null });
        if (kh.items.length !== 5 || s2.learned.promoted.length) return fail('knowhow-promoted-twice', `seed ${seed}: ${kh.items.length} · ${s2.learned.promoted.join(',')}`);
      }
      ctx.recorder.event('la3s:dedupe', { cap: 12, knowhowCap: 5 });
      return { ok: true };
    },
  },
  {
    id: 'LA3S-LLM',
    title: 'ambiguous plan → LLM judgment node through the router · absent / throwing / garbage / over-budget router → deterministic top (recorded)',
    async run(ctx) {
      const { cfg } = compile(join(ctx.universeRoot, 'pkg'), agentYaml({ margin: 1 })); // every alternative is «ambiguous»
      if (!cfg) return fail('sim-yaml', 'no cfg');
      const out: unknown[] = [];
      for (const seed of SEEDS) {
        const lesson = { key: 'unacted:nudge:mail:A', intent: 'nudge', action: 'mail', to: 'A', text: 'x', streak: 3, hits: 1, firstAt: '-', lastAt: new Date(NOW).toISOString(), windows: [1], status: 'active' as const };
        const reflection = { at: '-', gaps: { backlog: 0.2 + seed / 10 }, stats: [{ intent: 'nudge', action: 'mail', to: 'A', sent: 3, acted: 0, unacted: 3, pending: 0, streak: 3 }], patterns: [], resolved: { acted: 0, unacted: 0 } };
        const intent = { intent: 'nudge', to: 'A', kpis: ['backlog'] };
        const base = plan({ cfg, reflection, lessons: [lesson], intent, l0: 'L0' });
        if (!base.ambiguous || base.judgedBy !== 'score') return fail('not-ambiguous', JSON.stringify(base));
        const other = base.ambiguous[1];
        const st = () => ({ llmTurns: [] as number[], reflections: 0 });
        const now = new Date(NOW);
        const run = (router: Router | null, state = st()) => judge({ cfg, choice: base, intent, l0: 'L0', router, state, now });
        const none = await run(null);
        const boom = await run({ complete: async () => { throw new Error('router 503'); } });
        const junk = await run({ complete: async () => ({ text: 'launch the rockets', model: 'sim/m' }) });
        const good = await run({ complete: async () => ({ text: ` ${other}\n`, model: 'sim/m' }) });
        const spent = { llmTurns: [NOW - 60_000, NOW - 120_000], reflections: 0 };
        const over = await run({ complete: async () => ({ text: other, model: 'sim/m' }) }, spent);
        const got = [none, boom, junk, over].map(c => [c.action, c.judgedBy, c.fallback]);
        const want = [[base.action, 'fallback', 'router-unavailable'], [base.action, 'fallback', 'llm-error'], [base.action, 'fallback', 'llm-invalid'], [base.action, 'fallback', 'over-budget']];
        if (JSON.stringify(got) !== JSON.stringify(want)) return fail('fallback-wrong', `seed ${seed}: ${JSON.stringify(got)}`);
        if (good.action !== other || good.judgedBy !== 'llm' || good.model !== 'sim/m') return fail('llm-not-used', `seed ${seed}: ${JSON.stringify(good)}`);
        out.push({ seed, deterministic: base.action, llm: good.action });
      }
      ctx.recorder.event('la3s:llm', { out });
      return { ok: true };
    },
  },
  {
    id: 'LA3S-POLICY',
    title: 'YAML-only policy changes alter planning: costly escalate-l0 → fold-digest instead · lesson_repeat_min 3 → 5 → first switch later',
    async run(ctx) {
      const rows: unknown[] = [];
      for (const seed of SEEDS) {
        const base = compile(join(ctx.universeRoot, `p-${seed}`, 'a'), agentYaml()).cfg;
        const costly = compile(join(ctx.universeRoot, `p-${seed}`, 'b'), agentYaml({ costL0: 2 })).cfg;
        const patient = compile(join(ctx.universeRoot, `p-${seed}`, 'c'), agentYaml({ repeat: 5 })).cfg;
        if (!base || !costly || !patient) return fail('sim-yaml', 'cfg');
        const a = runStream(seed, base, join(ctx.universeRoot, `p-${seed}`, 'ha'));
        const b = runStream(seed, costly, join(ctx.universeRoot, `p-${seed}`, 'hb'));
        const c = runStream(seed, patient, join(ctx.universeRoot, `p-${seed}`, 'hc'));
        if (!a.escalations || b.escalations || !b.folds) return fail('cost-ignored', `seed ${seed}: base ${JSON.stringify(a)} costly ${JSON.stringify(b)}`);
        if (a.firstSwitchTick === null || c.firstSwitchTick === null || c.firstSwitchTick <= a.firstSwitchTick) return fail('repeat-ignored', `seed ${seed}: ${a.firstSwitchTick} vs ${c.firstSwitchTick}`);
        rows.push({ seed, base: { l0: a.escalations, switch: a.firstSwitchTick }, costly: { l0: b.escalations, folds: b.folds }, repeat5: { switch: c.firstSwitchTick } });
      }
      ctx.recorder.event('la3s:policy', { rows });
      return { ok: true };
    },
  },
  {
    id: 'LA3S-AGENTS',
    title: 'land-steward (repo agent.yaml) 8 ticks: lines → lesson → one L0 card → quiet while v2 keeps speaking · judge-butler: a silent HOLD owner → the L0 directly (seeds 1–5)',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const rows: unknown[] = [];
      for (const seed of SEEDS) {
        // ── land-steward: nothing lands, nothing is landable — the KPI cannot move whatever the channel says
        const n = 2 + (seed % 3);
        const w: World = { prs: Array.from({ length: n }, (_, i) => 41960 + seed * 10 + i).map(num => ({ number: num, head: hx(num), base: 'main', draft: false, state: 'OPEN' as const, title: `pr ${num}`, author: 'UX', files: [`src/f${num}.ts`], headRef: `b${num}`, createdAt: new Date(NOW - 60 * MIN).toISOString() })),
          receipts: new Map(), focused: new Map(), tsc: new Set(), pastLands: 0 };
        const dir = copyPkg(ctx.universeRoot, `ag-${seed}`);
        const v3 = loadCards(dir); const v2 = v2Cards(dir);
        if (!v3.smart) return fail('steward-no-smart', `${v3.source} ${(v3.refused ?? []).join(' · ')}`);
        const tickN = async (cards: typeof v3, tag: string) => {
          const s = join(ctx.universeRoot, tag); mkdirSync(s, { recursive: true });
          const lines: string[] = []; const mails: string[] = []; const sent = new Set<string>(); const kh = memKnowhow();
          const ports: StewardPorts = { memory: fileMemory(s), channel: l => { lines.push(l); }, report: (key, to, body) => { if (!sent.has(key)) { sent.add(key); mails.push(`${to} ${body}`); } }, knowhow: kh };
          const byKey: Record<string, string[]> = {};
          for (let t = 0; t < 8; t++) {
            const rep = await stewardTick(deps(s, w, org, [], NOW + t * 31 * MIN), ports, cards);
            for (const c of rep.smart?.choices ?? []) (byKey[c.key] ??= []).push(c.action);
          }
          return { lines, mails, byKey, knowhow: kh.items.length, lessons: fileSmartStore(join(s, 'loop-agents', 'land-steward')).lessons() };
        };
        const a = await tickN(v2, `ag-${seed}-v2`); const b = await tickN(v3, `ag-${seed}-v3`);
        // «lands» (0/h vs 10 — gap 1) walks the whole ladder; smaller gaps leave the line for quiet sooner (score < 0)
        const want = ['breach-line', 'breach-line', 'breach-line', 'l0-card', 'l0-card', 'l0-card', 'quiet', 'quiet'];
        if (a.lines.length < 16 || a.mails.length) return fail('v2-baseline', `seed ${seed}: ${a.lines.length} lines ${a.mails.length} mails`);
        if (JSON.stringify(b.byKey.lands) !== JSON.stringify(want)) return fail('steward-plan', `seed ${seed} lands: ${JSON.stringify(b.byKey)}`);
        // every key: starts as the v2 line · once the plan has left the line it does not go back while the KPI cannot move
        for (const [k, xs] of Object.entries(b.byKey)) {
          const off = xs.findIndex(x => x !== 'breach-line');
          if (xs[0] !== 'breach-line' || (off >= 0 && xs.slice(off).includes('breach-line')) || xs.filter(x => x === 'l0-card').length > 3) return fail('steward-ladder', `seed ${seed} ${k}: ${xs.join(',')}`);
        }
        if (b.lines.length + b.mails.length >= a.lines.length || !b.mails.every(m => m.startsWith('TC ') && m.includes('결정 카드'))) return fail('steward-not-quieter', `seed ${seed}: ${b.lines.length}+${b.mails.length} vs ${a.lines.length}`);
        if (b.lessons.length < 4 || new Set(b.lessons.map(l => l.key)).size !== b.lessons.length) return fail('steward-lessons', `seed ${seed}: ${JSON.stringify(b.lessons.map(l => l.key))}`);
        // ── judge-butler: one new HOLD per 40 min · TC never narrows · UX narrows within the grace
        const home = join(ctx.universeRoot, `jb-${seed}`); mkdirSync(home, { recursive: true });
        const { cfg } = loadButlerSmart();
        if (!cfg) return fail('butler-no-smart', 'judge-butler agent.yaml refused');
        const holds: Array<{ id: string; owner: string; state: string; narrowed: number; expiresAt: string }> = [];
        const sentTo: string[] = []; const butler: string[] = [];
        for (let t = 0; t < 6 + (seed % 2); t++) {
          const nowMs = NOW + t * 40 * MIN; const owner = t % 2 === 0 ? 'TC' : 'UX';
          for (const h of holds) if (h.owner === 'UX' && h.narrowed === 0) h.narrowed = 1; // UX acts on last tick's proposal
          holds.push({ id: `H-${seed}-${t}`, owner, state: 'active', narrowed: 0, expiresAt: new Date(nowMs + 6 * 60 * MIN).toISOString() });
          const view = { now: new Date(nowMs), holds } as unknown as ButlerView;
          const base = { memory: { root: home }, post: (_k: string, to: string) => { sentTo.push(to); return sentTo.length; } } as unknown as ButlerPorts;
          const wrapped = await smartButlerPorts(view, base, { cfg, l0: 'JUD', router: null }, 3);
          if (!wrapped) return fail('butler-wrap-failed', `seed ${seed} t ${t}`);
          wrapped.ports.post(`propose:H-${seed}-${t}:0`, owner, 'narrow please', 'request');
          wrapped.session.save();
          butler.push(`${owner}:${wrapped.report.choices[0]!.action}`);
        }
        const firstL0 = butler.indexOf('TC:escalate-l0');
        if (firstL0 !== 4 || butler.some(x => x === 'UX:escalate-l0' || x === 'UX:fold-digest')) return fail('butler-plan', `seed ${seed}: ${JSON.stringify(butler)}`);
        rows.push({ seed, steward: { v2Lines: a.lines.length, v3Lines: b.lines.length, v3L0: b.mails.length, knowhow: b.knowhow }, butler });
      }
      ctx.recorder.event('la3s:agents', { rows });
      return { ok: true };
    },
  },
];
