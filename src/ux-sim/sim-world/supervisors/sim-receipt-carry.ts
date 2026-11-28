// SIM-WORLD supervisors — SIM-RECEIPT-CARRY (11-28 19:xx · greens 3/h vs 10: «시뮬 영수 미충족 — 장면 … 영수 없음» on cells whose
// authors ran the scene, because the land graph's merges moved the head, and the butler's own run said «this tree does not
// contain …» for every squash-landed PR). Each scene drives the REAL judge-butler wake (wakeButler → runTick → the kit's
// assessSimEvidence) over a REAL git repo in the universe: the carry door is src/git-smart/delta.ts carryProofAt and the
// butler's own run is src/kit/requirement-judge/sim-run.ts runNamedScene (landedIn on the build commit) — only the scene runner, the
// LLM and gh are faked. Five seeds per scene, both engines. Expectations are independent literals (rule 11).
//   JB-SIM-CARRY-MERGE        receipt on head A · landed head B = A ⊕ a clean main merge → signed, the line says «승계 ← A»
//   JB-SIM-CARRY-OWN-CHANGED  receipt on head A · landed head C = B ⊕ an own commit → not signed, the refusal names why
//   SUP-EXEC-BUTLER-SQUASH-RUN no receipt · the build commit holds the «(#pr)» squash of the landed head → the butler runs the
//                             scene (5 seeds) and signs · a PR the build does not carry → no run, not signed
//   JB-SELF-RUN-SCENE-ROOT    JUDGE-BUTLER-SELF-RUN-FIX (11-29): the child each seed runs gets «--test=<runRoot>» — from a cwd with
//                             no git tree above it (the installed box: cwd = ~) the bare «--test» resolves no root (rc 1 since
//                             11-28 11:56Z), the explicit form resolves exactly the run root (the real src/cli/test-flag.ts parser)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitAt, type GitRun } from '../../../git-fs/smart-run.js';
import { carryProofAt } from '../../../git-smart/delta.js';
import { runNamedScene } from '../../../kit/requirement-judge/sim-run.js';
import { loadSimEvidencePolicy, type SimSummaryIn } from '../../../kit/requirement-judge/sim-evidence.js';
import { extractTestFlag, resolveTestRoot } from '../../../cli/test-flag.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { fail, row, same, wake, yellow } from './judge-binding.js';
import { declared, full, runs, side, withCriterion } from './judge-sim-receipt.js';

