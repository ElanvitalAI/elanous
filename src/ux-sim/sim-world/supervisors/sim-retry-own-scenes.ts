// SIM-WORLD supervisors — SIM-RETRY-PER-BUILD ⊕ SIM-SCENES-OWN-DIFF (11-28 11:44Z after the rail with #40714: refusals 95/window ·
// greens/h 1 · self-runs 0). Each scene drives the REAL judge-butler wake (wakeButler → runTick → the collector → the kit's
// assessSimEvidence); only the scene runner, the LLM, gh and the PR-own change text are faked. Five seeds, both engines.
// Expectations are independent literals (rule 11).
//   SUP-EXEC-BUTLER-RETRY-BUILD  a self-run that failed on build A waits on A (retry window) — the same cell on build B is run
//                                again at once and signs: the window is per build (the fix's own rail kept «10:54Z 뒤 대기»)
//   JB-SIM-SCENES-OWN-DIFF       a PR body that names other PRs' scenes in prose (a status line · a copied body) binds only the
//                                scenes the PR-own change touches → signed · the same board without the own-change port refuses
import type { SimSummaryIn } from '../../../kit/requirement-judge/sim-evidence.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { fail, head, row, same, wake, yellow } from './judge-binding.js';
import { declared, full, runs, side, withCriterion } from './judge-sim-receipt.js';

const CRIT = 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록';
const BUILD_A = 'a1'.repeat(20); const BUILD_B = 'b2'.repeat(20);

async function scene(ctx: SimWorldScenarioContext, tag: string, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of [0, 1, 2, 3, 4].map(i => ctx.seed + i)) { const out = await body(seed, ctx.engine); if (out) return out; }
  ctx.recorder.event('sim-retry:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5, tag });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-EXEC-BUTLER-RETRY-BUILD',
    title: 'judge-butler: a named-scene self-run that failed on build A waits on A (e4_retry_min) · on build B the same cell is run again at once (1 run) and signs — the retry window is per build',
    async run(ctx) {
      return scene(ctx, 'retry-build', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-RETRY`;
        const tag = `retry-build-${engine}-s${seed}`;
        const summaries: SimSummaryIn[] = []; const ran: string[] = [];
        let builtFix = false;
        const runSimScene = (world: string, sc: string, n: number, sha: string) => {
          ran.push(`${world}/${sc}#${n}`);
          if (!builtFix) return { rc: -1, out: `build ${BUILD_A.slice(0, 12)} does not carry #${n}` };
          summaries.push(...runs(n, sha, full(sc)).map(x => ({ ...x, runId: `${x.runId}-${sc}` })));
          return { rc: 0, out: 's1 rc 0 · s2 rc 0 · s3 rc 0 · s4 rc 0 · s5 rc 0' };
        };
        const tick = (build: string) => wake(ctx, tag, engine, [withCriterion(yellow(cell, `#${pr}`), CRIT)], [declared(pr, cell)], [], undefined,
          side(summaries), { build, ports: { runSimScene, simSummaries: () => summaries } });
        const a1 = await tick(BUILD_A);
        const a2 = await tick(BUILD_A);
        const afterA = ran.length;
        builtFix = true;
        const b1 = await tick(BUILD_B);
        if (afterA !== 1) return fail('runs-on-a', `seed ${seed} ${engine}: ${afterA} runs on build A (want 1 · the second tick waits)`);
        if (a1.signed.length || a2.signed.length) return fail('signed-on-a', `seed ${seed} ${engine}: ${JSON.stringify([a1.signed, a2.signed])}`);
        if (ran.length !== 2) return fail('runs-on-b', `seed ${seed} ${engine}: ${ran.length - afterA} runs on build B (want 1)`);
        if (!same(b1.signed, [cell])) return fail('not-signed-on-b', `seed ${seed} ${engine}: signed ${JSON.stringify(b1.signed)} refused ${JSON.stringify(b1.refused)}`);
        if (!b1.evidence[cell]!.includes('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0')) return fail('sign-line', `seed ${seed} ${engine}: ${b1.evidence[cell]}`);
        ctx.recorder.event('sim-retry:build', { seed, engine, runs: ran.length });
        return null;
      });
    },
  },
  {
    id: 'JB-SIM-SCENES-OWN-DIFF',
    title: 'a PR body naming other PRs\' scenes in prose binds only the scenes the PR-own change touches → signed on its own scene\'s receipt · a body copied from another PR (own change touches none) needs no scene · without the own-change port both refuse',
    async run(ctx) {
      return scene(ctx, 'own-diff', async (seed, engine) => {
        const { stem, pr } = row(seed); const [mineCell, copied] = [`${stem}-OWNSC`, `${stem}-COPIED`];
        const prose = '\n\n| 장면 | 기대 |\n|---|---|\n| JB-CRIT-EMPTY | 초록 |\n\n상황: 옆 PR 은 JB-DECLARED · JB-CRIT-LLM-DOWN 영수 없음으로 거부됐다.';
        const prs = [{ ...declared(pr, mineCell, prose) }, { ...declared(pr + 1, copied, prose) }];
        const own = (n: number) => (n === pr ? `diff --git a/x.yaml b/x.yaml\n+  - { id: JB-CRIT-EMPTY, module: x.ts }` : 'diff --git a/src/els/keys.ts b/src/els/keys.ts\n+export const KEY = 1;');
        const cells = [yellow(mineCell, `#${pr}`), yellow(copied, `#${pr + 1}`)];
        const summaries = runs(pr, head(pr), full('JB-CRIT-EMPTY'));
        const withPort = await wake(ctx, `own-diff-${engine}-s${seed}`, engine, cells, prs, [], undefined, side(summaries), { ownChange: n => own(n) });
        if (!same(withPort.signed, [copied, mineCell].sort())) return fail('own-diff-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(withPort.signed)} refused ${JSON.stringify(withPort.refused)}`);
        if (!withPort.evidence[mineCell]!.includes('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0')) return fail('sign-line', `seed ${seed} ${engine}: ${withPort.evidence[mineCell]}`);
        if (withPort.evidence[mineCell]!.includes('JB-DECLARED')) return fail('foreign-scene', `seed ${seed} ${engine}: ${withPort.evidence[mineCell]}`);
        const without = await wake(ctx, `own-diff-noport-${engine}-s${seed}`, engine, cells, prs, [], undefined, side(summaries));
        const want = '시뮬 영수 미충족 — 장면 JB-CRIT-LLM-DOWN 영수 없음(같은 PR head 의 sim world summary) · 장면 JB-DECLARED 영수 없음(같은 PR head 의 sim world summary)';
        if (without.signed.length || without.refused[mineCell] !== want) return fail('no-port-baseline', `seed ${seed} ${engine}: signed ${JSON.stringify(without.signed)} refused ${JSON.stringify(without.refused)}`);
        ctx.recorder.event('sim-retry:own-diff', { seed, engine, signed: withPort.signed });
        return null;
      });
    },
  },
];
