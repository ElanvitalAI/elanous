// SIM-WORLD supervisors · CODE-BODY-TO-KIND (대표 11-28 17:3x «루프 에이전트 중에 코드로 된 것도 빠르게 플러그인화»).
// The land steward has no TS body of its own any more: it is an agent.yaml instance of the shared kinds land-graph.tick ⊕
// kpi-voice (src/loop-agent/v3/land-graph-kind.ts · kpi-voice.ts). This scene changes YAML only and expects behaviour to move:
//   P  a threshold (lands_per_hour_min) and a breach text (kpis[].breach) changed in agent.yaml → other lines, other words
//   O  the train keys changed in policies.yaml → the land order changes (no code change)
//   R  a SECOND agent (another id · address · L0 duty · thresholds · its own line template) on the same two kinds speaks its
//      own line into its own channel and memory — the kinds carry no land-steward name
// Every expectation is an independent literal (rule 11); the seed only moves the world, never a verdict.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLedger, type PrInfo } from '../../../land-graph/land-graph.js';
import { parseLandPolicy } from '../../../land-graph/lane-order.js';
import { landGraphAgentTick, loadAgentCards, type TickMemory } from '../../../loop-agent/v3/land-graph-kind.js';
import { cardsDir, fileMemory, loadCards, STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR } from '../../../land-steward/memory.js';
import { copyPkg, deps, hx, MIN, NOW, orgFile, type World } from '../graph/loop-agent-v3.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const NAMES = { id: STEWARD_ID, address: STEWARD_SEAT, l0Fallback: STEWARD_SUPERVISOR };
const strip = (l: string) => l.replace(/ · \d\d:\d\dZ(?: · .*)?$/u, '');

