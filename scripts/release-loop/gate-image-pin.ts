import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { gateImageReadinessPendingPath, gateImageReadinessSignalPath,
  readGateImageReadinessSignal, type GateImageReadinessSignal } from './release-readiness.js';

/** A gate run may execute only against one immutable image identity and its exact source tag. */
export interface GateImagePin { runId: string; digest: string; image: string; commit: string }

export type GateImagePinResolution =
  | { ok: true; digest: string; eligiblePools: string[] }
  | { ok: false; reason: 'saved-image-digest-invalid' | 'initial-image-digest-invalid' | 'initial-image-digest-missing' | 'pinned-image-unavailable' };

export interface ResolveGateImagePinOptions {
  /** Persisted at the run boundary; takes precedence over any newly probed default. */
  savedDigest?: string | null;
  /** Used only to create the pin for a new run. */
  initialDigest?: string | null;
  /** Exact immutable digest selected by the gate image probe in each pool. */
  poolImages: ReadonlyMap<string, readonly string[]>;
}

interface PinnedGateImagePullDecision {
  push: false;
  imageRef: string;
  tagDrift?: { event: 'image-tag-drift'; runId: string; tag: string; pinnedDigest: string; observedDigest: string | null; reason: 'digest-changed' | 'tag-unavailable' };
}

export interface PinnedGateImageSyncResult {
  images: Map<string, { ok: true; action: 'fresh'; detail: string; ms: 0; imageRef: string }>;
  tagDrifts: Array<{ event: 'image-tag-drift'; runId: string; tag: string; pinnedDigest: string;
    observedDigest: string | null; reason: 'digest-changed' | 'tag-unavailable'; context: string }>;
}

export interface GateImagePrebuildMember { context: string }
export interface GateImagePrebuildResult { outcome: 'built' | 'reused'; digest: string; eligiblePools: string[] }

/** Stable, host-independent cache key for the source-free gate runtime layer. */
export function gateImageLayerRuntimeKey(input: { baseImageDigest: string; lockHash: string; architecture: string; bunVersion: string;
  buildRecipeHash: string; gateDepsDigest: string; skillsDigest: string }): string {
  const baseImageDigest = normalizeGateImageDigest(input.baseImageDigest);
  if (!baseImageDigest || !/^[a-f0-9]{64}$/i.test(input.lockHash) || !/^[a-z0-9._-]+$/i.test(input.architecture)
    || !/^\d+\.\d+\.\d+$/i.test(input.bunVersion) || !/^[a-f0-9]{64}$/i.test(input.buildRecipeHash)
    || !/^[a-f0-9]{12}$/i.test(input.gateDepsDigest) || !(input.skillsDigest === 'none' || /^[a-f0-9]{16}$/i.test(input.skillsDigest)))
    throw new Error('gate image runtime cache identity is incomplete');
  return createHash('sha256').update([baseImageDigest, input.lockHash.toLowerCase(), input.architecture.toLowerCase(), input.bunVersion,
    input.buildRecipeHash.toLowerCase(), input.gateDepsDigest.toLowerCase(), input.skillsDigest.toLowerCase()].join('\n')).digest('hex').slice(0, 40);
}

export function normalizeGateRuntimeArchitecture(value: string): string {
  return value.replace(/^aarch64$/i, 'arm64').replace(/^x86_64$/i, 'amd64');
}

export function gateRuntimeBaseReuseMode(
  identities: readonly ({ digest: string; architecture: string } | null)[],
  existingTagDigests: readonly (string | null)[],
): 'uniform-base' | 'shared-tag' {
  if (!identities.length || identities.some((identity) => !identity))
    throw new Error('gate runtime base digest or architecture could not be measured consistently across pools');
  const distinctBases = new Set(identities.map((identity) => `${identity!.digest}\n${normalizeGateRuntimeArchitecture(identity!.architecture)}`));
  if (distinctBases.size === 1) return 'uniform-base';
  const digests = existingTagDigests.map(normalizeGateImageDigest);
  if (digests.length !== identities.length || digests.some((digest) => !digest)
    || new Set(digests).size !== 1)
    throw new Error('gate runtime base digest or architecture differs and no shared pinned image tag exists across pools');
  return 'shared-tag';
}

