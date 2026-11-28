// SIM-RECEIPT-CARRY — the judge-butler's own scene run (SUPERVISORS-EXECUTE-NOT-PROPOSE), as one kit function over its doors so
// the live port (src/judge-butler/live.ts) and the sim world run the same decision.
//
// S: the butler ran the named scenes itself once per retry window — and every run ended «this tree does not contain
//    <head12>» (11-28 09:54Z · #40705 · #40707 on build add0b3a that had both): the test was `merge-base --is-ancestor head
//    HEAD` in the installed tree, which has no .git, and a squash landing never makes the PR head an ancestor anyway.
//    Two named scenes of one seed also shared one run id («<pr>-<head12>-s<seed>») — the second run was «already exists».
// C: the build commit is known (git HEAD, else versions/<dir>/install.json commit · fed-observe installedBuildSha) and the
//    HQ repo holds both the PR head and main; «the build carries the PR» is the carry rule's question (src/git-smart/delta.ts
//    landedIn: ancestor, or the «(#pr)» squash whose own lines equal the PR-own change).
// A: runNamedScene asks landedIn on the HQ repo for the build commit, then runs judging.yaml sim_evidence.request.scene for
//    every seed (run ids <pr>-<head12>-s<seed>-<scene>) — a seed whose summary is already there is kept, not re-run.
import { join } from 'node:path';
import type { GitRun } from '../../git-fs/smart-run.js';
import { landedIn } from '../../git-smart/delta.js';
import type { SimEvidencePolicy } from './sim-evidence.js';

export interface SimSceneRunDeps {
  readonly policy: SimEvidencePolicy;
  /** The HQ repo (PR heads ⊕ main ⊕ the build commit). */
  readonly git: GitRun;
  /** The commit this code was built from — null = unknown (no run: a sim of unknown code is no receipt). */
  readonly buildSha: string | null;
  /** The test universe the runs write into (…/.elanous-test · judging.yaml sim_evidence.roots[0]). */
  readonly runRoot: string;
  readonly exists: (path: string) => boolean;
  /** One `<cli> --test=<runRoot> sim world run …` (argv without the cli word) — its rc and tail. */
  readonly run: (argv: readonly string[]) => { rc: number; out: string };
  /** Fetch the PR head when the repo lacks it (`git fetch origin pull/<pr>/head`). */
  readonly fetchHead?: (pr: number) => void;
}

/** The argv of every seed's run (policy.request.scene filled) — the run id is the value after `--run-id`. */
export function sceneRunArgv(policy: SimEvidencePolicy, world: string, scene: string, pr: number, head: string): string[][] {
  return Array.from({ length: policy.minSeeds }, (_, n) => policy.request.scene.replaceAll('{world}', world).replaceAll('{scene}', scene).replaceAll('{pr}', String(pr))
    .replaceAll('{head12}', head.slice(0, 12)).replaceAll('{seed}', String(n + 1)).split(/\s+/u).filter(Boolean));
}

/** JUDGE-BUTLER-SELF-RUN-FIX (11-29): the bare `--test` resolves its root from the child's cwd («<git tree>/.elanous-test») —
 *  the butler's child ran with cwd = dirname(runRoot) = ~ (no git tree above) and refused «[--test] 격리 루트를 정할 수 없습니다»
 *  rc 1 on every run since 11-28 11:56Z. The run is given its root explicitly: `--test=<runRoot>` (src/cli/test-flag.ts — the
 *  `=` form names the isolated root itself), so the summary lands at <runRoot>/sim-world/<runId> wherever the child starts. */
export const explicitTestRootArgv = (argv: readonly string[], runRoot: string): string[] => argv.map((a, i) => (i === 1 && a === '--test' ? `--test=${runRoot}` : a));

export function runNamedScene(deps: SimSceneRunDeps, world: string, scene: string, pr: number, head: string): { rc: number; out: string } {
  const runs = sceneRunArgv(deps.policy, world, scene, pr, head);
  if (runs.some(a => a[1] !== '--test')) return { rc: -1, out: 'sim_evidence.request.scene must be «<cli> --test sim world run …» (a test-universe run)' };
  if (!deps.buildSha) return { rc: -1, out: 'build commit unknown (no git HEAD · no install.json commit) — the scene run waits for a known build' };
  if (deps.git(['cat-file', '-e', `${head}^{commit}`]).status !== 0) deps.fetchHead?.(pr);
  const carried = landedIn(deps.git, pr, head, deps.buildSha);
  if (!carried.ok) return { rc: -1, out: `build ${deps.buildSha.slice(0, 12)} does not carry #${pr}@${head.slice(0, 12)} (${carried.reason}) — the scene run waits for a build that does (rail)` };
  if (!/(^|\/)\.elanous-test$/u.test(deps.runRoot)) return { rc: -1, out: `sim_evidence.roots[0] ${deps.runRoot} is not a --test universe root (…/.elanous-test)` };
  const outs: string[] = [];
  for (const [n, argv] of runs.entries()) {
    const runId = argv[argv.indexOf('--run-id') + 1];
    if (argv.includes('--run-id') && runId && deps.exists(join(deps.runRoot, 'sim-world', runId, 'summary.json'))) { outs.push(`s${n + 1} kept`); continue; }
    const r = deps.run(explicitTestRootArgv(argv, deps.runRoot).slice(1));
    outs.push(`s${n + 1} rc ${r.rc}`);
    if (r.rc !== 0) return { rc: r.rc, out: `${outs.join(' · ')} — ${r.out.trim().slice(-200)}` };
  }
  return { rc: 0, out: `${outs.join(' · ')} (build ${deps.buildSha.slice(0, 12)} carries #${pr} via ${carried.via})` };
}

/** SIM-RETRY-PER-BUILD: the state key of a cell's self-run retry window («e4» · «sim-run») on this build — a new build opens a
 *  new window (a run that failed on the old build is no reason to wait on the new one). */
export const selfRunKey = (kind: 'e4' | 'sim-run', cell: string, build?: string | null): string => (build ? `${kind}:${cell}@${build.slice(0, 12)}` : `${kind}:${cell}`);
