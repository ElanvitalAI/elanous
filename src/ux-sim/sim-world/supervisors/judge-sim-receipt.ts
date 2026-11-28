// SIM-WORLD supervisors — JUDGE-SIM-RECEIPT (대표 11-28 15:2x «시뮬레이션 및 우주 합성 이벤트도 초록의 조건으로»). Each scene drives
// the REAL judge-butler wake (wakeButler → runTick → judgeCell → the kit's assessSimEvidence ⊕ assessCriterionForSign) over
// facts from the REAL collector (PR body scene table through the REAL pack registry). Only the outside is faked: the LLM (one
// must, met), gh pr view, the receipt reader, the checklist write and the sim world summaries — written in the existing
// SimWorldSummary shape (<root>/sim-world/<runId>/summary.json · runId «<pr>-<head12>-…»). Five seeds per scene, both engines.
// Expectations are independent literals (rule 11).
import { classifyBoardRequirements, decomposeDoneCriterion } from '../../../kit/requirement-judge/index.js';
import type { SimSummaryIn } from '../../../kit/requirement-judge/sim-evidence.js';
import type { CellIn } from '../../../judge-butler/done-when.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { fail, head, row, same, wake, yellow, type CriterionSide, type FuLedger, type SimPr } from './judge-binding.js';

const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];
/** The LLM side: one must, met by the first evidence row (what this world measures is the sim receipt, decided before it). */
const metLlm = async (prompt: string): Promise<string> => {
  const line = (tag: string) => prompt.split('\n').find(l => l.startsWith(tag))!.slice(tag.length);
  if (prompt.startsWith('Split the criterion')) return JSON.stringify({ segments: [{ text: JSON.parse(line('Criterion: ')) as string, classification: 'must' }] });
  if (prompt.startsWith('Independently audit')) return JSON.stringify({ approved: true, reason: 'one must' });
  const input = JSON.parse(line('Input: ')) as { requirements: Array<{ id: string }>; evidence: Array<{ id: string }> };
  return JSON.stringify({ requirements: input.requirements.map(r => ({ id: r.id, classification: 'must', fulfilled: true, evidenceIds: [input.evidence[0]!.id], reason: 'met', gap: 'none', clause: '' })) });
};
export const side = (summaries: readonly SimSummaryIn[]): CriterionSide => ({
  decomposeCriterion: (id, c) => decomposeDoneCriterion(id, c, { callLLM: metLlm }),
  judgeCriterion: input => classifyBoardRequirements(input, { callLLM: metLlm }),
  fus: new Map() as FuLedger, simSummaries: () => summaries,
});
type Rec = { scenario: string; engine: SimWorldEngine; seed: number; verdict?: 'pass' | 'regression' };
/** One recorded run per seed (`eln --test sim world run supervisors --seed N --engine both --only <scene> --run-id <pr>-<head12>-sN`). */
export const runs = (pr: number, headSha: string, recs: readonly Rec[]): SimSummaryIn[] =>
  [...new Set(recs.map(r => r.seed))].map(seed => ({
    runId: `${pr}-${headSha.slice(0, 12)}-s${seed}`,
    summary: { schema: 'sim-world.summary/1', seed, engine: 'both', scenarios: recs.filter(r => r.seed === seed).map(r => ({
      world: 'supervisors', scenario: r.scenario, engine: r.engine, seed, expected: 'green', actual: r.verdict === 'regression' ? 'fail' : 'pass', verdict: r.verdict ?? 'pass',
      diffFirstLine: null, observedReason: null, dir: `${r.scenario}/${r.engine}-s${seed}`, wallMs: 5 })) },
  }) as SimSummaryIn);
export const full = (scenario: string, from = 1, n = 5): Rec[] => Array.from({ length: n }, (_, i) => from + i).flatMap(seed => (['legacy', 'graph'] as const).map(engine => ({ scenario, engine, seed })));
export const declared = (pr: number, cell: string, body = ''): SimPr => ({ pr, title: `fix(x): ${cell.toLowerCase()}`, body: `칸: ${cell} (0.3.39 P0 · owner TC)${body}`, headRef: `fix/${cell.toLowerCase()}` });
export const withCriterion = (c: CellIn, criterion: string): CellIn => ({ ...c, doneCriterion: criterion });

