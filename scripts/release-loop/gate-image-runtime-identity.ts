export interface GateImageRuntimeIdentity {
  readonly baseImageDigest: string;
  readonly bunVersion: string;
  readonly nodeVersion: string;
  readonly lockHash: string;
  readonly checkoutSha: string;
}

export type GateImageRuntimeIdentityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'image-metadata-unavailable' | 'image-identity-invalid' }
  | { readonly ok: false; readonly reason: 'image-drift'; readonly fields: readonly (keyof GateImageRuntimeIdentity)[] };

const FIELDS = ['baseImageDigest', 'bunVersion', 'nodeVersion', 'lockHash', 'checkoutSha'] as const;
const DIGEST = /^sha256:[0-9a-f]{64}(?![\s\S])/i;
const HASH = /^[0-9a-f]{64}(?![\s\S])/i;
const SHA = /^[0-9a-f]{40}(?![\s\S])/i;
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?![\s\S])/;

function hasAllFields(value: unknown): value is GateImageRuntimeIdentity {
  return !!value && typeof value === 'object' && FIELDS.every((field) => typeof (value as Record<string, unknown>)[field] === 'string');
}

function validIdentity(value: GateImageRuntimeIdentity): boolean {
  return DIGEST.test(value.baseImageDigest) && VERSION.test(value.bunVersion) && VERSION.test(value.nodeVersion)
    && HASH.test(value.lockHash) && SHA.test(value.checkoutSha);
}

/** Compare measured immutable image/runtime facts with the cutoff pins; any unknown or drift blocks the gate. */
export function compareGateImageRuntimeIdentity(
  cut: unknown,
  image: unknown,
): GateImageRuntimeIdentityResult {
  if (!cut || !image || typeof cut !== 'object' || typeof image !== 'object')
    return { ok: false, reason: 'image-metadata-unavailable' };
  if (!hasAllFields(cut) || !hasAllFields(image)) return { ok: false, reason: 'image-metadata-unavailable' };
  if (!validIdentity(cut) || !validIdentity(image)) return { ok: false, reason: 'image-identity-invalid' };

  const fields = FIELDS.filter((field) => cut[field] !== image[field]);
  return fields.length ? { ok: false, reason: 'image-drift', fields } : { ok: true };
}
