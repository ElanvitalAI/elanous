/** A hard rehearsal's immutable gate evidence may select the next release's cut tests, but never authorizes a carry. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { changedFilesBetween, planPartialRegate, testFileOfId, type PartialPlan } from './gate-partial.js';
import { CODE_FILE, gitClosureTree, testsReachingChanged } from './gate-closure.js';
import { versionOnlyBumps } from './gate-radius-shadow.js';
import { gateAssignableTestsAtCommit, gateBaselineReceipt, gateEnvFingerprint, type GateBaselineReceipt, type GateBaselineRecheck,
  type GatePodRuntimeIdentity } from './gate-baseline-receipt.js';
import { defaultRemoteRun, NODE_REGISTRY, parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { podCommandImageFor } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { gateTestBaseline } from '../lib/gate-test-env.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const TEST = /\.test\.(?:tsx?|jsx?|mts|cts)$/;
export const HARD_REHEARSAL_POD_SHARDS = 12;

export function hardRehearsalGateVersion(version: string, runId: string): string {
  const id = /^hard-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(runId)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !id) throw new Error('invalid hard rehearsal gate identity');
  return `${version}-rc.${BigInt(`0x${id.replaceAll('-', '')}`).toString(10)}`;
}

export function hardRehearsalGateArgs(version: string, runId: string, commit: string, previous: string, pool: string): string[] {
  return ['scripts/release-loop/gate-node-cli.ts', '--commit', commit, '--version', hardRehearsalGateVersion(version, runId),
    '--baseline-version', previous, '--run-id', runId, '--executor', 'pod', '--pod-pool', pool, '--pod-shards', String(HARD_REHEARSAL_POD_SHARDS), '--rehearsal-baseline', '--json'];
}

export interface LiveRadiusDecision { plan: PartialPlan | null; reason: string; rehearsalRunId?: string }

export interface GatePodExecutionIdentity extends GatePodRuntimeIdentity { imageDigest: string }

export interface HardRehearsalRecheckResult {
  file: string;
  outcome: 'pass' | 'fail' | 'unmeasured';
}

export interface HardRehearsalRecheck {
  runId: string;
  commit: string;
  graphSha: string;
  recipeSha: string;
  envFingerprint: string;
  imageDigest: string;
  executionIdentity: GatePodExecutionIdentity;
  results: readonly HardRehearsalRecheckResult[];
}

/**
 * Merge a focused same-commit run into a full hard-rehearsal receipt only when its observed
 * runtime identity matches the full sweep and it proves every previously failing file passed.
 */
