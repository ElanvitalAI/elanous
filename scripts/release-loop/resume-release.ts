// RELEASE-BRANCH (10-06): resume a failed release run after `release cut-branch --append --pick` moved release/<v>.
// The saved version-release output is re-pointed at the new branch tip (fast-forward only, state backed up first), so
// every later node reads the repaired commit without anyone hand-editing the run state.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { acquireLockAsync } from '../../src/storage/file-lock.js';
import { lastJsonObject, runGraph, verifyReleaseCommandRoot, verifyReleaseRecipeSnapshot, type GraphRunState } from '../../src/graph-runner/runner.js';
import { withOpSeatFlock } from '../../src/steward/resync-tick.js';
import { releaseRunUniverse } from './release-universe.js';
import { isReleaseVersion } from './release-version.js';
import { changedFilesBetween, clearPartialPlan, collectExecutedPodShardImages, planPartialRegate, planSameCommitRecheck, planStalledShardRecheck, testFileOfId, writePartialPlan, writeRecheckPlan } from './gate-partial.js';
import { gateAssignableTestsAtCommit, gateEnvFingerprint } from './gate-baseline-receipt.js';
import { readGateShardManifest, readGateShardResult } from './gate-shard-receipts.js';
import { gitClosureTree, testsReachingChanged, TRACEABLE_RELEASE_JSON, type ClosureTree } from './gate-closure.js';
import { assertReleaseResumeApprovalBoundary, releaseResumeAcceptedRegressions, releaseResumeGateExecutor, releaseResumeGatePodPool, releaseResumeGateShardReroute, releaseResumeWaiver, type AcceptedRegression } from './resume.js';
import { reserveReleaseResumeAttempt } from './resume-cap.js';
import { cutReleaseBranch } from './cut-branch.js';
import { releaseLoopConfig } from './unattended-release.js';
import { trafficOptionsFromConfig } from './traffic-transition.js';
import type { GateAutohealDecision } from './gate-autoheal.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');

/** Compare existing artifact paths by filesystem identity so macOS /var and /private/var aliases agree. */
function sameRealPath(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try { return realpathSync(left) === realpathSync(right); }
  catch { return false; }
}

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
  /** Test seam for the pinned Pod gate selection; production reads the selected test universe at the cut commit. */
  gateTestsAtCommit?: (commit: string) => string[] | null;
  /** Source observation before the first resumed node. */
  onSource?: (line: string) => void;
  /** Test seam; production resolves this from ELANOUS_RELEASE_TRAFFIC_FILE / release.loop.trafficFile. */
  trafficFile?: string;
}

export interface ResumeReleaseOptions {
  runId: string; from: string; partial?: boolean; waive?: string; reason?: string;
  acceptedRegressions?: AcceptedRegression[]; gateExecutor?: string; gateHost?: string; gatePodPool?: string;
  rerouteShard?: string; shardHost?: string; shardOs?: 'darwin' | 'linux';
  commandRoot?: string;
}

export interface ResumeReleasePlan {
  runId: string; version: string; fromNode: string; commandRoot: string; tip: TipRefresh;
  partial: PartialOutcome; gatePlan: { mode: 'not-run' | 'partial' | 'full'; reason?: string };
  /** Most recent failed gate's autoheal recommendation, carried into the resume plan for the caller. */
  autoheal?: GateAutohealDecision;
  autohealReroute?: string;
  nextAttempt: number; priorCountKnown: boolean; preflight: 'passed';
}

function priorGateAutoheal(run: GraphRunState): GateAutohealDecision | undefined {
  const gate = lastJsonObject(run.nodes.find((node) => node.nodeId === 'gate')?.output);
  const value = gate?.autoheal;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GateAutohealDecision>;
  if (!['reroute-shard', 'retry-shard', 'partial-resume', 'host-switch', 'hitl'].includes(String(candidate.action))) return undefined;
  if (!['shard-pod-death', 'timeout', 'host-down', 'interference', 'true-regression', 'environment'].includes(String(candidate.cause))) return undefined;
  if (typeof candidate.signature !== 'string' || typeof candidate.reason !== 'string'
    || typeof candidate.shardElapsedMs !== 'number' || typeof candidate.overallElapsedMs !== 'number') return undefined;
  return candidate as GateAutohealDecision;
}

