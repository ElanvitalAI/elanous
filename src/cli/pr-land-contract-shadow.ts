import { getDefaultLogStore } from '../mss/logging/log-store.js';

type ShadowComparison = { comparison: 'complete' | 'unmeasured'; reason?: string;
  observedFailureCount?: number; missedFailureCount?: number; selectedTests?: number; totalTests?: number };

/** Missing pinned identity is unknown, never an asserted match. */
export function comparePinnedLandingHead(actual: string, pinned?: string): boolean | null {
  return pinned && /^[a-f0-9]{40}$/i.test(pinned) ? actual.toLowerCase() === pinned.toLowerCase() : null;
}

/** A landing can claim zero misses only from a complete gate observation on the exact head/base pair. */
export function compareContractShadowLanding(input: { head: string; base?: string }, observations: readonly unknown[]): ShadowComparison {
  if (!/^[a-f0-9]{40}$/i.test(input.head) || !input.base || !/^[a-f0-9]{40}$/i.test(input.base))
    return { comparison: 'unmeasured', reason: 'pinned head/base unavailable' };
  const matches = observations.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
    && (entry as Record<string, unknown>).commit === input.head
    && (entry as Record<string, unknown>).priorCommit === input.base);
  if (matches.length !== 1) return { comparison: 'unmeasured', reason: matches.length ? 'ambiguous gate observations' : 'exact-head gate observation absent' };
  const row = matches[0]!;
  if (row.comparison !== 'complete' || !Number.isSafeInteger(row.observedFailureCount)
    || !Number.isSafeInteger(row.selectedTests) || !Number.isSafeInteger(row.totalTests)
    || (row.observedFailureCount as number) < 0 || (row.selectedTests as number) < 0
    || (row.totalTests as number) < (row.selectedTests as number))
    return { comparison: 'unmeasured', reason: 'full gate sweep or counts unmeasured' };
  const missed = row.candidate === 'full' ? 0 : row.candidate === 'limited' ? row.missedFailureCount : null;
  if (!Number.isSafeInteger(missed) || (missed as number) < 0 || (missed as number) > (row.observedFailureCount as number))
    return { comparison: 'unmeasured', reason: 'missed failure count unmeasured' };
  return { comparison: 'complete', observedFailureCount: row.observedFailureCount as number,
    missedFailureCount: missed as number, selectedTests: row.selectedTests as number, totalTests: row.totalTests as number };
}

export function readContractShadowLanding(input: { head: string; base?: string }): ShadowComparison {
  const store = getDefaultLogStore();
  if (!store) return { comparison: 'unmeasured', reason: 'log store unavailable' };
  // Source: bounded local log query; an older observation outside the window remains unmeasured.
  const rows = store.query({ exactCategories: ['gate.contract-select.shadow'], events: ['observation'], limit: 500 });
  const observations = rows.flatMap((row) => { try { return [JSON.parse(row.data ?? '')]; } catch { return []; } });
  return compareContractShadowLanding(input, observations);
}
