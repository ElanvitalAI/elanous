// SIM-WORLD supervisors — JUDGE-GREEN-PR-BINDING (11-28 · eln OP caught WORK-NEXT-ROSTER-SCOPE-FU signed on #40622 and
// CONTEXT-BUS-FEDERATION signed on #40630; the day scan found 12 more). Each scene drives the REAL judge-butler wake
// (wakeButler → planTick/runTick → sign through the ports) over facts from the REAL collector (collectPrFacts · the
// PR's own body/title/branch · the land steward's cell-link.jsonl rows read by readSweepRows) — only the outside is faked
// (gh pr view · the receipt reader · the checklist write). Five seeds per scene, both engines:
//   legacy = the v2 wake (body tick only)
//   graph  = the v3 wake the trigger runs (graphs/loop-agents/judge-butler/agent.yaml reflect · plan · learn hooks)
// JUDGE-GREEN-PR-BINDING-LEGACY: JB-LEGACY-OWN-EVIDENCE · JB-NEGATION feed the collector the cells' evidence trail (who wrote
// which line · features.sqlite events in the live) — a legacy PR silent about every cell binds by the cell's own evidence.
// Expectations are independent literals (rule 11): the signed set and the refusal line are written here, not rendered.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipelineCellsByPr, readSweepRows } from '../../../land-graph/main-cell-link.js';
import { evidencePrRefs } from '../../../release-loop/green-triage.js';
import { wakeButler } from '../../../judge-butler/agent.js';
import type { ButlerPorts, ButlerView } from '../../../judge-butler/body.js';
import { collectPrFacts, type CollectorDeps, type PrMeta } from '../../../judge-butler/collector.js';
import type { CellTrail } from '../../../land-graph/cell-link.js';
import type { CellIn } from '../../../judge-butler/done-when.js';
import { fileMemory } from '../../../judge-butler/memory.js';
import { loadButlerSmart, type ButlerSmartInput } from '../../../judge-butler/smart.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

export const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];
export const NOW = new Date('2026-11-28T02:00:00.000Z');
export const head = (n: number): string => n.toString(16).padStart(8, '0').repeat(5).slice(0, 40);

/** Per seed: a cell-id stem and a PR base — literal rows (seed 1 replays the 11-28 live ids). */
const ROWS: ReadonlyArray<{ stem: string; pr: number }> = [
  { stem: 'WORK-NEXT-ROSTER-SCOPE', pr: 40622 }, { stem: 'CONTEXT-BUS-FED', pr: 40630 }, { stem: 'LAND-PREGATE-BYPASS', pr: 40606 },
  { stem: 'JEV-MEMORY-RECALL', pr: 40588 }, { stem: 'LAND10-SUPPLY', pr: 40618 },
];
export const row = (seed: number) => ROWS[((seed - 1) % 5 + 5) % 5]!;

export interface SimPr { readonly pr: number; readonly title: string; readonly body: string; readonly headRef: string; readonly receiptHead?: string;
  /** SIM-RECEIPT-CARRY scenes: a real commit of the scene's git repo as the landed head (default: the synthetic head(pr)). */
  readonly landedHead?: string }
interface SweepRowIn { readonly pr: number; readonly action: string; readonly cells: readonly string[]; readonly basis?: string }
export interface Outcome { readonly signed: string[]; readonly why: Record<string, string>; readonly refused: Record<string, string>; readonly evidence: Record<string, string> }
/** JUDGE-NOT-OVERSTRICT scenes: the criterion LLM side of the world (the kit with a fake callLLM) ⊕ the FU ledger. */
export type FuLedger = Map<string, { title: string; evidence: string }>;
export type CriterionSide = Partial<Pick<ButlerPorts, 'decomposeCriterion' | 'judgeCriterion'>> & {
  /** The board's FU cells (shared across wakes = a re-sign sees what an earlier sign filed) — read · add · append through the ports. */
  readonly fus?: FuLedger;
  /** JUDGE-SIM-RECEIPT: the sim world summaries on this board (the live reads <root>/sim-world/<runId>/summary.json). */
  readonly simSummaries?: ButlerPorts['simSummaries'];
};

