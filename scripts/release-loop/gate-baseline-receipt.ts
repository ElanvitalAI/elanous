/** A full gate's reusable identity. Missing evidence is recorded, never promoted to a clean baseline. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gateTestBaseline } from '../lib/gate-test-env.js';

const SHA256 = /^[0-9a-f]{64}$/i;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/i;
export const POD_SWEEP_INTEGRATION_ONLY: readonly string[] = ['scripts/install.test.ts', 'scripts/review-model-ab.test.ts'];

/** Reconstruct the producer's tracked test selection at its pinned commit. Missing Git evidence is not a smaller set. */
export function gateAssignableTestsAtCommit(repo: string, commit: string): string[] | null {
  if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
  const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', commit], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const cdp = spawnSync('git', ['grep', '-l', '-e', 'requireCdpBase', '-e', '9333', commit, '--', 'test', 'scripts'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (tree.status !== 0 || tree.error || (cdp.status !== 0 && cdp.status !== 1) || cdp.error) return null;
  const cdpFiles = new Set(cdp.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(commit.length + 1))
    .filter((file) => file.endsWith('.test.ts')));
  return tree.stdout.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)
    && !cdpFiles.has(file) && !POD_SWEEP_INTEGRATION_ONLY.includes(file)
    && !file.split('/').some((part) => part.startsWith('.'))).sort();
}

export interface GateBaselineReceipt {
  schema: 2;
  valid: boolean;
  reason: string;
  version: string;
  commit: string;
  graphSha: string | null;
  recipeSha: string | null;
  envFingerprint: string;
  imageDigest: string | null;
  executionIdentity: GatePodRuntimeIdentity | null;
  files: number;
  shards: number;
  attributionRecheck?: { summary: number; observed: number; identified: number; baselineResult: string; targetFiles: string[] };
}

export interface GatePodRuntimeIdentity {
  bunVersion: string;
  platform: string;
  architecture: string;
  envFingerprint: string;
}

const validRuntimeIdentity = (value: unknown): value is GatePodRuntimeIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<GatePodRuntimeIdentity>;
  return Object.keys(value).sort().join(',') === 'architecture,bunVersion,envFingerprint,platform'
    && typeof row.bunVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(row.bunVersion)
    && typeof row.platform === 'string' && /^[a-z0-9_-]{1,32}$/.test(row.platform)
    && typeof row.architecture === 'string' && /^[a-z0-9_-]{1,32}$/.test(row.architecture)
    && typeof row.envFingerprint === 'string' && SHA256.test(row.envFingerprint);
};

/** Parse runtime facts written by the gate Pod before its tests start. */
export function parseGatePodRuntimeIdentity(text: string): GatePodRuntimeIdentity | null {
  try {
    const value: unknown = JSON.parse(text);
    return validRuntimeIdentity(value) ? value : null;
  } catch { return null; }
}

