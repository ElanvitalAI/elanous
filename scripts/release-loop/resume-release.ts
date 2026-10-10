// RELEASE-BRANCH (10-06): resume a failed release run after `release cut-branch --append --pick` moved release/<v>.
// The saved version-release output is re-pointed at the new branch tip (fast-forward only, state backed up first), so
// every later node reads the repaired commit without anyone hand-editing the run state.
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { lastJsonObject, runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { releaseRunUniverse } from './release-universe.js';
import { isReleaseVersion } from './release-version.js';
import { changedFilesBetween, clearPartialPlan, planPartialRegate, writePartialPlan } from './gate-partial.js';
import { releaseResumeAcceptedRegressions, releaseResumeWaiver, type AcceptedRegression } from './resume.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');

export interface ResumeReleaseDeps {
  root?: string;
  repo?: string;
  /** Runs git and returns stdout (throws on failure). */
  git?: (args: string[]) => string;
  /** `git merge-base --is-ancestor a b`. */
  isAncestor?: (ancestor: string, descendant: string) => boolean;
  graph?: typeof runGraph;
  /** The release graph (tests point it at a probe graph with the same graph id). */
  graphPath?: string;
  /** Node command runner for the resumed graph (tests record each node's context instead of running it). */
  runBash?: NonNullable<NonNullable<Parameters<typeof runGraph>[1]>['deps']>['runBash'];
  now?: () => Date;
  /** Machine release ledger (gate-failures.json of the prior gate) — default releaseLedgerRoot(). */
  ledgerRoot?: string;
}

export interface TipRefresh { version: string; branch: string; from: string; to: string; changed: boolean; statePath: string; backup?: string }

function gitRunner(repo: string) {
  return (args: string[]): string => {
    // git-spawn-allow: read-only fetch / ls-remote / rev-parse against release/<v>; nothing is pushed or checked out.
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error || 'no output').toString().trim()}`);
    return result.stdout.trim();
  };
}

function ancestorRunner(repo: string) {
  return (ancestor: string, descendant: string): boolean => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo });
    if (result.status !== 0 && result.status !== 1) throw new Error(`git merge-base failed: ${result.error || result.stderr || 'unknown'}`);
    return result.status === 0;
  };
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') throw new Error(`invalid run id: ${runId}`);
  return runId;
}

/** Point the saved version-release output at the current release/<v> tip (fast-forward of the recorded commit only). */
export function refreshReleaseBranchTip(runId: string, deps: ResumeReleaseDeps = {}, from?: string, waiverCommit?: string): TipRefresh {
  const root = deps.root ?? effectiveInstanceRoot();
  const statePath = join(root, 'graph-runs', 'release-loop', `${safeRunId(runId)}.json`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
  if (state.graphId !== 'release-loop' || state.runId !== runId) throw new Error(`run identity mismatch: ${statePath}`);
  if (state.status !== 'failed') throw new Error(`release run ${runId} is ${state.status} — only a failed run is resumed`);
  const restartAt = from === undefined ? -1 : state.path.indexOf(from);
  if (from !== undefined && (restartAt < 0 || state.path.lastIndexOf(from) !== restartAt)) throw new Error(`--from ${from} is not a node on the saved path of ${runId}`);
  const index = state.nodes.findIndex((node) => node.nodeId === 'version-release');
  const record = index >= 0 ? state.nodes[index]! : undefined;
  const output = record ? lastJsonObject(record.output) : undefined;
  if (!record?.ok || !output) throw new Error(`release run ${runId} has no successful version-release record`);
  const version = typeof output.version === 'string' ? output.version : '';
  const recorded = typeof output.commit === 'string' ? output.commit : '';
  if (!isReleaseVersion(version) || !/^[0-9a-f]{40}$/i.test(recorded)) throw new Error(`release run ${runId} version-release output is not a release commit`);
  const branch = `release/${version}`;
  // Only a run that cut release/<v> itself is re-pointed — a main-cut or --cut-commit run has no branch of its own.
  const input = (state.input ?? {}) as { branchCut?: unknown; version?: unknown };
  if (input.branchCut !== true || input.version !== version || output.branch !== branch) {
    throw new Error(`release run ${runId} was not cut as ${branch} (input.branchCut/version or version-release branch differ) — refusing to resume`);
  }
  const git = deps.git ?? gitRunner(deps.repo ?? process.cwd());
  const advertised = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/i.test(advertised)) throw new Error(`${branch} is not on origin — this run was not cut as a release branch`);
  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const to = git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  if (waiverCommit && (recorded.toLowerCase() !== waiverCommit.toLowerCase() || to.toLowerCase() !== waiverCommit.toLowerCase() || advertised.toLowerCase() !== waiverCommit.toLowerCase())) {
    throw new Error('release branch moved — re-gate the new tip before waiving a node');
  }
  if (to !== advertised) throw new Error(`${branch} moved while it was read (${advertised} → ${to})`);
  if (to === recorded) {
    debug.log('release-loop.resume', 'tip-unchanged', { runId, version, commit: to });
    return { version, branch, from: recorded, to, changed: false, statePath };
  }
  // A repair only appends (`cut-branch --append`): anything but a fast-forward is a different release.
  if (!(deps.isAncestor ?? ancestorRunner(deps.repo ?? process.cwd()))(recorded, to)) {
    throw new Error(`${branch} tip ${to} does not descend from the recorded release commit ${recorded} — refusing to resume`);
  }
  // A new tip invalidates everything built from the old one (gate verdict, prepared archive, …): restart no later
  // than the first node that consumed the commit, so each of them runs again on the new tip.
  const firstConsumer = state.path.indexOf('gate');
  if (restartAt >= 0 && firstConsumer >= 0 && restartAt > firstConsumer) {
    throw new Error(`${branch} moved (${recorded.slice(0, 12)} → ${to.slice(0, 12)}): resume at gate or earlier — later nodes were built from the old tip`);
  }
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backup = `${statePath}.before-tip-${stamp}-${process.pid}-${to.slice(0, 12)}.bak`;
  // Exclusive: a retry never overwrites an earlier backup.
  copyFileSync(statePath, backup, constants.COPYFILE_EXCL);
  const refreshed = { ...output, commit: to, refreshedFrom: recorded };
  const text = typeof record.output === 'string' ? record.output.replace(/\s*$/, '') : '';
  state.nodes[index] = { ...record, output: `${text}\n${JSON.stringify(refreshed)}\n` };
  const temporary = `${statePath}.${process.pid}.tip.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, statePath);
  debug.log('release-loop.resume', 'tip-refreshed', { runId, version, branch, from: recorded, to, backup });
  return { version, branch, from: recorded, to, changed: true, statePath, backup };
}