/** One wake over one universe: cells ⊕ merged PRs ⊕ (optional) land-steward sweep rows. */
export async function wake(ctx: SimWorldScenarioContext, tag: string, engine: SimWorldEngine, cellsIn: readonly CellIn[], prs: readonly SimPr[], sweepRows: readonly SweepRowIn[] = [],
  trails?: Readonly<Record<string, CellTrail>>, criterion?: CriterionSide,
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE scenes: extra ports (runSimScene · post) ⊕ registered HOLDs ⊕ the PR files (security-4). */
  more?: { readonly ports?: Partial<ButlerPorts>; readonly holds?: ButlerView['holds']; readonly files?: (pr: number) => string[];
    /** SIM-RETRY-PER-BUILD · SIM-SCENES-OWN-DIFF scenes: the butler's build commit ⊕ the PR-own change lines port. */
    readonly build?: string; readonly ownChange?: CollectorDeps['ownChange'] }): Promise<Outcome> {
  const root = join(ctx.universeRoot, tag);
  mkdirSync(join(root, 'land-graph'), { recursive: true });
  if (sweepRows.length) appendFileSync(join(root, 'land-graph', 'cell-link.jsonl'), sweepRows.map(r => JSON.stringify({ at: NOW.toISOString(), version: '0.3.39', mergedAt: NOW.toISOString(), ...r })).join('\n') + '\n');
  const pipeline = pipelineCellsByPr(readSweepRows(root));
  const cells = new Map(cellsIn.map(c => [c.id, { ...c }] as const));
  const fus: FuLedger = criterion?.fus ?? new Map();
  const byPr = new Map(prs.map(p => [p.pr, p] as const));
  const deps: CollectorDeps = {
    merged: new Map(prs.map(p => [p.pr, 'f'.repeat(40)] as const)), landedHead: pr => byPr.get(pr)?.landedHead ?? head(pr), cacheDir: join(root, 'butler'),
    prMeta: (pr): PrMeta | null => { const p = byPr.get(pr); return p ? { head: p.landedHead ?? head(pr), files: more?.files?.(pr) ?? [`src/sim-${pr}.ts`], title: p.title, body: p.body, headRef: p.headRef } : null; },
    receipt: (pr, h) => { const at = byPr.get(pr)?.receiptHead ?? h; return { head: at, dir: `PREGATE-GREEN/${pr}-${at.slice(0, 12)}-minim5`, focusedFiles: 1, focused: { pass: 7, fail: 0 } }; },
    security: () => [], cells: [...cells.values()], pipelineCells: pr => pipeline.get(pr) ?? [],
    ...(trails ? { trail: (id: string) => trails[id] } : {}),
    ...(more?.ownChange ? { ownChange: more.ownChange } : {}),
  };
  const facts = (c: CellIn) => collectPrFacts(evidencePrRefs(c.evidence ?? ''), deps);
  const memory = fileMemory(join(root, 'butler'));
  const ports: ButlerPorts = {
    memory, merged: new Set(prs.map(p => p.pr)),
    sign(id, evidence, expected) {
      const c = cells.get(id);
      if (!c || c.status !== expected.status || c.evidence !== expected.evidence) throw new Error('snapshot moved');
      Object.assign(c, { status: 'green', evidence, updatedBy: 'JUDGE-BUTLER', updatedAt: NOW.toISOString() });
    },
    readCell: id => cells.get(id) ?? (fus.has(id) ? { id, title: fus.get(id)!.title, status: 'yellow', evidence: fus.get(id)!.evidence } : null), freshFacts: facts, expireHolds: () => [], post: () => null, answerHand: () => null, escalateHand: () => null,
    // #40661 signing boundary (doneCriterion → requirements → judgment): the LLM is the outside, faked — one must, met by the
    // first PR evidence row. The binding (what this world measures) decides before it: an unbound PR never reaches here.
    decomposeCriterion: async () => ({ trusted: true, requirements: [{ id: 'R1', text: CRITERION, classification: 'must' }] }),
    judgeCriterion: async input => ({ trusted: true, policyVersion: 'sim', requirements: input.requirements.map(r => ({ id: r.id, classification: r.classification ?? 'must', fulfilled: true, evidenceIds: [input.evidence[0]!.id], reason: 'sim' })) }),
    ...(criterion ? {
      ...(criterion.decomposeCriterion ? { decomposeCriterion: criterion.decomposeCriterion } : {}),
      ...(criterion.judgeCriterion ? { judgeCriterion: criterion.judgeCriterion } : {}),
      ...(criterion.simSummaries ? { simSummaries: criterion.simSummaries } : {}),
      addFollowUp: (id: string, title: string) => { if (!fus.has(id) && !cells.has(id)) fus.set(id, { title, evidence: '' }); return true; },
      appendEvidence: (id: string, line: string) => {
        const f = fus.get(id); if (!f) return false;
        if (!f.evidence.split('\n').includes(line)) f.evidence = f.evidence ? `${f.evidence}\n${line}` : line;
        return true;
      },
    } : {}),
    ...(more?.ports ?? {}),
  };
  const all = collectPrFacts([...cells.values()].flatMap(c => evidencePrRefs(c.evidence ?? '')), deps);
  const view: ButlerView = { now: NOW, version: '0.3.39', cells: [...cells.values()], prFacts: all, holds: more?.holds ?? [], blocks: [], hands: [], ...(more?.build ? { build: more.build } : {}) };
  let smart: ButlerSmartInput | null = null;
  if (engine === 'graph') {
    const s = loadButlerSmart();
    if (!s.cfg) throw new Error(`agent.yaml refused: ${s.errors.join(' · ')}`);
    smart = { cfg: s.cfg, l0: 'JUD' };
  }
  const r = await wakeButler({ view, ports, smart });
  const signed = [...cells.values()].filter(c => c.status === 'green' && c.updatedBy === 'JUDGE-BUTLER');
  return { signed: signed.map(c => c.id).sort(), why: Object.fromEntries(r.tick.notSigned.map(n => [n.cell, n.why])),
    refused: Object.fromEntries(r.tick.signRefused.map(n => [n.cell, n.why])), evidence: Object.fromEntries(signed.map(c => [c.id, c.evidence ?? ''])) };
}

