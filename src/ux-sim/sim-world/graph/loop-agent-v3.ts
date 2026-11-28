// SIM-WORLD graph · LOOP-AGENT-V3-YAML (대표 11-27 11:2x «루프 에이전트 v3 는 그래프러너 v2 처럼 yaml 로 정의 · 시뮬레이터에서 점검»
// · 11:3x «yaml 이면 다른 사람에게 이전 쉽다 · 마켓에서 플러그인으로 유통»).
// The device is the REAL code path: src/loop-agent/v3/agent-yaml.ts (lint · compile) → src/land-steward/memory.ts loadCards →
// the shared kinds land-graph.tick ⊕ kpi-voice (src/loop-agent/v3/land-graph-kind.ts · CODE-BODY-TO-KIND) over the real land graph (tickLand). Only the outside is faked (gh · receipts · land
// command · mail store · clock). Every universe lives under ctx.universeRoot; the repo's agent dir is only ever copied.
//   LA3-EQUIV     agent.yaml with its v3 hooks ≡ the same package without them (the v2 voice) on the same synthetic events — decisions · lands · channel lines · mail · cases · ledger (seeds 1–5)
//   LA3-POLICY    a threshold changed in YAML only changes the breach lines as expected (no code change)
//   LA3-REFUSE    bad yaml · unknown node kind · missing policy ref · missing kit · hook node not optional → lint fails loudly,
//                 the steward refuses the definition (plain body · level off) and cards its L0 once per error set
//   LA3-EDGE      trigger storm (20 wakes in 1 min → one line per breach key) · missing ledger · sub-agent (finisher) down
//   LA3-PORTABLE  copy the agent dir into a fresh universe → lints and runs · a non-portable variant is refused
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedger, readLedger, type Focused, type LandDeps, type PrInfo, type Receipt } from '../../../land-graph/land-graph.js';
import { landGraphAgentTick, type LandTickPorts as StewardPorts, type LandTickReport as StewardReport } from '../../../loop-agent/v3/land-graph-kind.js';
import { cardsDir, fileMemory, loadCards, STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR, type StewardCards } from '../../../land-steward/memory.js';
import { lintAgentYaml } from '../../../loop-agent/v3/agent-yaml.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

export const NOW = Date.parse('2026-11-27T03:00:00Z');
export const MIN = 60_000;
/** The land steward = one agent.yaml instance of the land-graph.tick kind. */
export const stewardTick = (d: LandDeps, p: StewardPorts, c: StewardCards): Promise<StewardReport> => landGraphAgentTick(d, p, c, { id: STEWARD_ID, address: STEWARD_SEAT, l0Fallback: STEWARD_SUPERVISOR });
const SEEDS = [1, 2, 3, 4, 5];
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface World { prs: PrInfo[]; receipts: Map<number, Receipt>; focused: Map<number, Focused>; tsc: Set<number>; pastLands: number }
export const hx = (n: number) => `${String(n).padStart(6, '0')}${'b'.repeat(34)}`;

/** A seeded landing queue: hot files, crown PRs, drafts, red receipts, tsc refusals at land time, past lands in the ledger. */
export function world(seed: number): World {
  const r = rng(seed * 7919 + 13);
  const n = 6 + Math.floor(r() * 8);
  const prs: PrInfo[] = []; const receipts = new Map<number, Receipt>(); const focused = new Map<number, Focused>(); const tsc = new Set<number>();
  for (let i = 0; i < n; i++) {
    const num = 41000 + seed * 100 + i;
    const hot = r() < 0.35;
    const p: PrInfo = { number: num, head: hx(num), base: 'main', draft: r() < 0.12, state: 'OPEN', title: r() < 0.15 ? `\u{1F451} P0 fix ${num}` : `pr ${num}`, author: r() < 0.5 ? 'UX' : 'RES',
      files: hot ? ['src/hot.ts'] : [`src/f${num}.ts`], headRef: `b${num}`, createdAt: new Date(NOW - Math.floor(r() * 600) * MIN).toISOString() };
    prs.push(p);
    const roll = r();
    if (roll < 0.6) receipts.set(num, { dir: `r/${num}-${p.head.slice(0, 12)}-simhost`, head: p.head, host: 'simhost', focused: [`src/f${num}.test.ts`], rawDir: '', focusedExit: 0 });
    else if (roll < 0.75) { receipts.set(num, { dir: `r/${num}-${p.head.slice(0, 12)}-simhost`, head: p.head, host: 'simhost', focused: [`src/f${num}.test.ts`], rawDir: '', focusedExit: 1 }); focused.set(num, { pass: 3, fail: 1 }); }
    if (r() < 0.15) tsc.add(num);
  }
  return { prs, receipts, focused, tsc, pastLands: Math.floor(r() * 14) };
}

