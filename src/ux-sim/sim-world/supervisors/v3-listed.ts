// SIM-WORLD supervisors · JUDGE-BUTLER-V3-LISTED (LOOP-AGENTS-AS-PLUGINS · 대표 11-28 15:3x «감독자들이 다 도는지 · 플러그인화»).
// The REAL repo agent packages (graphs/loop-agents/*/agent.yaml · the v2 cards) ⊕ the REAL lint ⊕ the REAL trigger builder
// (graphs/triggers/judge-butler.yaml shim → agent.yaml wake) ⊕ the REAL els space grouping, over a test universe whose agent
// homes hold synthetic tick files:
//   L — `eln loop agent list` rows: every agent.yaml without a v2 card is listed (judge-butler · land-steward · guardian) with
//       its body kind, and judge-butler's L0 = JUD (duty veto) · KPI lines read through kpis[].from (literal)
//   U — an unreadable tick file → every value «?» (모름 · never a false 0)
//   F — a broken `from:` in a package → that agent is refused with the lint line, the others still listed
//   T — the judge-butler trigger is built from agent.yaml: owner JUD (its loops row sits in JUD's space) · the same wake
//       (5 files · cooldown 2 · max-wait 10 fire) · goal deadline 30 · 2 attempts · backoff [60] · the recipe runs the shared door
//   G — GUARDIAN-KPI-FROM: guardian's KPI is read from its pulse snapshot (last-pulse.json kpi[] · agent.yaml from: { file · path ·
//       where }) — the sub rows with ok false are counted (ok null = 모름, not counted) · last tick = the pulse `at` · no pulse = «?»
// Expectations are independent literals (rule 11). Seeds move only the greens/h number, never a verdict.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cardsRoot, listCards } from '../../../loop-agent/card.js';
import { listedAgents } from '../../../loop-agent/v3/listed.js';
import { KIND_DOORS, KIND_RUNNERS, greensInWindow } from '../../../loop-agent/v3/kind-runners.js';
import { readTriggerDecl } from '../../../loops/trigger-registry.js';
import { loopHomeSeat } from '../../../els/loop-agents.js';
import { DEFAULT_ORG } from '../../../org/org-map.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const tick = (state: string, id: string, body: unknown) => { mkdirSync(join(state, 'loop-agents', id), { recursive: true }); writeFileSync(join(state, 'loop-agents', id, 'last-tick.json'), JSON.stringify(body)); };
/** The land graph's KPI block as the live tick wrote it 11-28 06:12Z (literal shape). */
/** The guardian pulse snapshot as the live pulse wrote it 11-28 10:18Z (literal shape · values trimmed): 2 subs missed, 1 모름. */
const row = (agent: string, ok: boolean | null) => ({ agent, name: agent, kpi: `${agent} KPI`, value: `${agent} value`, ok, lastSpawn: '2026-11-28T10:04:10.275Z', why: 'cadence 15m' });
const GUARDIAN_PULSE = { at: '2026-11-28T10:18:06.860Z', world: [], kpi: [row('pulse', false), row('lease', true), row('keys', true), row('macrophage', true), row('patrol', null), row('post', false), row('fuel', true)] };
const LAND_KPI = { landsLastHour: 4, landsToday: 66, ready: 5, judged: 15, landableRatio: 0.3333333333333333, needsFinisherWaitP50Min: 1027.5204666666666, needsFinisherOpen: 1, refusalsWithoutNext: [], waitingForSlot: 0 };