/** GATE-PARTIAL outcome of a resume — applied (plan written) or the reason it fell back to a full gate. */
export type PartialOutcome = { requested: false } | { requested: true; applied: true; files: number; priorCommit: string } | { requested: true; applied: false; reason: string };

/** Build (or clear) the partial re-gate plan for the new tip. Fail-closed: any doubt leaves a full gate. */
function preparePartial(tip: TipRefresh, opts: { from: string; partial?: boolean }, deps: ResumeReleaseDeps): PartialOutcome {
  const root = deps.root ?? effectiveInstanceRoot();
  // Any resume starts from no plan: one without --partial (from whatever node) never inherits an older plan.
  clearPartialPlan(root, tip.version);
  if (!opts.partial) return { requested: false };
  const fallback = (reason: string): PartialOutcome => {
    debug.log('release-loop.resume', 'partial-fallback', { version: tip.version, reason });
    return { requested: true, applied: false, reason };
  };
  if (opts.from !== 'gate') return fallback('--partial only applies to --from gate');
  if (!tip.changed) return fallback('release branch tip unchanged — nothing new to re-check');
  let prior: { commit?: unknown; failures?: unknown; errors?: unknown } | undefined;
  for (const location of [...new Set([deps.ledgerRoot ?? releaseLedgerRoot(), root])]) {
    const path = join(location, 'release', tip.version, 'gate-failures.json');
    if (!existsSync(path)) continue;
    let record: typeof prior;
    try { record = JSON.parse(readFileSync(path, 'utf8')) as typeof prior; }
    catch { return fallback(`unreadable gate record: ${path}`); }
    if (record?.commit === tip.from) { prior = record; break; }
  }
  if (!prior || !Array.isArray(prior.failures) || !(prior.errors === undefined || Array.isArray(prior.errors))) {
    return fallback(`no complete gate record for ${tip.from.slice(0, 12)} (a stalled or errored gate keeps none)`);
  }
  // Both sides of a rename count (`--no-renames`): a source moved to a test/Markdown name is still a source change.
  let changed: string[];
  try {
    changed = deps.git
      ? deps.git(['diff', '--name-only', '--no-renames', `${tip.from}..${tip.to}`]).split(/\r?\n/).filter(Boolean)
      : changedFilesBetween(deps.repo ?? process.cwd(), tip.from, tip.to);
  } catch (error) {
    // The tip is already refreshed — a failed diff must not strand the resume: run the full gate and say why.
    return fallback(`changed files unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
  }
  const planned = planPartialRegate({ version: tip.version, priorCommit: tip.from, forCommit: tip.to, changedFiles: changed,
    priorFailures: prior.failures as string[], priorErrors: (prior.errors ?? []) as string[] });
  if (!planned.ok) return fallback(planned.reason);
  const path = writePartialPlan(root, planned.plan);
  debug.log('release-loop.resume', 'partial-planned', { version: tip.version, priorCommit: tip.from, commit: tip.to, files: planned.plan.files.length, path });
  return { requested: true, applied: true, files: planned.plan.files.length, priorCommit: tip.from };
}

/** The graph file the run started from — a snapshot run refuses any other path (the installed CLI's own copy differs). */
function savedGraphPath(statePath: string): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { graphPath?: unknown };
    return typeof saved.graphPath === 'string' && saved.graphPath ? saved.graphPath : undefined;
  } catch { return undefined; }
}

/** Refresh the branch tip, then restart the failed run at `from` with the saved graph snapshot. */
export async function resumeReleaseRun(opts: { runId: string; from: string; partial?: boolean; waive?: string; reason?: string; acceptedRegressions?: AcceptedRegression[] }, deps: ResumeReleaseDeps = {}): Promise<{ tip: TipRefresh; partial: PartialOutcome; state: GraphRunState }> {
  if (opts.from === 'version-release') throw new Error('--from version-release would cut again — resume at a later node');
  // RELEASE-LEDGER-UNIVERSE: decide the universe once; the run lookup and every resumed node use it.
  deps = { ...deps, root: releaseRunUniverse({ root: deps.root }) };
  const statePath = join(deps.root!, 'graph-runs', 'release-loop', `${safeRunId(opts.runId)}.json`);
  let waiverCommit: string | undefined;
  const original = opts.waive !== undefined || opts.reason !== undefined || opts.acceptedRegressions !== undefined
    ? JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState : undefined;
  const waiver = original && (opts.waive !== undefined || opts.reason !== undefined)
    ? releaseResumeWaiver(original, opts) : undefined;
  const acceptedRegressions = original && opts.acceptedRegressions !== undefined && !waiver
    ? releaseResumeAcceptedRegressions(original, opts.acceptedRegressions, opts.from) : undefined;
  // A waived verdict may reuse its original commit. A moved tip still requires a full re-gate.
  if (waiver) {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    const versionRecord = saved.nodes.find((node) => node.nodeId === 'version-release');
    const output = lastJsonObject(versionRecord?.output);
    const version = output?.version;
    const recorded = output?.commit;
    if (typeof version !== 'string' || typeof recorded !== 'string' || !isReleaseVersion(version) || !/^[0-9a-f]{40}$/i.test(recorded)) throw new Error('release waiver requires a recorded release commit');
    const git = deps.git ?? gitRunner(deps.repo ?? process.cwd());
    const branch = `release/${version}`;
    const advertised = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0];
    if (advertised?.toLowerCase() !== recorded.toLowerCase()) throw new Error('release branch moved — re-gate the new tip before waiving a node');
    waiverCommit = recorded;
  }
  // Check the refreshed tip before refresh writes a new version-release record or backup.
  const tip = refreshReleaseBranchTip(opts.runId, deps, opts.from, waiverCommit);
  const partial = preparePartial(tip, opts, deps);
  // Resume the graph at the path it was started from (its snapshot is used); only tests inject another path.
  const graphPath = deps.graphPath ?? savedGraphPath(tip.statePath) ?? GRAPH;
  const state = await (deps.graph ?? runGraph)(graphPath, { resumeRunId: opts.runId, fromNodeId: opts.from, pinChildUniverse: true,
    ...(waiver ? { releaseWaiver: { ...waiver, requestedRegressions: opts.acceptedRegressions ?? [] } } : {}),
    ...(acceptedRegressions ? { releaseAcceptedRegressions: { requested: opts.acceptedRegressions!, acceptedRegressions } } : {}),
    deps: { root: deps.root, ...(deps.runBash ? { runBash: deps.runBash } : {}) } });
  return { tip, partial, state };
}