export function deps(stateRoot: string, w: World, org: string, posts: string[], nowMs = NOW, o: Partial<LandDeps> = {}): LandDeps {
  const merged = new Set<number>();
  return {
    now: () => new Date(nowMs), stateRoot, mode: 'live', slots: 3, org: { path: org },
    listPrs: async () => w.prs.filter(p => !merged.has(p.number)).map(p => ({ ...p })),
    prNow: async n => { const p = w.prs.find(x => x.number === n); return p ? { ...p, state: merged.has(n) ? 'MERGED' : p.state } : null; },
    receipt: (n, h) => (w.receipts.get(n)?.head === h ? w.receipts.get(n)! : null), olderReceiptHead: () => null,
    focused: rc => w.focused.get(Number(rc.dir.split('/')[1]!.split('-')[0])) ?? { pass: 5, fail: 0 }, security: () => [],
    land: async p => { if (w.tsc.has(p.number)) return { rc: 10, text: 'STOP tsc-preflight rc=1 (sim)' }; merged.add(p.number); return { rc: 0, text: 'merged' }; },
    post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
    finisher: { launchPregate: () => ({ ok: true, pid: 9 }), alive: () => true, refresh: () => ({ result: 'error' }) },
    ...o,
  };
}

interface Run { report: StewardReport; lines: string[]; posts: string[]; mails: string[]; cases: string; ledger: string }

/** One universe: fresh state root · the world's past lands seeded into the ledger · one steward tick with `cards`. */
async function runOnce(root: string, tag: string, w: World, cards: StewardCards, org: string, o: { nowMs?: number; extra?: Partial<LandDeps>; ticks?: number; seedLedger?: boolean } = {}): Promise<Run> {
  const s = join(root, tag); mkdirSync(s, { recursive: true });
  if (o.seedLedger !== false) for (let i = 0; i < w.pastLands; i++) appendLedger(s, { at: new Date(NOW - (5 + i * 4) * MIN).toISOString(), pr: 40000 + i, head: hx(40000 + i), mode: 'live', event: 'landed' });
  const lines: string[] = []; const posts: string[] = []; const mails: string[] = []; const sent = new Set<string>();
  const ports: StewardPorts = { memory: fileMemory(s), channel: l => { lines.push(l); }, report: (key, to, body) => { if (!sent.has(key)) { sent.add(key); mails.push(`${to} ${body}`); } } };
  let report!: StewardReport;
  for (let t = 0; t < (o.ticks ?? 1); t++) report = await stewardTick(deps(s, w, org, posts, (o.nowMs ?? NOW) + t * 3_000, o.extra), ports, cards);
  const strip = (txt: string) => txt.split('\n').filter(Boolean).map(l => { const j = JSON.parse(l) as Record<string, unknown>; delete j.doneAt; return JSON.stringify(j); }).join('\n');
  let ledger = ''; try { ledger = readLedger(s).map(r => JSON.stringify({ ...r, doneAt: undefined })).join('\n'); } catch { ledger = ''; }
  let cases = ''; try { cases = strip(readFileSync(join(s, 'loop-agents', 'land-steward', 'cases.jsonl'), 'utf8')); } catch { cases = ''; }
  return { report, lines, posts, mails, cases, ledger };
}