export const CRITERION = 'the cell\'s own merged PR carries a same-head receipt with focused exit 0';
export const yellow = (id: string, evidence: string): CellIn => ({ id, title: id, status: 'yellow', owner: 'TC', evidence, doneCriterion: CRITERION, updatedAt: '2026-11-28T01:00:00.000Z', updatedBy: 'TC' });
/** A cell's evidence trail: each line written once, by `by` (the live: features.sqlite evidence / evidence.add events). */
const trail = (lines: ReadonlyArray<readonly [by: string, text: string]>, claimants: readonly string[] = []): CellTrail =>
  ({ writes: lines.map(([by, text], i) => ({ at: `2026-11-27T1${i}:00:00.000Z`, by, text })), claimants, writers: [] });
const owned = (id: string, owner: string, lines: ReadonlyArray<readonly [string, string]>): CellIn => ({ ...yellow(id, lines.map(l => l[1]).join('\n')), owner });
/** A PR older than the «칸» convention: nothing in its title, body or branch names a cell. */
const legacyPr = (pr: number, seed: number): SimPr => ({ pr, title: `[queue] preserve the reason on idle resume ${pr % 7}`, body: 'Preserve queue interruption causes on idle resume.', headRef: `hand-mx-${seed}/queue-resume-core` });
const green = (id: string): CellIn => ({ id, title: id, status: 'green', owner: 'TC', evidence: 'done', updatedAt: '2026-11-28T00:00:00.000Z', updatedBy: 'JUD' });

