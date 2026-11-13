/** A36: pure candidate contract. Lease generation/quorum promotion remains in lease.ts. */
export const HQ_PRIORITY = ['mshq', 'node-b', 'aws1'] as const;
export type HqPriorityHost = typeof HQ_PRIORITY[number];

export interface HqHostObservation { readonly reachable: boolean; readonly at: number }
export type HqPriorityDecision =
  | { readonly kind: 'hold'; readonly host: 'mshq' }
  | { readonly kind: 'candidate'; readonly host: 'node-b' | 'aws1'; readonly prior: readonly HqPriorityHost[] }
  | { readonly kind: 'office-unavailable'; readonly hosts: readonly HqPriorityHost[] }
  | { readonly kind: 'unknown'; readonly host: HqPriorityHost; readonly reason: 'missing-or-stale-observation' };

/** A missing/stale higher-priority observation never licenses a lower-priority promotion. */
export function decideHqPriorityCandidate(input: {
  readonly now: number;
  readonly observations: Partial<Record<HqPriorityHost, HqHostObservation>>;
  readonly freshnessSeconds?: number;
}): HqPriorityDecision {
  const freshness = input.freshnessSeconds ?? 1500;
  if (!Number.isFinite(input.now) || !Number.isFinite(freshness) || freshness <= 0) {
    throw new Error('invalid HQ observation window');
  }
  for (const [index, host] of HQ_PRIORITY.entries()) {
    const view = input.observations[host];
    if (!view || !Number.isFinite(view.at) || view.at > input.now || input.now - view.at > freshness) {
      return { kind: 'unknown', host, reason: 'missing-or-stale-observation' };
    }
    if (view.reachable === false) continue;
    if (view.reachable !== true) return { kind: 'unknown', host, reason: 'missing-or-stale-observation' };
    if (host === 'mshq') return { kind: 'hold', host };
    return { kind: 'candidate', host, prior: HQ_PRIORITY.slice(0, index) };
  }
  return { kind: 'office-unavailable', hosts: HQ_PRIORITY };
}