function automaticReroute(run: GraphRunState, autoheal: GateAutohealDecision | undefined, tipChanged: boolean, from: string): string | undefined {
  if (!autoheal || tipChanged || from !== 'gate' || typeof (run.input as Record<string, unknown> | undefined)?.gatePodPool !== 'string'
    || (autoheal.action !== 'retry-shard' && autoheal.action !== 'reroute-shard' && autoheal.action !== 'host-switch')) return undefined;
  const key = autoheal.shardKey;
  if (autoheal?.action === 'host-switch') return 'auto';
  if (typeof key === 'string' && /^pod-\d+$/.test(key)) return key;
  if (typeof key === 'string' && /^\d+$/.test(key)) return `pod-${key}`;
  const gate = lastJsonObject(run.nodes.find((node) => node.nodeId === 'gate')?.output);
  const stalled = gate?.stalledShards;
  return Array.isArray(stalled) && stalled.length > 0 ? 'auto' : undefined;
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

/** Lower-level maintenance primitive; the resume entrypoints run verifyResumePreflight before calling it. */
export function refreshReleaseBranchTip(runId: string, deps: ResumeReleaseDeps = {}, from?: string, waiverCommit?: string): TipRefresh {
  return refreshReleaseBranchTipInternal(runId, deps, from, waiverCommit, false);
}

function refreshReleaseBranchTipInternal(runId: string, deps: ResumeReleaseDeps, from: string | undefined, waiverCommit: string | undefined, dryRun: boolean, expectedTip?: string): TipRefresh {
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
  if (expectedTip && advertised.toLowerCase() !== expectedTip.toLowerCase()) throw new Error(`${branch} moved during pin preflight (${expectedTip} → ${advertised}) — retry resume`);
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
    throw new Error(`${branch} tip ${to} does not descend from the recorded release commit ${recorded} — refusing to resume; remedy: inspect both commits and create a new release run from the intended pinned tip`);
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

/** Check the saved graph and recipes before fetch, backup, or run-ledger writes. */
function verifyResumeRecipePin(commandRoot: string, snapshot: GraphRunState['graphSnapshot'], version: string): void {
  try { verifyReleaseRecipeSnapshot(commandRoot, snapshot); }
  catch (error) {
    if (!snapshot) throw error;
    const mismatches: string[] = [];
    for (const [name, savedSha] of [
      ['release-loop.yaml', snapshot.graphSha], ['recipes.yaml', snapshot.recipesSha],
    ] as const) {
      const file = join(commandRoot, 'graphs', 'release', name);
      let currentSha: string;
      try { currentSha = createHash('sha256').update(readFileSync(file)).digest('hex'); }
      catch { continue; }
      if (currentSha !== savedSha) mismatches.push(`${file} saved=${savedSha} current=${currentSha}`);
    }
    if (!mismatches.length) throw error;
    throw new Error(`release recipe source differs from saved pin: ${mismatches.join('; ')}\nremedy: start a new pinned run with eln release run --version ${version}`, { cause: error });
  }
}

/** Common read-only gate for dry-run and actual resume. Every rejection includes an operator action. */
function verifyResumePreflight(run: GraphRunState, opts: ResumeReleaseOptions, deps: ResumeReleaseDeps,
  version: string, recordedCommit: string, currentTip: string, commandRoot: string): void {
  let trafficFile = deps.trafficFile;
  if (trafficFile === undefined) {
    try { trafficFile = trafficOptionsFromConfig(process.env, releaseLoopConfig()).trafficFile; }
    catch (error) { throw new Error(`cannot read release traffic configuration — remedy: repair release.loop.trafficFile in the active config before resuming`, { cause: error }); }
  }
  if (!trafficFile) throw new Error('release.loop.trafficFile is not configured — remedy: set release.loop.trafficFile or ELANOUS_RELEASE_TRAFFIC_FILE before resuming');
  let fd: number | undefined;
  try {
    const path = resolve(trafficFile);
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o222) === 0) throw new Error('not a writable regular file');
    fd = openSync(path, constants.O_WRONLY);
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new Error(`release traffic file is missing or not writable: ${trafficFile} (${error instanceof Error ? error.message : String(error)}) — remedy: create a regular writable traffic file and set release.loop.trafficFile`, { cause: error });
  } finally { if (fd !== undefined) closeSync(fd); }

  for (const path of [join(commandRoot, 'node_modules'), join(commandRoot, 'apps', 'pwa', 'node_modules')]) {
    try { if (!statSync(path).isDirectory()) throw new Error('not a directory'); }
    catch (error) { throw new Error(`release resume dependencies missing: ${path} — remedy: run bun install --frozen-lockfile at repository root and apps/pwa`, { cause: error }); }
  }

  const nodeOutput = (nodeId: string): Record<string, unknown> | undefined => {
    const node = run.nodes.find((entry) => entry.nodeId === nodeId);
    if (!node?.ok || typeof node.output !== 'string') return undefined;
    try { return lastJsonObject(node.output) as Record<string, unknown> | undefined; } catch { return undefined; }
  };
  const recordedNodeOutput = (nodeId: string): Record<string, unknown> | undefined => {
    const node = run.nodes.find((entry) => entry.nodeId === nodeId);
    if (typeof node?.output !== 'string') return undefined;
    try { return lastJsonObject(node.output) as Record<string, unknown> | undefined; } catch { return undefined; }
  };
  const roots = [...new Set([deps.root ?? effectiveInstanceRoot(), deps.ledgerRoot ?? releaseLedgerRoot()])];
  for (const root of roots) {
    const prepared = join(root, 'release', version, 'prepared');
    if (existsSync(prepared)) {
      const record = nodeOutput('prepare');
      const output = record && typeof record.out === 'string' ? record : undefined;
      const manifestPath = join(prepared, 'release.json');
      let manifest: { version?: unknown; sourceCommit?: unknown } | undefined;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest; } catch { /* fail closed below */ }
      const ownerPath = join(prepared, '.release-node-owner.json');
      let owner: { runId?: unknown; commit?: unknown } | undefined;
      let ownerReadable = !existsSync(ownerPath);
      try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as typeof owner; ownerReadable = true; } catch { /* old artifacts can be owned by the run ledger */ }
      const ledgerOwns = output !== undefined && sameRealPath(output.out, prepared)
        && output.commit === currentTip && output.outcome === 'ok';
      const receiptOwns = owner ? owner.runId === opts.runId && owner.commit === currentTip : ownerReadable && ledgerOwns;
      if (!ledgerOwns || manifest?.version !== version || manifest.sourceCommit !== currentTip || !receiptOwns) {
        throw new Error(`prepared artifact is outside the current release run ledger: ${prepared} — remedy: preserve it, compare release.json and .release-node-owner.json with run ${opts.runId}, then resolve ownership before resume`);
      }
    }

    const receiptPath = join(root, 'release', version, 'docs-branch-owner.json');
    const docsBranch = `release-docs/${version}`;
    let receipt: { owner?: { runId?: unknown; attempt?: unknown }; branch?: unknown; worktree?: unknown; outcome?: unknown; head?: unknown } | undefined;
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as typeof receipt; } catch { /* no/invalid receipt is rejected if an artifact exists */ }
    const docsRecord = recordedNodeOutput('docs');
    const worktree = typeof docsRecord?.worktree === 'string' ? docsRecord.worktree : undefined;
    let localBranch: string | undefined;
    try { localBranch = (deps.git ?? gitRunner(deps.repo ?? process.cwd()))(['show-ref', '--verify', '--hash', `refs/heads/${docsBranch}`]).trim(); } catch { /* absent */ }
    let docsWorktrees: string[] = [];
    try {
      const listing = (deps.git ?? gitRunner(deps.repo ?? process.cwd()))(['worktree', 'list', '--porcelain']);
      docsWorktrees = listing.split(/\n\n+/).filter(Boolean).flatMap((entry) => {
        const branch = /^branch (.+)$/m.exec(entry)?.[1];
        const path = /^worktree (.+)$/m.exec(entry)?.[1];
        return branch === `refs/heads/${docsBranch}` && path ? [path] : [];
      });
    } catch (error) {
      throw new Error(`cannot inspect release worktrees for ${docsBranch} — remedy: restore read-only git access and retry resume`, { cause: error });
    }
    let remoteHead: string | undefined;
    try {
      const response = (deps.git ?? gitRunner(deps.repo ?? process.cwd()))(['ls-remote', '--heads', 'origin', `refs/heads/${docsBranch}`]);
      const line = response.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(`refs/heads/${docsBranch}`));
      remoteHead = line?.trim().split(/\s+/)[0];
    } catch (error) {
      throw new Error(`cannot inspect docs branch ${docsBranch} — remedy: restore read-only git access and retry resume`, { cause: error });
    }
    const hasDocsArtifact = existsSync(receiptPath) || !!localBranch || !!remoteHead || docsWorktrees.length > 0;
    const outputOwner = docsRecord?.artifactOwner as { runId?: unknown; attempt?: unknown } | undefined;
    const receiptMatches = receipt?.branch === docsBranch && receipt.owner?.runId === opts.runId
      && receipt.owner.attempt === outputOwner?.attempt && outputOwner?.runId === opts.runId
      && typeof receipt.worktree === 'string' && sameRealPath(worktree, receipt.worktree)
      && docsWorktrees.some((listedWorktree) => sameRealPath(listedWorktree, receipt.worktree));
    if (hasDocsArtifact && !receiptMatches) {
      throw new Error(`docs branch/worktree is outside the current release run ledger: ${docsBranch} — remedy: compare ${receiptPath} with the saved docs node output and resolve ownership before resume`);
    }
    if (receipt?.outcome === 'pushed' && (!/^[0-9a-f]{40}$/i.test(String(receipt.head ?? ''))
      || remoteHead?.toLowerCase() !== String(receipt.head).toLowerCase())) {
      throw new Error(`docs branch tip differs from the saved ownership receipt: ${docsBranch} — remedy: preserve the branch and worktree, compare the remote tip with ${receiptPath} and the saved docs node output, then resolve ownership before resume`);
    }
  }

  const recorded = nodeOutput('version-release');
  if (recorded?.branch !== `release/${version}` || recorded.commit !== recordedCommit || !/^[0-9a-f]{40}$/i.test(currentTip)) {
    throw new Error(`release branch tip does not match the saved version-release ledger for ${version} — remedy: inspect the branch and saved run ${opts.runId}, then resume from a node before gate only after resolving the mismatch`);
  }
}

/** GATE-PARTIAL outcome of a resume — applied (with its exact remeasure selection) or the reason it fell back to a full gate.
 *  `auto` marks the default plan of `--from gate` (GATE-REUSE-BY-DIFF); `closure` is set when code changes were followed. */
export type PartialOutcome = { requested: false }
  | { requested: true; applied: true; files: number; plannedFiles: string[]; priorCommit: string; auto?: true; closure?: { reached: number; opaque: number } }
  | { requested: true; applied: false; reason: string; auto?: true };

/** Build (or clear) the partial re-gate plan for the new tip. Fail-closed: any doubt leaves a full gate.
 *  GATE-REUSE-BY-DIFF: `--from gate` on a moved tip plans by default (`partial: undefined`); `partial: false` opts out. */
type StalledGateEvidence = {
  stalledShards: Array<{ shard: number; files: string[]; reason: string }>;
  partialSummary: { pass: number; fail: number; errors: number; ran: number; files: number };
  partialFailures: { failures: string[]; errors: string[] };
  preservedShardCount: number;
};

