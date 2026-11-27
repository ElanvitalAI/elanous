// ALLOCATION-BUDGET daily reconcile — metered totals per provider vs the provider usage snapshot (drift alert).
// The snapshot gives a window share (or a prepaid balance), not token counts, so drift is judged as movement without
// metering: the provider's used share rose by ≥ DRIFT_PCT since the previous reconcile while no allocation on it was metered
// (somebody spends outside the allocator), or metered paid $ moved while the snapshot did not exist.
import type { AllocReconcileEvent, AllocReconcileRow } from './alloc-events.js';
import { paidUsdOf, providerOf, providerUsedPct, since, tokensOf, usdOf, type AllocRow, type AllocUsageSnapshot } from './fold.js';
import { DEFAULT_ALLOC_POLICY, kstDay } from './policy.js';

export const DRIFT_PCT = 5;

export function reconcileMetering(events: readonly { event: string }[], rows: readonly AllocRow[], snap: AllocUsageSnapshot | null, now: Date, by = 'loop:guardian'): AllocReconcileEvent {
  const prev = [...events].reverse().find((e): e is AllocReconcileEvent => e.event === 'alloc-reconcile');
  const fromMs = prev ? Date.parse(prev.at) : now.getTime() - 86_400_000;
  const window = since(rows, fromMs);
  const providers = [...new Set([...(snap?.accounts ?? []).map(a => a.provider), ...window.map(providerOf).filter((p): p is string => !!p)])].sort();
  const out: AllocReconcileRow[] = providers.map(provider => {
    const mine = window.filter(r => providerOf(r) === provider);
    const used = providerUsedPct(snap, provider);
    const before = prev?.rows.find(r => r.provider === provider)?.providerUsedPct ?? null;
    const delta = used !== null && before !== null ? Math.round((used - before) * 10) / 10 : null;
    const paid = mine.reduce((s, r) => s + paidUsdOf(r, DEFAULT_ALLOC_POLICY), 0);
    const unmetered = delta !== null && delta >= DRIFT_PCT && mine.length === 0;
    const blind = used === null && paid > 0;
    return { provider, meteredUsd: Math.round(mine.reduce((s, r) => s + usdOf(r), 0) * 100) / 100, meteredTokens: mine.reduce((s, r) => s + tokensOf(r), 0), grants: mine.length,
      providerUsedPct: used === null ? null : Math.round(used * 10) / 10, deltaUsedPct: delta, alert: unmetered || blind,
      why: unmetered ? `창 +${delta}% 인데 미터링 0건 — 할당기 밖 소비` : blind ? `유료 $${paid.toFixed(2)} 미터됐는데 공급자 스냅숏 없음` : delta === null ? '첫 대조 또는 스냅숏 없음' : '일치' };
  });
  return { event: 'alloc-reconcile', at: now.toISOString(), by, day: kstDay(now), rows: out };
}
