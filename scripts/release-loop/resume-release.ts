// RELEASE-BRANCH (10-06): resume a failed release run after `release cut-branch --append --pick` moved release/<v>.
// The saved version-release output is re-pointed at the new branch tip (fast-forward only, state backed up first), so
// every later node reads the repaired commit without anyone hand-editing the run state.
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { lastJsonObject, runGraph, verifyReleaseCommandRoot, type GraphRunState } from '../../src/graph-runner/runner.js';
import { withOpSeatFlock } from '../../src/steward/resync-tick.js';
import { releaseRunUniverse } from './release-universe.js';
import { isReleaseVersion } from './release-version.js';
import { changedFilesBetween, clearPartialPlan, planPartialRegate, writePartialPlan } from './gate-partial.js';
import { gitClosureTree, testsReachingChanged, TRACEABLE_RELEASE_JSON, type ClosureTree } from './gate-closure.js';
import { releaseResumeAcceptedRegressions, releaseResumeGateExecutor, releaseResumeGatePodPool, releaseResumeWaiver, type AcceptedRegression } from './resume.js';
import { reserveReleaseResumeAttempt } from './resume-cap.js';

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
  /** GATE-REUSE-BY-DIFF: the tip tree for the import closure — default read from git objects of the tip commit. */
  closureTree?: (commit: string) => ClosureTree;
  /** Source observation before the first resumed node. */
  onSource?: (line: string) => void;
}

export interface ResumeReleaseOptions {
  runId: string; from: string; partial?: boolean; waive?: string; reason?: string;
  acceptedRegressions?: AcceptedRegression[]; gateExecutor?: string; gateHost?: string; gatePodPool?: string;
  commandRoot?: string;
}

export interface ResumeReleasePlan {
  runId: string; version: string; fromNode: string; commandRoot: string; tip: TipRefresh;
  partial: PartialOutcome; gatePlan: { mode: 'not-run' | 'partial' | 'full'; reason?: string };
  nextAttempt: number; attemptLimit: 2; preflight: 'passed';
}

/** CLI entry files: a production file that only names one (help text, a goal's command line) does not run it. */
const CLI_ENTRIES = ['bin/elanous.mjs', 'src/index.ts'] as const;
/** The gate's own test-file set (gate-node sweep: `git ls-files '*.test.*'` filtered by this). */
const GATE_TEST = /\.test\.(?:tsx?|jsx?|mts|cts)$/;

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
  return refreshReleaseBranchTipInternal(runId, deps, from, waiverCommit, false);
}

