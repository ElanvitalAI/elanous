import { createGateImagePinHandshake, verifyGatePodImagePin } from '../../scripts/release-loop/gate-image-pin-handshake.js';

const RUN_ID = 'cut-run-037';
const CUTOFF_SHA = 'a'.repeat(40);
const PINNED_DIGEST = `sha256:${'b'.repeat(64)}`;
const DRIFTED_DIGEST = `sha256:${'c'.repeat(64)}`;

export interface GateImagePinHandshakeScenario {
  readonly id: string;
  readonly preflightDigest: unknown;
  readonly preflightRunId?: unknown;
  readonly observedRunId?: unknown;
  readonly observedCutoffSha?: unknown;
  readonly podImageDigest?: unknown;
  readonly podObservation?: unknown;
  readonly pinRunIdOverride?: unknown;
  readonly pinCutoffShaOverride?: unknown;
  /** Informational only: the mutable tag can move after preflight; the Pod is checked by imageID digest. */
  readonly tagDigestAtPodStart?: string;
  readonly expected: { readonly gateMayStart: boolean; readonly stage: 'preflight' | 'pod' | 'ready'; readonly reason?: string };
}

export const GATE_IMAGE_PIN_HANDSHAKE_SCENARIOS: readonly GateImagePinHandshakeScenario[] = [
  {
    id: 'aws3-registry-image-absent-no-pin-no-start',
    preflightDigest: null,
    expected: { gateMayStart: false, stage: 'preflight', reason: 'cutoff-image-unavailable' },
  },
  {
    id: 'preflight-run-id-explicitly-null-refuse',
    preflightDigest: PINNED_DIGEST,
    preflightRunId: null,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'preflight', reason: 'run-id-invalid' },
  },
  {
    id: 'cutoff-digest-matches-pod-imageID',
    preflightDigest: PINNED_DIGEST,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: true, stage: 'ready' },
  },
  {
    id: 'mutable-tag-moved-after-preflight-pod-still-uses-pinned-digest',
    preflightDigest: PINNED_DIGEST,
    tagDigestAtPodStart: DRIFTED_DIGEST,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: true, stage: 'ready' },
  },
  {
    id: 'pod-imageID-differs-from-cutoff-pin-refuse',
    preflightDigest: PINNED_DIGEST,
    podImageDigest: DRIFTED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'pod-image-digest-mismatch' },
  },
  {
    id: 'pod-imageID-not-observed-refuse',
    preflightDigest: PINNED_DIGEST,
    podImageDigest: null,
    expected: { gateMayStart: false, stage: 'pod', reason: 'pod-image-unavailable' },
  },
  {
    id: 'pod-observation-object-unavailable-refuse',
    preflightDigest: PINNED_DIGEST,
    podObservation: null,
    expected: { gateMayStart: false, stage: 'pod', reason: 'pod-observation-unavailable' },
  },
  {
    id: 'malformed-cutoff-digest-refuse-before-pin',
    preflightDigest: 'registry lookup returned no digest field',
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'preflight', reason: 'cutoff-image-digest-invalid' },
  },
  {
    id: 'pod-cutoff-tip-differs-from-pin-refuse',
    preflightDigest: PINNED_DIGEST,
    observedCutoffSha: 'd'.repeat(40),
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'cutoff-tip-mismatch' },
  },
  {
    id: 'pod-run-differs-from-pin-refuse',
    preflightDigest: PINNED_DIGEST,
    observedRunId: 'other-cut-run',
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'run-id-mismatch' },
  },
  {
    id: 'pod-run-id-explicitly-null-refuse',
    preflightDigest: PINNED_DIGEST,
    observedRunId: null,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'run-id-mismatch' },
  },
  {
    id: 'pod-cutoff-sha-explicitly-null-refuse',
    preflightDigest: PINNED_DIGEST,
    observedCutoffSha: null,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'cutoff-tip-mismatch' },
  },
  {
    id: 'malformed-pin-run-id-null-refuse',
    preflightDigest: PINNED_DIGEST,
    pinRunIdOverride: null,
    observedRunId: null,
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: false, stage: 'pod', reason: 'pin-invalid' },
  },
  {
    id: 'uppercase-cutoff-pin-normalizes-before-comparison',
    preflightDigest: PINNED_DIGEST,
    pinCutoffShaOverride: CUTOFF_SHA.toUpperCase(),
    podImageDigest: PINNED_DIGEST,
    expected: { gateMayStart: true, stage: 'ready' },
  },
];

export function runGateImagePinHandshakeScenario(scenario: GateImagePinHandshakeScenario) {
  const preflight = createGateImagePinHandshake({
    runId: Object.prototype.hasOwnProperty.call(scenario, 'preflightRunId') ? scenario.preflightRunId : RUN_ID,
    cutoffSha: CUTOFF_SHA,
    preflightDigest: scenario.preflightDigest,
  });
  if (!preflight.ok) return { gateMayStart: false as const, stage: 'preflight' as const, reason: preflight.reason };

  const pin: unknown = {
    ...preflight.pin,
    ...(scenario.pinRunIdOverride !== undefined ? { runId: scenario.pinRunIdOverride } : {}),
    ...(scenario.pinCutoffShaOverride !== undefined ? { cutoffSha: scenario.pinCutoffShaOverride } : {}),
  };
  const podObservation: unknown = Object.prototype.hasOwnProperty.call(scenario, 'podObservation')
    ? scenario.podObservation
    : {
      runId: Object.prototype.hasOwnProperty.call(scenario, 'observedRunId') ? scenario.observedRunId : RUN_ID,
      cutoffSha: Object.prototype.hasOwnProperty.call(scenario, 'observedCutoffSha') ? scenario.observedCutoffSha : CUTOFF_SHA,
      imageDigest: scenario.podImageDigest,
    };
  const gateCheck = verifyGatePodImagePin(pin, podObservation);
  if (!gateCheck.ok) return { gateMayStart: false as const, stage: 'pod' as const, reason: gateCheck.reason };
  return {
    gateMayStart: true as const,
    stage: 'ready' as const,
    pin,
    digest: gateCheck.digest,
    tagDrifted: scenario.tagDigestAtPodStart === undefined ? null : scenario.tagDigestAtPodStart !== gateCheck.digest,
  };
}