/** Recover an interrupted Pod sweep from its atomic shard receipts. No receipt or identity doubt authorizes a partial gate. */
function stalledGateEvidence(input: { version: string; commit: string; repo: string; roots: string[];
  gateOutput?: Record<string, unknown>; expectedBase40?: string; expectedTests?: (commit: string) => string[] | null }):
  { ok: true; evidence: StalledGateEvidence } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (input.gateOutput && (input.gateOutput.outcome !== 'error' || input.gateOutput.commit !== input.commit))
    return fail('saved gate result is not an error for the recorded cut');
  if (!/^[a-f0-9]{40}$/i.test(input.expectedBase40 ?? ''))
    return fail('saved cutoff baseline is absent or invalid');
  const fingerprint = gateEnvFingerprint(process.env);
  let receiptDir: string | undefined;
  for (const root of input.roots) {
    const candidate = join(root, 'release', input.version, 'gate-logs', 'cut', 'receipts');
    if (existsSync(candidate)) { receiptDir = candidate; break; }
  }
  if (!receiptDir) return fail('stalled gate receipts are absent');
  const names = readdirSync(receiptDir).filter((name) => /^pod-\d+\.receipt\.json$/.test(name)).sort((a, b) =>
    Number(/^pod-(\d+)/.exec(a)![1]) - Number(/^pod-(\d+)/.exec(b)![1]));
  if (!names.length || names.some((name, index) => Number(/^pod-(\d+)/.exec(name)![1]) !== index))
    return fail('stalled gate receipt shard set is incomplete');
  const allFiles: string[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  const stalledShards: StalledGateEvidence['stalledShards'] = [];
  const imageDigests = new Set<string>();
  let pass = 0, failCount = 0, errorCount = 0, ran = 0, files = 0, preservedShardCount = 0;
  let base40: string | undefined;
  for (const name of names) {
    const id = name.slice(0, -'.receipt.json'.length);
    const receipt = readGateShardManifest(receiptDir, id);
    if (!receipt || receipt.head40 !== input.commit || !/^[a-f0-9]{40}$/i.test(receipt.base40)
      || !receipt.files.length
      || receipt.files.some((file) => typeof file !== 'string'
        || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file) || file.split('/').includes('..'))
      || typeof receipt.envKey !== 'string' || typeof receipt.host !== 'string')
      return fail(`stalled gate receipt identity or file list is invalid: ${id}`);
    if (receipt.base40 !== input.expectedBase40)
      return fail(`stalled gate receipt baseline differs from saved cutoff baseline: ${id}`);
    if (base40 && receipt.base40 !== base40) return fail(`stalled gate receipts disagree on baseline: ${id}`);
    base40 = receipt.base40;
    allFiles.push(...receipt.files);
    if (receipt.status === 'unmeasured') {
      stalledShards.push({ shard: Number(id.slice(4)), files: [...receipt.files], reason: 'incomplete' });
      continue;
    }
    if (!receipt.envKey.startsWith(`${fingerprint}:`)) return fail(`stalled gate receipt environment mismatch: ${id}`);
    const imageDigest = receipt.envKey.slice(fingerprint.length + 1);
    if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) return fail(`stalled gate receipt image identity is missing: ${id}`);
    imageDigests.add(imageDigest.toLowerCase());
    const result = readGateShardResult(receiptDir, { shard: { id, files: receipt.files }, head40: input.commit,
      base40: receipt.base40, envKey: receipt.envKey });
    if (!result) return fail(`stalled gate receipt payload is incomplete or corrupt: ${id}`);
    const totals = result.runs.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    if (!Object.values(totals).every(Number.isSafeInteger) || receipt.failureIds.length !== totals.fail
      || receipt.errorIds.length !== totals.errors)
      return fail(`stalled gate receipt counts do not reconcile: ${id}`);
    pass += totals.pass; failCount += totals.fail; errorCount += totals.errors; ran += totals.ran; files += totals.files;
    failures.push(...receipt.failureIds); errors.push(...receipt.errorIds); preservedShardCount++;
  }
  if (!stalledShards.length) return fail('no incomplete shard receipt identifies the interrupted work');
  if (new Set(allFiles).size !== allFiles.length) return fail('stalled gate receipt file assignments overlap');
  if (imageDigests.size !== 1) return fail('stalled gate completed shards do not share one executed image');
  const expected = (input.expectedTests ?? ((commit) => gateAssignableTestsAtCommit(input.repo, commit)))(input.commit);
  if (!expected || JSON.stringify([...expected].sort()) !== JSON.stringify([...allFiles].sort()))
    return fail('stalled gate receipts do not cover the pinned test selection');
  const partialSummary = { pass, fail: failCount, errors: errorCount, ran, files };
  const partialFailures = { failures: [...new Set(failures)].sort(), errors: [...new Set(errors)].sort() };
  const gate = input.gateOutput;
  if (gate) {
    const savedSummary = gate.partialSummary as Partial<StalledGateEvidence['partialSummary']> | undefined;
    const savedFailures = gate.partialFailures as Partial<StalledGateEvidence['partialFailures']> | undefined;
    if (savedSummary && JSON.stringify(savedSummary) !== JSON.stringify(partialSummary))
      return fail('saved gate summary disagrees with shard receipts');
    if (savedFailures && (JSON.stringify([...((savedFailures.failures as string[] | undefined) ?? [])].sort()) !== JSON.stringify(partialFailures.failures)
      || JSON.stringify([...((savedFailures.errors as string[] | undefined) ?? [])].sort()) !== JSON.stringify(partialFailures.errors)))
      return fail('saved gate failures disagree with shard receipts');
    if (gate.preservedShardCount !== undefined && gate.preservedShardCount !== preservedShardCount)
      return fail('saved preserved shard count disagrees with shard receipts');
    if (Array.isArray(gate.stalledShards)) {
      const savedStalled = gate.stalledShards.flatMap((item) => item && typeof item === 'object'
        && Array.isArray((item as { files?: unknown }).files) ? (item as { files: string[] }).files : []).sort();
      if (JSON.stringify(savedStalled) !== JSON.stringify(stalledShards.flatMap((item) => item.files).sort()))
        return fail('saved stalled shard list disagrees with shard receipts');
    }
  }
  return { ok: true, evidence: { stalledShards, partialSummary, partialFailures, preservedShardCount } };
}

