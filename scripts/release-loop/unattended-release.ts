import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { userConfigPath } from '../../src/user-config.js';
import { cutChecklistGate } from '../../src/release-loop/checklist.js';
import { getSchedule } from '../../src/release-loop/release-schedule.js';
import { isLandingFreezeRefusal, readLandingFreeze, LandingFrozenError } from '../../src/release-loop/landing-freeze.js';
import { debug } from '../../src/debug/log.js';
import { lastJsonObject, listGraphRuns, runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { releaseGateCutoverPath } from '../../src/graph-runner/release-gate-cutover-policy.js';
import { withOpSeatFlock } from '../../src/steward/resync-tick.js';
import { ReleaseRunClaimConflict, findActiveReleaseRun } from '../../src/cli/release-single-flight.js';
import { releaseRunUniverse } from './release-universe.js';
import { baseVersion, isStableVersion, nextPrereleaseVersion, type PrereleaseKind } from './release-version.js';
import { publishAtError } from './publish-at.js';
import type { CloudElasticGraphRequest } from '../../src/release-loop/cloud-elastic.js';
import { checkGateExecutorChoice, type GateExecutor } from './gate-executor.js';
import { readReleaseGateRehearsal, readReleaseOpsPolicy, selectReleaseGateMethod } from './gate-method.js';
import { createMacrophageRuntime } from '../../src/release-loop/macrophage-heal-node.js';
import { createMacrophageSafeCleanup } from '../../src/release-loop/macrophage-safe-cleanup.js';
import { createIncidentPolicyHandler } from '../../src/release-loop/incident-policy-handler.js';
import type { GraphSubscriptionHandler } from '../../src/graph-runner/graph-subscriptions.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { runRlaScorecardReportCli } from './rla-event-response-scorecard-report.js';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REPOSITORY_ROOT = join(import.meta.dir, '../..');
const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const RLA_SCORECARD_KNOWHOW_PACK = join(import.meta.dir, '../../scenarios/ux-sim/knowhow-pack-release-heal-1107.md');
const RLA_SCORECARD_SIM_RIG = join(import.meta.dir, '../../scenarios/ux-sim/release-sim-rig.yaml');

function refreshRlaScorecardForCompletedRun(runId: string, stateRoot: string): void {
  const path = runRlaScorecardReportCli([
    '--run-id', runId,
    '--knowledge-pack', RLA_SCORECARD_KNOWHOW_PACK,
    '--release-sim-rig', RLA_SCORECARD_SIM_RIG,
    '--state-root', stateRoot,
  ]);
  debug.log('release.run', 'rla-scorecard-refreshed', { runId, path });
}

function gitOutput(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed while checking release CLI freshness`);
  return result.stdout.trim();
}

/** Canonical REL record release-exec-patch-manifest-0623.json.
 *  The env path only locates this file. Its SHA256 is the trust anchor.
 *  Recorded diff SHA256 is 5b1e0deda2d77c50e8e9cd2ed8f358199ac9618db72cf610ca760a59fb50ef96.
 */
export const APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SOURCE = 'release-exec-patch-manifest-0623.json';
export const APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SHA256 = '2dc5022e5872e19bdb0ec1e5ad9139e1dbdb38b1454a0d5393ae5a74fcfed391';

const RELEASE_EXEC_PATCH_PATHS = [
  'scripts/release-loop/publish-node.ts',
  'scripts/release-loop/unattended-release.ts',
  'scripts/release-loop/version-node.ts',
] as const;

/** A stale installed/seat CLI must not start a release graph with recipes that differ from main. */
export function assertReleaseCliCurrent(repo: string, cutCommit?: string): void {
  const dirty = gitOutput(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) {
    const manifestPath = process.env.ELANOUS_RELEASE_EXEC_PATCH_MANIFEST;
    if (!manifestPath) throw new Error('release CLI checkout has uncommitted changes');
    const bytes = readFileSync(manifestPath);
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    if (basename(manifestPath) !== APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SOURCE
      || fileSha256 !== APPROVED_RELEASE_EXEC_PATCH_MANIFEST_SHA256) {
      throw new Error('unapproved release CLI execution patch manifest');
    }
    const manifest = JSON.parse(bytes.toString('utf8')) as
      { baseHead?: unknown; paths?: unknown; diffSha256?: unknown };
    const paths = [...RELEASE_EXEC_PATCH_PATHS];
    const actual = dirty.split('\n').map((row) => row.replace(/^\s*[A-Z?!]{1,2}\s+/, '')).sort();
    const expected = [...paths].sort();
    const head = gitOutput(repo, ['rev-parse', 'HEAD']);
    const diff = gitOutput(repo, ['diff', '--binary', '--', ...paths]);
    const digest = createHash('sha256').update(diff).digest('hex');
    if (manifest.baseHead !== head || JSON.stringify(manifest.paths) !== JSON.stringify(expected)
      || JSON.stringify(actual) !== JSON.stringify(expected) || manifest.diffSha256 !== digest
      || gitOutput(repo, ['diff', '--cached', '--name-only'])) {
      throw new Error('release CLI execution patch manifest does not match checkout');
    }
  }
  const head = gitOutput(repo, ['rev-parse', 'HEAD']);
  const remoteMain = gitOutput(repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (!remoteMain || !/^[0-9a-f]{40,64}$/i.test(remoteMain)) throw new Error('cannot resolve origin/main for release CLI freshness check');
  const cutParent = cutCommit ? gitOutput(repo, ['rev-parse', `${cutCommit}^{commit}^`]) : undefined;
  const remoteReleaseTips = (cutCommit === undefined || cutCommit === head)
    ? gitOutput(repo, ['ls-remote', 'origin', 'refs/heads/release/*']).split('\n').map((line) => line.split(/\s+/)[0]) : [];
  const exactReleaseTip = remoteReleaseTips.includes(head);
  if (head !== remoteMain && head !== cutParent && !exactReleaseTip) {
    throw new Error(`stale release CLI: HEAD ${head} does not match origin/main ${remoteMain}${cutParent ? ` or cut parent ${cutParent}` : ''}`);
  }
}

export interface ReleaseLoopConfig {
  /** Explicitly allow bounded same-run cut repair; a repaired cut must use receipt audit. */
  autoAppendRepair?: boolean;
  /** OP-controlled gate route. The absent value keeps the established gate path. */
  graphCutover?: 'legacy' | 'audit';
  /** OP decision record covering the hard rehearsal and shadow comparison. */
  graphCutoverEvidenceId?: string;
  /** Mid-cycle full-gate rehearsal, hours before cut (default 12; 0 disables). */
  rehearsalHardIntervalHours?: number;
  gatePodPool?: string;
  gatePodBunCache?: string;
  gatePodShards?: number;
  /** Release-room opt-in: start every gate shard fresh for the cold cut. */
  gatePodFreshShards?: boolean;
  /** GATE-TIMEOUT-HEAL — the per-shard deadline floor; each shard gets planned × 1.5 above it (capped). */
  gatePodShardTimeoutSeconds?: number;
  /** GATE-INSTALL-CACHE — concurrent `bun install`s per gate node (default 4 · 0 = off). */
  gatePodInstallSlots?: number;
  /** GATE-MEM-ADMIT — seconds a gate shard waits for pool admission (memory headroom) before launching anyway with `admission-timeout` (default 300 · 0 = off). */
  gatePodAdmissionWaitSeconds?: number;
  /** Maximum simultaneous file-level isolation retries across all gate shards (default 4). */
  gatePodIsolationConcurrency?: number;
  /** Final isolated recheck files per window; overflow continues in later windows (default 32). */
  gateRecheckFileLimit?: number;
  /** GATE-SPEED A3①: gate shard Pod CPU — `2` (request = limit) or `{ request, limit }`. Omitted = request 1 / limit 4. */
  gatePodCpu?: number | string | { request?: number | string; limit?: number | string };
  gateRemote?: string;
  gateRemoteMirror?: string;
  /** RELEASE-PWA-NODE-RESILIENCE ① — SSH host the `pwa` node runs its scenario suite on (e.g. `node-b`); absent = this machine. No fallback. */
  pwaRemote?: string;
  /** RELEASE-EXPORT-CHECK-REMOTE — non-gate SSH host for the public export + PWA build check (aws1/gcp2; default aws1). */
  exportCheckRemote?: 'aws1' | 'gcp2';
  opsHosts?: string[];
  internalDist?: string;
  opsRestart?: boolean;
  /** An active OP traffic hold forces human approval before the irreversible publish node. */
  trafficHold?: boolean;
  /** Any non-empty OP marker forces the run through approve-publish, even if metrics pass. */
  opApprovalMarker?: string;
}

export interface ReleaseRehearsalConfig {
  /** Executable implementing `cloud-vm.sh <start|stop|status> <host> ...`; absent means cloud rehearsal is disabled. */
  cloudVmCommand?: string;
}

export interface ReleaseRunInput extends ReleaseLoopConfig {
  version: string;
  previousVersion: string;
  triggerEvent?: { id: string; type: 'release.cut.due'; version: string; cutAt: string; at: string };
  cutCommit?: string;
  /** Required for the pod executor (the default); a host-executor run may have none. */
  gatePodPool?: string;
  /** GATE-HOST-EXECUTOR — absent = pod (today's input, byte-identical); `host` sweeps on `gateRemote`. */
  gateExecutor?: GateExecutor;
  /** RELEASE-POLICY-PACK — gate source/image identity follows the selected cut commit. */
  gateImagePin?: 'cut-commit';
  forceFreeze?: boolean;
  publishAt?: string;
  /** Opt-in temporary VM request. OP approval is bound to its exact estimated amount. */
  cloudElastic?: CloudElasticGraphRequest;
  /** RELEASE-BRANCH: version-release cuts release/<v> from main HEAD and bumps only the branch. */
  branchCut?: boolean;
  /** MACRO-PREFLIGHT-CLI-FRESH: exact main commit checked by the CLI before graph launch. */
  branchCutBaseCommit?: string;
}

export interface UnattendedReleaseDeps {
  ledgerRoot?: string;
  config?: ReleaseLoopConfig;
  configPath?: string;
  policyPath?: string;
  graphPath?: string;
  graph?: (path: string, options: { input: ReleaseRunInput; runId?: string; resumeRunId?: string; useCurrentGraph?: boolean;
    resumeInputPatch?: Record<string, unknown>; fromNodeId?: string; pinChildUniverse?: boolean;
    deps?: { root?: string; dispatchGraphSubscription?: GraphSubscriptionHandler } }) => Promise<GraphRunState>;
  assertCliCurrent?: (repo: string, cutCommit?: string) => void;
  registerLogSink?: (surface: string) => Promise<boolean>;
  checklist?: (version: string) => Pick<ReturnType<typeof cutChecklistGate>, 'ok' | 'red' | 'undecided' | 'blocked'>;
  freezeRoot?: string;
  /** Names already taken for prerelease numbering (remote release branches and tags). */
  releaseRefs?: (base: string, kind: PrereleaseKind) => string[];
  /** Test seam for verifying scorecard reporting is advisory after graph completion. */
  refreshScorecard?: (runId: string, stateRoot: string) => void;
}

/** Remote `release/<base>-<kind>.*` branches and `v<base>-<kind>.*` tags — read-only. */
export function remoteReleaseRefs(base: string, kind: PrereleaseKind, repo = process.cwd()): string[] {
  // git-spawn-allow: read-only ls-remote to number a prerelease.
  const result = spawnSync('git', ['ls-remote', 'origin', `refs/heads/release/${base}-${kind}.*`, `refs/tags/v${base}-${kind}.*`], {
    cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  if (result.status !== 0 || result.error) throw new Error(`git ls-remote failed: ${(result.stderr || result.error || 'no output').toString().trim()}`);
  return result.stdout.split('\n').map((line) => line.split(/\s+/)[1] ?? '').filter(Boolean);
}

/** `0.2.18` + `rc` → the next free `0.2.18-rc.<n>`; a stable run keeps its version. */
export function resolveRunVersion(version: string, prerelease: PrereleaseKind | undefined, deps: UnattendedReleaseDeps = {}): string {
  if (!prerelease) return version;
  if (!isStableVersion(version)) throw new Error(`--prerelease takes the base version x.y.z: ${version}`);
  return nextPrereleaseVersion(version, prerelease, (deps.releaseRefs ?? remoteReleaseRefs)(version, prerelease));
}

function compareVersions(a: string, b: string): number {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (aa[i]! < bb[i]!) return -1;
    if (aa[i]! > bb[i]!) return 1;
  }
  return 0;
}

/** Only completed publications in the release ledger count as a prior release. */
export function latestPublishedPreviousVersion(version: string, ledgerRoot = releaseLedgerRoot()): string {
  if (!VERSION.test(version)) throw new Error(`release version must be x.y.z: ${version}`);
  const dir = join(ledgerRoot, 'release');
  const versions = existsSync(dir) ? readdirSync(dir) : [];
  const published = versions.filter((candidate) => {
    if (!VERSION.test(candidate) || compareVersions(candidate, version) >= 0) return false;
    try {
      const record = JSON.parse(readFileSync(join(dir, candidate, 'release.json'), 'utf8')) as { version?: unknown; publishedAt?: unknown };
      return record.version === candidate && typeof record.publishedAt === 'string' && record.publishedAt.trim().length > 0;
    } catch { return false; }
  });
  const previous = published.sort((a, b) => compareVersions(b, a))[0];
  if (!previous) throw new Error(`no published previous release before ${version} in ${dir}`);
  return previous;
}

export function releaseLoopConfig(configPath = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath()): ReleaseLoopConfig {
  if (!existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { release?: { loop?: ReleaseLoopConfig } };
  return raw.release?.loop ?? {};
}

/** Cloud VM control is configured separately from graph/gate settings: release.rehearsal.cloudVmCommand. */
export function releaseRehearsalConfig(configPath = userConfigPath()): ReleaseRehearsalConfig {
  if (!existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { release?: { rehearsal?: { cloudVmCommand?: unknown } } };
  const value = raw.release?.rehearsal?.cloudVmCommand;
  if (value === undefined) return {};
  if (typeof value !== 'string' || !value.trim()) throw new Error('release.rehearsal.cloudVmCommand must name an executable');
  return { cloudVmCommand: value.trim() };
}

/** GATE-HOST-EXECUTOR — the operator's explicit executor choice (`--gate-executor` / `--gate-host`); absent = pod. */
export interface GateExecutorRequest { executor?: string; host?: string }

export function buildReleaseRunInput(version: string, deps: UnattendedReleaseDeps = {}, cutCommit?: string, gate: GateExecutorRequest = {}): ReleaseRunInput {
  const config = deps.config ?? releaseLoopConfig(deps.configPath);
  const graphCutover = releaseGateCutoverPath(config);
  if (gate.executor === undefined && gate.host !== undefined) throw new Error('--gate-host requires --gate-executor host');
  const previousVersion = latestPublishedPreviousVersion(baseVersion(version), deps.ledgerRoot);
  const rehearsal = readReleaseGateRehearsal(deps.ledgerRoot ?? releaseLedgerRoot(), previousVersion);
  const method = selectReleaseGateMethod({ policy: readReleaseOpsPolicy(deps.policyPath), targetVersion: baseVersion(version),
    configuredPool: config.gatePodPool, rehearsal });
  debug.log('release.run', 'gate-method-selected', { version, previousVersion, ...method });
  const requested = gate.executor === undefined ? undefined
    : checkGateExecutorChoice(gate.executor, gate.executor === 'host' ? gate.host ?? config.gateRemote : gate.host);
  if (requested && requested.executor !== method.executor) {
    debug.log('release.run', 'gate-method-override-rejected', { version, requested: requested.executor, selected: method.executor, decision: method.decision });
    throw new Error(`gate executor ${requested.executor} conflicts with release policy ${method.executor}`);
  }
  if (method.executor === 'pod' && !method.pool) throw new Error('release.loop.gatePodPool is required by release ops policy');
  return {
    ...config,
    // Pin the selected route explicitly, even when the config omits the legacy default.
    graphCutover,
    ...(config.graphCutoverEvidenceId === undefined ? {} : { graphCutoverEvidenceId: config.graphCutoverEvidenceId }),
    version, previousVersion,
    ...(cutCommit !== undefined ? { cutCommit } : {}),
    ...(method.executor === 'pod' ? { gatePodPool: method.pool } : {}),
    ...(method.executor === 'pod' && process.env.ELANOUS_RELEASE_FORCE_FRESH_SHARDS === '1' ? { gatePodFreshShards: true } : {}),
    gateExecutor: method.executor,
    gateImagePin: method.imagePin,
    // A future policy may select host; only then can its validated host request reach this input.
    ...(requested?.host ? { gateRemote: requested.host } : {}),
  };
}

/** Fail closed at the entry boundary, before any graph node can change a release. */
function stableResumeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "[" + value.map(stableResumeValue).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableResumeValue(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function assertReleaseResumeCompatible(savedInput: unknown, requestedInput: ReleaseRunInput, runId: string): void {
  if (!savedInput || typeof savedInput !== "object" || Array.isArray(savedInput))
    throw new Error("cannot resume release run " + runId + ": saved input is not an object");
  const saved = { ...(savedInput as Record<string, unknown>) };
  const requested = requestedInput as unknown as Record<string, unknown>;
  // Older cuts omitted this pin; the resume patch below repairs only that known legacy omission.
  if (saved.gateImagePin === undefined && requested.gateImagePin === "cut-commit") saved.gateImagePin = "cut-commit";
  // Runs started before the cutover switch had the old gate route implicitly.
  if (saved.graphCutover === undefined && requested.graphCutover === 'legacy') saved.graphCutover = 'legacy';
  const keys = [...new Set([...Object.keys(saved), ...Object.keys(requested)])].sort();
  const mismatches = keys.filter((key) => stableResumeValue(saved[key]) !== stableResumeValue(requested[key]));
  if (mismatches.length) throw new Error("cannot resume release run " + runId + ": incompatible input fields: " + mismatches.join(", "));
}

function releaseResumeBoundary(run: GraphRunState): string {
  const failed = [...run.nodes].reverse().find((node) => !node.ok && node.nodeId !== "failed" && node.nodeId !== "done");
  const boundary = failed?.nodeId ?? [...run.path].reverse().find((nodeId) => nodeId !== "failed" && nodeId !== "done");
  if (!boundary) throw new Error("cannot resume release run " + run.runId + ": no executable restart node");
  return boundary;
}

function assertReleaseCutCompatible(run: GraphRunState, requested: ReleaseRunInput): void {
  const cut = run.nodes.find((node) => node.nodeId === 'version-release' && node.ok);
  const output = cut?.output && typeof cut.output === 'object' && !Array.isArray(cut.output)
    ? cut.output as Record<string, unknown> : lastJsonObject(cut?.output);
  if (!output || output.version !== requested.version || typeof output.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(output.commit) ||
      (requested.branchCut === true && output.branch !== `release/${requested.version}`) ||
      (typeof requested.cutCommit === 'string' && output.commit !== requested.cutCommit)) {
    throw new Error(`cannot resume release run ${run.runId}: saved version-release cut is incompatible with current input`);
  }
}

export async function runUnattendedRelease(
  opts: { version: string; dryRun?: boolean; cutCommit?: string; branchCutBaseCommit?: string; forceFreeze?: boolean; forceNew?: boolean; mainCut?: boolean; prerelease?: PrereleaseKind; publishAt?: string; gateExecutor?: string; gateHost?: string; triggerEvent?: ReleaseRunInput['triggerEvent'] },
  deps: UnattendedReleaseDeps = {},
): Promise<{ input: ReleaseRunInput; dryRun: boolean; state?: GraphRunState }> {
  // A dry run only builds the input and mutates nothing, so it neither creates nor waits on the OP-seat lock.
  if (opts.dryRun) return runUnattendedReleaseLocked(opts, deps);
  // The lock root is the OP seat's (opSeatLockRoot), never the injected ledger root: a different `deps.ledgerRoot` must
  // not move this run onto a separate lock inode from the steward resync and a manual resume.
  return withOpSeatFlock(() => runUnattendedReleaseLocked(opts, deps));
}

async function runUnattendedReleaseLocked(
  opts: { version: string; dryRun?: boolean; cutCommit?: string; branchCutBaseCommit?: string; forceFreeze?: boolean; forceNew?: boolean; mainCut?: boolean; prerelease?: PrereleaseKind; publishAt?: string; gateExecutor?: string; gateHost?: string; triggerEvent?: ReleaseRunInput['triggerEvent'] },
  deps: UnattendedReleaseDeps,
): Promise<{ input: ReleaseRunInput; dryRun: boolean; state?: GraphRunState }> {
  // RELEASE-BRANCH (10-06): the default cut is a release branch, so main keeps landing and the run no longer needs a
  // landing freeze. A freeze stays the emergency switch: when one is on, it still stops the run (`--force-freeze` overrides).
  // `--cut-commit` (an already-cut branch) and `--main-cut` keep the old main-bump path.
  const branchCut = opts.cutCommit === undefined && !opts.mainCut;
  if (opts.prerelease && !branchCut) throw new Error('--prerelease needs the release-branch cut (no --cut-commit / --main-cut): a rehearsal must never bump main');
  if (!opts.dryRun) {
    const frozen = readLandingFreeze(deps.freezeRoot);
    if (frozen) {
      debug.log('release.run', opts.forceFreeze ? 'freeze-forced' : 'frozen', { version: opts.version, reason: frozen.reason, until: frozen.until });
      if (!opts.forceFreeze) throw new LandingFrozenError(frozen);
    }
  }
  const version = resolveRunVersion(opts.version, opts.prerelease, deps);
  const input = buildReleaseRunInput(version, deps, opts.cutCommit, { executor: opts.gateExecutor, host: opts.gateHost });
  if (opts.triggerEvent) input.triggerEvent = opts.triggerEvent;
  if (opts.publishAt !== undefined) {
    const invalid = publishAtError(opts.publishAt);
    if (invalid) throw new Error(invalid);
    input.publishAt = new Date(opts.publishAt).toISOString();
  }
  if (opts.forceFreeze) input.forceFreeze = true;
  if (branchCut) input.branchCut = true;
  if (branchCut && opts.branchCutBaseCommit !== undefined) input.branchCutBaseCommit = opts.branchCutBaseCommit;
  debug.log('release.run', 'input', { version, requested: opts.version, branchCut, prerelease: opts.prerelease ?? null, dryRun: opts.dryRun === true,
    ...(input.gateExecutor ? { gateExecutor: input.gateExecutor, gateHost: input.gateExecutor === 'host' ? input.gateRemote ?? null : null } : {}) });
  if (opts.dryRun) return { input, dryRun: true };
  (deps.assertCliCurrent ?? assertReleaseCliCurrent)(REPOSITORY_ROOT, opts.cutCommit);
  if (opts.prerelease) {
    // A rehearsal neither judges nor carries the stable version's checklist cells.
    debug.log('release.run', 'checklist-skipped', { version, reason: 'prerelease' });
  } else {
    // Same judgement as the checklist-gate node: past the landing deadline non-P0 yellows carry; P0 yellows block.
    const gate = (deps.checklist ?? ((v: string) => cutChecklistGate(v, getSchedule(v)?.landBy)))(version);
    if (!gate.ok) throw new Error(`release checklist blocked: ${[...gate.red, ...gate.undecided, ...gate.blocked].join(', ')}`);
  }
  const beforeGraph = readLandingFreeze(deps.freezeRoot);
  if (beforeGraph && !opts.forceFreeze) throw new LandingFrozenError(beforeGraph);
  // RELEASE-LEDGER-UNIVERSE: one universe for the run ledger, the release ledger and every node subprocess.
  const root = releaseRunUniverse({ root: deps.ledgerRoot });
  // Resume and fresh runs share the OP-seat flock. Recheck under that flock so a
  // resume that began after CLI preflight cannot slip between the ledger scan and graph start.
  if (findActiveReleaseRun(version, root)) throw new ReleaseRunClaimConflict();
  const runInventory = listGraphRuns(root);
  if (runInventory.unreadable > 0) throw new Error(`cannot safely claim release ${version}: ${runInventory.unreadable} graph run ledger(s) are unreadable`);
  // Fan-out children (prefetch, checklist-gate, regression-suite) are separate release-loop
  // ledgers. Their graph still lists version-release, and a finished child is status=done.
  // Only a root — entry is version-release, no parent — may block or satisfy this launch.
  const priorRuns = runInventory.runs.filter((run) => run.graphId === 'release-loop'
    && run.parentRunId === undefined
    && (run.entryNodeId === undefined || run.entryNodeId === 'version-release')
    && run.path[0] === 'version-release'
    && !!run.input && typeof run.input === 'object' && !Array.isArray(run.input)
    && (run.input as Record<string, unknown>).version === version);
  const completed = priorRuns.find((run) => run.status === 'done' || run.status === 'awaiting-approval');
  if (completed) return { input, dryRun: false, state: completed };
  const budgetExceeded = priorRuns.find((run) => run.status === 'budget-exceeded');
  if (budgetExceeded && !opts.forceNew) throw new Error("release run " + budgetExceeded.runId + " exceeded its graph budget; explicit reasoned resume is required");
  if (!opts.forceNew && priorRuns.some((run) => run.status === 'running')) {
    throw new Error(`release run ${version} is recorded as running without an active owner; inspect it or use --force-new`);
  }
  const resumable = opts.forceNew ? undefined : priorRuns.find((run) => run.status === 'failed');
  if (resumable) {
    assertReleaseResumeCompatible(resumable.input, input, resumable.runId);
    assertReleaseCutCompatible(resumable, input);
  }
  const resumeFromNodeId = resumable ? releaseResumeBoundary(resumable) : undefined;
  const runId = resumable?.runId ?? randomUUID();
  await (deps.registerLogSink ?? registerStandaloneLogSink)('release-loop');
  const safeCleanup = createMacrophageSafeCleanup({ repoRoot: REPOSITORY_ROOT });
  const macrophage = createMacrophageRuntime({ runId, root, inventory: () => safeCleanup.inventory(), liveCleanup: safeCleanup.cleanup });
  let state: GraphRunState;
  try { state = await (deps.graph ?? runGraph)(deps.graphPath ?? GRAPH, resumable
    ? { resumeRunId: runId, fromNodeId: resumeFromNodeId, useCurrentGraph: true, input, resumeInputPatch: { ...(input.gateImagePin ? { gateImagePin: input.gateImagePin } : {}) },
      pinChildUniverse: true, eventBus: macrophage.eventBus, deps: { root, dispatchGraphSubscription: createIncidentPolicyHandler() } }
    : { runId, input, pinChildUniverse: true, eventBus: macrophage.eventBus, deps: { root, dispatchGraphSubscription: createIncidentPolicyHandler() } }); }
  finally { macrophage.dispose(); }
  // A freeze switched on while the graph ran stops gate or publish inside it. Only a failed gate/publish node whose own
  // record is the freeze refusal is reported as the freeze; any other failure keeps its own reason.
  if (state.status === 'failed' && !opts.forceFreeze) {
    const refused = (state.nodes ?? []).find((node) => (node.nodeId === 'gate' || node.nodeId === 'publish') && !node.ok
      && isLandingFreezeRefusal(`${typeof node.output === 'string' ? node.output : JSON.stringify(node.output ?? '')} ${node.error ?? ''}`));
    const during = refused ? readLandingFreeze(deps.freezeRoot) : null;
    if (refused) throw new LandingFrozenError(during ?? { reason: 'frozen during the run', startedAt: new Date().toISOString(), until: null, by: 'release-run' });
  }
  if (state.status === 'done') {
    try {
      (deps.refreshScorecard ?? refreshRlaScorecardForCompletedRun)(runId, root);
    } catch (error) {
      debug.log('release.run', 'rla-scorecard-refresh-failed', { runId, version, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { input, dryRun: false, state };
}