export function mergeHardRehearsalRecheck(input: { receipt: GateBaselineReceipt; priorFailures: readonly string[];
  priorErrors: readonly string[]; recheck: HardRehearsalRecheck }): {
  accepted: boolean; reason: string; receipt: GateBaselineReceipt; failures: string[]; errors: string[];
} {
  const priorFailures = Array.isArray(input?.priorFailures) ? [...input.priorFailures] as string[] : input?.priorFailures as unknown as string[];
  const priorErrors = Array.isArray(input?.priorErrors) ? [...input.priorErrors] as string[] : input?.priorErrors as unknown as string[];
  const unchanged = (reason: string) => ({ accepted: false, reason, receipt: input.receipt,
    failures: Array.isArray(priorFailures) ? [...priorFailures] : priorFailures,
    errors: Array.isArray(priorErrors) ? [...priorErrors] : priorErrors });
  try {
    const { receipt, recheck } = input;
    const validFile = (file: unknown): file is string => typeof file === 'string'
      && /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)
      && !file.split('/').some((part) => part === '.' || part === '..');
    const validRuntimeIdentity = (value: unknown): value is GatePodRuntimeIdentity => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as Partial<GatePodRuntimeIdentity>;
      return typeof row.bunVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(row.bunVersion)
        && typeof row.platform === 'string' && /^[a-z0-9_-]{1,32}$/.test(row.platform)
        && typeof row.architecture === 'string' && /^[a-z0-9_-]{1,32}$/.test(row.architecture)
        && typeof row.envFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(row.envFingerprint)
        && typeof row.baseImageDigest === 'string' && DIGEST.test(row.baseImageDigest);
    };
    const validExecutionIdentity = (value: unknown): value is GatePodExecutionIdentity => !!value
      && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as Partial<GatePodExecutionIdentity>).imageDigest === 'string'
      && DIGEST.test((value as Partial<GatePodExecutionIdentity>).imageDigest!) && validRuntimeIdentity(value);
    const baselineDigest = (receipt.executionIdentity as GatePodRuntimeIdentity & { imageDigest?: string } | null)?.imageDigest;
    if (!receipt.valid || receipt.schema !== 2 || !SHA.test(receipt.commit) || receipt.commit !== receipt.head40
      || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(receipt.version)
      || !receipt.graphSha || !/^[0-9a-f]{64}$/i.test(receipt.graphSha)
      || !receipt.recipeSha || !/^[0-9a-f]{64}$/i.test(receipt.recipeSha)
      || !/^[0-9a-f]{64}$/i.test(receipt.envFingerprint)
      || !receipt.imageDigest || !DIGEST.test(receipt.imageDigest)
      || !Number.isSafeInteger(receipt.files) || receipt.files < 1
      || !Number.isSafeInteger(receipt.shards) || receipt.shards < 1)
      return unchanged('full-sweep receipt identity is malformed');
    if (!validRuntimeIdentity(receipt.executionIdentity)) return unchanged('full-sweep runtime identity is malformed');
    if (receipt.executionIdentity.envFingerprint !== receipt.envFingerprint)
      return unchanged('full-sweep runtime environment differs from receipt');
    if (baselineDigest !== undefined && (!DIGEST.test(baselineDigest) || baselineDigest.toLowerCase() !== receipt.imageDigest.toLowerCase()))
      return unchanged('full-sweep runtime image differs from receipt');
    if (!Array.isArray(receipt.fileInventory) || receipt.fileInventory.length !== receipt.files
      || !receipt.fileInventory.every(validFile) || new Set(receipt.fileInventory).size !== receipt.fileInventory.length)
      return unchanged('full-sweep file inventory is malformed');
    const inventory = new Set(receipt.fileInventory);
    if (!recheck || typeof recheck !== 'object' || Array.isArray(recheck)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(recheck.runId) || !SHA.test(recheck.commit)
      || recheck.commit !== receipt.commit || recheck.commit !== receipt.head40)
      return unchanged('focused run commit or run identity differs');
    if (!Array.isArray(input.priorFailures) || !input.priorFailures.every((id) => typeof id === 'string')
      || !Array.isArray(input.priorErrors) || !input.priorErrors.every((id) => typeof id === 'string'))
      return unchanged('prior failure inventory is malformed');
    if (!/^[0-9a-f]{64}$/i.test(recheck.graphSha) || !/^[0-9a-f]{64}$/i.test(recheck.recipeSha)
      || !/^[0-9a-f]{64}$/i.test(recheck.envFingerprint) || !DIGEST.test(recheck.imageDigest)
      || recheck.graphSha !== receipt.graphSha || recheck.recipeSha !== receipt.recipeSha
      || recheck.envFingerprint !== receipt.envFingerprint || recheck.imageDigest.toLowerCase() !== receipt.imageDigest.toLowerCase())
      return unchanged('focused run graph, recipe, environment or image differs');
    const runtime = recheck.executionIdentity;
    const baseline = receipt.executionIdentity;
    if (!validExecutionIdentity(runtime) || runtime.imageDigest.toLowerCase() !== receipt.imageDigest.toLowerCase()
      || runtime.bunVersion !== baseline.bunVersion || runtime.platform !== baseline.platform
      || runtime.architecture !== baseline.architecture || runtime.envFingerprint !== baseline.envFingerprint
      || runtime.baseImageDigest !== baseline.baseImageDigest)
      return unchanged('focused run runtime identity differs');
    if (!Array.isArray(recheck.results) || recheck.results.some((result) => !result || typeof result !== 'object'
      || !validFile(result.file) || !['pass', 'fail', 'unmeasured'].includes(result.outcome)))
      return unchanged('focused run result inventory is malformed');
    if (!Array.isArray(receipt.rechecks ?? []) || (receipt.rechecks ?? []).some((row) => !row || typeof row.runId !== 'string'))
      return unchanged('prior focused-run evidence is malformed');
    if ((receipt.rechecks ?? []).some((row) => row.runId === recheck.runId)) return unchanged('focused run already recorded');
    if (!priorFailures.length && !priorErrors.length) return unchanged('no failed files to recheck');
    const results = new Map<string, HardRehearsalRecheckResult['outcome']>();
    for (const result of recheck.results) {
      if (!inventory.has(result.file) || results.has(result.file)) return unchanged('focused run file inventory is invalid');
      results.set(result.file, result.outcome);
    }
    if (!results.size || [...results.values()].some((outcome) => outcome !== 'pass'))
      return unchanged('focused run did not pass every measured file');
    const failedFiles: Set<string> = new Set([...priorFailures, ...priorErrors].map(testFileOfId));
    if ([...failedFiles].some((file) => !inventory.has(file))) return unchanged('prior failure is outside the full-sweep inventory');
    if ([...failedFiles].some((file) => results.get(file) !== 'pass'))
      return unchanged('focused run did not pass every previously failing file');
    const remaining = (ids: readonly string[]) => ids.filter((id) => !failedFiles.has(testFileOfId(id)));
    const evidence: GateBaselineRecheck = {
      runId: recheck.runId, commit: recheck.commit, graphSha: recheck.graphSha, recipeSha: recheck.recipeSha,
      envFingerprint: recheck.envFingerprint, imageDigest: recheck.imageDigest.toLowerCase(),
      executionIdentity: { bunVersion: runtime.bunVersion, platform: runtime.platform, architecture: runtime.architecture,
        envFingerprint: runtime.envFingerprint, baseImageDigest: runtime.baseImageDigest },
      files: [...results.keys()].sort(),
    };
    return { accepted: true, reason: 'same-identity focused pass merged into full-sweep receipt',
      receipt: { ...receipt, rechecks: [...(receipt.rechecks ?? []), evidence] },
      failures: remaining(priorFailures), errors: remaining(priorErrors) };
  } catch { return unchanged('focused run input is malformed'); }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Registry v2 manifest digest is the identity Kubernetes reports in containerStatuses.imageID. */
