import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { userConfigPath } from '../../src/user-config.js';
import { checklistGate } from '../../src/release-loop/checklist.js';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';

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
  gatePodPool: string;
}

export interface UnattendedReleaseDeps {
  ledgerRoot?: string;
  config?: ReleaseLoopConfig;
  configPath?: string;
  graph?: (path: string, options: { input: ReleaseRunInput }) => Promise<GraphRunState>;
  checklist?: typeof checklistGate;
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

export function buildReleaseRunInput(version: string, deps: UnattendedReleaseDeps = {}): ReleaseRunInput {
  const config = deps.config ?? releaseLoopConfig(deps.configPath);
  const pool = config.gatePodPool;
  if (typeof pool !== 'string' || !pool.trim()) throw new Error('release.loop.gatePodPool is required before graph execution');
  const previousVersion = latestPublishedPreviousVersion(version, deps.ledgerRoot);
  return {
    ...config,
    version, previousVersion,
    gatePodPool: pool.trim(),
  };
}

/** Fail closed at the entry boundary, before any graph node can change a release. */
export async function runUnattendedRelease(
  opts: { version: string; dryRun?: boolean },
  deps: UnattendedReleaseDeps = {},
): Promise<{ input: ReleaseRunInput; dryRun: boolean; state?: GraphRunState }> {
  const input = buildReleaseRunInput(opts.version, deps);
  if (opts.dryRun) return { input, dryRun: true };
  const gate = (deps.checklist ?? checklistGate)(opts.version);
  if (!gate.ok) throw new Error(`release checklist blocked: ${[...gate.red, ...gate.undecided, ...gate.blocked].join(', ')}`);
  const state = await (deps.graph ?? runGraph)(GRAPH, { input });
  return { input, dryRun: false, state };
}