function preparePartial(tip: TipRefresh, opts: { from: string; partial?: boolean; gateExecutor?: string }, deps: ResumeReleaseDeps, dryRun = false): PartialOutcome {
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
  if (opts.partial === false || (auto && (!reachesGate || (!tip.changed && opts.from !== 'gate')))) return { requested: false };
  const fallback = (reason: string): PartialOutcome => {
    debug.log('release-loop.resume', 'partial-fallback', { version: tip.version, reason, auto,
      planKind: 'full', remeasureFileCount: 0, preservedShardCount: 0, fallbackReason: reason });
    return { requested: true, applied: false, reason, ...(auto ? { auto: true as const } : {}) };
  };
  if (!reachesGate) return fallback('--partial requires a restart that reaches gate');
  if (!tip.changed) {
    if (opts.from !== 'gate') return fallback('same-commit stalled-shard recheck requires --from gate');
    const saved = JSON.parse(readFileSync(tip.statePath, 'utf8')) as GraphRunState;
    const gateRecord = saved.nodes.find((node) => node.nodeId === 'gate');
    const previousGate = gateRecord ? lastJsonObject(gateRecord.output) as Record<string, unknown> | undefined : undefined;
    // `loadFlaky` is also a partial-resume cause, but it is emitted separately from
    // shard-only interference. Carry both sets into the same affected-file recheck.
    const interference = [...new Set([
      ...(Array.isArray(previousGate?.interferenceErrors) ? previousGate.interferenceErrors : []),
      ...(Array.isArray(previousGate?.loadFlaky) ? previousGate.loadFlaky : []),
    ])];
    if (previousGate?.outcome === 'error' && previousGate.commit === tip.to && previousGate.autoheal
      && typeof previousGate.autoheal === 'object' && (previousGate.autoheal as { action?: unknown }).action === 'partial-resume') {
      if (!Array.isArray(interference) || !interference.length || !interference.every((id) => typeof id === 'string'))
        return fallback('partial-resume has no complete interference error record');
      let closure: ClosureTree;
      try { closure = (deps.closureTree ?? ((commit: string) => gitClosureTree(deps.repo ?? process.cwd(), commit)))(tip.to); }
      catch (error) { return fallback(`tip tree unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`); }
      const tracked = new Set(closure.files);
      const planned = planSameCommitRecheck({ version: tip.version, measuredCommit: tip.to, forCommit: tip.to,
        failures: [], errors: interference as string[], existsAtCommit: (file) => tracked.has(file) });
      if (!planned.ok) return fallback(planned.reason);
      // The gate consumer only executes same-cut partial work for the stalled-only recheck shape.
      // Interference files are likewise unmeasured, so mark exactly this set as the recheck boundary.
      const partialFailures = previousGate.partialFailures as { failures?: unknown; errors?: unknown } | undefined;
      if (!Array.isArray(partialFailures?.failures) || !partialFailures.failures.every((id) => typeof id === 'string')
        || !Array.isArray(partialFailures.errors) || !partialFailures.errors.every((id) => typeof id === 'string'))
        return fallback('partial-resume has no complete prior failure record');
      let priorFailures: string[];
      let priorErrors: string[];
      try {
        const affected = new Set(planned.plan.files);
        priorFailures = (partialFailures.failures as string[]).filter((id) => !affected.has(testFileOfId(id)));
        priorErrors = (partialFailures.errors as string[]).filter((id) => !affected.has(testFileOfId(id)));
      } catch { return fallback('partial-resume prior failure record is malformed'); }
      const recheckPlan = { ...planned.plan, priorFailures, priorErrors, stalledFiles: planned.plan.files };
      const path = dryRun ? undefined : writeRecheckPlan(root, recheckPlan);
      debug.log('release-loop.resume', 'interference-recheck-planned', { version: tip.version, commit: tip.to,
        remeasureFileCount: recheckPlan.files.length, fallbackReason: null, ...(path ? { path } : {}), dryRun });
      return { requested: true, applied: true, files: recheckPlan.files.length, priorCommit: tip.to, ...(auto ? { auto: true as const } : {}) };
    }
    const stalled = previousGate?.stalledShards;
    const summary = previousGate?.partialSummary as { pass?: unknown; fail?: unknown; errors?: unknown; ran?: unknown; files?: unknown } | undefined;
    const measured = previousGate?.partialFailures as { failures?: unknown; errors?: unknown } | undefined;
    if (previousGate?.outcome !== 'error' || previousGate.commit !== tip.to || !Array.isArray(stalled) || !stalled.length || !summary || !measured
      || !['pass', 'fail', 'errors', 'ran', 'files'].every((key) => Number.isSafeInteger(summary[key as keyof typeof summary]) && Number(summary[key as keyof typeof summary]) >= 0)
      || !Array.isArray(measured.failures) || !measured.failures.every((id) => typeof id === 'string')
      || !Array.isArray(measured.errors) || !measured.errors.every((id) => typeof id === 'string')
      || measured.failures.length !== Number(summary.fail) || measured.errors.length !== Number(summary.errors))
      return fallback('same-commit gate has no complete stalled-shard measurement record');
    const stalledFiles: string[] = [];
    for (const item of stalled) {
      if (!item || typeof item !== 'object' || !Array.isArray((item as { files?: unknown }).files)
        || !(item as { files: unknown[] }).files.every((file) => typeof file === 'string')
        || !['incomplete', 'no-output', 'job-failed', 'exit-code', 'unattributed', 'timeout', 'admission-timeout', 'admission-error'].includes(String((item as { reason?: unknown }).reason)))
        return fallback('stalled-shard record is malformed');
      stalledFiles.push(...(item as { files: string[] }).files);
    }
    const closure = (deps.closureTree ?? ((commit: string) => gitClosureTree(deps.repo ?? process.cwd(), commit)))(tip.to);
    const tracked = new Set(closure.files);
    const preservedShardCount = Number.isSafeInteger(previousGate?.preservedShardCount)
      && Number(previousGate?.preservedShardCount) >= 0 ? Number(previousGate?.preservedShardCount) : undefined;
    const planned = planStalledShardRecheck({ version: tip.version, measuredCommit: tip.to, forCommit: tip.to,
      failures: measured.failures as string[], errors: measured.errors as string[], stalledFiles,
      ...(preservedShardCount === undefined ? {} : { preservedShardCount }),
      existsAtCommit: (file) => tracked.has(file) });
    if (!planned.ok) return fallback(planned.reason);
    const path = writeRecheckPlan(root, planned.plan);
    debug.log('release-loop.resume', 'stalled-recheck-planned', { version: tip.version, commit: tip.to,
      planKind: planned.plan.kind, remeasureFileCount: planned.plan.files.length,
      preservedShardCount: planned.plan.preservedShardCount ?? 0, fallbackReason: null, path });
    return { requested: true, applied: true, files: planned.plan.files.length, plannedFiles: [...planned.plan.files], priorCommit: tip.to,
      ...(auto ? { auto: true as const } : {}) };
  }
  let prior: { commit?: unknown; failures?: unknown; errors?: unknown } | undefined;
  let movedStalledEvidence: StalledGateEvidence | undefined;
  for (const location of [...new Set([deps.ledgerRoot ?? releaseLedgerRoot(), root])]) {
    const path = join(location, 'release', tip.version, 'gate-failures.json');
    if (!existsSync(path)) continue;
    let record: typeof prior;
    try { record = JSON.parse(readFileSync(path, 'utf8')) as typeof prior; }
    catch { return fallback(`unreadable gate record: ${path}`); }
    if (record?.commit === tip.from) { prior = record; break; }
  }
  if (!prior || !Array.isArray(prior.failures) || !(prior.errors === undefined || Array.isArray(prior.errors))) {
    const gateRecord = saved.nodes.find((node) => node.nodeId === 'gate');
    const gateOutput = gateRecord ? lastJsonObject(gateRecord.output) as Record<string, unknown> | undefined : undefined;
    const cutoffRecord = saved.nodes.find((node) => node.nodeId === 'cutoff');
    const cutoffOutput = cutoffRecord ? lastJsonObject(cutoffRecord.output) as Record<string, unknown> | undefined : undefined;
    const expectedBase40 = (cutoffOutput?.baseline as { sha?: unknown } | undefined)?.sha;
    const evidence = stalledGateEvidence({ version: tip.version, commit: tip.from, repo: deps.repo ?? process.cwd(),
      roots: [...new Set([deps.ledgerRoot ?? releaseLedgerRoot(), root])], gateOutput,
      ...(typeof expectedBase40 === 'string' ? { expectedBase40 } : {}),
      expectedTests: deps.gateTestsAtCommit });
    if (!evidence.ok) return fallback(`no complete gate record for ${tip.from.slice(0, 12)}; ${evidence.reason}`);
    movedStalledEvidence = evidence.evidence;
    prior = { commit: tip.from, failures: movedStalledEvidence.partialFailures.failures,
      errors: movedStalledEvidence.partialFailures.errors };
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
  const priorCutLogs = [...new Set([deps.ledgerRoot ?? releaseLedgerRoot(), root])]
    .map((location) => join(location, 'release', tip.version, 'gate-logs', 'cut'))
    .find((dir) => existsSync(dir));
  const savedInput = saved.input as { gateExecutor?: unknown; gatePodPool?: unknown };
  const podGate = (opts.gateExecutor ?? savedInput.gateExecutor ?? (savedInput.gatePodPool ? 'pod' : undefined)) === 'pod';
  const priorShards = priorCutLogs ? collectExecutedPodShardImages(priorCutLogs, tip.from) : undefined;
  const stalledFiles = movedStalledEvidence?.stalledShards.flatMap((shard) => shard.files) ?? [];
  const planned = planPartialRegate({ version: tip.version, priorCommit: tip.from, forCommit: tip.to, changedFiles: [...changed, ...stalledFiles],
    priorFailures: prior.failures as string[], priorErrors: (prior.errors ?? []) as string[],
    existsAtTip: (file) => tracked.has(file),
    ...((podGate || movedStalledEvidence) ? { priorShards: priorShards ?? [] } : {}),
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
  return { requested: true, applied: true, files: planned.plan.files.length, plannedFiles: [...planned.plan.files], priorCommit: tip.from,
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
  assertReleaseResumeApprovalBoundary({ ...savedRun, statePath }, opts.from);
  if (opts.gateHost !== undefined && opts.gateExecutor === undefined) throw new Error('--gate-host requires --gate-executor host');
  if ((opts.shardHost !== undefined || opts.shardOs !== undefined) && opts.rerouteShard === undefined)
    throw new Error('--shard-host/--shard-os require --reroute-shard');
  const hasOverrides = opts.waive !== undefined || opts.reason !== undefined || opts.acceptedRegressions !== undefined
    || opts.gateExecutor !== undefined || opts.gatePodPool !== undefined || opts.rerouteShard !== undefined;
  const original = hasOverrides ? savedRun : undefined;
  if (original && opts.gateExecutor !== undefined) releaseResumeGateExecutor(original, { from: opts.from, executor: opts.gateExecutor, host: opts.gateHost });
  if (original && opts.gatePodPool !== undefined) releaseResumeGatePodPool(original, { from: opts.from, pool: opts.gatePodPool });
  if (original && opts.rerouteShard !== undefined) releaseResumeGateShardReroute(original, { from: opts.from, shard: opts.rerouteShard, host: opts.shardHost, os: opts.shardOs });
  const waiver = original && (opts.waive !== undefined || opts.reason !== undefined) ? releaseResumeWaiver(original, opts) : undefined;
  if (original && opts.acceptedRegressions !== undefined && !waiver)
    releaseResumeAcceptedRegressions(original, opts.acceptedRegressions, opts.from);
  const attempt = reserveReleaseResumeAttempt(savedRun, deps.root!, { now: deps.now, checkOnly: true });
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
  const fromIndex = savedRun.path.indexOf(opts.from);
  const gateIndex = savedRun.path.indexOf('gate');
  const gateWillRun = fromIndex >= 0 && gateIndex >= fromIndex;
  if (opts.rerouteShard !== undefined && tip.changed) throw new Error('shard reroute requires the original cut head; moved tip needs a full re-gate');
  verifyResumeRecipePin(opts.commandRoot ?? process.cwd(), savedRun.graphSnapshot, tip.version);
  const commandRoot = verifyReleaseCommandRoot(opts.commandRoot ?? process.cwd(), tip.to, deps.git);
  verifyResumePreflight(savedRun, opts, deps, tip.version, tip.from, tip.to, commandRoot);
  const autoheal = gateWillRun ? priorGateAutoheal(savedRun) : undefined;
  const autoReroute = opts.rerouteShard === undefined ? automaticReroute(savedRun, autoheal, tip.changed, opts.from) : undefined;
  const automaticShardReroute = autoReroute ? releaseResumeGateShardReroute(savedRun, { from: opts.from, shard: autoReroute }) : undefined;
  const effectiveOpts = automaticShardReroute ? { ...opts, rerouteShard: automaticShardReroute.set.gateRerouteShard } : opts;
  const partial = preparePartial(tip, effectiveOpts.rerouteShard !== undefined ? { ...effectiveOpts, partial: false } : effectiveOpts, deps, true);
  const gatePlan = !gateWillRun ? { mode: 'not-run' as const }
    : partial.requested && partial.applied ? { mode: 'partial' as const }
      : { mode: 'full' as const, reason: partial.requested ? partial.reason : opts.partial === false ? 'partial recheck disabled' : 'no partial plan applies' };
  if (autoheal) debug.log('release-loop.resume', 'gate-autoheal-plan', { runId: opts.runId, version: tip.version, appliedReroute: automaticShardReroute?.set.gateRerouteShard ?? null, ...autoheal });
  return { runId: opts.runId, version: tip.version, fromNode: opts.from, commandRoot, tip, partial,
    gatePlan, ...(autoheal ? { autoheal } : {}), ...(automaticShardReroute ? { autohealReroute: automaticShardReroute.set.gateRerouteShard } : {}),
    nextAttempt: attempt.attempt, priorCountKnown: attempt.priorCountKnown, preflight: 'passed' };
}

async function resumeReleaseRunLocked(opts: ResumeReleaseOptions, deps: ResumeReleaseDeps): Promise<{ tip: TipRefresh; partial: PartialOutcome; state: GraphRunState }> {
  if (opts.from === 'version-release') throw new Error('--from version-release would cut again — resume at a later node');
  // RELEASE-LEDGER-UNIVERSE: decide the universe once; the run lookup and every resumed node use it.
  deps = { ...deps, root: releaseRunUniverse({ root: deps.root }) };
  const statePath = join(deps.root!, 'graph-runs', 'release-loop', `${safeRunId(opts.runId)}.json`);
  const savedRun = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
  assertReleaseResumeApprovalBoundary({ ...savedRun, statePath }, opts.from);
  let waiverCommit: string | undefined;
  if (opts.gateHost !== undefined && opts.gateExecutor === undefined) throw new Error('--gate-host requires --gate-executor host');
  if ((opts.shardHost !== undefined || opts.shardOs !== undefined) && opts.rerouteShard === undefined)
    throw new Error('--shard-host/--shard-os require --reroute-shard');
  const original = opts.waive !== undefined || opts.reason !== undefined || opts.acceptedRegressions !== undefined || opts.gateExecutor !== undefined || opts.gatePodPool !== undefined || opts.rerouteShard !== undefined
    ? savedRun : undefined;
  // GATE-HOST-EXECUTOR: checked before the tip refresh writes anything; the runner checks it again under the resume lock.
  const gateExecutor = original && opts.gateExecutor !== undefined
    ? releaseResumeGateExecutor(original, { from: opts.from, executor: opts.gateExecutor, host: opts.gateHost }) : undefined;
  const gatePodPool = original && opts.gatePodPool !== undefined
    ? releaseResumeGatePodPool(original, { from: opts.from, pool: opts.gatePodPool }) : undefined;
  const shardReroute = original && opts.rerouteShard !== undefined
    ? releaseResumeGateShardReroute(original, { from: opts.from, shard: opts.rerouteShard, host: opts.shardHost, os: opts.shardOs }) : undefined;
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
  // Validate request arguments before the tip refresh; the count is observational.
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
  // The read-only tip and recipe pin preflight must pass before fetch or a saved-run rewrite.
  const previewTip = refreshReleaseBranchTipInternal(opts.runId, deps, opts.from, waiverCommit, true);
  if (shardReroute && previewTip.changed) throw new Error('shard reroute requires the original cut head; moved tip needs a full re-gate');
  verifyResumeRecipePin(opts.commandRoot ?? process.cwd(), savedRun.graphSnapshot, previewTip.version);
  const commandRoot = verifyReleaseCommandRoot(opts.commandRoot ?? process.cwd(), previewTip.to, deps.git);
  verifyResumePreflight(savedRun, opts, deps, previewTip.version, previewTip.from, previewTip.to, commandRoot);
  const tip = refreshReleaseBranchTipInternal(opts.runId, deps, opts.from, waiverCommit, false, previewTip.to);
  const autoheal = priorGateAutoheal(savedRun);
  const autoReroute = !shardReroute ? automaticReroute(savedRun, autoheal, tip.changed, opts.from) : undefined;
  const automaticShardReroute = autoReroute ? releaseResumeGateShardReroute(savedRun, { from: opts.from, shard: autoReroute }) : undefined;
  const partial = preparePartial(tip, shardReroute || automaticShardReroute
    ? { ...opts, rerouteShard: (shardReroute ?? automaticShardReroute)!.set.gateRerouteShard, partial: false } : opts, deps);
  if (autoheal) debug.log('release-loop.resume', 'gate-autoheal-plan', { runId: opts.runId, version: tip.version, appliedReroute: automaticShardReroute?.set.gateRerouteShard ?? null, ...autoheal });
  // A failed preflight does not consume an observed release resume attempt.
  const attempt = reserveReleaseResumeAttempt(savedRun, deps.root!, { now: deps.now });
  debug.log('release-loop.resume', 'attempt', { runId: opts.runId, attempt: attempt.attempt,
    priorCountKnown: attempt.priorCountKnown, ledger: attempt.path });
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
    ...(shardReroute || automaticShardReroute ? { releaseGateShardReroute: { shard: (shardReroute ?? automaticShardReroute)!.set.gateRerouteShard,
      ...((shardReroute ?? automaticShardReroute)!.set.gateShardHost ? { host: (shardReroute ?? automaticShardReroute)!.set.gateShardHost } : {}),
      ...(opts.shardOs ? { os: opts.shardOs } : {}) } } : {}),
    deps: { root: deps.root, ...(deps.runBash ? { runBash: deps.runBash } : {}) } });
  return { tip, partial, state };
}

// RELEASE-RECOVER-ONE-CMD (0.2.36): a failed release run is repaired by three commands that used to be chained by
// hand (append dry-run → append → resume --from export-check). `release recover` runs them in that order, stops the
// moment one fails, and leaves every stage's result in the resume-attempts ledger.
export type RecoverStageName = 'append-dry-run' | 'append' | 'resume';
const RECOVER_STAGES: readonly RecoverStageName[] = ['append-dry-run', 'append', 'resume'];
/** The first node that consumes the cut — a moved tip must restart no later than here, so it is the default. */
const RECOVER_FIRST_NODE = 'export-check';

export interface RecoverReleaseOptions {
  runId: string;
  /** main commits that repair the cut — appended to release/<v> as a fast-forward only. */
  pick: string[];
  /** Node the resume restarts at — default `export-check`. */
  from?: string;
  commandRoot?: string;
  partial?: boolean;
  /** The checkout the append runs in (its `origin` remote); default the process cwd. */
  repoRoot?: string;
}

export interface RecoverStageRecord {
  stage: RecoverStageName; outcome: 'ok' | 'failed'; at: string; branch?: string; commit?: string | null;
  from?: string; gatePlan?: 'not-run' | 'partial' | 'full'; status?: string; reason?: string;
  /** The `--pick` list this recovery appended — a re-entry skips the append only for the same list. */
  pick?: string[];
}

export interface RecoverReleaseResult {
  runId: string; version: string; branch: string; fromNode: string; stages: RecoverStageRecord[];
  resume?: { status: string; tip: TipRefresh; partial: PartialOutcome };
}

export interface RecoverReleaseLandingOptions {
  runId: string;
  /** The landed repair commit on main; this is the idempotency key for a landing notification. */
  mergeSha: string;
  from?: string;
  commandRoot?: string;
  partial?: boolean;
  repoRoot?: string;
}

export type RecoverReleaseLandingResult = RecoverReleaseResult & { duplicate: boolean };

/** Commander represents `--no-partial` as false and its default (flag omitted) as true. */
export function recoverLandingPartialOption(optionValue?: boolean): boolean | undefined {
  return optionValue === false ? false : undefined;
}

export interface RecoverReleaseDeps extends ResumeReleaseDeps {
  /** `release cut-branch --append` — tests record the plan instead of pushing the branch. */
  cutBranch?: typeof cutReleaseBranch;
}

/** A recovery that stopped at a stage: the stages after it never ran, and a human decides the next move. */
export class ReleaseRecoverStopped extends Error {
  constructor(readonly stage: RecoverStageName, readonly stages: readonly RecoverStageRecord[],
    readonly notRun: readonly RecoverStageName[], reason: string) {
    super(`release recover ${stage} 단계에서 멈췄다: ${reason} — ${notRun.length
      ? `${notRun.join(' · ')} 단계는 실행하지 않았다` : '뒤에 실행할 단계가 없다'} · 사람이 판단한다(단계 원장: release/<v>/resume-attempts/<runId>.json)`);
    this.name = 'ReleaseRecoverStopped';
  }
}

function readRecoverJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`release ${label} JSON을 읽을 수 없다: ${path} (${detail}) — 파일을 보존하고 원장을 올바른 JSON으로 복구한 뒤 재시도하라.`);
  }
}