/** Build the cut image before the expensive gate starts, then persist the pin the gate will consume. */
export async function prebuildGateImagePinAtCut(input: {
  root: string; version: string; runId: string; commit: string; image: string;
  members: readonly GateImagePrebuildMember[];
  probe: (member: GateImagePrebuildMember) => string | null;
  sync: () => Promise<ReadonlyMap<string, { ok: boolean }>>;
}): Promise<GateImagePrebuildResult> {
  if (!/^[0-9a-f]{40}$/i.test(input.commit) || !input.members.length) throw new Error('invalid cut image prebuild identity');
  const pinPath = gateImagePinPath(input.root, input.version, input.runId);
  const imageTag = input.image;
  const currentPin = existsSync(pinPath) ? readGateImagePinForRun(pinPath, input.runId, imageTag) : null;
  const digests = () => new Map(input.members.map((member) => [member.context, normalizeGateImageDigest(input.probe(member))]));
  let observed = digests();
  const existing = currentPin?.commit === input.commit.toLowerCase() ? currentPin.digest
    : [...observed.values()].find((digest): digest is string => Boolean(digest));
  let outcome: GateImagePrebuildResult['outcome'] = 'reused';
  let digest = existing;
  if (!digest) {
    const synced = await input.sync();
    const failed = input.members.filter((member) => !synced.get(member.context)?.ok);
    if (failed.length) throw new Error(`cut gate image prebuild failed: ${failed.map((member) => member.context).join(', ')}`);
    observed = digests();
    digest = [...observed.values()].find((value): value is string => Boolean(value));
    if (!digest) throw new Error('cut gate image prebuild produced no immutable image digest');
    outcome = 'built';
  }
  const eligiblePools = [...observed].filter(([, value]) => value === digest).map(([context]) => context);
  if (!eligiblePools.length) throw new Error('cut gate image prebuild digest is unavailable in every pool');
  if (currentPin?.commit === input.commit.toLowerCase()) {
    if (currentPin.digest !== digest || currentPin.image !== imageTag) throw new Error('cut gate image pin changed during prebuild');
    return { outcome: 'reused', digest, eligiblePools };
  }
  if (currentPin) replaceGateImagePin(pinPath, input.runId, digest, imageTag, input.commit, imageTag, currentPin.commit);
  else writeGateImagePin(pinPath, input.runId, digest, imageTag, input.commit);
  return { outcome, digest, eligiblePools };
}

export async function prebuildGateImagePinForRuntimeBases(input: Parameters<typeof prebuildGateImagePinAtCut>[0] & {
  runtimeBases: readonly ({ digest: string; architecture: string } | null)[];
}): Promise<GateImagePrebuildResult> {
  if (input.runtimeBases.some((identity) => !identity))
    throw new Error('gate runtime base digest or architecture could not be measured consistently across pools');
  const distinctBases = new Set(input.runtimeBases.map((identity) => `${identity!.digest}\n${normalizeGateRuntimeArchitecture(identity!.architecture)}`));
  const observed = distinctBases.size === 1 ? [] : input.members.map(input.probe);
  const mode = gateRuntimeBaseReuseMode(input.runtimeBases, observed);
  if (mode === 'uniform-base') return prebuildGateImagePinAtCut(input);
  const sharedDigest = normalizeGateImageDigest(observed[0])!;
  return prebuildGateImagePinAtCut({ ...input, probe: () => sharedDigest,
    sync: async () => { throw new Error('mixed runtime bases cannot build a shared image'); } });
}

function imageRepository(image: string): string {
  let repository = image.trim().replace(/@sha256:[a-f0-9]{64}$/i, '');
  const firstSlash = repository.indexOf('/');
  if (firstSlash > 0) {
    const first = repository.slice(0, firstSlash);
    if (first === 'localhost' || first.includes('.') || first.includes(':')) repository = repository.slice(firstSlash + 1);
  }
  return repository.replace(/:[^/:]+$/, '');
}

