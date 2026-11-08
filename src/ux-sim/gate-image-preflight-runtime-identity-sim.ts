import { compareGateImageRuntimeIdentity, type GateImageRuntimeIdentity } from '../../scripts/release-loop/gate-image-runtime-identity.js';

const CUT_SHA = 'a'.repeat(40);
const CUT_IDENTITY: GateImageRuntimeIdentity = {
  baseImageDigest: `sha256:${'b'.repeat(64)}`,
  bunVersion: '1.4.2',
  nodeVersion: 'v26.3.0',
  lockHash: 'c'.repeat(64),
  checkoutSha: CUT_SHA,
};

export type GateImagePreflightRuntimeScenario = {
  readonly id: string;
  readonly cut?: GateImageRuntimeIdentity;
  readonly image: unknown;
  readonly expected: 'image-drift';
  readonly expectedFields: readonly (keyof GateImageRuntimeIdentity)[];
} | {
  readonly id: string;
  readonly cut?: GateImageRuntimeIdentity;
  readonly image: unknown;
  readonly expected: 'accepted' | 'image-metadata-unavailable' | 'image-identity-invalid';
};

const drift = (field: keyof GateImageRuntimeIdentity, value: string): GateImageRuntimeIdentity => ({
  ...CUT_IDENTITY,
  [field]: value,
});

/** Synthetic OCI labels/runtime probes run through the same pure checker used by release preflight. */
export const GATE_IMAGE_PREFLIGHT_RUNTIME_SCENARIOS: readonly GateImagePreflightRuntimeScenario[] = [
  { id: 'all-cut-pins-match', image: { ...CUT_IDENTITY }, expected: 'accepted' },
  { id: 'valid-prerelease-build-version', cut: { ...CUT_IDENTITY, bunVersion: '1.2.3-rc.1+build.1' },
    image: { ...CUT_IDENTITY, bunVersion: '1.2.3-rc.1+build.1' }, expected: 'accepted' },
  { id: 'prerelease-version-case-drift', cut: { ...CUT_IDENTITY, bunVersion: '1.2.3-rc.1' },
    image: { ...CUT_IDENTITY, bunVersion: '1.2.3-RC.1' }, expected: 'image-drift', expectedFields: ['bunVersion'] },
  { id: 'base-image-drift', image: drift('baseImageDigest', `sha256:${'d'.repeat(64)}`), expected: 'image-drift', expectedFields: ['baseImageDigest'] },
  { id: 'bun-runtime-drift', image: drift('bunVersion', '1.4.3'), expected: 'image-drift', expectedFields: ['bunVersion'] },
  { id: 'node-runtime-drift', image: drift('nodeVersion', 'v26.4.0'), expected: 'image-drift', expectedFields: ['nodeVersion'] },
  { id: 'node-version-prefix-drift', image: drift('nodeVersion', '26.3.0'), expected: 'image-drift', expectedFields: ['nodeVersion'] },
  { id: 'dependency-lock-drift', image: drift('lockHash', 'e'.repeat(64)), expected: 'image-drift', expectedFields: ['lockHash'] },
  { id: 'pod-checkout-drift', image: drift('checkoutSha', 'f'.repeat(40)), expected: 'image-drift', expectedFields: ['checkoutSha'] },
  { id: 'digest-case-drift', image: drift('baseImageDigest', `sha256:${'B'.repeat(64)}`), expected: 'image-drift', expectedFields: ['baseImageDigest'] },
  { id: 'multiple-field-drift', image: { ...CUT_IDENTITY, baseImageDigest: `sha256:${'d'.repeat(64)}`,
    bunVersion: '1.4.3', nodeVersion: 'v26.4.0', lockHash: 'e'.repeat(64) }, expected: 'image-drift',
    expectedFields: ['baseImageDigest', 'bunVersion', 'nodeVersion', 'lockHash'] },
  { id: 'missing-image-metadata', image: null, expected: 'image-metadata-unavailable' },
  { id: 'missing-node-version', image: { baseImageDigest: CUT_IDENTITY.baseImageDigest, bunVersion: CUT_IDENTITY.bunVersion,
    lockHash: CUT_IDENTITY.lockHash, checkoutSha: CUT_IDENTITY.checkoutSha }, expected: 'image-metadata-unavailable' },
  { id: 'malformed-lock-hash', image: drift('lockHash', 'not-a-hash'), expected: 'image-identity-invalid' },
  { id: 'malformed-semver', image: drift('bunVersion', '1.2.3-..'), expected: 'image-identity-invalid' },
  { id: 'base-image-digest-trailing-newline', image: drift('baseImageDigest', `sha256:${'b'.repeat(64)}\n`), expected: 'image-identity-invalid' },
  { id: 'bun-version-trailing-newline', image: drift('bunVersion', '1.4.2\n'), expected: 'image-identity-invalid' },
  { id: 'node-version-trailing-newline', image: drift('nodeVersion', 'v26.3.0\n'), expected: 'image-identity-invalid' },
  { id: 'lock-hash-trailing-newline', image: drift('lockHash', `${'c'.repeat(64)}\n`), expected: 'image-identity-invalid' },
  { id: 'checkout-sha-trailing-newline', image: drift('checkoutSha', `${CUT_SHA}\n`), expected: 'image-identity-invalid' },
];

export function runGateImagePreflightRuntimeScenario(scenario: GateImagePreflightRuntimeScenario) {
  return compareGateImageRuntimeIdentity(scenario.cut ?? CUT_IDENTITY, scenario.image);
}