export async function scene(ctx: SimWorldScenarioContext, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) {
    const out = await body(seed, ctx.engine);
    if (out) return out;
  }
  ctx.recorder.event('judge-binding:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
  return { ok: true };
}
export const same = (got: unknown, want: unknown): boolean => JSON.stringify(got) === JSON.stringify(want);

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'JB-UNRELATED',
    title: 'evidence that only mentions an unrelated merged PR (another cell\'s · the defect\'s subject) never signs green',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const cell = `${stem}-FU`; const other = `PWA-GATE-E4-S${seed}`; const subject = `${stem}-BYPASS-${pr + 1}`;
        const out = await wake(ctx, `unrelated-${engine}-s${seed}`, engine, [
          yellow(cell, `PR${pr} is existing HAND-FED work, NOT proof this follow-up is fixed\n#${pr}는 무관한 병합 PWA PR`),
          yellow(subject, `#${pr + 1} merged without a same-head receipt — find the path`), green(other),
        ], [
          { pr, title: 'test: synthetic PWA gate delta and cache lifecycle', body: 'Synthetic PWA gate scene.', headRef: `tc/pwa-gate-e4-s${seed}` },
          { pr: pr + 1, title: 'Keep warm pod preparation off HQ', body: 'Warm pool off HQ.', headRef: 'feat/warm-pool-no-mshq' },
        ]);
        const want = {
          [cell]: `missing — no merged PR of ${cell} — #${pr} is PWA-GATE-E4-S${seed}'s PR — the PR that does this cell carries «칸: ${cell}»`,
          [subject]: `missing — no merged PR of ${subject} — #${pr + 1} declares no cell (no «칸:» line · title · branch) — the PR that does this cell carries «칸: ${subject}»`,
        };
        if (out.signed.length) return fail('unrelated-pr-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want [])`);
        if (!same({ [cell]: out.why[cell], [subject]: out.why[subject] }, want)) return fail('refusal-line', `seed ${seed} ${engine}: ${JSON.stringify(out.why)} (want ${JSON.stringify(want)})`);
        ctx.recorder.event('judge-binding:unrelated', { seed, engine, signed: out.signed.length });
        return null;
      });
    },
  },
  {
    id: 'JB-DECLARED',
    title: 'a merged PR that declares «칸: <ID>» (or its own sweep row binds it) with a same-head receipt signs green; a stale receipt does not',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const [a, b, c] = [`${stem}-A`, `${stem}-B`, `${stem}-C`];
        const out = await wake(ctx, `declared-${engine}-s${seed}`, engine, [yellow(a, `#${pr}`), yellow(b, `#${pr + 1} merged`), yellow(c, `#${pr + 2}`)], [
          { pr, title: 'fix(x): bounded result', body: `## 요약\n칸: ${a} (0.3.39 P0 · owner TC)\n`, headRef: `fix/s${seed}` },
          { pr: pr + 1, title: 'feat(x): no label', body: 'no cell line', headRef: `feat/s${seed}` }, // bound by its own sweep row (files)
          { pr: pr + 2, title: 'fix(x): old head', body: `칸: ${c}`, headRef: `fix/c-s${seed}`, receiptHead: head(pr + 900) },
        ], [{ pr: pr + 1, action: 'attach', cells: [b], basis: 'files' }, { pr, action: 'linked', cells: [`${stem}-Z`] }]);
        const h = (n: number) => head(n).slice(0, 12);
        if (!same(out.signed, [a, b].sort())) return fail('declared-not-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want ${JSON.stringify([a, b].sort())}) · ${JSON.stringify(out.why)}`);
        const want = `missing — #${pr + 2} receipt head ${h(pr + 900)} ≠ landed ${h(pr + 2)} (re-run pregate on the landed head)`;
        if (out.why[c] !== want) return fail('stale-receipt', `seed ${seed} ${engine}: ${c} → ${out.why[c] ?? 'signed'} (want ${want})`);
        ctx.recorder.event('judge-binding:declared', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-UMBRELLA',
    title: 'two or more cells cite one PR: only the cells the PR declares turn green, the rest name the PR\'s own cells',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const [u1, u2, u3, u4, u5] = [1, 2, 3, 4, 5].map(i => `${stem}-U${i}`);
        const out = await wake(ctx, `umbrella-${engine}-s${seed}`, engine, [
          yellow(u1, `#${pr}`), yellow(u2, `#${pr} (same umbrella)`), yellow(u3, `#${pr + 1}`), yellow(u4, `#${pr + 1}`), yellow(u5, `#${pr + 1} 우산`),
        ], [
          { pr, title: `feat(x): ${u1} — one kit`, body: `칸: ${u1}`, headRef: `feat/one-s${seed}` },
          { pr: pr + 1, title: 'feat(x): two cells', body: `칸: ${u3} · ${u4} 후속 (0.3.39)`, headRef: `feat/two-s${seed}` },
        ]);
        if (!same(out.signed, [u1, u3, u4].sort())) return fail('umbrella-overreach', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want ${JSON.stringify([u1, u3, u4].sort())})`);
        const want = {
          [u2]: `missing — no merged PR of ${u2} — #${pr} is ${u1}'s PR — the PR that does this cell carries «칸: ${u2}»`,
          [u5]: `missing — no merged PR of ${u5} — #${pr + 1} is ${u3}, ${u4}'s PR — the PR that does this cell carries «칸: ${u5}»`,
        };
        if (!same({ [u2]: out.why[u2], [u5]: out.why[u5] }, want)) return fail('refusal-line', `seed ${seed} ${engine}: ${JSON.stringify(out.why)} (want ${JSON.stringify(want)})`);
        ctx.recorder.event('judge-binding:umbrella', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-MISLABEL',
    title: 'a PR whose «칸» line names C while its title/branch name another cell D (#40630) signs neither by the line',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const c = `${stem}-FEDERATION`; const d = `${stem}-ONE-SOURCE`;
        const out = await wake(ctx, `mislabel-${engine}-s${seed}`, engine, [yellow(c, `#${pr}`), yellow(d, 'not yet linked')], [
          { pr, title: `feat(release): ${d} — one current-board record`, body: `칸: ${c} (0.3.39 P0 · owner OP/claude)`, headRef: `op/${d.toLowerCase()}` },
        ]);
        if (out.signed.length) return fail('mislabel-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want [])`);
        const want = `missing — no merged PR of ${c} — #${pr} «칸: ${c}» but its title/branch name ${d} — mislabelled PR (fix its 칸 line) — the PR that does this cell carries «칸: ${c}»`;
        if (out.why[c] !== want) return fail('refusal-line', `seed ${seed} ${engine}: ${out.why[c] ?? 'no line'} (want ${want})`);
        ctx.recorder.event('judge-binding:mislabel', { seed, engine });
        return null;
      });
    },
  },
  {
    id: 'JB-LEGACY-OWN-EVIDENCE',
    title: 'a legacy PR silent about every cell binds by the cell\'s own evidence (owner · hand · unattributed writer); a judge\'s line, a PR that declared another cell, the subject PR never bind; an umbrella\'s «등록 칸» list binds',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const [inv, stale, other, judged, list] = [`${stem}-INVENTORY`, `${stem}-STALE`, `${stem}-OTHER`, `${stem}-JUDGED`, `${stem}-LISTED`];
        const subject = `${stem}-BYPASS-${pr + 5}`;
        const sha = 'ab'.repeat(20);
        const t: Record<string, CellTrail> = {
          [inv]: trail([['OP', `#${pr}`], ['TC-H-CX-7', `#${pr + 1} ${sha.slice(0, 12)} 착지`]], ['TC-H-CX-7']), // a hand that held it
          [stale]: trail([['cli', `#${pr + 2} merged; head ${sha}; focused exit 0`]]),
          [other]: trail([['OP', `implementing: PR #${pr + 3} (merged) — 우산`]]),
          [judged]: trail([['JUD', `JUD 독립 판정: #${pr + 4} MERGED head ${sha}`], ['JUDGE-BUTLER', `🟢 판정 집사 서명 — #${pr + 4}@${sha.slice(0, 12)}`]]),
          [subject]: trail([['TC', `#${pr + 5} merged without a same-head receipt`]]),
          [list]: trail([['TC', `#${pr + 6}`]]),
        };
        const lines = (id: string) => t[id]!.writes.map(w => [w.by, w.text] as const);
        const out = await wake(ctx, `legacy-${engine}-s${seed}`, engine, [
          owned(inv, 'OP', lines(inv)), owned(stale, 'OP', lines(stale)), owned(other, 'OP', lines(other)), owned(judged, 'TC', lines(judged)),
          owned(subject, 'TC', lines(subject)), owned(list, 'TC', lines(list)),
        ], [
          legacyPr(pr, seed), legacyPr(pr + 1, seed), legacyPr(pr + 2, seed),
          { pr: pr + 3, title: 'feat(fed-state): op actions as fed facts', body: `칸: FED-FACT-OP-ACTIONS-S${seed} (0.3.38 P1 · OP)`, headRef: `op/fed-fact-s${seed}` },
          legacyPr(pr + 4, seed), legacyPr(pr + 5, seed),
          { pr: pr + 6, title: 'docs(conductor): YAML-SYSTEM 우산', body: `칸 **YAML-DEFINABLE-AUDIT-S${seed}**(0.3.38) — 우산 설계 정본.\n- 등록 칸: ${list} · YAML-POLICY-PACK-S${seed}(0.3.38)`, headRef: `op/yaml-system-s${seed}` },
        ], [], t);
        const want = [inv, stale, list].sort();
        if (!same(out.signed, want)) return fail('legacy-binding', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want ${JSON.stringify(want)}) · ${JSON.stringify(out.why)}`);
        const whys = {
          [other]: `missing — no merged PR of ${other} — #${pr + 3} declares a cell of another release (its «칸» line names no cell of this one) — the PR that does this cell carries «칸: ${other}»`,
          [judged]: `missing — no merged PR of ${judged} — #${pr + 4} declares no cell (no «칸:» line · title · branch) — the PR that does this cell carries «칸: ${judged}»`,
          [subject]: `missing — no merged PR of ${subject} — #${pr + 5} declares no cell (no «칸:» line · title · branch) — the PR that does this cell carries «칸: ${subject}»`,
        };
        if (!same({ [other]: out.why[other], [judged]: out.why[judged], [subject]: out.why[subject] }, whys)) return fail('refusal-line', `seed ${seed} ${engine}: ${JSON.stringify(out.why)} (want ${JSON.stringify(whys)})`);
        ctx.recorder.event('judge-binding:legacy', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-NEGATION',
    title: 'a negation word in the clause that cites the PR («무관» · «NOT proof» · «unrelated» · «아님») never binds it; a clean own clause beside it does (the #40622 case)',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const { stem, pr } = row(seed);
        const [n1, n2, n3, n4] = [`${stem}-N1`, `${stem}-N2`, `${stem}-N3`, `${stem}-N4`];
        const t: Record<string, CellTrail> = {
          [n1]: trail([['TC-H-CX-7', `PR #${pr} is existing HAND-FED work, NOT proof this follow-up is fixed`], ['TC-H-CX-7', `#${pr}는 무관한 병합 PWA PR`]]),
          [n2]: trail([['TC', `#${pr + 1} merged · #${pr + 1} 은 실행 build 아님`]]),
          [n3]: trail([['TC', `#${pr + 2} merged, unrelated to this cell`]]),
          [n4]: trail([['TC-H-POOL-2', `#${pr + 3} merged — 이 칸 PR 아님`]], ['TC-H-POOL-2']),
        };
        const lines = (id: string) => t[id]!.writes.map(w => [w.by, w.text] as const);
        const out = await wake(ctx, `negation-${engine}-s${seed}`, engine, [n1, n2, n3, n4].map(id => owned(id, 'TC', lines(id))),
          [legacyPr(pr, seed), legacyPr(pr + 1, seed), legacyPr(pr + 2, seed), legacyPr(pr + 3, seed)], [], t);
        if (!same(out.signed, [n2])) return fail('negated-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want ${JSON.stringify([n2])}) · ${JSON.stringify(out.why)}`);
        const line = (cell: string, n: number) => `missing — no merged PR of ${cell} — #${n} declares no cell (no «칸:» line · title · branch) — the PR that does this cell carries «칸: ${cell}»`;
        const want = { [n1]: line(n1, pr), [n3]: line(n3, pr + 2), [n4]: line(n4, pr + 3) };
        if (!same({ [n1]: out.why[n1], [n3]: out.why[n3], [n4]: out.why[n4] }, want)) return fail('refusal-line', `seed ${seed} ${engine}: ${JSON.stringify(out.why)} (want ${JSON.stringify(want)})`);
        ctx.recorder.event('judge-binding:negation', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
];