/** Append one stage result to the resume-attempts ledger. `attempts[]` keeps its shape — the stage results are added. */
function recordRecoverStage(entry: { root: string; runId: string; version: string; priorCountKnown: boolean; stage: RecoverStageRecord }): void {
  const path = join(entry.root, 'release', entry.version, 'resume-attempts', `${entry.runId}.json`);
  const saved = existsSync(path)
    ? readRecoverJson(path, 'resume attempts 원장') as { attempts?: unknown; recoveries?: unknown; priorCountKnown?: unknown }
    : undefined;
  if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Array.isArray(saved.attempts)
    || (saved.recoveries !== undefined && !Array.isArray(saved.recoveries)))) throw new Error('release resume attempts ledger invalid');
  const next = { ...(saved ?? {}), version: entry.version, runId: entry.runId,
    priorCountKnown: saved?.priorCountKnown ?? entry.priorCountKnown,
    attempts: (saved?.attempts ?? []) as string[],
    recoveries: [...((saved?.recoveries ?? []) as RecoverStageRecord[]), entry.stage] };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.recover.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function acquireReleaseRecoveryLock(root: string, runId: string) {
  const lockDir = join(root, 'release', 'recovery-locks');
  mkdirSync(lockDir, { recursive: true });
  // A full-gate subprocess can block this process's event loop, delaying the async lock heartbeat.
  // The observed release gate reached 2h20m; leave a finite four-hour stale/wait window for one recovery.
  const lock = await acquireLockAsync(join(lockDir, `${runId}.lock`), {
    staleMs: 4 * 60 * 60_000, retryBusyMs: 1_000, maxTries: 14_400,
  });
  if (!lock.stillHeld()) {
    lock.release();
    throw new Error(`release recovery lock was lost for ${runId} — retry after inspecting the recovery ledger`);
  }
  return lock;
}

