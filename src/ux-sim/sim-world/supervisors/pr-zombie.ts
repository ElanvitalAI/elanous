// SIM-WORLD supervisors · PR-ZOMBIE-SUPPLY-TRUE (PR-ZOMBIE-AGING · 0.3.40 P1 · CEO 11-29 02:3x).
// The 11-28 shape: `eln pulse throughput` read «141 waiting» while most of those were #36xxx–#38xxx PRs whose head had not
// moved for over a week and which no longer merged onto main. The world (seeded counts and ages): Z zombies (head 8–30 d · a
// PREGATE-RED merge-main step or a land refusal merge-conflict on that head) ⊕ S stale non-conflicting (head 8–30 d) ⊕ F fresh
// PRs (head ≤ 6 d), every one waiting for a receipt in the land ledger. Driven through the real code on main:
//   ① supply   kit/pr-aging splitSupply (graphs/policies/pr-aging.yaml) → readLandLedger → decideThroughput: pipeline = F
//              (without the policy the same world reads Z+S+F — the 11-28 number)
//   ② aging    tickLand live (the land steward's body): every zombie under 14 d is drafted with one author card, every one
//              ≥ 14 d gets one close proposal (author ⊕ landing owner) · nothing closed · the fresh and the stale non-conflicting
//              PRs are untouched · a second tick sends nothing new
// Expected values are literals or counts written from the world's own seeded rows (rule 11), never from the kit's verdicts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePrAgingPolicy, prAgingPolicyPath, splitSupply } from '../../../kit/pr-aging/index.js';
import { appendLedger, tickLand, type LandDeps, type PrInfo } from '../../../land-graph/land-graph.js';
import { readLandLedger } from '../../../loops/throughput-controller-live.js';
import { decideThroughput, type ThroughputSnapshot } from '../../../loops/throughput-controller.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const NOW = new Date('2026-11-28T14:00:00.000Z'); // 11-28 23:00 KST — the «141 waiting» reading
const DAY = 86_400_000;
const H = (n: number) => n.toString(16).padStart(40, '0');

interface WorldPr { pr: PrInfo; ageDays: number; kind: 'zombie' | 'stale' | 'fresh'; via?: 'red' | 'land' }