/** n open PRs with no receipt (nothing landable) · `past` lands in the last hour · titles / ages chosen by the caller. */
function quietWorld(seed: number, prs: Array<{ n: number; title?: string; ageMin: number }>, past: number): World {
  return { prs: prs.map(p => ({ number: p.n + seed * 10, head: hx(p.n + seed * 10), base: 'main', draft: false, state: 'OPEN' as const, title: p.title ?? `pr ${p.n + seed * 10}`, author: 'UX',
    files: [`src/f${p.n}.ts`], headRef: `b${p.n}`, createdAt: new Date(NOW - p.ageMin * MIN).toISOString() })), receipts: new Map(), focused: new Map(), tsc: new Set(), pastLands: past };
}
const seedLedger = (root: string, w: World) => { for (let i = 0; i < w.pastLands; i++) appendLedger(root, { at: new Date(NOW - (5 + i * 4) * MIN).toISOString(), pr: 40000 + i, head: hx(40000 + i), mode: 'live', event: 'landed' }); };
const memMemory = (root: string): TickMemory & { cases: string[] } => {
  let st = { lastTickAt: null as string | null, ticks: 0, breaches: {} as Record<string, string> }; const cases: string[] = [];
  return { root, cases, readState: () => ({ ...st, breaches: { ...st.breaches } }), writeState: s => { st = s; }, appendCase: c => { cases.push(`${c.kind} ${c.subject} — ${c.why}`); }, level: () => ({ level: 'live' }) };
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-LAND-KIND-PARAMS',
    title: 'CODE-BODY-TO-KIND: land-steward = agent.yaml on land-graph.tick ⊕ kpi-voice — a YAML threshold / breach text / train key alone changes the lines and the land order · a second agent (own id · address · L0 duty · KPI · texts) on the same kinds speaks its own line',
    async run(ctx) {
      const org = orgFile(ctx.universeRoot);
      const past = 3 + (ctx.seed % 3); // 3..5 lands in the last hour — always under 10, never under 2
      // ── P · threshold and text in agent.yaml only
      const w = quietWorld(ctx.seed, [{ n: 42001, ageMin: 60 }, { n: 42002, ageMin: 50 }], past);
      const runP = async (tag: string, dir: string) => {
        const s = join(ctx.universeRoot, tag); mkdirSync(s, { recursive: true }); seedLedger(s, w);
        const lines: string[] = [];
        const cards = loadCards(dir);
        if (!cards.compiled) return { lines: [`refused ${(cards.refused ?? []).join(' · ')}`] };
        await landGraphAgentTick(deps(s, w, org, []), { memory: fileMemory(s), channel: l => { lines.push(l); } }, cards, NAMES);
        return { lines: lines.map(strip) };
      };
      const base = await runP('p-base', copyPkg(ctx.universeRoot, 'p-base'));
      const low = await runP('p-low', copyPkg(ctx.universeRoot, 'p-low', y => y.replace('lands_per_hour_min: 10', 'lands_per_hour_min: 2')));
      const words = await runP('p-words', copyPkg(ctx.universeRoot, 'p-words', y => y.replace('breach: "착지 {value}/h < {target} (준비 {kpi.ready} · 슬롯 대기 {kpi.waitingForSlot})"', 'breach: "시간당 착지 {value}건 — 목표 {target}건"')));
      const wantBase = [`[착지 집사 · KPI] 착지 ${past}/h < 10 (준비 0 · 슬롯 대기 0)`, '[착지 집사 · KPI] 착지 가능 0% < 50% (0/2)'];
      if (JSON.stringify(base.lines) !== JSON.stringify(wantBase)) return fail('P-baseline', JSON.stringify(base.lines));
      if (JSON.stringify(low.lines) !== JSON.stringify(['[착지 집사 · KPI] 착지 가능 0% < 50% (0/2)'])) return fail('P-threshold-ignored', JSON.stringify(low.lines));
      if (JSON.stringify(words.lines) !== JSON.stringify([`[착지 집사 · KPI] 시간당 착지 ${past}건 — 목표 10건`, '[착지 집사 · KPI] 착지 가능 0% < 50% (0/2)'])) return fail('P-text-ignored', JSON.stringify(words.lines));
      // ── O · train keys in policies.yaml only (crown first → oldest first · number only)
      const ow = quietWorld(ctx.seed, [{ n: 42011, ageMin: 30 }, { n: 42012, ageMin: 90 }, { n: 42013, title: 'P0 hotfix', ageMin: 10 }], 0);
      const order = async (tag: string, pack: string) => {
        const s = join(ctx.universeRoot, tag); mkdirSync(s, { recursive: true });
        const r = await landGraphAgentTick(deps(s, ow, org, []), { memory: fileMemory(s), channel: () => {}, policy: parseLandPolicy(pack) }, loadCards(), NAMES);
        return r.decisions.map(d => d.pr - ctx.seed * 10);
      };
      const shipped = await order('o-train', readFileSync(join(cardsDir(), 'policies.yaml'), 'utf8'));
      const numbers = await order('o-number', 'lane_order:\n  mode: train\n  train: { keys: [number] }\n  pins: []\n');
      if (JSON.stringify(shipped) !== '[42013,42012,42011]') return fail('O-shipped-train', JSON.stringify(shipped));
      if (JSON.stringify(numbers) !== '[42011,42012,42013]') return fail('O-keys-ignored', JSON.stringify(numbers));
      // ── R · a second agent on the same kinds (its own id · address · L0 duty · KPI · texts)
      const pkg = join(ctx.universeRoot, 'pkg', 'other', 'queue-keeper'); mkdirSync(pkg, { recursive: true });
      for (const f of ['soul.md', 'knowhow.md']) cpSync(join(cardsDir(), f), join(pkg, f));
      const other = readFileSync(join(cardsDir(), 'agent.yaml'), 'utf8')
        .replace('  name: land-steward\n', '  name: queue-keeper\n').replace('  agent: land-steward\n', '  agent: queue-keeper\n')
        .replace('  id: land-steward\n  address: LAND-STEWARD\n', '  id: queue-keeper\n  address: QUEUE-KEEPER\n')
        .replace('  duty: landing ', '  duty: veto ')
        .replace('lands_per_hour_min: 10 ', 'lands_per_hour_min: 1 ')
        .replace('landable_ratio_min: 0.5 ', 'landable_ratio_min: 0.9 ')
        .replace('breach: "착지 가능 {value|pct} < {target|pct} ({kpi.ready}/{kpi.judged})"', 'breach: "대기열 준비율 {value|pct} (목표 {target|pct})"')
        .replace('line: "[착지 집사 · KPI] {breach} · {time}Z · eln land steward status"', 'line: "[queue-keeper] {breach} · {time}Z"')
        .replace('  registered_as: land-graph ', '  registered_as: queue-keeper ');
      writeFileSync(join(pkg, 'agent.yaml'), other);
      const rc = loadAgentCards(pkg, 'queue-keeper');
      if (!rc.compiled) return fail('R-refused', (rc.refused ?? []).join(' · '));
      const rs = join(ctx.universeRoot, 'r-state'); mkdirSync(rs, { recursive: true }); seedLedger(rs, w);
      const mem = memMemory(join(rs, 'loop-agents', 'queue-keeper')); const rl: string[] = [];
      const rr = await landGraphAgentTick(deps(rs, w, org, []), { memory: mem, channel: l => { rl.push(l); }, policy: null }, rc, { id: 'queue-keeper', address: 'QUEUE-KEEPER', l0Fallback: 'JUD' });
      if (JSON.stringify(rl.map(strip)) !== JSON.stringify(['[queue-keeper] 대기열 준비율 0% (목표 90%)'])) return fail('R-own-line', JSON.stringify(rl));
      if (rr.level !== 'live' || !mem.cases.length || !mem.cases[0]!.startsWith('tick landed 0 — ready 0/2')) return fail('R-own-memory', JSON.stringify(mem.cases));
      ctx.recorder.event('sup:land-kind-params', { past, base: base.lines, low: low.lines, words: words.lines, shipped, numbers, other: rl.map(strip), otherCases: mem.cases.length });
      return { ok: true };
    },
  },
];
