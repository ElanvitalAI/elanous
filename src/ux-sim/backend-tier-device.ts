import { recommendBackendTier, type BackendTierInput } from '../nexus/apps/backend-tier.js';

/** Fake host profiles exercise tier advice without probing or changing the machine. */
export function simulateBackendTierProfiles() {
  const profiles: Array<{ name: string; input: BackendTierInput }> = [
    { name: 'unknown-memory', input: { memory: null, engines: [] } },
    { name: 'small-host', input: { memory: { totalBytes: 4 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 }, engines: [] } },
    { name: 't1-ready', input: { memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }, engines: [] } },
    { name: 't2-ready', input: { memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }, engines: ['Colima'] } },
    { name: 'low-available', input: { memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 }, engines: ['podman'] } },
  ];
  return profiles.map(({ name, input }) => ({ name, ...recommendBackendTier(input) }));
}
