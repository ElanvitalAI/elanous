import { normalizeGateImageDigest } from './gate-image-pin.js';

export interface GateImagePinHandshake {
  readonly runId: string;
  readonly cutoffSha: string;
  readonly digest: string;
}

export type CutoffGateImagePinResult =
  | { readonly ok: true; readonly pin: GateImagePinHandshake }
  | { readonly ok: false; readonly reason: 'run-id-invalid' | 'cutoff-sha-invalid'
    | 'cutoff-image-unavailable' | 'cutoff-image-digest-invalid' };

/** Bind preflight's measured cutoff-image digest to this graph run and exact source tip. */
export function createGateImagePinHandshake(input: {
  readonly runId: unknown;
  readonly cutoffSha: unknown;
  /** Null represents a registry/tag lookup that found no image, as on aws3. */
  readonly preflightDigest: unknown;
}): CutoffGateImagePinResult {
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.runId))
    return { ok: false, reason: 'run-id-invalid' };
  if (typeof input.cutoffSha !== 'string' || !/^[0-9a-f]{40}$/i.test(input.cutoffSha))
    return { ok: false, reason: 'cutoff-sha-invalid' };
  if (input.preflightDigest == null || input.preflightDigest === '') return { ok: false, reason: 'cutoff-image-unavailable' };
  const digest = normalizeGateImageDigest(input.preflightDigest);
  if (!digest) return { ok: false, reason: 'cutoff-image-digest-invalid' };
  return { ok: true, pin: { runId: input.runId, cutoffSha: input.cutoffSha.toLowerCase(), digest } };
}

export type GatePodImagePinCheck =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: 'pin-invalid' | 'pod-observation-unavailable' | 'run-id-mismatch' | 'cutoff-tip-mismatch'
    | 'pod-image-unavailable' | 'pod-image-invalid' | 'pod-image-digest-mismatch' };

/** Refuse to start a shard unless the Job identity and observed Pod image match the run pin. */
export function verifyGatePodImagePin(pin: unknown, observed: unknown): GatePodImagePinCheck {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return { ok: false, reason: 'pin-invalid' };
  const candidate = pin as Record<string, unknown>;
  if (typeof candidate.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.runId)
    || typeof candidate.cutoffSha !== 'string' || !/^[0-9a-f]{40}$/i.test(candidate.cutoffSha))
    return { ok: false, reason: 'pin-invalid' };
  const pinnedDigest = normalizeGateImageDigest(candidate.digest);
  if (!pinnedDigest) return { ok: false, reason: 'pin-invalid' };
  if (!observed || typeof observed !== 'object' || Array.isArray(observed))
    return { ok: false, reason: 'pod-observation-unavailable' };
  const pod = observed as Record<string, unknown>;
  if (pod.runId !== candidate.runId) return { ok: false, reason: 'run-id-mismatch' };
  if (typeof pod.cutoffSha !== 'string' || !/^[0-9a-f]{40}$/i.test(pod.cutoffSha)
    || pod.cutoffSha.toLowerCase() !== candidate.cutoffSha.toLowerCase())
    return { ok: false, reason: 'cutoff-tip-mismatch' };
  if (pod.imageDigest == null || pod.imageDigest === '') return { ok: false, reason: 'pod-image-unavailable' };
  const podDigest = normalizeGateImageDigest(pod.imageDigest);
  if (!podDigest) return { ok: false, reason: 'pod-image-invalid' };
  if (podDigest !== pinnedDigest) return { ok: false, reason: 'pod-image-digest-mismatch' };
  return { ok: true, digest: pinnedDigest };
}
