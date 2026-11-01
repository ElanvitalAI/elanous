import { constants } from 'node:fs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    || !imageRepo || imageRepo !== imageRepository(expectedImage) || image !== `${imageRepo}:${commit.slice(0, 12)}`)
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