function buildWorld(seed: number): WorldPr[] {
  let x = (seed * 2654435761) >>> 0 || 1;
  const r = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const out: WorldPr[] = [];
  const zombies = int(60, 110); const stale = int(5, 20); const fresh = int(4, 12);
  for (let i = 0; i < zombies; i++) out.push({ pr: pr(36000 + i * 20, 'TC'), ageDays: int(8, 30), kind: 'zombie', via: r() < 0.5 ? 'red' : 'land' });
  for (let i = 0; i < stale; i++) out.push({ pr: pr(38500 + i * 7, 'UX'), ageDays: int(8, 30), kind: 'stale' });
  for (let i = 0; i < fresh; i++) out.push({ pr: pr(40600 + i, 'MK'), ageDays: int(0, 6), kind: 'fresh' });
  return out;
}
const pr = (n: number, author: string): PrInfo => ({ number: n, head: H(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author, files: [`src/f${n}.ts`] });

const snapshot = (awaiting: ReadonlyArray<{ pr: number; sinceMin: number }>, stale: number[] | null): ThroughputSnapshot => ({
  now: NOW.toISOString(), version: '0.3.40', targets: { landsPerH: 10, greensPerH: 10 },
  landsLastHour: 2, graphLandsLastHour: 2, greensLastHour: 10, judgeReady: [], landsWithoutCell: 0,
  land: { readyToLand: 1, slots: 2, mode: 'live', lastTickAgeMin: 2, avgTickMin: 6 },
  churn: [], openPrs: [], awaitingPregate: awaiting, staleExcluded: stale, receipts: [], pregateHosts: ['sim-host-a'],
  hands: { free: ['TC-H-1'], holdingIdle: [], working: 3 }, frozen: [], readyCells: 30,
});

async function oneSeed(root: string, seed: number): Promise<SimWorldScenarioOutcome | { row: Record<string, number> }> {
  const policy = parsePrAgingPolicy(readFileSync(prAgingPolicyPath(), 'utf8'));
  const world = buildWorld(seed);
  const stateRoot = join(root, `s${seed}`); mkdirSync(stateRoot, { recursive: true });
  const org = join(stateRoot, 'federation.yaml'); writeFileSync(org, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
  // every PR waits for a receipt on its head (the land graph's no-receipt decision) · land-refused zombies carry merge-conflict
  for (const w of world) {
    appendLedger(stateRoot, { at: new Date(NOW.getTime() - 30 * 60_000).toISOString(), mode: 'live', pr: w.pr.number, head: w.pr.head, event: 'decision', action: 'refuse', cls: 'no-receipt', why: 'no receipt' });
    if (w.via === 'land') appendLedger(stateRoot, { at: new Date(NOW.getTime() - w.ageDays * DAY + 3_600_000).toISOString(), mode: 'live', pr: w.pr.number, head: w.pr.head, event: 'refused', cls: 'merge-conflict', why: 'STOP merge rc=1' });
  }
  const commit = new Map(world.map(w => [w.pr.head, NOW.getTime() - w.ageDays * DAY - 60_000] as const));
  const counts = { zombie: world.filter(w => w.kind === 'zombie').length, stale: world.filter(w => w.kind === 'stale').length, fresh: world.filter(w => w.kind === 'fresh').length };

  // ① supply — before (no policy: every non-draft PR) and after (fresh only)
  const supplyPrs = world.map(w => ({ pr: w.pr.number, head: w.pr.head, draft: false }));
  const before = splitSupply(supplyPrs, commit, null, NOW.getTime());
  const after = splitSupply(supplyPrs, commit, policy, NOW.getTime());
  const pipe = (heads: ReadonlyMap<number, string>, stale: number[] | null) =>
    decideThroughput(snapshot(readLandLedger(stateRoot, NOW.getTime(), heads).awaiting ?? [], stale)).measured;
  const mBefore = pipe(before.heads, null); const mAfter = pipe(after.heads, after.stale);
  const total = counts.zombie + counts.stale + counts.fresh;
  if (mBefore.pipeline !== 1 + total) return fail('supply-before', `seed ${seed}: pipeline ${mBefore.pipeline} ≠ ready 1 + ${total}`);
  if (mAfter.pipeline !== 1 + counts.fresh || mAfter.staleExcluded !== counts.zombie + counts.stale) {
    return fail('supply-not-true', `seed ${seed}: pipeline ${mAfter.pipeline} (want ${1 + counts.fresh}) · excluded ${mAfter.staleExcluded} (want ${counts.zombie + counts.stale})`);
  }

  // ② aging — the land steward's body, live, twice
  const prs = new Map(world.map(w => [w.pr.number, w.pr] as const));
  const drafted: number[] = []; const closed: number[] = []; const cards: Array<{ to: string; body: string }> = [];
  const d: LandDeps = {
    now: () => NOW, stateRoot, mode: 'live', slots: 1, org: { path: org },
    listPrs: async () => [...prs.values()], prNow: async n => prs.get(n) ?? null,
    receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
    land: async () => ({ rc: 0, text: '' }), record: () => {},
    post: (to, body) => { if (body.includes('PR 노화')) cards.push({ to, body }); },
    closePr: p => { closed.push(p.number); return { ok: true }; },
    prAging: { ...policy, toDraft: { ...policy.toDraft, maxPerTick: total } },
    headTimes: heads => new Map(heads.flatMap(h => commit.has(h) ? [[h, commit.get(h)!] as const] : [])),
    redSteps: n => (world.find(w => w.pr.number === n)?.via === 'red' ? ['fetch-main', 'merge-main'] : ['focused']),
    toDraft: p => { drafted.push(p.number); prs.set(p.number, { ...p, draft: true }); return { ok: true }; },
  };
  await tickLand(d);
  const cardsAfterFirst = cards.length;
  await tickLand(d);
  const z = world.filter(w => w.kind === 'zombie');
  const wantDraft = z.filter(w => w.ageDays < 14).map(w => w.pr.number).sort((a, b) => a - b);
  const wantClose = z.filter(w => w.ageDays >= 14).map(w => w.pr.number).sort((a, b) => a - b);
  const gotDraft = [...drafted].sort((a, b) => a - b);
  const closeCards = cards.filter(c => c.body.includes('닫기 제안'));
  const gotClose = [...new Set(closeCards.map(c => Number(/#(\d+)/u.exec(c.body)![1])))].sort((a, b) => a - b);
  if (JSON.stringify(gotDraft) !== JSON.stringify(wantDraft)) return fail('drafts', `seed ${seed}: drafted ${gotDraft.length} want ${wantDraft.length}`);
  if (JSON.stringify(gotClose) !== JSON.stringify(wantClose)) return fail('close-proposals', `seed ${seed}: proposed ${gotClose.length} want ${wantClose.length}`);
  if (closed.length) return fail('closed-by-code', `seed ${seed}: ${closed.join(',')}`);
  // one author card per draft (TC) · two per close proposal (author TC ⊕ landing owner TC → one seat once) · none on tick 2
  if (cardsAfterFirst !== wantDraft.length + wantClose.length || cards.length !== cardsAfterFirst) return fail('cards', `seed ${seed}: ${cardsAfterFirst} then ${cards.length}`);
  const untouched = world.filter(w => w.kind !== 'zombie').some(w => drafted.includes(w.pr.number) || cards.some(c => c.body.includes(`#${w.pr.number} `)));
  if (untouched) return fail('non-zombie-touched', `seed ${seed}`);
  return { row: { seed, zombies: counts.zombie, stale: counts.stale, fresh: counts.fresh, before: mBefore.pipeline!, after: mAfter.pipeline!, drafted: gotDraft.length, closeProposals: gotClose.length } };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'PR-ZOMBIE-SUPPLY-TRUE',
  title: 'PR-ZOMBIE-AGING: throughput pipeline counts only fresh PRs (head ≤ 7 d · not draft) · zombies (old head ⊕ main conflict) drafted with an author card · ≥ 14 d one close proposal · nothing closed by code',
  async run(ctx) {
    const rows: Array<Record<string, number>> = [];
    for (let s = ctx.seed; s < ctx.seed + 5; s++) {
      const r = await oneSeed(ctx.universeRoot, s);
      if ('ok' in r) return r;
      rows.push(r.row);
    }
    ctx.recorder.event('pr-zombie-supply-true', { rows });
    return { ok: true };
  },
}];
