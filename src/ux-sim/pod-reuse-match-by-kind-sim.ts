import { warmRuntimeContractMatches, type WarmPodSpec } from '../task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { scoreWarmPodCandidates, type WarmPodKind } from '../task-orchestrator/surfaces/pod-warm-provenance.js';
import { runtimeArchitecturesMatch } from '../runtime-identity.js';

const runtimeContract: NonNullable<WarmPodSpec['runtimeContract']> = {
  bunVersion: '1.2.3', os: 'linux', architecture: 'amd64', requiredTools: ['bun', 'git'],
};
const observed = { bunVersion: '1.2.3', os: 'linux', architecture: 'amd64', tools: { bun: true, git: true } };
const cutSha = 'a'.repeat(40);
const lockHash = 'b'.repeat(64);
const digest = 'sha256:' + 'c'.repeat(64);
const runtimeIdentity = { baseImageDigest: 'sha256:' + 'a'.repeat(64), lockHash, os: 'linux', architecture: 'amd64', bunVersion: '1.2.3' };

/** The actual production scorer and runtime-contract predicate, with no cluster or network. */
export function runPodReuseMatchByKindSimulation() {
  const candidate = (id: string, kind: WarmPodKind, options: { cutSha?: string; lockHash?: string; imageDigest?: string;
    cutShaDistance?: number; contractCompatible?: boolean; architecture?: string; allowedArchitectures?: readonly string[] } = {}) => ({
    candidate: id, kind, cutSha: options.cutSha ?? cutSha, lockHash: options.lockHash ?? lockHash,
    imageDigest: options.imageDigest ?? digest, cutShaDistance: options.cutShaDistance ?? 0,
    runtimeIdentity: { ...runtimeIdentity, architecture: options.architecture ?? runtimeIdentity.architecture },
    contractCompatible: options.contractCompatible ?? (options.architecture
      ? runtimeArchitecturesMatch(runtimeContract.architecture, options.architecture, options.allowedArchitectures)
      : warmRuntimeContractMatches(runtimeContract, observed)),
  });
  const score = (kind: WarmPodKind, rows: ReturnType<typeof candidate>[], allowedArchitectures?: readonly string[]) => scoreWarmPodCandidates({
    kind, cutSha, lockHash, imageDigest: digest, runtimeIdentity, allowedArchitectures, candidates: rows,
  });

  return {
    implementation: {
      compatibleImageDrift: score('implementation', [candidate('impl-digest-drift', 'implementation', {
        imageDigest: 'sha256:' + 'd'.repeat(64),
      })]),
      lockHashMismatch: score('implementation', [candidate('impl-wrong-lock', 'implementation', {
        lockHash: 'e'.repeat(64),
      })]),
      runtimeContractMismatch: score('implementation', [candidate('impl-wrong-runtime', 'implementation', {
        contractCompatible: warmRuntimeContractMatches(runtimeContract, { ...observed, bunVersion: '0.0.0' }),
      })]),
    },
    gate: {
      exactTupleOnly: score('gate', [candidate('gate-cut-mismatch', 'gate', { cutSha: 'f'.repeat(40) }),
        candidate('gate-lock-mismatch', 'gate', { lockHash: 'e'.repeat(64) }),
        candidate('gate-digest-mismatch', 'gate', { imageDigest: 'sha256:' + 'd'.repeat(64) }),
        candidate('gate-exact', 'gate')]),
      contractMismatchRejected: score('gate', [candidate('gate-wrong-runtime', 'gate', { contractCompatible: false }),
        candidate('gate-compatible', 'gate')]),
      architectureMismatchRejected: score('gate', [candidate('gate-arm64-without-allowlist', 'gate', { architecture: 'arm64' })]),
      architecturePairAllowlisted: score('gate', [candidate('gate-arm64-allowlisted', 'gate', {
        architecture: 'arm64', allowedArchitectures: ['amd64', 'arm64'],
      })], ['amd64', 'arm64']),
      kindMismatchRejected: score('gate', [candidate('implementation-only', 'implementation'),
        candidate('gate-kind', 'gate')]),
    },
  };
}
