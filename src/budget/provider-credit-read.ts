/** Provider read-only observations. Never resolve or persist credentials here: the
 * Nexus caller must supply an in-memory, appropriately scoped vault lease.
 * OpenRouter: https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
 */
export type CreditObservation = {
  provider: string;
  balance: { status: 'measured'; usd: number; totalCreditsUsd: number; totalUsageUsd: number; source: 'openrouter-credits-derived'; observedAt: string } | { status: 'unmeasured'; reason: string };
  autoTopUp: { status: 'unmeasured'; reason: 'not-provided' };
};

const unmeasured = (provider: string, reason: string): CreditObservation => ({
  provider, balance: { status: 'unmeasured', reason },
  autoTopUp: { status: 'unmeasured', reason: 'not-provided' },
});

/** No redirects: never send the bearer credential to a different origin. */
export async function readOpenRouterCredit(
  lease: string | undefined,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<CreditObservation> {
  if (!lease) return unmeasured('openrouter', 'missing-management-lease');
  try {
    const response = await (deps.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/credits', {
      method: 'GET', headers: { authorization: `Bearer ${lease}` },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return unmeasured('openrouter', response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'upstream-error');
    const body: unknown = await response.json();
    const data = (body as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
    const total = data?.total_credits;
    const used = data?.total_usage;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 ||
        typeof used !== 'number' || !Number.isFinite(used) || used < 0 || !Number.isFinite(total - used)) {
      return unmeasured('openrouter', 'invalid-response');
    }
    return {
      provider: 'openrouter',
      balance: { status: 'measured', usd: total - used, totalCreditsUsd: total, totalUsageUsd: used, source: 'openrouter-credits-derived', observedAt: (deps.now ?? (() => new Date()))().toISOString() },
      autoTopUp: { status: 'unmeasured', reason: 'not-provided' },
    };
  } catch {
    // Neither upstream payloads nor exception strings are safe to disclose.
    return unmeasured('openrouter', 'request-failed');
  }
}