/**
 * Repair a failed release run in one command: append dry-run (plan only) → append (fast-forward release/<v> onto the
 * picked repairs) → resume --from export-check (preflight plan, then the graph). A failing stage stops the command:
 * the later stages never run, and the stage results are already in the ledger for the human to read.
 */
export async function recoverReleaseRun(opts: RecoverReleaseOptions, deps: RecoverReleaseDeps = {}): Promise<RecoverReleaseResult> {
  const root = releaseRunUniverse({ root: deps.root });
  const runId = safeRunId(opts.runId);
  const lock = await acquireReleaseRecoveryLock(root, runId);
  try {
    return await recoverReleaseRunLocked(opts, deps, root);
  } finally { lock.release(); }
}

async function recoverReleaseRunLocked(opts: RecoverReleaseOptions, deps: RecoverReleaseDeps, root: string): Promise<RecoverReleaseResult> {
  if (!Array.isArray(opts.pick) || !opts.pick.length) throw new Error('release recover requires at least one --pick commit');
  const statePath = join(root, 'graph-runs', 'release-loop', `${safeRunId(opts.runId)}.json`);
  const savedRun = readRecoverJson(statePath, 'release run 상태') as GraphRunState;
  if (savedRun.graphId !== 'release-loop' || savedRun.runId !== opts.runId) throw new Error(`run identity mismatch: ${statePath}`);
  // The saved version-release record names what to repair: the release branch and the commit the run cut.
  const versionRecord = savedRun.nodes.find((node) => node.nodeId === 'version-release');
  const recorded = lastJsonObject(versionRecord?.output);
  const version = typeof recorded?.version === 'string' ? recorded.version : '';
  // RELEASE-RECOVER-BASE: a first recover that reached the resume left refreshed-tip lines in the
  // version-release output, and `lastJsonObject` names the CURRENT branch tip. The append builds on the
  // commit the run CUT — an ancestor of the picked repairs on origin/main — so walk to the FIRST JSON
  // object of the output for that original cut. Without this, a second recover with a different --pick
  // fails append-dry-run with «base … is not an ancestor of origin/main» and strands the new repair
  // unpushed while the run looks recovered.
  const firstCutObject = (text: unknown): { version?: unknown; commit?: unknown } | undefined => {
    if (typeof text !== 'string') return undefined;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
          return parsed as { version?: unknown; commit?: unknown };
        }
      } catch { /* not a JSON line — keep walking */ }
    }
    return undefined;
  };
  const originalCut = firstCutObject(versionRecord?.output) ?? recorded;
  const base = typeof originalCut?.commit === 'string' ? originalCut.commit : '';
  if (!versionRecord?.ok || !isReleaseVersion(version) || !/^[0-9a-f]{40}$/i.test(base)) {
    throw new Error(`release run ${opts.runId} has no successful version-release record — nothing to repair`);
  }
  const branch = `release/${version}`;
  const fromNode = opts.from ?? RECOVER_FIRST_NODE;
  // RELEASE-RECOVER-PREFLIGHT (MS-02 review): the append pushes release/<v> on origin, and the resume refuses a
  // bad run only after that push. Every read-only resume rejection is checked here FIRST — a run the resume
  // would refuse never moves the branch. command-root mismatch is gone by construction: recover prepares the
  // tip checkout itself below, and a human-provided --command-root is verified by the plan before the graph.
  if (savedRun.status !== 'failed') {
    throw new Error(`release run ${opts.runId} is ${savedRun.status} — only a failed run is recovered; ${branch} was not moved`);
  }
  if (fromNode === 'version-release') {
    throw new Error(`--from version-release would cut again — recover at a later node; ${branch} was not moved`);
  }
  const restartAt = savedRun.path.indexOf(fromNode);
  if (restartAt < 0 || savedRun.path.lastIndexOf(fromNode) !== restartAt) {
    throw new Error(`--from ${fromNode} is not a node on the saved path of ${opts.runId}; ${branch} was not moved`);
  }
  const consumers = ['export-check', 'gate'].map((node) => savedRun.path.indexOf(node)).filter((index) => index >= 0);
  const firstConsumer = consumers.length ? Math.min(...consumers) : -1;
  if (firstConsumer >= 0 && restartAt > firstConsumer) {
    throw new Error(`--from ${fromNode} is later than ${savedRun.path[firstConsumer]!} — later nodes were built from the old tip; ${branch} was not moved`);
  }
  const savedInput = (savedRun.input ?? {}) as { branchCut?: unknown; version?: unknown };
  if (savedInput.branchCut !== true || savedInput.version !== version || recorded?.branch !== branch) {
    throw new Error(`release run ${opts.runId} was not cut as ${branch} (input.branchCut/version or version-release branch differ); ${branch} was not moved`);
  }
  // The attempt ledger is the resume's own read-only gate — a refused recover consumes no attempt.
  reserveReleaseResumeAttempt(savedRun, root, { now: deps.now, checkOnly: true });
  const now = (): string => (deps.now?.() ?? new Date()).toISOString();
  const stages: RecoverStageRecord[] = [];
  const record = (stage: RecoverStageRecord): void => {
    const withPick = { ...stage, pick: stage.pick ?? [...opts.pick] };
    stages.push(withPick);
    recordRecoverStage({ root, runId: opts.runId, version, priorCountKnown: !savedRun.resume, stage: withPick });
  };
  const stop = (stage: RecoverStageName, error: unknown): never => {
    throw new ReleaseRecoverStopped(stage, stages, RECOVER_STAGES.slice(RECOVER_STAGES.indexOf(stage) + 1),
      error instanceof Error ? error.message : String(error));
  };
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const cutBranch = deps.cutBranch ?? cutReleaseBranch;
  const cut = { version, base, pick: opts.pick, append: true, repoRoot: opts.repoRoot, log: deps.onSource };
  const repoRoot = resolve(opts.repoRoot ?? deps.repo ?? process.cwd());
  // RELEASE-RECOVER-REENTRY (MS-02 review): once the append pushed and the resume did not finish, re-running
  // recover with the same --pick is refused by cut-branch with «pick … is already in release/<v>» and dies at
  // stage 1 with no guidance. The ledger recoveries decide: when their append-ok commit is still inside the
  // advertised branch tip AND its recorded pick list is this --pick (an entry with no pick record is «기록 없음»,
  // not an empty list — it falls back to the safe side and appends again), the repair already landed and this
  // recover continues from the resume — the append stages never re-run.
  /** Same pick list, order-insensitive, full 40-hex object ids only — anything else is «no record». */
  const samePickList = (recorded: unknown): boolean => {
    if (!Array.isArray(recorded) || recorded.length !== opts.pick.length) return false;
    const left = recorded.map((sha) => (typeof sha === 'string' ? sha.toLowerCase() : '')).sort();
    const right = [...opts.pick].map((sha) => sha.toLowerCase()).sort();
    return left.every((sha, index) => /^[0-9a-f]{40}$/.test(sha) && sha === right[index]);
  };
  const ledgerPath = join(root, 'release', version, 'resume-attempts', `${opts.runId}.json`);
  const recoveries: RecoverStageRecord[] = existsSync(ledgerPath)
    ? ((readRecoverJson(ledgerPath, 'resume attempts 원장') as { recoveries?: unknown[] }).recoveries ?? []) as RecoverStageRecord[]
    : [];
  let appendedCommit: string | undefined;
  for (let index = recoveries.length - 1; index >= 0; index -= 1) {
    const entry = recoveries[index]!;
    if (entry.stage === 'append' && entry.outcome === 'ok' && typeof entry.commit === 'string' && samePickList(entry.pick)) {
      appendedCommit = entry.commit;
      break;
    }
  }
  let advertised = '';
  try {
    advertised = (deps.git ?? gitRunner(repoRoot))(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0] ?? '';
  } catch {
    advertised = '';
  }
  const isAncestor = deps.isAncestor ?? ancestorRunner(repoRoot);
  const humanResume = `release resume --run ${opts.runId} --from ${fromNode}`;
  const alreadyInGuidance = (cause: string): string =>
    `${cause} — ${branch}가 이미 고른 수선을 담고 있다: 이 recover는 append하지 않았다. 사람이 직접 이어 간다: ${humanResume}`;
  let tip = '';
  if (appendedCommit !== undefined && /^[0-9a-f]{40}$/i.test(advertised) && isAncestor(appendedCommit, advertised)) {
    tip = advertised;
    deps.onSource?.(`· recover 재진입 · 원장의 append-ok(${appendedCommit.slice(0, 12)})이 가지 끝에 그대로 있다 — append를 다시 하지 않고 ${fromNode} resume부터 이어 간다`);
  } else {
    if (/^[0-9a-f]{40}$/i.test(advertised) && opts.pick.every((sha) => isAncestor(sha, advertised))) {
      // The repair is on the branch already (a hand-run append) and the ledger has no append-ok for it: there is
      // nothing to append — the stop error and the ledger record both name the human's next step.
      const guidance = alreadyInGuidance(`pick ${opts.pick.join(' + ')} is already in ${branch}`);
      record({ stage: 'append-dry-run', outcome: 'failed', at: now(), branch, reason: guidance });
      return stop('append-dry-run', new Error(guidance));
    }
    // 1/3 append dry-run — the fast-forward plan only: no worktree, no push, no run-state write.
    try {
      const planned = cutBranch({ ...cut, dryRun: true });
      record({ stage: 'append-dry-run', outcome: 'ok', at: now(), branch: planned.branch, commit: planned.commit });
      deps.onSource?.(`· recover 1/3 append dry-run · ${planned.branch} ← ${opts.pick.join(' + ')} · 가지·push·런 상태 변경 없음`);
    } catch (error) {
      const raw = reason(error);
      if (!/is already in /.test(raw)) {
        record({ stage: 'append-dry-run', outcome: 'failed', at: now(), branch, reason: raw });
        return stop('append-dry-run', error);
      }
      const guided = alreadyInGuidance(raw);
      record({ stage: 'append-dry-run', outcome: 'failed', at: now(), branch, reason: guided });
      return stop('append-dry-run', new Error(guided));
    }
    // 2/3 append — cherry-pick the repairs onto release/<v> and push the fast-forward (never a force push).
    try {
      const appended = cutBranch(cut);
      if (!appended.commit) throw new Error(`${appended.branch} append produced no commit`);
      tip = appended.commit;
      record({ stage: 'append', outcome: 'ok', at: now(), branch: appended.branch, commit: tip, pick: opts.pick });
      deps.onSource?.(`↻ recover 2/3 append · ${appended.branch} ${base.slice(0, 12)} → ${tip.slice(0, 12)} (fast-forward)`);
    } catch (error) {
      const raw = reason(error);
      if (!/is already in /.test(raw)) {
        record({ stage: 'append', outcome: 'failed', at: now(), branch, reason: raw });
        return stop('append', error);
      }
      const guided = alreadyInGuidance(raw);
      record({ stage: 'append', outcome: 'failed', at: now(), branch, reason: guided });
      return stop('append', new Error(guided));
    }
  }

  // 3/3 resume --from export-check — the read-only preflight first (its plan is the record), then the graph run.
  // The append moved only the origin branch tip: the operator checkout is still wherever it was, and the resume
  // preflight (verifyReleaseCommandRoot) demands a checkout whose HEAD is the new tip. So recover prepares that
  // checkout itself — a temporary worktree at the tip. A human-provided --command-root stays a judgment
  // boundary: the plan verifies it against the tip and stops there on a mismatch.
  const resumeOptions: ResumeReleaseOptions = { runId: opts.runId, from: fromNode,
    ...(opts.partial === undefined ? {} : { partial: opts.partial }) };
  let preparedRoot: { dir: string; git: (args: string[]) => string } | undefined;
  if (opts.commandRoot !== undefined) resumeOptions.commandRoot = opts.commandRoot;
  else {
    const temp = mkdtempSync(join(tmpdir(), 'release-recover-'));
    const dir = join(temp, 'command-root');
    const worktreeGit = gitRunner(repoRoot);
    try {
      worktreeGit(['worktree', 'add', '--detach', dir, tip]);
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    preparedRoot = { dir, git: worktreeGit };
    resumeOptions.commandRoot = dir;
  }
  try {
    const plan = await planResumeReleaseRun(resumeOptions, deps);
    const resumed = await resumeReleaseRun(resumeOptions, deps);
    record({ stage: 'resume', outcome: 'ok', at: now(), from: fromNode, branch: resumed.tip.branch,
      commit: resumed.tip.to, gatePlan: plan.gatePlan.mode, status: resumed.state.status });
    deps.onSource?.(`▶ recover 3/3 resume ${fromNode}부터 · tip ${resumed.tip.to.slice(0, 12)} · gate ${plan.gatePlan.mode} → ${resumed.state.status}`);
    return { runId: opts.runId, version, branch: resumed.tip.branch, fromNode, stages,
      resume: { status: resumed.state.status, tip: resumed.tip, partial: resumed.partial } };
  } catch (error) {
    record({ stage: 'resume', outcome: 'failed', at: now(), from: fromNode, branch, reason: reason(error) });
    return stop('resume', error);
  } finally {
    if (preparedRoot) {
      try {
        preparedRoot.git(['worktree', 'remove', '--force', preparedRoot.dir]);
      } catch {
        try { preparedRoot.git(['worktree', 'prune']); } catch { /* the temp dir below is still removed */ }
      }
      rmSync(dirname(preparedRoot.dir), { recursive: true, force: true });
    }
  }
}