function scene(universeRoot: string, seed: number) {
  const state = join(universeRoot, `vl-${seed}`, 'state');
  const greens = 9 + seed; // seed 1 → 10 (met) … seed 5 → 14
  tick(state, 'judge-butler', { level: 'live', at: '2026-11-28T06:20:18.663Z', signed: ['WORK-PULL-OPEN-PR-WRITER'], frozenHands: 1, kpi: { greensLastHour: greens, frozenHands: 1 } });
  tick(state, 'land-steward', { at: '2026-11-28T06:12:20.893Z', level: 'live', kpi: LAND_KPI });
  mkdirSync(join(state, 'loop-agents', 'guardian'), { recursive: true });
  writeFileSync(join(state, 'loop-agents', 'guardian', 'last-pulse.json'), JSON.stringify(GUARDIAN_PULSE));
  const skip = new Set(listCards(cardsRoot(REPO)).cards.map(c => c.id));
  const L = listedAgents({ cardsRoot: cardsRoot(REPO), stateRoot: state, skip });
  rmSync(join(state, 'loop-agents', 'land-steward', 'last-tick.json'));
  rmSync(join(state, 'loop-agents', 'guardian', 'last-pulse.json'));
  const U = listedAgents({ cardsRoot: cardsRoot(REPO), stateRoot: state, skip });
  // F — a package copy whose first KPI has a broken path
  const tmp = mkdtempSync(join(universeRoot, `vl-${seed}-pkg-`));
  for (const id of ['judge-butler', 'land-steward']) cpSync(join(cardsRoot(REPO), id), join(tmp, id), { recursive: true });
  const y = join(tmp, 'judge-butler', 'agent.yaml');
  writeFileSync(y, readFileSync(y, 'utf8').replace('from: kpi.greensLastHour', 'from: kpi..greens'));
  const F = listedAgents({ cardsRoot: tmp, stateRoot: state, skip: new Set() });
  const decl = readTriggerDecl(join('graphs', 'triggers', 'judge-butler.yaml'), REPO);
  const recipe = /judge-butler-tick:\n {2}command: '([^\n]*)'/u.exec(readFileSync(join(REPO, 'graphs', 'triggers', 'recipes.yaml'), 'utf8'))?.[1] ?? '';
  const T0 = Date.parse('2026-11-28T06:00:00Z');
  const cases = [{ at: '2026-11-28T05:10:00Z', kind: 'sign', subject: 'A' }, { at: '2026-11-28T05:20:00Z', kind: 'sign', subject: 'A' }, { at: '2026-11-28T05:30:00Z', kind: 'sign', subject: 'B' },
    { at: '2026-11-28T05:40:00Z', kind: 'sign', subject: 'C' }, { at: '2026-11-28T04:00:00Z', kind: 'sign', subject: 'D' }, { at: '2026-11-28T05:50:00Z', kind: 'hold', subject: 'E' }];
  return {
    listed: L.agents.map(a => a.id), errors: L.errors,
    butler: L.agents.find(a => a.id === 'judge-butler') ?? null, steward: L.agents.find(a => a.id === 'land-steward') ?? null,
    stewardUnread: U.agents.find(a => a.id === 'land-steward') ?? null,
    guardian: L.agents.find(a => a.id === 'guardian') ?? null, guardianUnread: U.agents.find(a => a.id === 'guardian') ?? null,
    refused: { listed: F.agents.map(a => a.id), errors: F.errors },
    trigger: { owner: decl.owner, space: loopHomeSeat(decl.owner, DEFAULT_ORG.duties), parts: decl.condition?.predicate && 'parts' in decl.condition.predicate ? (decl.condition.predicate as { parts: Array<{ file: string }> }).parts.map(p => p.file) : null,
      cooldownMin: decl.condition?.cooldownMin ?? null, maxWaitMin: decl.condition?.maxWaitMin ?? null, onMaxWait: decl.condition?.onMaxWait ?? null, goal: decl.goal, deadline: decl.goalDeadlineMin, attempts: decl.maxAttempts, backoff: decl.backoffSec },
    door: { runner: Object.keys(KIND_RUNNERS), doors: KIND_DOORS, recipe },
    greens: greensInWindow(cases, { C: true }, T0, 3_600_000), greensSeed: greens,
  };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-V3-LISTED',
    title: 'judge-butler · land-steward · guardian are listed v3 agents (L0 · level · last tick · KPI from kpis[].from) · an unreadable tick is «?» · a broken from: is refused · the judge-butler trigger comes from agent.yaml, owner JUD (its JUD space) · the recipe runs the shared door',
    async run(ctx) {
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2, ctx.seed + 3, ctx.seed + 4]) {
        const o = scene(ctx.universeRoot, seed);
        ctx.recorder.event('sup:v3-listed', { seed, ...o });
        // L — listed rows
        if (JSON.stringify(o.listed) !== '["guardian","judge-butler","land-steward"]') return fail('L-listed', `seed ${seed}: ${JSON.stringify(o.listed)} · errors ${JSON.stringify(o.errors)}`);
        if (o.errors.length) return fail('L-errors', `seed ${seed}: ${JSON.stringify(o.errors)}`);
        const b = o.butler!;
        if (b.supervisor !== 'JUD' || b.body !== 'judge-butler.tick' || b.lastTickAt !== '2026-11-28T06:20:18.663Z' || b.level !== 'live') return fail('L-butler-row', `seed ${seed}: ${JSON.stringify(b)}`);
        const g = o.greensSeed;
        const want = `greens_per_hour ${g} /h (목표 ≥ 10) 충족 · frozen_hands 1 (목표 ≤ 0) 위반`;
        if (b.kpi !== want || b.kpiOk !== false) return fail('L-butler-kpi', `seed ${seed}: «${b.kpi}» ok ${String(b.kpiOk)} (want «${want}» false)`);
        const s = o.steward!;
        const wantS = 'lands_per_hour 4 /h (목표 ≥ 10) 위반 · landable_ratio 0.33 (목표 ≥ 0.5) 위반 · needs_finisher_wait_p50 1027.52 min (목표 ≤ 30) 위반 · refusals_without_next 0 (목표 ≤ 0) 충족';
        if (s.body !== 'land-graph.tick' || s.kpi !== wantS || s.kpiOk !== false) return fail('L-steward-kpi', `seed ${seed}: «${s.kpi}» ${s.body}`);
        // U — unreadable tick file
        const u = o.stewardUnread!;
        if (u.kpi !== 'lands_per_hour ? /h (목표 ≥ 10) 모름 · landable_ratio ? (목표 ≥ 0.5) 모름 · needs_finisher_wait_p50 ? min (목표 ≤ 30) 모름 · refusals_without_next ? (목표 ≤ 0) 모름' || u.kpiOk !== null || u.lastTickAt !== null) return fail('U-unknown', `seed ${seed}: «${u.kpi}» ${String(u.kpiOk)}`);
        // G — guardian KPI from its pulse snapshot
        const gd = o.guardian!; const gu = o.guardianUnread!;
        if (gd.body !== 'guardian.pulse' || gd.kpi !== 'subs_kpi_breached 2 서브 (목표 ≤ 0) 위반' || gd.kpiOk !== false || gd.lastTickAt !== '2026-11-28T10:18:06.860Z') return fail('G-guardian-kpi', `seed ${seed}: «${gd.kpi}» ${String(gd.kpiOk)} ${gd.lastTickAt}`);
        if (gu.kpi !== 'subs_kpi_breached ? 서브 (목표 ≤ 0) 모름' || gu.kpiOk !== null || gu.lastTickAt !== null) return fail('G-guardian-unread', `seed ${seed}: «${gu.kpi}» ${String(gu.kpiOk)} ${gu.lastTickAt}`);
        // F — broken from:
        if (JSON.stringify(o.refused.listed) !== '["land-steward"]' || JSON.stringify(o.refused.errors) !== '["judge-butler/agent.yaml refused: kpis[0].from must be a dotted field path into the tick file (e.g. kpi.landsLastHour)"]') return fail('F-refused', `seed ${seed}: ${JSON.stringify(o.refused)}`);
        // T — trigger from agent.yaml
        const t = o.trigger;
        if (t.owner !== 'JUD' || t.space !== 'JUD') return fail('T-owner', `seed ${seed}: owner ${t.owner} space ${t.space}`);
        if (JSON.stringify(t.parts) !== '["{seatState}/RES/evidence/PREGATE-GREEN","{stateRoot}/land-graph/ledger.jsonl","{stateRoot}/hold-ledger/events.jsonl","{stateRoot}/release/features.sqlite","{stateRoot}/release/features.sqlite-wal"]'
          || t.cooldownMin !== 2 || t.maxWaitMin !== 10 || t.onMaxWait !== 'fire') return fail('T-wake', `seed ${seed}: ${JSON.stringify(t)}`);
        if (JSON.stringify(t.goal) !== '{"kind":"file-mtime","path":"{stateRoot}/loop-agents/judge-butler/last-tick.json"}' || t.deadline !== 30 || t.attempts !== 2 || JSON.stringify(t.backoff) !== '[60]') return fail('T-failure', `seed ${seed}: ${JSON.stringify(t)}`);
        // door — the shared runner runs judge-butler.tick ⊕ land-graph.tick (CODE-BODY-TO-KIND · `eln land steward tick` is its alias) · guardian keeps its own door (named)
        if (JSON.stringify(o.door.runner) !== '["judge-butler.tick","land-graph.tick"]' || o.door.doors['land-graph.tick'] !== undefined || o.door.doors['guardian.pulse'] !== 'eln loop guardian pulse') return fail('door', `seed ${seed}: ${JSON.stringify(o.door)}`);
        if (!o.door.recipe.includes('bin/elanous.mjs" loop agent judge-butler tick --json')) return fail('door-recipe', `seed ${seed}: ${o.door.recipe}`);
        // greens/h = distinct signed cells in the last hour that were not reversed (A twice · B · C reversed · D 2 h ago)
        if (o.greens !== 2) return fail('greens', `seed ${seed}: ${o.greens} (want 2)`);
      }
      return { ok: true };
    },
  },
];