const CRIT = 'JB-CRIT-EMPTY 장면이 5 seeds · 두 엔진에서 초록';
const ID = ['-c', 'user.name=sim', '-c', 'user.email=sim@elanous.local', '-c', 'commit.gpgsign=false'];
interface Repo { readonly dir: string; readonly git: GitRun; readonly a: string; readonly b: string; readonly c: string; readonly squash: string; readonly beforeSquash: string }
/** main M0 → PR commit A (own.ts) · main M1 (other.txt) · PR merges main → B · PR own commit → C · main squashes B «(#pr)». */
function repo(dir: string, pr: number, seed: number): Repo {
  mkdirSync(dir, { recursive: true });
  const git = gitAt(dir, { timeoutMs: 30_000 });
  const must = (args: string[]): string => { const r = git(args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout.trim(); };
  const put = (file: string, text: string) => writeFileSync(join(dir, file), text);
  const commit = (msg: string) => { must(['add', '-A']); must([...ID, 'commit', '-q', '-m', msg]); return must(['rev-parse', 'HEAD']); };
  must(['init', '-q', '-b', 'main']);
  put('base.txt', `base ${seed}\n`); commit('base');
  must(['checkout', '-q', '-b', 'pr']);
  put('own.ts', `export const own = ${seed};\n`); const a = commit('own change');
  must(['checkout', '-q', 'main']);
  put('other.txt', `main moved ${seed}\n`); const beforeSquash = commit('main moves');
  must(['checkout', '-q', 'pr']);
  must([...ID, 'merge', '-q', '--no-ff', '-m', 'Merge main', 'main']); const b = must(['rev-parse', 'HEAD']);
  put('own.ts', `export const own = ${seed + 100};\n`); const c = commit('own change after the receipt');
  must(['checkout', '-q', 'main']);
  must(['merge', '-q', '--squash', b]); const squash = commit(`feat: carried change (#${pr})`);
  return { dir, git, a, b, c, squash, beforeSquash };
}

async function scene(ctx: SimWorldScenarioContext, tag: string, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of [0, 1, 2, 3, 4].map(i => ctx.seed + i)) { const out = await body(seed, ctx.engine); if (out) return out; }
  ctx.recorder.event('sim-carry:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5, tag });
  return { ok: true };
}
const carriesIn = (r: Repo) => (old: string, _pr: number, head: string) => { const c = carryProofAt(r.dir, old, head, 'main'); return c.ok ? { ok: true } : { ok: false, reason: c.reason }; };

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'JB-SIM-CARRY-MERGE',
    title: 'a sim receipt of an older head (A) whose landed head (B) only merged main — PR-own lines identical → carried, signed, the sign line names the head it came from',
    async run(ctx) {
      return scene(ctx, 'carry-merge', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-CARRY`;
        const r = repo(join(ctx.universeRoot, `carry-merge-${engine}-s${seed}`, 'repo'), pr, seed);
        const out = await wake(ctx, `carry-merge-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), CRIT)], [{ ...declared(pr, cell), landedHead: r.b }], [], undefined,
          side(runs(pr, r.a, full('JB-CRIT-EMPTY'))), { ports: { simCarries: carriesIn(r) } });
        if (!same(out.signed, [cell])) return fail('carry-not-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)}`);
        const want = `sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0 (승계 ← ${r.a.slice(0, 12)} · PR 고유 변경 동일)`;
        if (!out.evidence[cell]!.includes(want)) return fail('sign-line', `seed ${seed} ${engine}: ${out.evidence[cell]} (want … ${want} …)`);
        ctx.recorder.event('sim-carry:merge', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-SIM-CARRY-OWN-CHANGED',
    title: 'a sim receipt of an older head (A) whose landed head (C) added an own commit after it → not carried, not signed, the refusal names the commit',
    async run(ctx) {
      return scene(ctx, 'carry-own-changed', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-OWNCHG`;
        const r = repo(join(ctx.universeRoot, `carry-own-${engine}-s${seed}`, 'repo'), pr, seed);
        const out = await wake(ctx, `carry-own-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), CRIT)], [{ ...declared(pr, cell), landedHead: r.c }], [], undefined,
          side(runs(pr, r.a, full('JB-CRIT-EMPTY'))), { ports: { simCarries: carriesIn(r) } });
        if (out.signed.length) return fail('own-changed-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)}`);
        const want = `시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary · 옛 head ${r.a.slice(0, 12)} 영수 승계 불가 — own commit ${r.c.slice(0, 12)} after the receipt)`;
        if (out.refused[cell] !== want) return fail('refusal-line', `seed ${seed} ${engine}: ${out.refused[cell] ?? 'no refusal'} (want ${want})`);
        ctx.recorder.event('sim-carry:own-changed', { seed, engine });
        return null;
      });
    },
  },
  {
    id: 'SUP-EXEC-BUTLER-SQUASH-RUN',
    title: 'judge-butler: no receipt · the build commit holds the «(#pr)» squash of the landed head → the butler runs the named scene itself (5 seeds · run ids <pr>-<head12>-s<seed>-<scene>) and signs · a PR the build does not carry → no run, not signed',
    async run(ctx) {
      return scene(ctx, 'squash-run', async (seed, engine) => {
        const { stem, pr } = row(seed); const [inBuild, notIn] = [`${stem}-SQIN`, `${stem}-SQOUT`];
        const tag = `squash-run-${engine}-s${seed}`;
        const r = repo(join(ctx.universeRoot, tag, 'repo'), pr, seed);
        const other = repo(join(ctx.universeRoot, tag, 'repo-other'), pr + 1, seed + 50); // its commits are not in r — never built
        const summaries: SimSummaryIn[] = []; const ran: string[] = [];
        const policy = loadSimEvidencePolicy();
        const runScene = (world: string, sc: string, n: number, sha: string) => runNamedScene({
          policy, git: r.git, buildSha: r.squash, runRoot: join(ctx.universeRoot, tag, '.elanous-test'), exists: () => false,
          run: argv => {
            const id = argv[argv.indexOf('--run-id') + 1]!; ran.push(id);
            const s = Number(argv[argv.indexOf('--seed') + 1]);
            summaries.push(...runs(n, sha, full(sc, s, 1)).map(x => ({ ...x, runId: id })));
            return { rc: 0, out: '' };
          },
        }, world, sc, n, sha);
        const out = await wake(ctx, tag, engine, [withCriterion(yellow(inBuild, `#${pr}`), CRIT), withCriterion(yellow(notIn, `#${pr + 1}`), CRIT)],
          [{ ...declared(pr, inBuild), landedHead: r.b }, { ...declared(pr + 1, notIn), landedHead: other.b }], [], undefined,
          side(summaries), { ports: { runSimScene: runScene, simSummaries: () => summaries } });
        const wantRan = [1, 2, 3, 4, 5].map(s => `${pr}-${r.b.slice(0, 12)}-s${s}-JB-CRIT-EMPTY`);
        if (!same(ran, wantRan)) return fail('runs', `seed ${seed} ${engine}: ${JSON.stringify(ran)} (want ${JSON.stringify(wantRan)})`);
        if (!same(out.signed, [inBuild])) return fail('signed-set', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)} (want [${inBuild}])`);
        if (!out.evidence[inBuild]!.includes('sim JB-CRIT-EMPTY 시드 5·graph+legacy·regression 0')) return fail('sign-line', `seed ${seed} ${engine}: ${out.evidence[inBuild]}`);
        if (out.refused[notIn] !== '시뮬 영수 미충족 — 장면 JB-CRIT-EMPTY 영수 없음(같은 PR head 의 sim world summary)') return fail('not-carried', `seed ${seed} ${engine}: ${out.refused[notIn] ?? 'no refusal'}`);
        ctx.recorder.event('sim-carry:squash-run', { seed, engine, runs: ran.length });
        return null;
      });
    },
  },
  {
    id: 'JB-SELF-RUN-SCENE-ROOT',
    title: 'judge-butler self-run: every seed\'s child CLI is given its test root explicitly (--test=<runRoot>) — from a cwd with no git tree above it the bare --test resolves no root, the explicit form resolves exactly the run root (5 seeds · real test-flag parser)',
    async run(ctx) {
      return scene(ctx, 'self-run-root', async (seed, engine) => {
        const { pr } = row(seed); const tag = `self-run-root-${engine}-s${seed}`;
        const r = repo(join(ctx.universeRoot, tag, 'repo'), pr, seed);
        const runRoot = join(ctx.universeRoot, tag, '.elanous-test');
        const resolved: Array<string | null> = []; const bare: Array<string | null> = [];
        const out = runNamedScene({
          policy: loadSimEvidencePolicy(), git: r.git, buildSha: r.squash, runRoot, exists: () => false,
          run: argv => {
            // the child's own boot step: process.argv = [bun, cli, ...argv] · cwd «/» has no .git above it (as ~ on the installed box)
            const flag = extractTestFlag(['bun', 'eln', ...argv]);
            resolved.push(flag.globalFound ? resolveTestRoot('/', flag.globalExplicitDir) : null);
            bare.push(resolveTestRoot('/', undefined));
            return { rc: 0, out: '' };
          },
        }, 'supervisors', 'JB-CRIT-EMPTY', pr, r.b);
        if (out.rc !== 0) return fail('run', `seed ${seed} ${engine}: rc ${out.rc} ${out.out}`);
        if (!same(resolved, [runRoot, runRoot, runRoot, runRoot, runRoot])) return fail('explicit-root', `seed ${seed} ${engine}: ${JSON.stringify(resolved)} (want 5 × ${runRoot})`);
        if (!same(bare, [null, null, null, null, null])) return fail('bare-root', `seed ${seed} ${engine}: bare --test from «/» resolved ${JSON.stringify(bare)} (want 5 × null)`);
        ctx.recorder.event('sim-carry:self-run-root', { seed, engine, runs: resolved.length });
        return null;
      });
    },
  },
];
