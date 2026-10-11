// Grok budget fetcher adapter.
//
// Reuses `fetchGrokUsage` (src/grok/usage.ts). Existing subscription token
// only. Maps an explicitly returned weekly period + creditUsagePercent into
// the provider's weekly quota window; credit balances remain on the credits axis.

import {
  fetchGrokUsage,
  grokUsageToSubscriptionAxis,
  grokUsageToCreditAxis,
  type GrokUsage,
} from '../../grok/usage.js';
import type { ProviderFetcher } from '../usage-store.js';
import type { CreditsInfo, UsageProvider, UsageSnapshot } from '../types.js';

export interface GrokFetcherOpts {
  /** Test seam — same injected fetch as `fetchGrokUsage`. */
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export function createGrokFetcher(opts: GrokFetcherOpts = {}): ProviderFetcher {
  return {
    async fetch(): Promise<UsageSnapshot> {
      const result = await fetchGrokUsage({
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (result.status !== 'ok') {
        throw new Error(grokFetchFailureMessage(result.status, result.status === 'error' ? result.detail : undefined));
      }
      return grokUsageToSnapshot(result.usage);
    },
  };
}

export function grokUsageToSnapshot(usage: GrokUsage, fetchedAt: number = Date.now()): UsageSnapshot {
  const credits = creditsFromGrokUsage(usage);
  const subscription = grokUsageToSubscriptionAxis(usage);
  const windows = subscription.status === 'available'
    ? [{
        kind: 'weekly' as const,
        windowMinutes: 10_080,
        limit: 100,
        used: 100 - subscription.remainingPercent,
        remainingPercent: subscription.remainingPercent,
        resetsAt: subscription.resetsAt,
      }]
    : [];
  return {
    provider: 'grok' as UsageProvider,
    windows,
    ...(credits ? { credits } : {}),
    fetchedAt,
    source: 'oauth-api',
  };
}

function creditsFromGrokUsage(usage: GrokUsage): CreditsInfo | undefined {
  const axis = grokUsageToCreditAxis(usage);
  if (axis.prepaidBalance === null && axis.used === null && axis.monthlyLimit === null) return undefined;
  return {
    balance: axis.prepaidBalance ?? 0,
    hasCredits: axis.prepaidBalance !== null && axis.prepaidBalance > 0,
    unlimited: false,
  };
}

function grokFetchFailureMessage(
  status: 'no-subscription' | 'unauthorized' | 'error',
  detail?: string,
): string {
  if (status === 'no-subscription') return 'grok: no-subscription';
  if (status === 'unauthorized') return 'grok: unauthorized';
  return `grok: error${detail ? ` — ${detail}` : ''}`;
}
