import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

function normalizeGateImageDigest(value: unknown): string | null {
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