async function scene(ctx: SimWorldScenarioContext, tag: string, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) { const out = await body(seed, ctx.engine); if (out) return out; }
  ctx.recorder.event('judge-sim:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5, tag });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'JB-SIM-GREEN',
    title: 'a sim world receipt bound to the cell\'s PR head (5 seeds · both engines · regression 0) for the scene its criterion or its PR body names → green, the sign line carries it',
    async run(ctx) {
      return scene(ctx, 'green', async (seed, engine) => {
        const { stem, pr } = row(seed); const [a, b] = [`${stem}-SIMA`, `${stem}-SIMB`];
        const out = await wake(ctx, `sim-green-${engine}-s${seed}`, engine, [
          withCriterion(yellow(a, `#${pr}`), 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록'),
          withCriterion(yellow(b, `#${pr + 1}`), 'PR 본문 장면 표의 장면이 초록 · focused 0 fail'),
        ], [declared(pr, a), declared(pr + 1, b, '\n\n| 장면 | 기대 |\n|---|---|\n| JB-DECLARED | 선언 PR 만 초록 |')], [], undefined,
          side([...runs(pr, head(pr), full('JB-CRIT-EMPTY')), ...runs(pr + 1, head(pr + 1), full('JB-DECLARED'))]));
        if (!same(out.signed, [a, b].sort())) return fail('sim-not-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)} (want ${JSON.stringify([a, b].sort())})`);
        if (!out.evidence[a]!.includes('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0')) return fail('sign-line', `seed ${seed} ${engine}: ${out.evidence[a]}`);
        if (!out.evidence[b]!.includes('sim JB-DECLARED 시드 5·graph+legacy·regression 0')) return fail('sign-line-body', `seed ${seed} ${engine}: ${out.evidence[b]}`);
        ctx.recorder.event('judge-sim:green', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-SIM-SCENE-MISMATCH',
    title: 'the receipt covers another scene · binds another head · has 4 of 5 seeds · one engine → not green, the refusal names the gap',
    async run(ctx) {
      return scene(ctx, 'mismatch', async (seed, engine) => {
        const { stem, pr } = row(seed); const [m, h, s4, e1] = ['M', 'H', 'S4', 'E1'].map(x => `${stem}-SIM${x}`) as [string, string, string, string];
        const crit = 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록';
        const out = await wake(ctx, `sim-mismatch-${engine}-s${seed}`, engine, [m, h, s4, e1].map((id, i) => withCriterion(yellow(id, `#${pr + i}`), crit)),
          [m, h, s4, e1].map((id, i) => declared(pr + i, id)), [], undefined, side([
            ...runs(pr, head(pr), full('JB-CRIT-LLM-DOWN')),                                    // another scene
            ...runs(pr + 1, head(pr + 901), full('JB-CRIT-EMPTY')),                             // another head of the PR
            ...runs(pr + 2, head(pr + 2), full('JB-CRIT-EMPTY', 1, 4)),                         // seeds 1–4
            ...runs(pr + 3, head(pr + 3), full('JB-CRIT-EMPTY').filter(r => r.engine === 'legacy')), // legacy only
          ]));
        if (out.signed.length) return fail('mismatch-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want [])`);
        const none = '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary)';
        const want = { [m]: none, [h]: none, [s4]: '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 시드 4/5', [e1]: '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 엔진 graph 없음' };
        if (!same(out.refused, want)) return fail('refusal-line', `seed ${seed} ${engine}: ${JSON.stringify(out.refused)} (want ${JSON.stringify(want)})`);
        ctx.recorder.event('judge-sim:mismatch', { seed, engine, refused: Object.keys(out.refused).length });
        return null;
      });
    },
  },
  {
    id: 'JB-SIM-REGRESSION',
    title: 'a bound receipt of the named scene with a regression record (any seed · any engine) → not green, the refusal names verdict@engine·seed',
    async run(ctx) {
      return scene(ctx, 'regression', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-SIMREG`;
        const recs = full('JB-CRIT-EMPTY').map(r => (r.seed === 3 && r.engine === 'graph' ? { ...r, verdict: 'regression' as const } : r));
        const out = await wake(ctx, `sim-regression-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록')],
          [declared(pr, cell)], [], undefined, side(runs(pr, head(pr), recs)));
        if (out.signed.length) return fail('regression-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} (want [])`);
        const want = '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY regression 1 (regression@graph·s3)';
        if (out.refused[cell] !== want) return fail('refusal-line', `seed ${seed} ${engine}: ${out.refused[cell] ?? 'no refusal'} (want ${want})`);
        ctx.recorder.event('judge-sim:regression', { seed, engine });
        return null;
      });
    },
  },
  {
    id: 'JB-SIM-E4',
    title: 'a criterion that reads as a synthetic test-universe event (COND-WATCH 11-28) and names no scene → green only with the cell\'s E4 run receipt; without it not green with the E4 run to request',
    async run(ctx) {
      return scene(ctx, 'e4', async (seed, engine) => {
        const { stem, pr } = row(seed); const [without, withE4] = [`${stem}-SYNTH`, `${stem}-SYNTHE4`];
        const crit = '#40586 착지(같은 head pregate 영수) · condition-watch.test.ts·self-timer-watch.test.ts focused 0 fail · 무장 조건 1건을 시험 우주에서 합성 주입 → 조건 충족 시 한 번만 깨움·미충족 시 0회(로그 원문) · JUD 서명';
        const e4 = `E4 test 층 — runId r-synth-${seed} · event: checklist.evidence.run · 2026-11-28T01:30:00Z · host minim5 · 칸 ${withE4} · 명령: bun test src/x.test.ts · rc 0 (evidence run · synthetic/test)`;
        const out = await wake(ctx, `sim-e4-${engine}-s${seed}`, engine, [withCriterion(yellow(without, `#${pr}`), crit), withCriterion(yellow(withE4, `#${pr + 1}\n${e4}`), crit)],
          [declared(pr, without), declared(pr + 1, withE4)], [], undefined, side([]));
        if (!same(out.signed, [withE4])) return fail('e4-signed-set', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)} (want [${withE4}])`);
        const want = '완료조건이 시뮬/합성 사건 꼴(«시험 우주») — 같은 칸 E4 실행 영수 또는 장면 id 를 적은 sim world 영수 없음';
        if (out.refused[without] !== want) return fail('refusal-line', `seed ${seed} ${engine}: ${out.refused[without] ?? 'no refusal'} (want ${want})`);
        if (!out.evidence[withE4]!.includes(`E4 합성 사건 영수 (r-synth-${seed} rc 0)`)) return fail('sign-line', `seed ${seed} ${engine}: ${out.evidence[withE4]}`);
        ctx.recorder.event('judge-sim:e4', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
];
