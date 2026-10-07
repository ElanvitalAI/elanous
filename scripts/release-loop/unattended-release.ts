import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { userConfigPath } from '../../src/user-config.js';
import { cutChecklistGate } from '../../src/release-loop/checklist.js';
import { getSchedule } from '../../src/release-loop/release-schedule.js';
import { isLandingFreezeRefusal, readLandingFreeze, LandingFrozenError } from '../../src/release-loop/landing-freeze.js';
import { debug } from '../../src/debug/log.js';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { baseVersion, isStableVersion, nextPrereleaseVersion, type PrereleaseKind } from './release-version.js';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');

export interface ReleaseLoopConfig {
  gatePodPool?: string;
  gatePodBunCache?: string;
  gatePodShards?: number;
  gatePodShardTimeoutSeconds?: number;
  gateRemote?: string;
  gateRemoteMirror?: string;
  opsHosts?: string[];
  internalDist?: string;
  opsRestart?: boolean;
}

export interface ReleaseRunInput extends ReleaseLoopConfig {
  version: string;
  previousVersion: string;
  cutCommit?: string;
  gatePodPool: string;
  forceFreeze?: boolean;
  /** RELEASE-BRANCH: version-release cuts release/<v> from main HEAD and bumps only the branch. */
  branchCut?: boolean;
}

export interface UnattendedReleaseDeps {
  ledgerRoot?: string;
  config?: ReleaseLoopConfig;
  configPath?: string;
  graph?: (path: string, options: { input: ReleaseRunInput }) => Promise<GraphRunState>;
  checklist?: (version: string) => Pick<ReturnType<typeof cutChecklistGate>, 'ok' | 'red' | 'undecided' | 'blocked'>;
  freezeRoot?: string;
  /** Names already taken for prerelease numbering (remote release branches and tags). */
  releaseRefs?: (base: string, kind: PrereleaseKind) => string[];
}

/** Remote `release/<base>-<kind>.*` branches and `v<base>-<kind>.*` tags — read-only. */
export function remoteReleaseRefs(base: string, kind: PrereleaseKind, repo = process.cwd()): string[] {
  // git-spawn-allow: read-only ls-remote to number a prerelease.
  const result = spawnSync('git', ['ls-remote', 'origin', `refs/heads/release/${base}-${kind}.*`, `refs/tags/v${base}-${kind}.*`], { cwd: repo, encoding: 'utf8' });
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

export function buildReleaseRunInput(version: string, deps: UnattendedReleaseDeps = {}, cutCommit?: string): ReleaseRunInput {
  const config = deps.config ?? releaseLoopConfig(deps.configPath);
  const pool = config.gatePodPool;
  if (typeof pool !== 'string' || !pool.trim()) throw new Error('release.loop.gatePodPool is required before graph execution');
  const previousVersion = latestPublishedPreviousVersion(baseVersion(version), deps.ledgerRoot);
  return {
    ...config,
    version, previousVersion,
    ...(cutCommit !== undefined ? { cutCommit } : {}),
    gatePodPool: pool.trim(),
  };
}

/** Fail closed at the entry boundary, before any graph node can change a release. */
export async function runUnattendedRelease(
  opts: { version: string; dryRun?: boolean; cutCommit?: string; forceFreeze?: boolean; mainCut?: boolean; prerelease?: PrereleaseKind },
  deps: UnattendedReleaseDeps = {},
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
  const input = buildReleaseRunInput(version, deps, opts.cutCommit);
  if (opts.forceFreeze) input.forceFreeze = true;
  if (branchCut) input.branchCut = true;
  debug.log('release.run', 'input', { version, requested: opts.version, branchCut, prerelease: opts.prerelease ?? null, dryRun: opts.dryRun === true });
  if (opts.dryRun) return { input, dryRun: true };
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
  const state = await (deps.graph ?? runGraph)(GRAPH, { input });
  // A freeze switched on while the graph ran stops gate or publish inside it. Only a failed gate/publish node whose own
  // record is the freeze refusal is reported as the freeze; any other failure keeps its own reason.
  if (state.status === 'failed' && !opts.forceFreeze) {
    const refused = (state.nodes ?? []).find((node) => (node.nodeId === 'gate' || node.nodeId === 'publish') && !node.ok
      && isLandingFreezeRefusal(`${typeof node.output === 'string' ? node.output : JSON.stringify(node.output ?? '')} ${node.error ?? ''}`));
    const during = refused ? readLandingFreeze(deps.freezeRoot) : null;
    if (refused) throw new LandingFrozenError(during ?? { reason: 'frozen during the run', startedAt: new Date().toISOString(), until: null, by: 'release-run' });
  }
  return { input, dryRun: false, state };
}