export function parseGateRepoDigestResponse(headers: string): string | null {
  const match = /^docker-content-digest:\s*(sha256:[0-9a-f]{64})\s*$/im.exec(headers);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface GateRepoDigestProbeRequest { url: string; acceptHeader: string; command: string }

export function gateRepoDigestProbeRequest(registry: string, image: string, commit: string): GateRepoDigestProbeRequest | null {
  const port = /:(\d+)$/.exec(registry)?.[1];
  if (!port || !SHA.test(commit)) return null;
  const imageName = image.startsWith('elanous-harness-lite:') ? 'elanous-harness-lite' : 'elanous-harness';
  const tag = commit.slice(0, 12);
  const url = `http://localhost:${port}/v2/${imageName}/manifests/${tag}`;
  const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
  const acceptHeader = `Accept: ${accept}`;
  return { url, acceptHeader, command: `curl -fsS --max-time 8 -D - -o /dev/null -H ${shellQuote(acceptHeader)} ${shellQuote(url)}` };
}

function probeGateRepoDigest(member: ReturnType<typeof parsePodPool>[number], image: string, commit: string): string | null {
  const registry = member.registry ?? NODE_REGISTRY;
  const request = gateRepoDigestProbeRequest(registry, image, commit);
  if (!request) return null;
  const result = member.sshHost
    ? defaultRemoteRun(member.sshHost, request.command)
    : spawnSync('curl', ['-fsS', '--max-time', '8', '-D', '-', '-o', '/dev/null', '-H', request.acceptHeader, request.url],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  return result.status === 0 ? parseGateRepoDigestResponse(result.stdout) : null;
}

function gateRegistryHostImage(member: ReturnType<typeof parsePodPool>[number], image: string, commit: string): string | null {
  const registry = member.registry ?? NODE_REGISTRY;
  const port = /:(\d+)$/.exec(registry)?.[1];
  if (!port) return null;
  const imageName = image.startsWith('elanous-harness-lite:') ? 'elanous-harness-lite' : 'elanous-harness';
  return `localhost:${port}/${imageName}:${commit.slice(0, 12)}`;
}

/** Read the dependency-layer identity from the exact pinned image's OCI config label. */
function probeGateBaseImageDigest(member: ReturnType<typeof parsePodPool>[number], imageRef: string): string | null {
  const format = '{{index .Config.Labels "elanous.base-image-digest"}}';
  const command = `docker image inspect ${shellQuote(imageRef)} --format '${format}'`;
  const result = member.sshHost ? defaultRemoteRun(member.sshHost, command)
    : spawnSync('docker', ['image', 'inspect', imageRef, '--format', format],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return DIGEST.test(value) ? value.toLowerCase() : null;
}

/** Every selected pool must prove the same valid label; missing metadata only disables reuse. */
export function preflightGateBaseImageDigest(pool: string, commit: string, pinnedImageDigest: string): string | null {
  try {
    if (!SHA.test(commit) || !DIGEST.test(pinnedImageDigest)) return null;
    const image = podCommandImageFor([], true);
    const members = parsePodPool(pool);
    if (!members.length) return null;
    const rows = members.map((member) => {
      const registry = member.registry ?? NODE_REGISTRY;
      const port = /:(\d+)$/.exec(registry)?.[1];
      if (!port) return null;
      const imageName = image.startsWith('elanous-harness-lite:') ? 'elanous-harness-lite' : 'elanous-harness';
      return probeGateBaseImageDigest(member, `localhost:${port}/${imageName}@${pinnedImageDigest}`);
    });
    return rows[0] && rows.every((row) => row === rows[0]) ? rows[0] : null;
  } catch { return null; }
}

/** Read the immutable pushed image manifest on every candidate host. Local Docker Image IDs are diagnostic only. */
export function preflightGateImageDigest(pool: string, commit?: string): string | null {
  try {
    if (!commit || !SHA.test(commit)) return null;
    const image = podCommandImageFor([], true);
    const members = parsePodPool(pool);
    if (!members.length) return null;
    const digests = members.map((member) => probeGateRepoDigest(member, image, commit));
    return digests.every((digest) => digest && DIGEST.test(digest) && digest === digests[0]) ? digests[0]! : null;
  } catch { return null; }
}

/** Probe each candidate's exact gate image/runtime and deterministic environment without a Kubernetes Job. */
export function preflightGateExecutionIdentity(pool: string, env: NodeJS.ProcessEnv, commit?: string, expectedImageDigest?: string): GatePodExecutionIdentity | null {
  try {
    if (!commit || !SHA.test(commit)) return null;
    const image = podCommandImageFor([], true);
    const members = parsePodPool(pool);
    if (!members.length) return null;
    const baseline = gateTestBaseline(env);
    const expectedEnvFingerprint = gateEnvFingerprint(env);
    const script = "const {createHash}=require('node:crypto');const keys=['ELANOUS_TEST_FAKE_LLM','LANG','LC_ALL','TZ'];const e=Object.fromEntries(keys.sort().map(k=>[k,process.env[k]??'']));const envFingerprint=createHash('sha256').update(JSON.stringify(e)).digest('hex');console.log(JSON.stringify({bunVersion:Bun.version,platform:process.platform,architecture:process.arch,envFingerprint,baseImageDigest:process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST??''}));";
    const rows = members.map((member): GatePodExecutionIdentity | null => {
      const imageDigest = probeGateRepoDigest(member, image, commit);
      if (!imageDigest || !DIGEST.test(imageDigest) || (expectedImageDigest && imageDigest !== expectedImageDigest)) return null;
      const registry = member.registry ?? NODE_REGISTRY;
      const port = /:(\d+)$/.exec(registry)?.[1];
      if (!port) return null;
      const imageName = image.startsWith('elanous-harness-lite:') ? 'elanous-harness-lite' : 'elanous-harness';
      const pinnedImage = `localhost:${port}/${imageName}@${imageDigest}`;
      const baseImageDigest = probeGateBaseImageDigest(member, pinnedImage);
      if (!baseImageDigest) return null;
      const args = ['run', '--rm', '--pull=never', '--network=none', ...Object.entries({ ...baseline,
        ELANOUS_GATE_BASE_IMAGE_DIGEST: baseImageDigest }).flatMap(([key, value]) => ['-e', `${key}=${value}`]), '--entrypoint', 'bun', pinnedImage, '-e', script];
      const result = member.sshHost
        ? defaultRemoteRun(member.sshHost, `docker ${args.map(shellQuote).join(' ')}`)
        : spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (result.status !== 0) return null;
      try {
        const row = JSON.parse(result.stdout.trim()) as Partial<GatePodRuntimeIdentity>;
        if (typeof row.bunVersion !== 'string' || typeof row.platform !== 'string' || typeof row.architecture !== 'string'
          || row.envFingerprint !== expectedEnvFingerprint || row.baseImageDigest !== baseImageDigest) return null;
        return { imageDigest, bunVersion: row.bunVersion, platform: row.platform, architecture: row.architecture,
          envFingerprint: row.envFingerprint, baseImageDigest: row.baseImageDigest };
      } catch { return null; }
    });
    if (rows.some((row) => row === null)) return null;
    const first = rows[0]!;
    return rows.every((row) => JSON.stringify(row) === JSON.stringify(first)) ? first : null;
  } catch { return null; }
}

/** The current sweep ID and exact root inventory prevent stale Pod logs from proving a new partial run's image. */
export function partialGateImagesMatch(root: string, version: string, digest: string, commit: string,
  sweep: { id: string; shards: number; files: readonly string[] } | undefined): boolean {
  if (!SHA.test(commit) || !sweep || !/^[0-9a-f-]{36}$/i.test(sweep.id)
    || !Number.isSafeInteger(sweep.shards) || sweep.shards < 1) return false;
  try {
    const dir = join(root, 'release', version, 'gate-logs', 'cut-partial');
    const names = readdirSync(dir).filter((name) => /^pod-\d+(?:-[\w-]+)?\.json$/.test(name));
    const allRows = names.map((name) => ({ name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      commit?: string; sweepId?: string; shardCount?: number; files?: unknown; imageDigest?: string;
      attemptId?: string; parentAttempt?: string } }));
    const rows = allRows.filter((row) => row.sweepId === sweep.id);
    const roots = rows.filter((row) => /^pod-\d+\.json$/.test(row.name));
    if (roots.length !== sweep.shards || roots.some((row) => row.shardCount !== sweep.shards
      || row.commit !== commit || !Array.isArray(row.files) || !row.attemptId || row.imageDigest !== digest)) return false;
    if (allRows.some((row) => /^pod-\d+\.json$/.test(row.name)
      && row.commit === commit && row.sweepId !== sweep.id)) return false;
    if (allRows.some((row) => row.commit === commit && !row.sweepId)) return false;
    const indices = roots.map((row) => Number(/^pod-(\d+)\.json$/.exec(row.name)![1]));
    if (new Set(indices).size !== sweep.shards || indices.some((index) => index < 0 || index >= sweep.shards)) return false;
    const files = roots.flatMap((row) => row.files as string[]);
    if (files.some((file) => typeof file !== 'string')
      || JSON.stringify(files.sort()) !== JSON.stringify([...sweep.files].sort())) return false;
    const attempts = new Set(roots.map((row) => row.attemptId));
    let pending = allRows.filter((row) => !/^pod-\d+\.json$/.test(row.name));
    for (let count = 0; pending.length && count < allRows.length; count++) {
      const connected = pending.filter((row) => row.parentAttempt && attempts.has(row.parentAttempt));
      if (!connected.length) break;
      if (connected.some((row) => row.sweepId !== sweep.id || row.commit !== commit
        || !row.attemptId || row.imageDigest !== digest)) return false;
      for (const row of connected) attempts.add(row.attemptId);
      pending = pending.filter((row) => !connected.includes(row));
    }
    return !pending.some((row) => row.sweepId === sweep.id || (row.commit === commit && !row.sweepId));
  } catch { return false; }
}

/** Every missing or mismatched proof returns a full gate. The caller uses this only when no explicit resume plan exists. */
export function planHardRehearsalRadius(input: { root: string; repo: string; version: string; forCommit: string;
  graphPins: { graphSha: string; recipeSha: string } | null; envFingerprint: string;
  imageDigest: string | null; executionIdentity: GatePodExecutionIdentity | null }): LiveRadiusDecision {
  const full = (reason: string): LiveRadiusDecision => ({ plan: null, reason });
  if (!/^\d+\.\d+\.\d+$/.test(input.version) || !SHA.test(input.forCommit)) return full('invalid release identity');
  if (!input.graphPins || !/^[0-9a-f]{64}$/i.test(input.envFingerprint) || !input.imageDigest || !DIGEST.test(input.imageDigest)
    || !input.executionIdentity || input.executionIdentity.imageDigest !== input.imageDigest.toLowerCase()
    || typeof input.executionIdentity.baseImageDigest !== 'string' || !DIGEST.test(input.executionIdentity.baseImageDigest)
    || input.executionIdentity.envFingerprint !== input.envFingerprint
    || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(input.executionIdentity.bunVersion)
    || !/^[a-z0-9_-]{1,32}$/.test(input.executionIdentity.platform)
    || !/^[a-z0-9_-]{1,32}$/.test(input.executionIdentity.architecture))
    return full('current graph, environment or Pod image identity unmeasured');
  try {
    const stamps = ['hard-5h', 'hard-mid'].map((step) => {
      const path = join(input.root, 'release', input.version, 'rehearsal', `${step}.json`);
      if (!existsSync(path)) return null;
      const stamp = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: string; step?: string; outcome?: string; sha?: string; endedAt?: string; hardGateRunId?: string;
        hardGate?: { commit?: string; executor?: string; outcome?: string; introduced?: unknown[] };
      };
      return { step, stamp, ended: Date.parse(stamp.endedAt ?? '') };
    }).filter((row): row is NonNullable<typeof row> => row !== null);
    if (!stamps.length) return full('no clean hard rehearsal receipt');
    if (stamps.some((row) => !Number.isFinite(row.ended))) return full('hard rehearsal completion time unmeasured');
    stamps.sort((a, b) => b.ended - a.ended);
    if (stamps.length > 1 && stamps[0]!.ended === stamps[1]!.ended) return full('hard rehearsal order ambiguous');
    for (const { step, stamp } of stamps.slice(0, 1)) {
      if (stamp.version !== input.version || stamp.step !== step || !(stamp.outcome === 'ok' || stamp.outcome === 'regression') || !stamp.sha || !SHA.test(stamp.sha)
        || !(stamp.hardGate?.outcome === 'ok' || stamp.hardGate?.outcome === 'fail' || stamp.hardGate?.outcome === 'regression') || stamp.hardGate.commit !== stamp.sha || stamp.hardGate.executor !== 'pod'
        || !Array.isArray(stamp.hardGate.introduced))
        return full('latest hard rehearsal is not clean');
      let gateVersion: string;
      try { gateVersion = hardRehearsalGateVersion(input.version, stamp.hardGateRunId ?? ''); }
      catch { return full('hard rehearsal run identity invalid'); }
      const dir = join(input.root, 'release', gateVersion);
      const verdict = JSON.parse(readFileSync(join(dir, 'gate-verdict.json'), 'utf8')) as {
        commit?: string; outcome?: string; baselineReceipt?: GateBaselineReceipt };
      const receipt = verdict.baselineReceipt;
      if (verdict.commit !== stamp.sha || !(verdict.outcome === 'ok' || verdict.outcome === 'regression' || verdict.outcome === 'fail')
        || !receipt || receipt.schema !== 2 || !receipt.valid || receipt.version !== gateVersion || receipt.commit !== stamp.sha
        || receipt.graphSha !== input.graphPins.graphSha || receipt.recipeSha !== input.graphPins.recipeSha
        || receipt.envFingerprint !== input.envFingerprint || receipt.imageDigest !== input.imageDigest.toLowerCase()
        || !receipt.executionIdentity
        || JSON.stringify(receipt.executionIdentity) !== JSON.stringify({ bunVersion: input.executionIdentity.bunVersion,
          platform: input.executionIdentity.platform, architecture: input.executionIdentity.architecture,
          envFingerprint: input.executionIdentity.envFingerprint, baseImageDigest: input.executionIdentity.baseImageDigest })
        || !Number.isSafeInteger(receipt.files) || receipt.files < 1 || !Number.isSafeInteger(receipt.shards) || receipt.shards < 1)
        return full('hard rehearsal receipt or current execution identity differs');
      const recomputed = gateBaselineReceipt({ root: input.root, version: gateVersion, commit: stamp.sha,
        fullSweep: true, graphPins: input.graphPins, envFingerprint: input.envFingerprint, artifactPath: receipt.artifactPath });
      if (!recomputed.valid || recomputed.imageDigest !== receipt.imageDigest
        || JSON.stringify(recomputed.executionIdentity) !== JSON.stringify(receipt.executionIdentity) || recomputed.files !== receipt.files
        || recomputed.shards !== receipt.shards) return full(`hard rehearsal Pod proof differs: ${recomputed.reason}`);
      const artifactRoot = join(input.root, receipt.artifactPath ?? join('release', gateVersion));
      const failures = JSON.parse(readFileSync(join(artifactRoot, 'gate-failures.json'), 'utf8')) as {
        commit?: string; failures?: string[]; errors?: string[] };
      if (failures.commit !== stamp.sha || !Array.isArray(failures.failures)
        || !Array.isArray(failures.errors)
        || [...failures.failures, ...failures.errors].some((id) => typeof id !== 'string'))
        return full('hard rehearsal failure inventory differs');
      const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', stamp.sha, input.forCommit], { cwd: input.repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (ancestor.status !== 0 || ancestor.error) return full('hard rehearsal commit is not an ancestor');
      const expectedFiles = gateAssignableTestsAtCommit(input.repo, stamp.sha);
      const receiptCutDir = join(artifactRoot, 'gate-logs', 'cut');
      const measuredFiles = readdirSync(receiptCutDir).filter((name) => /^pod-\d+\.json$/.test(name))
        .flatMap((name) => {
          const row = JSON.parse(readFileSync(join(receiptCutDir, name), 'utf8')) as { files?: unknown };
          return Array.isArray(row.files) ? row.files : [];
        });
      if (!expectedFiles || JSON.stringify(measuredFiles.sort()) !== JSON.stringify(expectedFiles)
        || measuredFiles.length !== receipt.files)
        return full('hard rehearsal file inventory differs from receipt');
      // A validated clean full-sweep receipt for the exact cut SHA already measures every test at that SHA.
      // Keep an explicit empty carry plan so the caller skips the cut sweep instead of treating an empty radius
      // as missing evidence and silently running the entire suite again.
      if (stamp.sha === input.forCommit && (failures.failures.length || failures.errors.length)) {
        let failedFiles: string[];
        try { failedFiles = [...new Set([...failures.failures, ...failures.errors].map(testFileOfId))].sort(); }
        catch { return full('hard rehearsal failure ids unreadable'); }
        if (failedFiles.some((file) => !expectedFiles.includes(file))) return full('hard rehearsal failure is outside measured inventory');
        return { plan: { version: input.version, priorCommit: stamp.sha, forCommit: input.forCommit, files: failedFiles,
          priorFailures: failures.failures, priorErrors: failures.errors },
          reason: `same-head rehearsal receipt verified; re-measure ${failedFiles.length} failed or errored file(s) only`, rehearsalRunId: stamp.hardGateRunId };
      }
      if (stamp.sha === input.forCommit) return { plan: { kind: 'carry', version: input.version, priorCommit: stamp.sha,
        forCommit: input.forCommit, files: [], priorFailures: [], priorErrors: [] },
        reason: 'same-head clean rehearsal receipt verified; zero tests rerun', rehearsalRunId: stamp.hardGateRunId };
      const tree = gitClosureTree(input.repo, input.forCommit);
      const tests = tree.files.filter((file) => TEST.test(file));
      const changed = changedFilesBetween(input.repo, stamp.sha, input.forCommit);
      const bumps = versionOnlyBumps(input.repo, stamp.sha, input.forCommit, input.version, changed);
      const effective = changed.filter((file) => !bumps.includes(file));
      // A version-only JSON/lock bump is still observable to tests that read it. Follow those literal readers and
      // opaque tests before removing the bump from the ordinary code-only partial planner.
      const versionEnvReaders = bumps.includes('package.json')
        ? tree.files.filter((file) => CODE_FILE.test(file) && tree.read(file)?.includes('npm_package_version')) : [];
      const bumpRadius = bumps.length ? testsReachingChanged(tree, [...bumps, ...versionEnvReaders], tests) : null;
      if (bumpRadius && !bumpRadius.ok) return full(bumpRadius.reason);
      const planned = planPartialRegate({ version: input.version, priorCommit: stamp.sha, forCommit: input.forCommit,
        changedFiles: effective, priorFailures: failures.failures, priorErrors: failures.errors ?? [],
        existsAtTip: (file) => tree.files.includes(file),
        closure: (code) => testsReachingChanged(tree, code, tests),
        priorCutLogs: receiptCutDir });
      if (!planned.ok && (effective.length || planned.reason.startsWith('executed-pod-image-digest-')))
        return full(planned.reason);
      let fileSet: string[];
      let base: PartialPlan;
      if (planned.ok) {
        if (planned.plan.kind === 'carry' && !bumpRadius?.ok) return full('docs-only carry requires full gate across releases');
        base = planned.plan.kind === 'carry' ? { ...planned.plan, kind: undefined } : planned.plan;
        fileSet = planned.plan.files;
      } else {
        let priorFiles: string[];
        try { priorFiles = [...failures.failures, ...(failures.errors ?? [])].map(testFileOfId); }
        catch { return full('hard rehearsal failure ids unreadable'); }
        base = { version: input.version, priorCommit: stamp.sha, forCommit: input.forCommit,
          files: [], priorFailures: failures.failures, priorErrors: failures.errors ?? [] };
        fileSet = priorFiles;
      }
      const files = [...new Set([...fileSet, ...(bumpRadius?.ok ? bumpRadius.tests : [])])].sort();
      if (!files.length || files.some((file) => !tests.includes(file))) return full('empty or missing rehearsal radius requires full gate');
      return { plan: { ...base, files }, reason: 'hard rehearsal receipt and import radius verified', rehearsalRunId: stamp.hardGateRunId };
    }
    return full('no clean hard rehearsal receipt');
  } catch (error) { return full(`hard rehearsal evidence unreadable: ${String(error)}`); }
}