/**
 * Manual landing-event entrypoint. The event's merge SHA is the dedupe key; once that repair has completed its
 * resume stage, a redelivered event returns the recorded result without appending or running the graph again.
 * The event producer can call this after its own hook lands; this function does not subscribe to PR-land events.
 */
export async function recoverReleaseRunFromLanding(opts: RecoverReleaseLandingOptions,
  deps: RecoverReleaseDeps = {}): Promise<RecoverReleaseLandingResult> {
  if (!/^[0-9a-f]{40}$/i.test(opts.mergeSha)) throw new Error('release recover-landing requires a full 40-hex merge SHA');
  const root = releaseRunUniverse({ root: deps.root });
  const runId = safeRunId(opts.runId);
  // Share one run-scoped lock with manual `release recover`: the dedupe read, append, and resume must not race.
  const landingLock = await acquireReleaseRecoveryLock(root, runId);
  try {
    return await recoverReleaseRunFromLandingLocked(opts, deps, root, runId);
  } finally { landingLock.release(); }
}

async function recoverReleaseRunFromLandingLocked(opts: RecoverReleaseLandingOptions, deps: RecoverReleaseDeps,
  root: string, runId: string): Promise<RecoverReleaseLandingResult> {
  const pick = [opts.mergeSha.toLowerCase()];
  const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
  if (existsSync(statePath)) {
    const savedRun = readRecoverJson(statePath, 'release run 상태') as GraphRunState;
    const versionNode = savedRun.nodes.find((node) => node.nodeId === 'version-release');
    const recorded = lastJsonObject(versionNode?.output);
    const version = typeof recorded?.version === 'string' ? recorded.version : '';
    if (savedRun.graphId === 'release-loop' && savedRun.runId === runId && isReleaseVersion(version)) {
      const ledgerPath = join(root, 'release', version, 'resume-attempts', `${runId}.json`);
      if (existsSync(ledgerPath)) {
        const ledger = readRecoverJson(ledgerPath, 'resume attempts 원장') as { recoveries?: unknown };
        if (ledger.recoveries !== undefined && !Array.isArray(ledger.recoveries)) throw new Error(`release resume attempts ledger invalid: ${ledgerPath}`);
        const records = (ledger.recoveries ?? []) as RecoverStageRecord[];
        const matchesPick = (entry: RecoverStageRecord): boolean => Array.isArray(entry.pick)
          && entry.pick.some((sha) => typeof sha === 'string' && sha.toLowerCase() === pick[0]);
        let completedIndex = -1;
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const entry = records[index]!;
          if (matchesPick(entry) && entry.stage === 'resume' && entry.outcome === 'ok') {
            completedIndex = index;
            break;
          }
        }
        if (completedIndex >= 0) {
          let cycleStart = completedIndex;
          for (let index = completedIndex; index >= 0; index -= 1) {
            const entry = records[index]!;
            if (matchesPick(entry) && entry.stage === 'append-dry-run') {
              cycleStart = index;
              break;
            }
          }
          const completed = records[completedIndex]!;
          return { runId, version, branch: `release/${version}`, fromNode: completed.from ?? opts.from ?? RECOVER_FIRST_NODE,
            stages: records.slice(cycleStart, completedIndex + 1).filter(matchesPick), duplicate: true };
        }
      }
    }
  }
  const result = await recoverReleaseRunLocked({ runId, pick,
    ...(opts.from === undefined ? {} : { from: opts.from }),
    ...(opts.commandRoot === undefined ? {} : { commandRoot: opts.commandRoot }),
    ...(opts.partial === undefined ? {} : { partial: opts.partial }),
    ...(opts.repoRoot === undefined ? {} : { repoRoot: opts.repoRoot }) }, deps, root);
  return { ...result, duplicate: false };
}