/** A direct hard rehearsal has no graph run state. Pin the graph and recipe bytes at its Git SHA. */
export function gateSourcePins(repo: string, commit: string): { graphSha: string; recipeSha: string } | null {
  if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
  const read = (file: string): string | null => {
    const result = spawnSync('git', ['show', `${commit}:${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return result.status === 0 && !result.error ? result.stdout : null;
  };
  const graph = read('graphs/release/release-loop.yaml');
  const recipe = read('graphs/release/recipes.yaml');
  return graph === null || recipe === null ? null : {
    graphSha: createHash('sha256').update(graph).digest('hex'),
    recipeSha: createHash('sha256').update(recipe).digest('hex'),
  };
}

/** Only Kubernetes' observed child container imageID is evidence; the requested image tag is not. */
export function actualGatePodImageDigest(podJson: string): string | null {
  try {
    const pods = JSON.parse(podJson) as { items?: Array<{ status?: { containerStatuses?: Array<{ name?: string; imageID?: string }> } }> };
    // A retry can create more than one Pod; collected test bytes are not bound to one of their UIDs.
    if (pods.items?.length !== 1) return null;
    const id = pods.items[0]?.status?.containerStatuses?.find((row) => row.name === 'child')?.imageID;
    const digest = typeof id === 'string' ? /(?:^|@|:\/\/)(sha256:[0-9a-f]{64})$/i.exec(id)?.[1] : undefined;
    return digest && IMAGE_DIGEST.test(digest) ? digest.toLowerCase() : null;
  } catch { return null; }
}

export function gateEnvFingerprint(env: NodeJS.ProcessEnv): string {
  const baseline = gateTestBaseline(env);
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}

/** Graph runner pins these bytes in its run state. A direct gate without that state cannot mint a reusable receipt. */
export function gateGraphPins(root: string, runId: string | undefined): { graphSha: string; recipeSha: string } | null {
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return null;
  try {
    const state = JSON.parse(readFileSync(join(root, 'graph-runs', 'release-loop', `${runId}.json`), 'utf8')) as
      { graphId?: string; runId?: string; graphSnapshot?: { graphSha?: string; recipesSha?: string } };
    const graphSha = state.graphSnapshot?.graphSha;
    const recipeSha = state.graphSnapshot?.recipesSha;
    return state.graphId === 'release-loop' && state.runId === runId && graphSha && recipeSha
      && SHA256.test(graphSha) && SHA256.test(recipeSha) ? { graphSha, recipeSha } : null;
  } catch { return null; }
}

export function gateBaselineReceipt(input: { root: string; version: string; commit: string; fullSweep: boolean;
  graphPins: { graphSha: string; recipeSha: string } | null; envFingerprint: string;
  attributionRecheck?: { summary: number; observed: number; identified: number; baselineResult: string; targetFiles: string[] } }): GateBaselineReceipt {
  const { root, version, commit, graphPins, envFingerprint } = input;
  const base = { schema: 2 as const, version, commit, graphSha: graphPins?.graphSha ?? null,
    recipeSha: graphPins?.recipeSha ?? null, envFingerprint, imageDigest: null as string | null,
    executionIdentity: null as GatePodRuntimeIdentity | null, files: 0, shards: 0 };
  const invalid = (reason: string): GateBaselineReceipt => ({ ...base, valid: false, reason });
  if (input.attributionRecheck) {
    const evidence = input.attributionRecheck;
    return { ...invalid(`failure attribution unresolved after baseline recheck (${evidence.baselineResult}): summary=${evidence.summary}, observed=${evidence.observed}, identified=${evidence.identified}`),
      attributionRecheck: { ...evidence, targetFiles: [...evidence.targetFiles].sort() } };
  }
  if (!input.fullSweep) return invalid('gate was not a complete clean full sweep');
  if (!graphPins) return invalid('pinned graph or recipe SHA absent');
  if (!SHA256.test(envFingerprint)) return invalid('gate environment fingerprint absent');
  try {
    const dir = join(root, 'release', version, 'gate-logs', 'cut');
    if (!existsSync(dir)) return invalid('cut Pod logs absent');
    const names = readdirSync(dir).filter((name) => /^pod-\d+(?:-[\w-]+)?\.json$/.test(name));
    const roots = new Map<number, { files: string[]; shardCount: number; sweepId: string; attemptId: string; runtimeIdentity?: GatePodRuntimeIdentity }>();
    const descendants: Array<{ name: string; commit?: string; imageDigest?: string; sweepId?: string; parentAttempt?: string; attemptId?: string; runtimeIdentity?: GatePodRuntimeIdentity }> = [];
    const images = new Set<string>();
    const identities = new Map<string, GatePodRuntimeIdentity>();
    for (const name of names) {
      const row = JSON.parse(readFileSync(join(dir, name), 'utf8')) as
        { commit?: string; files?: unknown; shardCount?: number; sweepId?: string; imageDigest?: string; parentAttempt?: string; attemptId?: string; runtimeIdentity?: unknown };
      const runtimeIdentity = validRuntimeIdentity(row.runtimeIdentity) ? row.runtimeIdentity : undefined;
      const match = /^pod-(\d+)\.json$/.exec(name);
      if (match) {
        if (row.commit !== commit) return invalid(`root cut Pod ${name} belongs to another commit`);
        if (!Array.isArray(row.files) || !row.files.length || !row.files.every((file) => typeof file === 'string'))
          return invalid(`root cut Pod ${name} has no file list`);
        if (!row.attemptId) return invalid(`root cut Pod ${name} has no attempt`);
        if (!row.sweepId) return invalid(`root cut Pod ${name} has no sweep identity`);
        roots.set(Number(match[1]), { files: row.files as string[], shardCount: row.shardCount ?? 0,
          sweepId: row.sweepId, attemptId: row.attemptId, runtimeIdentity });
      } else descendants.push({ name, commit: row.commit, imageDigest: row.imageDigest, sweepId: row.sweepId,
        parentAttempt: row.parentAttempt, attemptId: row.attemptId, runtimeIdentity });
      if (match) {
        if (!row.imageDigest || !IMAGE_DIGEST.test(row.imageDigest)) return invalid(`actual Pod image digest absent: ${name}`);
        if (!runtimeIdentity) return invalid(`actual Pod runtime identity absent: ${name}`);
        if (runtimeIdentity.envFingerprint !== envFingerprint) return invalid(`actual Pod environment differs: ${name}`);
        images.add(row.imageDigest.toLowerCase());
        identities.set(JSON.stringify(runtimeIdentity), runtimeIdentity);
      }
    }
    if (!roots.size) return invalid('root cut shards absent');
    const count = roots.get(0)?.shardCount;
    if (!count || !Number.isSafeInteger(count) || count !== roots.size
      || [...roots.keys()].some((index) => index < 0 || index >= count)) return invalid('root cut shard set incomplete');
    const sweepId = roots.get(0)!.sweepId;
    if ([...roots.values()].some((row) => row.shardCount !== count || row.sweepId !== sweepId))
      return invalid('root cut shards belong to different sweeps');
    const files = [...roots.values()].flatMap((row) => row.files);
    if (new Set(files).size !== files.length) return invalid('root cut file lists overlap');
    // A new cut can leave older split descendants in the same directory. Bind only the current roots' attempt tree.
    const attempts = new Set([...roots.values()].map((row) => row.attemptId));
    let pending = descendants;
    for (; pending.length;) {
      const next = pending.filter((row) => !row.parentAttempt || !attempts.has(row.parentAttempt));
      if (next.length === pending.length) break;
      for (const row of pending) {
        if (!row.parentAttempt || !attempts.has(row.parentAttempt)) continue;
        if (row.commit !== commit) return invalid(`cut Pod ${row.name} belongs to another commit`);
        if (row.sweepId !== sweepId) return invalid(`cut Pod ${row.name} belongs to another sweep`);
        if (!row.imageDigest || !IMAGE_DIGEST.test(row.imageDigest)) return invalid(`actual Pod image digest absent: ${row.name}`);
        if (!row.attemptId) return invalid(`cut Pod ${row.name} has no attempt`);
        if (!row.runtimeIdentity) return invalid(`actual Pod runtime identity absent: ${row.name}`);
        if (row.runtimeIdentity.envFingerprint !== envFingerprint) return invalid(`actual Pod environment differs: ${row.name}`);
        images.add(row.imageDigest.toLowerCase());
        identities.set(JSON.stringify(row.runtimeIdentity), row.runtimeIdentity);
        attempts.add(row.attemptId);
      }
      pending = next;
    }
    // A child carrying this sweep's identity must be connected to a root,
    // even when its parentAttempt is missing or corrupt. Otherwise its image
    // evidence is silently omitted and a mixed-image receipt can look valid.
    for (const row of pending) {
      if (row.sweepId === sweepId) return invalid(`cut Pod ${row.name} has no connected parent attempt`);
      if (row.commit === commit && !row.sweepId) return invalid(`cut Pod ${row.name} has no sweep identity`);
    }
    if (images.size !== 1) return invalid('cut Pods used different image digests');
    if (identities.size !== 1) return invalid('cut Pods used different runtime identities');
    return { ...base, valid: true, reason: 'complete clean full sweep', imageDigest: [...images][0]!,
      executionIdentity: identities.values().next().value!, files: files.length, shards: count };
  } catch (error) { return invalid(`cut Pod evidence unreadable: ${String(error)}`); }
}