/** Build a Job image ref from the registry service visible inside a pool's Kubernetes cluster. */
function pinnedGateImagePullDecision(input: {
  runId: string; registry: string; image: string; digest: string; observedTagDigest?: string | null;
}): PinnedGateImagePullDecision {
  const digest = normalizeGateImageDigest(input.digest);
  const registry = input.registry.trim().replace(/\/$/, '');
  const repository = imageRepository(input.image);
  if (!input.runId || !registry || !repository || repository.includes('@') || !digest) throw new Error('invalid pinned gate image pull identity');
  const observed = normalizeGateImageDigest(input.observedTagDigest);
  const tag = `${registry}/${repository}:${input.image.split(':').at(-1) ?? ''}`;
  return {
    push: false,
    imageRef: `${registry}/${repository}@${digest}`,
    ...(!observed || observed !== digest ? { tagDrift: { event: 'image-tag-drift', runId: input.runId,
      tag, pinnedDigest: digest, observedDigest: observed, reason: observed ? 'digest-changed' as const : 'tag-unavailable' as const } } : {}),
  };
}

/** Convert every selected gate member to a digest ref; this path deliberately has no build/push operation. */
export function pinnedGateImageSync(input: {
  runId: string; commit: string; digest: string; image: string;
  members: readonly { context: string; registry: string }[];
  probeTagDigest: (member: { context: string; registry: string }) => string | null;
}): PinnedGateImageSyncResult {
  const repository = imageRepository(input.image);
  if (!/^[0-9a-f]{40}$/i.test(input.commit) || !repository || repository.includes('@')) throw new Error('invalid pinned gate image identity');
  const tag = `${repository}:${input.commit.slice(0, 12)}`;
  const images = new Map<string, { ok: true; action: 'fresh'; detail: string; ms: 0; imageRef: string }>();
  const tagDrifts: PinnedGateImageSyncResult['tagDrifts'] = [];
  for (const member of input.members) {
    const decision = pinnedGateImagePullDecision({ runId: input.runId, registry: member.registry, image: tag,
      digest: input.digest, observedTagDigest: input.probeTagDigest(member) });
    images.set(member.context, { ok: true, action: 'fresh', detail: 'run-pinned-digest; tag push skipped', ms: 0,
      imageRef: decision.imageRef });
    if (decision.tagDrift) tagDrifts.push({ ...decision.tagDrift, context: member.context });
  }
  return { images, tagDrifts };
}

export function normalizeGateImageDigest(value: unknown): string | null {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

/**
 * Resolve the durable run pin and fail closed unless at least one pool can prove it has that exact image.
 * Callers must filter placement to `eligiblePools`; a mutable tag is never a substitute.
 */
export function resolveGateImagePin(options: ResolveGateImagePinOptions): GateImagePinResolution {
  const hasSaved = options.savedDigest !== undefined && options.savedDigest !== null;
  const rawDigest = hasSaved ? options.savedDigest : options.initialDigest;
  if (!hasSaved && (rawDigest === undefined || rawDigest === null || rawDigest.trim() === '')) {
    return { ok: false, reason: 'initial-image-digest-missing' };
  }
  const digest = normalizeGateImageDigest(rawDigest);
  if (!digest) return { ok: false, reason: hasSaved ? 'saved-image-digest-invalid' : 'initial-image-digest-invalid' };
  const eligiblePools = [...options.poolImages]
    .filter(([, images]) => images.some((image) => normalizeGateImageDigest(image) === digest))
    .map(([pool]) => pool);
  if (!eligiblePools.length) return { ok: false, reason: 'pinned-image-unavailable' };
  return { ok: true, digest, eligiblePools };
}

/** The pin is immutable for one graph gate run; absence on resume is a hard refusal. */
export function readGateImagePin(path: string, expectedRunId: string, expectedImage: string, expectedCommit: string): GateImagePin | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; runId?: unknown; digest?: unknown; image?: unknown; commit?: unknown };
  const normalizedCommit = expectedCommit.toLowerCase();
  if (parsed.version !== 2 || parsed.runId !== expectedRunId || parsed.image !== expectedImage || parsed.commit !== normalizedCommit
    || !normalizeGateImageDigest(parsed.digest))
    throw new Error(`invalid gate image pin: ${path}`);
  return { runId: expectedRunId, digest: normalizeGateImageDigest(parsed.digest)!, image: expectedImage, commit: normalizedCommit };
}