/** A private copy of the repo's land-steward package (agent.yaml · soul.md · knowhow.md) — the repo is never edited. */
export function copyPkg(root: string, name: string, edit?: (yaml: string) => string): string {
  const dir = join(root, 'pkg', name, 'land-steward');
  mkdirSync(dir, { recursive: true });
  for (const f of ['agent.yaml', 'soul.md', 'knowhow.md']) cpSync(join(cardsDir(), f), join(dir, f));
  if (edit) writeFileSync(join(dir, 'agent.yaml'), edit(readFileSync(join(dir, 'agent.yaml'), 'utf8')));
  return dir;
}
export function orgFile(root: string): string {
  const p = join(root, 'org', 'federation.yaml'); mkdirSync(join(root, 'org'), { recursive: true });
  writeFileSync(p, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n'); return p;
}
/** The same package without its v3 hooks — the v2 voice (one default line per breach key per window). */
export const v2Cards = (dir: string): StewardCards => { const { smart: _hooks, ...cards } = loadCards(dir); return cards; };
const kpiLines = (r: Run) => r.lines.map(l => l.replace(/ · \d\d:\d\dZ · .*/u, '').split(' (')[0]!);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'LA3-EQUIV',
    title: 'land-steward from agent.yaml ≡ the same package without its v3 hooks (v2 voice) on the same synthetic events — seeds 1–5',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const dir = copyPkg(ctx.universeRoot, 'equiv');
      const v3 = loadCards(dir, { triggersDir: join(cardsDir(), '..', '..', 'triggers') });
      if (v3.source !== 'agent.yaml') return fail('agent-yaml-not-loaded', `source ${v3.source} · ${(v3.refused ?? []).join(' · ')}`);
      const v2 = v2Cards(dir);
      if (v2.smart || JSON.stringify(v3.compiled?.kpis) !== JSON.stringify(v2.compiled?.kpis)) return fail('goal-differs', `${JSON.stringify(v3.compiled?.kpis)} vs ${JSON.stringify(v2.compiled?.kpis)}`);
      const rows: unknown[] = [];
      for (const seed of SEEDS) {
        const a = await runOnce(ctx.universeRoot, `eq-${seed}-v2`, world(seed), v2, org);
        const b = await runOnce(ctx.universeRoot, `eq-${seed}-v3`, world(seed), v3, org);
        const pick = (r: Run) => JSON.stringify({ landed: r.report.landed, decisions: r.report.decisions, kpi: r.report.kpi, breaches: r.report.breaches, posted: r.report.posted, lanes: r.report.lanes, slots: r.report.slots,
          lines: r.lines, posts: r.posts, mails: r.mails, cases: r.cases, ledger: r.ledger.replaceAll(`eq-${seed}-v2`, 'S').replaceAll(`eq-${seed}-v3`, 'S') });
        if (pick(a) !== pick(b)) return fail('v3-diverges', `seed ${seed}: v2 ${pick(a).slice(0, 300)} … ≠ v3 ${pick(b).slice(0, 300)}`);
        if (b.mails.length) return fail('v3-mailed-l0', `seed ${seed}: ${b.mails[0]}`);
        rows.push({ seed, landed: b.report.landed.length, decisions: b.report.decisions.length, lines: b.lines.length, posts: b.posts.length });
      }
      ctx.recorder.event('la3:equiv', { rows });
      return { ok: true };
    },
  },
  {
    id: 'LA3-POLICY',
    title: 'a threshold changed in agent.yaml only (lands_per_hour_min · landable_ratio_min) changes the breach lines — no code change',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      // 4 past lands in the last hour · nothing landable now (no receipts) → lands 4/h, landable 0 %
      const w: World = { prs: [41901, 41902].map(n => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN' as const, title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], headRef: `b${n}`, createdAt: new Date(NOW - 60 * MIN).toISOString() })),
        receipts: new Map(), focused: new Map(), tsc: new Set(), pastLands: 4 };
      const base = loadCards(copyPkg(ctx.universeRoot, 'p10'));
      const low = loadCards(copyPkg(ctx.universeRoot, 'p3', y => y.replace('lands_per_hour_min: 10', 'lands_per_hour_min: 3')));
      const strict = loadCards(copyPkg(ctx.universeRoot, 'p0', y => y.replace('lands_per_hour_min: 10', 'lands_per_hour_min: 3').replace('landable_ratio_min: 0.5', 'landable_ratio_min: 0')));
      for (const [k, c] of [['p10', base], ['p3', low], ['p0', strict]] as const) if (c.source !== 'agent.yaml') return fail('policy-edit-refused', `${k}: ${(c.refused ?? []).join(' · ')}`);
      const a = kpiLines(await runOnce(ctx.universeRoot, 'pol-10', w, base, org));
      const b = kpiLines(await runOnce(ctx.universeRoot, 'pol-3', w, low, org));
      const c = kpiLines(await runOnce(ctx.universeRoot, 'pol-0', w, strict, org));
      const want = { a: ['[착지 집사 · KPI] 착지 4/h < 10', '[착지 집사 · KPI] 착지 가능 0% < 50%'], b: ['[착지 집사 · KPI] 착지 가능 0% < 50%'], c: [] as string[] };
      if (JSON.stringify(a) !== JSON.stringify(want.a)) return fail('policy-baseline', `10/h: ${JSON.stringify(a)}`);
      if (JSON.stringify(b) !== JSON.stringify(want.b)) return fail('policy-threshold-ignored', `3/h: ${JSON.stringify(b)}`);
      if (JSON.stringify(c) !== JSON.stringify(want.c)) return fail('policy-ratio-ignored', `ratio 0: ${JSON.stringify(c)}`);
      ctx.recorder.event('la3:policy', { a, b, c });
      return { ok: true };
    },
  },
  {
    id: 'LA3-REFUSE',
    title: 'bad agent.yaml → lint fails loudly · the steward refuses the definition (plain body · off) · its L0 gets one card per error set',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const cases: Array<[string, (y: string) => string, RegExp]> = [
        ['bad-yaml', y => `${y}\n  : [unclosed`, /bad yaml/u],
        ['unknown-node-kind', y => y.replace('kind: land-graph.tick', 'kind: land-graph.teleport').replace('node_kinds: [land-graph.tick, kpi-voice, gate,', 'node_kinds: [land-graph.teleport, kpi-voice, gate,'), /unknown node kind land-graph\.teleport/u],
        ['missing-policy-ref', y => y.replace('$policies.landable_ratio_min', '$policies.landable_ratio_floor'), /missing policy ref \$policies\.landable_ratio_floor/u],
        ['missing-kit', y => y.replace('kits: [kpi]', 'kits: [kpi, negotiation]'), /requires kit negotiation — not installed/u],
        ['hook-not-optional', y => y.replace('{ node_id: reflect, kind: reflect, optional: true }', '{ node_id: reflect, kind: reflect }'), /reflect is a v3 hook kind — mark it optional/u],
        ['wake-drift', y => y.replace('cooldown_min: 2', 'cooldown_min: 7'), /wake drift/u],
      ];
      const w = world(3); const out: unknown[] = [];
      for (const [name, edit, want] of cases) {
        const dir = copyPkg(ctx.universeRoot, name, edit);
        const lint = lintAgentYaml(readFileSync(join(dir, 'agent.yaml'), 'utf8'), dir, { triggersDir: join(cardsDir(), '..', '..', 'triggers') });
        if (lint.ok || !lint.errors.some(e => want.test(e))) return fail('lint-not-loud', `${name}: ok=${lint.ok} errors=${JSON.stringify(lint.errors)}`);
        const cards = loadCards(dir, { triggersDir: join(cardsDir(), '..', '..', 'triggers') });
        if (!cards.refused?.length) return fail('runtime-loaded-bad-yaml', `${name}: source ${cards.source}`);
        const r = await runOnce(ctx.universeRoot, `ref-${name}`, w, cards, org, { ticks: 3 });
        if (r.report.level !== 'off' || !r.report.refused?.length) return fail('runtime-not-refused', `${name}: level ${r.report.level}`);
        if (r.mails.length !== 1 || !r.mails[0]!.startsWith('TC ') || !r.mails[0]!.includes('agent.yaml 거부')) return fail('l0-not-reported', `${name}: ${JSON.stringify(r.mails)}`);
        if (r.lines.length) return fail('refused-agent-spoke', `${name}: ${r.lines[0]}`);
        out.push({ name, errors: lint.errors.length, landed: r.report.landed.length });
      }
      ctx.recorder.event('la3:refuse', { out });
      return { ok: true };
    },
  },
  {
    id: 'LA3-EDGE',
    title: 'trigger storm (20 wakes / 1 min → one line per breach key) · missing ledger (no throw · KPI from nothing) · finisher sub-agent down (tick completes · every refusal has a next owner)',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const cards = loadCards(copyPkg(ctx.universeRoot, 'edge'));
      const quiet: World = { prs: [41951, 41952].map(n => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN' as const, title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], headRef: `b${n}`, createdAt: new Date(NOW - 60 * MIN).toISOString() })),
        receipts: new Map(), focused: new Map(), tsc: new Set(), pastLands: 0 };
      const storm = await runOnce(ctx.universeRoot, 'storm', quiet, cards, org, { ticks: 20 });
      const keys = kpiLines(storm);
      if (keys.length !== 2 || new Set(keys).size !== 2) return fail('storm-not-debounced', `${keys.length} lines: ${JSON.stringify(keys)}`);
      const bare = await runOnce(ctx.universeRoot, 'no-ledger', world(2), cards, org, { seedLedger: false });
      if (bare.report.error || !bare.report.kpi) return fail('missing-ledger-broke-tick', `${bare.report.error ?? 'no kpi'}`);
      for (const seed of SEEDS) {
        const down = await runOnce(ctx.universeRoot, `fin-down-${seed}`, world(seed), cards, org, { extra: { finisher: { launchPregate: () => ({ ok: false, why: 'sim: finisher down' }), alive: () => false, refresh: () => ({ result: 'error' }) } } });
        if (down.report.error) return fail('sub-down-broke-tick', `seed ${seed}: ${down.report.error}`);
        if (down.report.kpi!.refusalsWithoutNext.length) return fail('sub-down-no-next', `seed ${seed}: ${down.report.kpi!.refusalsWithoutNext.join(',')}`);
      }
      ctx.recorder.event('la3:edge', { stormLines: keys.length });
      return { ok: true };
    },
  },
  {
    id: 'LA3-PORTABLE',
    title: 'copy the agent dir into a fresh universe (no repo · no trigger file) → lints and runs · a non-portable variant is refused',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const dir = join(ctx.universeRoot, 'other-install', 'loop-agents', 'land-steward'); mkdirSync(dir, { recursive: true });
      for (const f of ['agent.yaml', 'soul.md', 'knowhow.md']) cpSync(join(cardsDir(), f), join(dir, f)); // no goal.yaml: the package alone
      const lint = lintAgentYaml(readFileSync(join(dir, 'agent.yaml'), 'utf8'), dir, { triggersDir: join(ctx.universeRoot, 'other-install', 'triggers') });
      if (!lint.ok) return fail('package-not-portable', JSON.stringify(lint.errors));
      if (!lint.warnings.some(x => /no trigger file here/u.test(x))) return fail('unregistered-wake-silent', JSON.stringify(lint.warnings));
      const cards = loadCards(dir);
      if (cards.source !== 'agent.yaml') return fail('package-not-loaded', `${cards.source} ${(cards.refused ?? []).join(' · ')}`);
      const r = await runOnce(ctx.universeRoot, 'fresh', world(4), cards, org);
      if (r.report.error || !r.report.kpi) return fail('package-did-not-run', r.report.error ?? 'no kpi');
      const bad = lintAgentYaml(readFileSync(join(dir, 'agent.yaml'), 'utf8').replace('  duty: landing', '  seat: TC').replace('soul: soul.md', 'soul: /home/someone/soul.md'), dir);
      if (bad.ok || !bad.errors.some(e => /not portable/u.test(e)) || !bad.warnings.some(x => /seat id/u.test(x))) return fail('non-portable-accepted', JSON.stringify({ e: bad.errors, w: bad.warnings }));
      ctx.recorder.event('la3:portable', { landed: r.report.landed.length, warnings: lint.warnings });
      return { ok: true };
    },
  },
];
