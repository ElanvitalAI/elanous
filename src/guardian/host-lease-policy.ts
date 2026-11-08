export type HostLeasePolicyReason = 'exclusive-lease-conflict' | 'host-purpose-restricted';
export interface HostLeasePolicyInput { host: string; consumer: string; purpose: string }
export interface HostLeasePolicy {
  allowed: boolean;
  reason?: HostLeasePolicyReason;
  alternatives: string[];
  exclusive: boolean;
}

export const HOST_LEASE_ALTERNATIVE_HOSTS = ['mshq', 'node-c', 'aws1', 'gcp2'] as const;

/** Shared protected-host policy for both the simulator and Nexus-backed admission. */
export function evaluateHostLeasePolicy(request: HostLeasePolicyInput): HostLeasePolicy {
  if (request.host === 'gcp1') return request.consumer === 'TSC-DIET'
    ? { allowed: true, alternatives: [], exclusive: true }
    : { allowed: false, reason: 'exclusive-lease-conflict', alternatives: [...HOST_LEASE_ALTERNATIVE_HOSTS], exclusive: true };
  if (request.host === 'node-b') return request.purpose === 'release-cut-gate'
    ? { allowed: true, alternatives: [], exclusive: true }
    : { allowed: false, reason: 'host-purpose-restricted', alternatives: [...HOST_LEASE_ALTERNATIVE_HOSTS], exclusive: true };
  return { allowed: true, alternatives: [], exclusive: false };
}