/** Read a valid pin for this run and image repository while allowing its commit tag to be stale. */
export function readGateImagePinForRun(path: string, expectedRunId: string, expectedImage: string): GateImagePin | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; runId?: unknown; digest?: unknown; image?: unknown; commit?: unknown };
  const commit = typeof parsed.commit === 'string' && /^[0-9a-f]{40}$/i.test(parsed.commit) ? parsed.commit.toLowerCase() : null;
  const image = typeof parsed.image === 'string' ? parsed.image : '';
  const imageRepo = imageRepository(image);
  if (parsed.version !== 2 || parsed.runId !== expectedRunId || !commit || !normalizeGateImageDigest(parsed.digest)
    || !imageRepo || imageRepo !== imageRepository(expectedImage) || !/^[a-f0-9]{12}$/i.test(image.split(':').at(-1) ?? ''))
    throw new Error(`invalid gate image pin: ${path}`);
  return { runId: expectedRunId, digest: normalizeGateImageDigest(parsed.digest)!, image, commit };
}

/** Preserve a valid old tip pin before a resumed gate establishes a new commit pin. */
export function supersedeGateImagePin(path: string, expectedRunId: string, expectedImage: string, expectedCommit: string): { pin: GateImagePin; archivePath: string } | null {
  const prior = readGateImagePinForRun(path, expectedRunId, expectedImage);
  if (!prior || prior.commit === expectedCommit.toLowerCase()) return null;
  const stem = `${path}.superseded-${prior.commit.slice(0, 12)}-${process.pid}-${Date.now()}`;
  let archivePath = stem;
  for (let suffix = 1; ; suffix++) {
    archivePath = suffix === 1 ? stem : `${stem}-${suffix}`;
    try {
      copyFileSync(path, archivePath, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readFileSync(path).equals(readFileSync(archivePath))) break;
    }
  }
  return { pin: prior, archivePath };
}

/** Archive the old tip and atomically replace the active pin without an absent-pin crash window. */
export function replaceGateImagePin(path: string, runId: string, digest: string, image: string, commit: string,
  expectedImage: string, expectedPriorCommit: string): string {
  const prior = readGateImagePinForRun(path, runId, expectedImage);
  if (!prior || prior.commit !== expectedPriorCommit.toLowerCase()) throw new Error('stale gate image pin changed before replacement');
  const archived = supersedeGateImagePin(path, runId, expectedImage, commit);
  if (!archived) throw new Error('stale gate image pin could not be archived');
  const normalized = normalizeGateImageDigest(digest);
  if (!normalized || !runId || !image.trim() || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('invalid gate image pin identity');
  const value = `${JSON.stringify({ version: 2, runId, digest: normalized, image, commit: commit.toLowerCase() }, null, 2)}\n`;
  const tempPath = `${path}.pending-${randomUUID()}`;
  try {
    writeFileSync(tempPath, value, { mode: 0o600, flag: 'wx' });
    // Keep the old active pin until the complete replacement is ready; rename is atomic on this filesystem.
    renameSync(tempPath, path);
    return archived.archivePath;
  } finally { rmSync(tempPath, { force: true }); }
}

export function writeGateImagePin(path: string, runId: string, digest: string, image: string, commit: string): void {
  const normalized = normalizeGateImageDigest(digest);
  if (!runId || !normalized || !image.trim() || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('invalid gate image pin identity');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = JSON.stringify({ version: 2, runId, digest: normalized, image, commit: commit.toLowerCase() });
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as { runId?: unknown; digest?: unknown; image?: unknown; commit?: unknown };
    if (prior.runId !== runId || normalizeGateImageDigest(prior.digest) !== normalized || prior.image !== image
      || prior.commit !== commit.toLowerCase())
      throw new Error(`gate image pin is immutable: ${path}`);
    return;
  }
  try { writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = JSON.parse(readFileSync(path, 'utf8')) as { runId?: unknown; digest?: unknown; image?: unknown; commit?: unknown };
    if (prior.runId === runId && normalizeGateImageDigest(prior.digest) === normalized && prior.image === image
      && prior.commit === commit.toLowerCase()) return;
    throw new Error(`gate image pin is immutable: ${path}`);
  }
}

export function gateImagePinPath(root: string, version: string, runId: string): string {
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
    throw new Error('invalid gate image pin path identity');
  return `${root.replace(/\/$/, '')}/release/${version}/gate-image-pin-${runId}.json`;
}

export interface CutGateImagePrebuildInput { root: string; repo: string; runId: string; version: string; commit: string; pool: string }
type ChildGateImagePrebuildOutcome = GateImagePrebuildResult | { outcome: 'skipped' | 'failed'; reason: string };
export type CutGateImagePrebuildOutcome = (GateImagePrebuildResult & { runId: string; cutCommit: string })
  | { outcome: 'skipped' | 'failed'; reason: string };
interface CutGateImagePrebuildDeps {
  runPrebuild?: () => { stdout?: string | null; stderr?: string | null; status: number | null; error?: Error };
  now?: () => Date;
  invalidateReady?: (input: CutGateImagePrebuildInput) => void;
  markLocalPending?: () => void;
  writeReady?: (input: CutGateImagePrebuildInput, result: GateImagePrebuildResult, now: Date) => void;
}

function writePendingMarker(path: string, input: CutGateImagePrebuildInput): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pending-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ runId: input.runId, cutCommit: input.commit.toLowerCase() })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function markGateImagePrebuildPending(input: CutGateImagePrebuildInput, deps: CutGateImagePrebuildDeps): void {
  deps.markLocalPending?.();
  writePendingMarker(gateImageReadinessPendingPath(input.root, input.version), input);
}