function refreshReleaseBranchTipInternal(runId: string, deps: ResumeReleaseDeps, from: string | undefined, waiverCommit: string | undefined, dryRun: boolean): TipRefresh {
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
  let to: string;
  if (dryRun) {
    // Use the advertised object id directly: a preflight must not create/update local remote-tracking refs.
    to = advertised;
  } else {
    git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    to = git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  }
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
  // The public export now consumes the cut before the gate. Old saved graphs still have export-check after gate,
  // so use the earliest consumer in this run's recorded path rather than assuming either graph version.
  const consumers = ['export-check', 'gate'].map((node) => state.path.indexOf(node)).filter((index) => index >= 0);
  const firstConsumer = consumers.length ? Math.min(...consumers) : -1;
  if (restartAt >= 0 && firstConsumer >= 0 && restartAt > firstConsumer) {
    throw new Error(`${branch} moved (${recorded.slice(0, 12)} → ${to.slice(0, 12)}): resume at ${state.path[firstConsumer]} or earlier — later nodes were built from the old tip`);
  }
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backup = `${statePath}.before-tip-${stamp}-${process.pid}-${to.slice(0, 12)}.bak`;
  if (dryRun) return { version, branch, from: recorded, to, changed: true, statePath };
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

/** GATE-PARTIAL outcome of a resume — applied (plan written) or the reason it fell back to a full gate. `auto` marks the
 *  default plan of `--from gate` (GATE-REUSE-BY-DIFF); `closure` is set when code changes were followed. */
export type PartialOutcome = { requested: false }
  | { requested: true; applied: true; files: number; priorCommit: string; auto?: true; closure?: { reached: number; opaque: number } }
  | { requested: true; applied: false; reason: string; auto?: true };

/** Build (or clear) the partial re-gate plan for the new tip. Fail-closed: any doubt leaves a full gate.
 *  GATE-REUSE-BY-DIFF: `--from gate` on a moved tip plans by default (`partial: undefined`); `partial: false` opts out. */
function preparePartial(tip: TipRefresh, opts: { from: string; partial?: boolean }, deps: ResumeReleaseDeps, dryRun = false): PartialOutcome {
  const root = deps.root ?? effectiveInstanceRoot();
  // Any resume starts from no plan: one without a partial plan (from whatever node) never inherits an older plan.
  if (!dryRun) clearPartialPlan(root, tip.version);
  const auto = opts.partial === undefined;
  // The current graph checks public export before gate. A moved tip must resume there, so its gate still needs
  // the diff plan; in older saved graphs export-check followed gate and cannot consume one.
  const saved = JSON.parse(readFileSync(tip.statePath, 'utf8')) as GraphRunState;
  const fromIndex = saved.path.indexOf(opts.from);
  const gateIndex = saved.path.indexOf('gate');
  const reachesGate = (opts.from === 'gate' || opts.from === 'export-check') && fromIndex >= 0 && gateIndex >= fromIndex;
  // The default applies only where it can help: a gate re-run on a tip that moved. An unchanged tip re-uses its own
  // shard results by commit already.
  if (opts.partial === false || (auto && (!reachesGate || !tip.changed))) return { requested: false };
  const fallback = (reason: string): PartialOutcome => {
    debug.log('release-loop.resume', 'partial-fallback', { version: tip.version, reason, auto });
    return { requested: true, applied: false, reason, ...(auto ? { auto: true as const } : {}) };
  };
  if (!reachesGate) return fallback('--partial requires a restart that reaches gate');
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
  // The tip tree (git objects of tip.to, never the working tree): existence of planned tests ⊕ the import closure.
  let tree: ClosureTree;
  try { tree = (deps.closureTree ?? ((commit: string) => gitClosureTree(deps.repo ?? process.cwd(), commit)))(tip.to); }
  catch (error) { return fallback(`tip tree unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`); }
  const tracked = new Set(tree.files);
  const tests = tree.files.filter((file) => GATE_TEST.test(file));
  if (changed.includes(TRACEABLE_RELEASE_JSON)) {
    // The one JSON exception is safe only while both the production reader and a test name this exact file at the tip.
    // A renamed, computed or unreadable reader returns to the full gate instead of trusting a stale dependency map.
    const reader = tree.read('scripts/release-loop/known-issues-node.ts');
    if (!reader || !/readFileSync\(join\(import\.meta\.dir,\s*['"]known-issues-0\.2\.33-approved\.json['"]\)/.test(reader)) {
      return fallback('known-issues JSON reader not statically verified — full gate');
    }
    const readerClosure = testsReachingChanged(tree, ['scripts/release-loop/known-issues-node.ts'], tests, { cliEntries: CLI_ENTRIES });
    if (!readerClosure.ok || readerClosure.reached === 0) return fallback('known-issues JSON production reader reaches no verified test — full gate');
    const jsonClosure = testsReachingChanged(tree, [TRACEABLE_RELEASE_JSON], tests, { cliEntries: CLI_ENTRIES });
    if (!jsonClosure.ok || jsonClosure.reached === 0) return fallback('known-issues JSON reaches no verified test — full gate');
  }
  const planned = planPartialRegate({ version: tip.version, priorCommit: tip.from, forCommit: tip.to, changedFiles: changed,
    priorFailures: prior.failures as string[], priorErrors: (prior.errors ?? []) as string[],
    existsAtTip: (file) => tracked.has(file),
    closure: (changedCode) => testsReachingChanged(tree, changedCode, tests, { cliEntries: CLI_ENTRIES }) });
  if (!planned.ok) return fallback(planned.reason);
  if (planned.plan.files.length >= tests.length) return fallback(`every test is re-run (${tests.length}) — full gate`);
  if (planned.plan.kind === 'carry') {
    // A cut-failures file can exist even when a later gate check errored. Reuse only a completed, clean verdict.
    const verdicts = [...new Set([deps.ledgerRoot ?? releaseLedgerRoot(), root])].map((location) => join(location, 'release', tip.version, 'gate-verdict.json'));
    let clean = false;
    for (const verdictPath of verdicts) {
      if (!existsSync(verdictPath)) continue;
      try {
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as { commit?: unknown; outcome?: unknown };
        if (verdict.commit === tip.from && verdict.outcome === 'ok') { clean = true; break; }
      } catch { return fallback(`unreadable prior gate verdict: ${verdictPath}`); }
    }
    if (!clean) return fallback(`no clean gate verdict for ${tip.from.slice(0, 12)} — full gate`);
  }
  const path = dryRun ? undefined : writePartialPlan(root, planned.plan);
  debug.log('release-loop.resume', 'partial-planned', { version: tip.version, priorCommit: tip.from, commit: tip.to, files: planned.plan.files.length,
    tests: tests.length, auto, ...(path ? { path } : {}), dryRun, ...(planned.closure ? { reached: planned.closure.reached, opaque: planned.closure.opaque } : {}) });
  return { requested: true, applied: true, files: planned.plan.files.length, priorCommit: tip.from,
    ...(auto ? { auto: true as const } : {}), ...(planned.closure ? { closure: planned.closure } : {}) };
}

/** The graph file the run started from — a snapshot run refuses any other path (the installed CLI's own copy differs). */
function savedGraphPath(statePath: string): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { graphPath?: unknown };
    return typeof saved.graphPath === 'string' && saved.graphPath ? saved.graphPath : undefined;
  } catch { return undefined; }
}

/** Refresh the branch tip, then restart the failed run at `from` with the saved graph snapshot. */
export async function resumeReleaseRun(opts: ResumeReleaseOptions, deps: ResumeReleaseDeps = {}): Promise<{ tip: TipRefresh; partial: PartialOutcome; state: GraphRunState }> {
  // The lock root is the OP seat's (opSeatLockRoot), never the injected ledger root: a different `deps.root` must not
  // move this run onto a separate lock inode from the steward resync and the unattended release.
  return withOpSeatFlock(() => resumeReleaseRunLocked(opts, deps));
}

/** Validate a resume without changing the saved run, attempt ledger, or partial-gate plan. */
export async function planResumeReleaseRun(opts: ResumeReleaseOptions, deps: ResumeReleaseDeps = {}): Promise<ResumeReleasePlan> {
  return withOpSeatFlock(() => planResumeReleaseRunLocked(opts, deps));
}

async function planResumeReleaseRunLocked(opts: ResumeReleaseOptions, deps: ResumeReleaseDeps): Promise<ResumeReleasePlan> {
  if (opts.from === 'version-release') throw new Error('--from version-release would cut again — resume at a later node');
  deps = { ...deps, root: releaseRunUniverse({ root: deps.root }) };
  const statePath = join(deps.root!, 'graph-runs', 'release-loop', `${safeRunId(opts.runId)}.json`);
  const savedRun = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
  if (savedRun.graphId !== 'release-loop' || savedRun.runId !== opts.runId) throw new Error(`run identity mismatch: ${statePath}`);
  if (opts.gateHost !== undefined && opts.gateExecutor === undefined) throw new Error('--gate-host requires --gate-executor host');
  const hasOverrides = opts.waive !== undefined || opts.reason !== undefined || opts.acceptedRegressions !== undefined
    || opts.gateExecutor !== undefined || opts.gatePodPool !== undefined;
  const original = hasOverrides ? savedRun : undefined;
  if (original && opts.gateExecutor !== undefined) releaseResumeGateExecutor(original, { from: opts.from, executor: opts.gateExecutor, host: opts.gateHost });
  if (original && opts.gatePodPool !== undefined) releaseResumeGatePodPool(original, { from: opts.from, pool: opts.gatePodPool });
  const waiver = original && (opts.waive !== undefined || opts.reason !== undefined) ? releaseResumeWaiver(original, opts) : undefined;
  if (original && opts.acceptedRegressions !== undefined && !waiver)
    releaseResumeAcceptedRegressions(original, opts.acceptedRegressions, opts.from);
  const attempt = reserveReleaseResumeAttempt(savedRun, deps.root!, { now: deps.now, checkOnly: true, noDecision: true });
  let waiverCommit: string | undefined;
  if (waiver) {
    const output = lastJsonObject(savedRun.nodes.find((node) => node.nodeId === 'version-release')?.output);
    const version = output?.version, recorded = output?.commit;
    if (typeof version !== 'string' || typeof recorded !== 'string' || !isReleaseVersion(version) || !/^[0-9a-f]{40}$/i.test(recorded)) throw new Error('release waiver requires a recorded release commit');
    const git = deps.git ?? gitRunner(deps.repo ?? process.cwd());
    const branch = `release/${version}`;
    const advertised = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0];
    if (advertised?.toLowerCase() !== recorded.toLowerCase()) throw new Error('release branch moved — re-gate the new tip before waiving a node');
    waiverCommit = recorded;
  }
  const tip = refreshReleaseBranchTipInternal(opts.runId, deps, opts.from, waiverCommit, true);
  const commandRoot = verifyReleaseCommandRoot(opts.commandRoot ?? process.cwd(), tip.to, deps.git);
  const partial = preparePartial(tip, opts, deps, true);
  const fromIndex = savedRun.path.indexOf(opts.from);
  const gateIndex = savedRun.path.indexOf('gate');
  const gateWillRun = fromIndex >= 0 && gateIndex >= fromIndex;
  const gatePlan = !gateWillRun ? { mode: 'not-run' as const }
    : partial.requested && partial.applied ? { mode: 'partial' as const }
      : { mode: 'full' as const, reason: partial.requested ? partial.reason : opts.partial === false ? 'partial recheck disabled' : 'no partial plan applies' };
  return { runId: opts.runId, version: tip.version, fromNode: opts.from, commandRoot, tip, partial,
    gatePlan, nextAttempt: attempt.attempt, attemptLimit: 2, preflight: 'passed' };
}

async function resumeReleaseRunLocked(opts: ResumeReleaseOptions, deps: ResumeReleaseDeps): Promise<{ tip: TipRefresh; partial: PartialOutcome; state: GraphRunState }> {
  if (opts.from === 'version-release') throw new Error('--from version-release would cut again — resume at a later node');
  // RELEASE-LEDGER-UNIVERSE: decide the universe once; the run lookup and every resumed node use it.
  deps = { ...deps, root: releaseRunUniverse({ root: deps.root }) };
  const statePath = join(deps.root!, 'graph-runs', 'release-loop', `${safeRunId(opts.runId)}.json`);
  const savedRun = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
  let waiverCommit: string | undefined;
  if (opts.gateHost !== undefined && opts.gateExecutor === undefined) throw new Error('--gate-host requires --gate-executor host');
  const original = opts.waive !== undefined || opts.reason !== undefined || opts.acceptedRegressions !== undefined || opts.gateExecutor !== undefined || opts.gatePodPool !== undefined
    ? savedRun : undefined;
  // GATE-HOST-EXECUTOR: checked before the tip refresh writes anything; the runner checks it again under the resume lock.
  const gateExecutor = original && opts.gateExecutor !== undefined
    ? releaseResumeGateExecutor(original, { from: opts.from, executor: opts.gateExecutor, host: opts.gateHost }) : undefined;
  const gatePodPool = original && opts.gatePodPool !== undefined
    ? releaseResumeGatePodPool(original, { from: opts.from, pool: opts.gatePodPool }) : undefined;
  if (gateExecutor) debug.log('release-loop.resume', 'gate-executor', { runId: opts.runId, from: opts.from, executor: gateExecutor.set.gateExecutor, host: gateExecutor.set.gateRemote ?? null, previous: gateExecutor.previous });
  if (gatePodPool) debug.log('release-loop.resume', 'gate-pod-pool', {
    runId: opts.runId, from: opts.from, pool: gatePodPool.set.gatePodPool, previous: gatePodPool.previous,
  });
  const waiver = original && (opts.waive !== undefined || opts.reason !== undefined)
    ? releaseResumeWaiver(original, opts) : undefined;
  if (waiver) debug.log('release-loop.resume', 'waiver', { runId: opts.runId, node: waiver.nodeId, reason: waiver.reason, unmeasured: waiver.unmeasured ?? null });
  const acceptedRegressions = original && opts.acceptedRegressions !== undefined && !waiver
    ? releaseResumeAcceptedRegressions(original, opts.acceptedRegressions, opts.from) : undefined;
  if (savedRun.graphId !== 'release-loop' || savedRun.runId !== opts.runId) throw new Error(`run identity mismatch: ${statePath}`);
  // Validate request arguments before the cap, then block the third attempt before tip refresh.
  reserveReleaseResumeAttempt(savedRun, deps.root!, { now: deps.now, checkOnly: true });
  // A waived verdict may reuse its original commit. A moved tip still requires a full re-gate.
  if (waiver) {
    const versionRecord = savedRun.nodes.find((node) => node.nodeId === 'version-release');
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
  const commandRoot = verifyReleaseCommandRoot(opts.commandRoot ?? process.cwd(), tip.to, deps.git);
  const partial = preparePartial(tip, opts, deps);
  // A failed preflight does not consume one of the two release resume attempts.
  const attempt = reserveReleaseResumeAttempt(savedRun, deps.root!, { now: deps.now });
  debug.log('release-loop.resume', 'attempt', { runId: opts.runId, attempt: attempt.attempt, limit: 2, ledger: attempt.path });
  // Resume the graph at the path it was started from (its snapshot is used); only tests inject another path.
  const graphPath = deps.graphPath ?? savedGraphPath(tip.statePath) ?? GRAPH;
  const savedSource = JSON.parse(readFileSync(tip.statePath, 'utf8')) as GraphRunState;
  deps.onSource?.(`레시피 출처: graph=${graphPath} · graph sha=${savedSource.graphSnapshot?.graphSha?.slice(0, 12) ?? 'legacy'} · recipes sha=${savedSource.graphSnapshot?.recipesSha?.slice(0, 12) ?? 'legacy'} · command-root=${commandRoot} · 컷 tip=${tip.to.slice(0, 12)}`);
  const state = await (deps.graph ?? runGraph)(graphPath, { resumeRunId: opts.runId, fromNodeId: opts.from, pinChildUniverse: true,
    releaseCommandSource: { root: commandRoot, cutTip: tip.to, ...(deps.git ? { git: deps.git } : {}) },
    ...(waiver ? { releaseWaiver: { ...waiver, requestedRegressions: opts.acceptedRegressions ?? [] } } : {}),
    ...(acceptedRegressions ? { releaseAcceptedRegressions: { requested: opts.acceptedRegressions!, acceptedRegressions } } : {}),
    ...(gateExecutor ? { releaseGateExecutor: { executor: gateExecutor.set.gateExecutor, ...(opts.gateHost !== undefined ? { host: opts.gateHost } : {}) } } : {}),
    ...(gatePodPool ? { releaseGatePodPool: gatePodPool.set.gatePodPool } : {}),
    deps: { root: deps.root, ...(deps.runBash ? { runBash: deps.runBash } : {}) } });
  return { tip, partial, state };
}
