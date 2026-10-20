/** Warm-pool profile labels select a host/tier allocation policy. */
export const WARM_POOL_PROFILES = ['fixed', 'gate', 'landing', 'feature'] as const;
export type WarmPoolProfile = (typeof WARM_POOL_PROFILES)[number];
export type WarmPoolTier = 'lite' | 'standard';
const STANDARD_HOST_MAX: Readonly<Record<string, number>> = {
  node-b: 16,
  node-c: 4,
  'host-e-wsl': 5,
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

/** Physical warm-worker cap for a host and worker memory tier; unknown pairs are unmeasured (0). */
export function resolveWarmPoolQuota(profile: WarmPoolProfile, host: string, tier: WarmPoolTier): number {
  if (!isWarmPoolProfile(profile) || !host.trim()) return 0;
  if (tier === 'lite') return Object.hasOwn(LITE_HOST_MAX, host) ? LITE_HOST_MAX[host] : 0;
  if (tier === 'standard') return Object.hasOwn(STANDARD_HOST_MAX, host) ? STANDARD_HOST_MAX[host] : 0;
  return 0;
}
