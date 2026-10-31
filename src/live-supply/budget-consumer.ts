import type { BudgetInputs } from '../self-implement/budget-gate.js';
import { debug } from '../debug/log.js';
import { freshSupplyAxis, loadLiveSupplySnapshot } from './read.js';
import type { LiveSupplySnapshot } from './snapshot.js';

function observe(event: string, data: Record<string, unknown>): void {
  try { debug.log('live-supply', event, data); } catch { /* observation never blocks a child */ }
}

/** Apply only negative, measured facts. The direct budget read still owns preference, credits and provider policy. */
export function budgetInputsWithLiveSupply(
  direct: BudgetInputs,
  snapshot: LiveSupplySnapshot | null = loadLiveSupplySnapshot(),
  nowMs = Date.now(),
): BudgetInputs {
  const codex = freshSupplyAxis(snapshot, 'codex', nowMs);
  const grok = freshSupplyAxis(snapshot, 'grok', nowMs);
  if (codex.status !== 'fresh' && grok.status !== 'fresh') {
    observe('snapshot-unavailable', {
      site: 'pod-budget', codex: codex.reason, grok: grok.reason,
    });
    return direct;
  }

  let candidates = direct.codexCandidates;
  if (codex.status === 'fresh' && Array.isArray(codex.value?.accounts)) {
    const accounts = codex.value.accounts;
    const sampled = new Map(accounts
      .filter(account => account && typeof account.name === 'string' && account.name.length > 0)
      .map(account => [account.name, account]));
    if (sampled.size !== accounts.length) {
      observe('snapshot-fallback', { site: 'pod-budget', axis: 'codex', sequence: codex.sequence, reason: 'malformed-accounts' });
    } else {
      let consumed = 0;
      let unmatched = 0;
      let invalid = 0;
      candidates = direct.codexCandidates.map(candidate => {
        const seen = sampled.get(candidate.name);
        if (!seen) { unmatched++; return candidate; }
        const used = typeof seen.usedPercent === 'number' && Number.isFinite(seen.usedPercent)
          && seen.usedPercent >= 0 && seen.usedPercent <= 100 ? seen.usedPercent : undefined;
        const available = typeof seen.available === 'boolean' ? seen.available : undefined;
        if (used === undefined && available !== false) { invalid++; return candidate; }
        consumed++;
        const directUsed = typeof candidate.usedPercent === 'number' && Number.isFinite(candidate.usedPercent)
          ? candidate.usedPercent : undefined;
        return {
          ...candidate,
          ...(used !== undefined ? { usedPercent: Math.max(directUsed ?? 0, used) } : {}),
          ...(available === false ? { reached: true } : {}),
        };
      });
      if (consumed) observe('snapshot-consumed', { site: 'pod-budget', axis: 'codex', sequence: codex.sequence });
      if (unmatched) observe('snapshot-fallback', { site: 'pod-budget', axis: 'codex', sequence: codex.sequence,
        reason: 'no-matching-account', count: unmatched });
      if (invalid) observe('snapshot-fallback', { site: 'pod-budget', axis: 'codex', sequence: codex.sequence,
        reason: 'invalid-account', count: invalid });
      if (!direct.codexCandidates.length) observe('snapshot-fallback', { site: 'pod-budget', axis: 'codex',
        sequence: codex.sequence, reason: 'no-candidates' });
    }
  } else {
    observe('snapshot-unavailable', { site: 'pod-budget', axis: 'codex',
      reason: codex.status === 'fresh' ? 'malformed' : codex.reason });
  }

  let grokUsedPercent = direct.grokUsedPercent;
  if (grok.status === 'fresh' && grok.value?.quota === 'exhausted') {
    grokUsedPercent = 100;
    observe('snapshot-consumed', { site: 'pod-budget', axis: 'grok', sequence: grok.sequence });
  } else if (grok.status === 'fresh') {
    observe('snapshot-fallback', { site: 'pod-budget', axis: 'grok', sequence: grok.sequence,
      reason: grok.value?.quota === 'usable' ? 'quota-usable' : grok.value?.quota === 'unknown' ? 'quota-unknown' : 'malformed' });
  } else {
    observe('snapshot-unavailable', { site: 'pod-budget', axis: 'grok',
      reason: grok.reason });
  }
  return { ...direct, codexCandidates: candidates, grokUsedPercent };
}