function writeGateImageReadiness(input: CutGateImagePrebuildInput, result: GateImagePrebuildResult, now: Date): void {
  const digest = normalizeGateImageDigest(result.digest);
  if (!digest || !Array.isArray(result.eligiblePools) || result.eligiblePools.length === 0
    || result.eligiblePools.some((pool) => typeof pool !== 'string' || !pool.trim())) {
    throw new Error('cut gate image prebuild returned invalid readiness identity');
  }
  const path = gateImageReadinessSignalPath(input.root, input.version);
  const signal: GateImageReadinessSignal = { schemaVersion: 1, status: 'ready', runId: input.runId,
    cutCommit: input.commit.toLowerCase(), imageDigest: digest, eligiblePools: result.eligiblePools, checkedAt: now.toISOString() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.pending-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(signal)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Best-effort cleanup of an earlier verdict for this run and cut. */
function invalidateGateImageReadiness(input: CutGateImagePrebuildInput): void {
  const path = gateImageReadinessSignalPath(input.root, input.version);
  if (readGateImageReadinessSignal(path, { runId: input.runId, cutCommit: input.commit }, { ignorePending: true }).status !== 'ready') return;
  rmSync(path, { force: true });
}

/** Sync entry point used immediately after cut-branch; the child performs the asynchronous pool build. */
export function runCutGateImagePrebuild(input: CutGateImagePrebuildInput, deps: CutGateImagePrebuildDeps = {}): CutGateImagePrebuildOutcome {
  if (!input.pool || !input.runId || !/^[0-9a-f]{40}$/i.test(input.commit)) return { outcome: 'skipped', reason: 'gate pool, run id, or cut commit absent' };
  try { markGateImagePrebuildPending(input, deps); (deps.invalidateReady ?? invalidateGateImageReadiness)(input); }
  catch (error) { return { outcome: 'failed', reason: `image readiness invalidation failed: ${error instanceof Error ? error.message : String(error)}` }; }
  const script = join(import.meta.dir, 'gate-image-pin.ts');
  const run = deps.runPrebuild?.() ?? spawnSync('bun', [script, '--prebuild', '--root', input.root, '--repo', input.repo, '--run-id', input.runId,
    '--version', input.version, '--commit', input.commit, '--pool', input.pool], {
    cwd: input.repo, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const line = (run.stdout ?? '').trim().split('\n').at(-1);
  if (!line) return { outcome: 'failed', reason: `${run.stderr || run.error || `prebuild child exited ${run.status}`}`.trim().slice(-1000) };
  try {
    const result = JSON.parse(line) as ChildGateImagePrebuildOutcome;
    if (run.status !== 0 || run.error) return result.outcome === 'failed' ? result
      : { outcome: 'failed', reason: `${run.stderr || run.error || `prebuild child exited ${run.status}`}`.trim().slice(-1000) };
    if (result.outcome === 'built' || result.outcome === 'reused') {
      try {
        (deps.writeReady ?? writeGateImageReadiness)(input, result, (deps.now ?? (() => new Date()))());
        rmSync(gateImageReadinessPendingPath(input.root, input.version), { force: true });
      }
      catch (error) { return { outcome: 'failed', reason: `image readiness signal write failed: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    return result.outcome === 'built' || result.outcome === 'reused'
      ? { ...result, runId: input.runId, cutCommit: input.commit.toLowerCase() } : 'reason' in result ? result : { outcome: 'failed', reason: 'invalid child outcome' };
  } catch { return { outcome: 'failed', reason: `prebuild child returned invalid JSON: ${line.slice(0, 300)}` }; }
}

async function prebuildFromArgs(args: string[]): Promise<ChildGateImagePrebuildOutcome> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--prebuild') continue;
    const value = args[++i];
    if (!value || !['--root', '--repo', '--run-id', '--version', '--commit', '--pool'].includes(key)) throw new Error(`invalid prebuild argument: ${key}`);
    values.set(key, value);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`missing ${key}`); return value; };
  const root = required('--root'), repo = required('--repo'), runId = required('--run-id'), version = required('--version');
  const commit = required('--commit'), pool = required('--pool');
  const [podPool, gateRadius, podCommand, fs, path, os] = await Promise.all([
    import('../../src/task-orchestrator/surfaces/pod-pool.js'), import('./gate-radius-live.js'),
    import('../../src/task-orchestrator/surfaces/pod-command-job.js'), import('node:fs'), import('node:path'), import('node:os'),
  ]);
  const { parsePodPool, syncPoolImages } = podPool;
  const { defaultRemoteRun } = podPool;
  const { preflightGateImageDigest } = gateRadius;
  const { podCommandImageFor } = podCommand;
  const { mkdtempSync } = fs;
  const { join: pathJoin } = path;
  const { tmpdir } = os;
  const members = parsePodPool(pool);
  const rawSpecs = pool.split(',').map((spec) => spec.trim()).filter(Boolean);
  const specFor = new Map(rawSpecs.map((spec) => [spec.split(/[@:#]/, 1)[0]!, spec]));
  const baseImage = podCommandImageFor([], true);
  const sourceRoot = mkdtempSync(pathJoin(tmpdir(), 'release-gate-image-prebuild-'));
  const sourceTree = pathJoin(sourceRoot, 'cut');
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, sourceTree], {
      cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER,
    });
    if (clone.status !== 0) throw new Error(`cut image source clone failed: ${clone.stderr || clone.error || clone.status}`);
    const checkout = spawnSync('git', ['checkout', '--quiet', '--detach', commit], {
      cwd: sourceTree, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER,
    });
    if (checkout.status !== 0) throw new Error(`cut image source checkout failed: ${checkout.stderr || checkout.error || checkout.status}`);
    const lockHash = createHash('sha256').update(readFileSync(pathJoin(sourceTree, 'bun.lock'))).digest('hex');
    const bunVersion = readFileSync(pathJoin(sourceTree, '.bun-version'), 'utf8').trim();
    const depsStage = pathJoin(sourceRoot, 'gate-deps');
    const stagedDeps = spawnSync('bun', [pathJoin(sourceTree, 'src/task-orchestrator/surfaces/pod-gate-deps.ts'), 'stage', depsStage], {
      cwd: sourceTree, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER,
    });
    if (stagedDeps.status !== 0 || stagedDeps.error) throw new Error(`gate image dependency inputs could not be measured: ${stagedDeps.stderr || stagedDeps.error || stagedDeps.status}`);
    const gateDepsDigest = /(?:^|\s)digest=([a-f0-9]{12})(?:\s|$)/i.exec(stagedDeps.stdout)?.[1]?.toLowerCase();
    if (!gateDepsDigest) throw new Error('gate image dependency digest is unmeasured');
    const skillsStage = pathJoin(sourceRoot, 'skills-extra');
    const stagedSkills = spawnSync('bun', [pathJoin(sourceTree, 'src/task-orchestrator/surfaces/pod-skills.ts'), 'stage', skillsStage], {
      cwd: sourceTree, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER,
    });
    if (stagedSkills.status !== 0 || stagedSkills.error) throw new Error(`gate image skill inputs could not be measured: ${stagedSkills.stderr || stagedSkills.error || stagedSkills.status}`);
    const skillsDigest = /(?:^|\s)digest=([a-f0-9]{16}|none)(?:\s|$)/i.exec(stagedSkills.stdout)?.[1]?.toLowerCase();
    if (!skillsDigest) throw new Error('gate image skill digest is unmeasured');
    const recipeHash = createHash('sha256');
    for (const relative of ['docker/harness/Dockerfile', 'docker/harness/build.sh', 'scripts/install.sh',
      'src/task-orchestrator/surfaces/pod-gate-deps.ts', 'src/task-orchestrator/surfaces/pod-skills.ts']) {
      recipeHash.update(relative).update('\0').update(readFileSync(pathJoin(sourceTree, relative))).update('\0');
    }
    const layerIdentities = members.map((member) => {
      const probe = member.sshHost ? defaultRemoteRun(member.sshHost,
        "docker pull ubuntu:24.04 >/dev/null && docker image inspect --format '{{index .RepoDigests 0}}' ubuntu:24.04 && uname -m")
        : spawnSync('sh', ['-c', "docker pull ubuntu:24.04 >/dev/null && docker image inspect --format '{{index .RepoDigests 0}}' ubuntu:24.04 && uname -m"],
          { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (probe.status !== 0) return null;
      const lines = probe.stdout.trim().split(/\r?\n/);
      const digest = /@?(sha256:[a-f0-9]{64})$/i.exec(lines[0] ?? '')?.[1]?.toLowerCase();
      const architecture = normalizeGateRuntimeArchitecture(lines.at(-1)?.trim() ?? '');
      return digest && architecture ? { digest, architecture } : null;
    });
    if (layerIdentities.some((identity) => !identity))
      throw new Error('gate runtime base digest or architecture could not be measured consistently across pools');
    const layerIdentity = layerIdentities[0]!;
    const runtimeKey = gateImageLayerRuntimeKey({ baseImageDigest: layerIdentity.digest, lockHash,
      architecture: layerIdentity.architecture, bunVersion, buildRecipeHash: recipeHash.digest('hex'), gateDepsDigest, skillsDigest });
    const image = `${imageRepository(baseImage)}:${runtimeKey.slice(0, 12)}`;
    return await prebuildGateImagePinForRuntimeBases({ root, version, runId, commit, image, members, runtimeBases: layerIdentities,
      probe: (member) => preflightGateImageDigest(specFor.get(member.context) ?? member.context, runtimeKey),
      sync: () => {
        const priorLayerOnly = process.env.ELANOUS_BUILD_GATE_LAYER_ONLY;
        const priorImageKey = process.env.ELANOUS_BUILD_IMAGE_KEY;
        const priorExpectedBase = process.env.ELANOUS_BUILD_EXPECTED_BASE_IMAGE_DIGEST;
        process.env.ELANOUS_BUILD_GATE_LAYER_ONLY = '1';
        process.env.ELANOUS_BUILD_IMAGE_KEY = runtimeKey;
        process.env.ELANOUS_BUILD_EXPECTED_BASE_IMAGE_DIGEST = layerIdentity.digest;
        return syncPoolImages(members, baseImage, runtimeKey,
          { buildScript: pathJoin(sourceTree, 'docker', 'harness', 'build.sh') }).finally(() => {
            if (priorLayerOnly === undefined) delete process.env.ELANOUS_BUILD_GATE_LAYER_ONLY;
            else process.env.ELANOUS_BUILD_GATE_LAYER_ONLY = priorLayerOnly;
            if (priorImageKey === undefined) delete process.env.ELANOUS_BUILD_IMAGE_KEY;
            else process.env.ELANOUS_BUILD_IMAGE_KEY = priorImageKey;
            if (priorExpectedBase === undefined) delete process.env.ELANOUS_BUILD_EXPECTED_BASE_IMAGE_DIGEST;
            else process.env.ELANOUS_BUILD_EXPECTED_BASE_IMAGE_DIGEST = priorExpectedBase;
          });
      },
    });
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
}

if (import.meta.main && process.argv.includes('--prebuild')) {
  try { console.log(JSON.stringify(await prebuildFromArgs(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ outcome: 'failed', reason: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
