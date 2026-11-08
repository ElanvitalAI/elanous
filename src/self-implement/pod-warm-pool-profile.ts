/** Warm-pool profile labels select a host/tier allocation policy. */
export const WARM_POOL_PROFILES = ['fixed', 'gate', 'landing', 'feature'] as const;
export type WarmPoolProfile = (typeof WARM_POOL_PROFILES)[number];
export type WarmPoolTier = 'lite' | 'standard';
export type WarmPoolMeasuredPhase = 'cut' | 'landing' | 'feature';

/** A phase's measured shard execution time; this is a scheduling proxy, not Pod occupancy. */
export interface WarmPoolPhaseSample {
  phase: WarmPoolMeasuredPhase;
  shardSeconds: number;
}
export interface WarmPoolPhaseRatios {
  gate: number;
  landing: number;
  feature: number;
}

/**
 * Convert measured shard-seconds into shares for profiles represented in the input.
 * The 0.3.6 cut ledger only records `cut`, which maps to the gate profile; absent
 * phases stay at zero so an unmeasured profile cannot claim warm capacity.
 */
export function deriveWarmPoolPhaseRatios(
  samples: readonly WarmPoolPhaseSample[],
): Readonly<WarmPoolPhaseRatios> {
  const totals = { gate: 0, landing: 0, feature: 0 };
  for (const sample of samples) {
    if (!Number.isFinite(sample.shardSeconds) || sample.shardSeconds <= 0) continue;
    if (sample.phase !== 'cut' && sample.phase !== 'landing' && sample.phase !== 'feature') continue;
    const profile = sample.phase === 'cut' ? 'gate' : sample.phase;
    totals[profile] += sample.shardSeconds;
  }
  const total = totals.gate + totals.landing + totals.feature;
  if (!Number.isFinite(total) || total === 0) return { gate: 0, landing: 0, feature: 0 };
  return {
    gate: totals.gate / total,
    landing: totals.landing / total,
    feature: totals.feature / total,
  };
}

// Snapshot from the 2026-11-07 0.3.6 cut ledger at commit 3cb140ec: latest rows
// for 82 shard IDs were all terminal; 70 had an attemptId and contributed 16,673.530
// executed shard-seconds, while 12 reused receipts (no attemptId) were excluded.
// All measured executions were phase `cut` (gate share 1.0; landing/feature unmeasured).
// This is shard execution time, not Pod occupancy; no occupancy trace was recorded.
const CUT_LEDGER_PHASE_RATIOS = deriveWarmPoolPhaseRatios([
  { phase: 'cut', shardSeconds: 16_673.53 },
]);
const STANDARD_HOST_MAX: Readonly<Record<string, number>> = {
  'node-b': 16,
  'node-c': 4,
  'elangram-wsl': 5,
  'host-e-wsl': 5,
  'gcp1': 2,
  'aws1': 2,
  'aws2': 2,
};

// Only this host/tier pair has a measured lite allocation. Other pairs fail closed to zero.
const LITE_HOST_MAX: Readonly<Record<string, number>> = { mbp: 7 };

export function isWarmPoolProfile(value: unknown): value is WarmPoolProfile {
  return typeof value === 'string' && (WARM_POOL_PROFILES as readonly string[]).includes(value);
}

/** Parse a configured profile. Missing or invalid values fail closed to the fixed profile. */
function parseWarmPoolProfile(value: unknown): WarmPoolProfile {
  return isWarmPoolProfile(value) ? value : 'fixed';
}

/** Read the profile from either the full config object or its pod section. */
export function resolveWarmPoolProfile(config: unknown): WarmPoolProfile {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'fixed';
  const root = config as Record<string, unknown>;
  const pod = root.pod && typeof root.pod === 'object' && !Array.isArray(root.pod)
    ? root.pod as Record<string, unknown>
    : root;
  const raw = root.raw && typeof root.raw === 'object' && !Array.isArray(root.raw)
    ? root.raw as Record<string, unknown>
    : undefined;
  const rawPod = raw?.pod && typeof raw.pod === 'object' && !Array.isArray(raw.pod)
    ? raw.pod as Record<string, unknown>
    : undefined;
  return parseWarmPoolProfile(pod.warmPoolProfile ?? rawPod?.warmPoolProfile);
}

/**
 * Phase-scaled warm-worker cap for a host and tier. Fixed keeps the physical cap;
 * phase profiles use their measured shard-time share, with unmeasured shares at zero.
 */
export function resolveWarmPoolQuota(
  profile: WarmPoolProfile,
  host: string,
  tier: WarmPoolTier,
  phaseRatios: WarmPoolPhaseRatios = CUT_LEDGER_PHASE_RATIOS,
): number {
  if (!isWarmPoolProfile(profile) || !host.trim()) return 0;
  const cap = tier === 'lite'
    ? (Object.hasOwn(LITE_HOST_MAX, host) ? LITE_HOST_MAX[host] : 0)
    : tier === 'standard'
      ? (Object.hasOwn(STANDARD_HOST_MAX, host) ? STANDARD_HOST_MAX[host] : 0)
      : 0;
  if (cap === 0 || profile === 'fixed') return cap;
  const ratio = phaseRatios[profile];
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return 0;
  return Math.floor(cap * ratio);
}
