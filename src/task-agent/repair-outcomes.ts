import type { TaskCard } from './task-hand.js';

/** Count confirmed repair-result transitions, not repeated rejudge decisions or current card status. */
export function measureRepairOutcomes(cards: readonly Pick<TaskCard, 'id' | 'history'>[], window: { since: number; until: number }) {
  const affected = new Set<string>();
  const latest = new Map<string, { effect: string | undefined; at: number; card: string }>();
  const counts = { applied: 0, failed: 0, unconfirmed: 0, results: 0, missingRunId: 0, unknownEffect: 0 };
  for (const card of cards) {
    for (const entry of card.history) {
      if (entry.event !== 'repair-result') continue;
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at) || at < window.since || at >= window.until) continue;
      // A repeated collector must not count a worker result twice.
      if (!entry.runId) { counts.missingRunId++; continue; }
      const key = `${card.id}\0${entry.runId}`;
      if (at >= (latest.get(key)?.at ?? -Infinity)) latest.set(key, { effect: entry.effect, at, card: card.id });
    }
  }
  for (const result of latest.values()) {
    if (result.effect === 'applied' || result.effect === 'failed' || result.effect === 'unconfirmed') {
      counts[result.effect]++;
    } else {
      counts.unknownEffect++;
    }
    counts.results++;
    affected.add(result.card);
  }
  return { ...counts, cards: affected.size };
}

export interface RepairTierModelCall {
  card: string;
  runId: string;
  at: string;
  tier: string;
  model: string;
  status: string;
}

/** Measure repair launch records in the requested window; missing dimensions stay explicit. */
export function measureRepairTierModels(
  cards: readonly Pick<TaskCard, 'id' | 'history' | 'repairs' | 'tier'>[],
  window: { since: number; until: number },
) {
  const attempts = new Map<string, RepairTierModelCall & { called: boolean }>();
  let invalidTimestamp = 0;
  let missingRunId = 0;
  for (const card of cards) {
    for (const repair of card.repairs ?? []) {
      const at = Date.parse(repair.at);
      if (!Number.isFinite(at)) { invalidTimestamp++; continue; }
      if (at < window.since || at >= window.until) continue;
      if (!repair.runId) { missingRunId++; continue; }
      const key = `${card.id}\0${repair.runId}`;
      const previous = attempts.get(key);
      if (previous && Date.parse(previous.at) > at) continue;
      const called = card.history.some((entry) => entry.runId === repair.runId
        && (entry.event === 'harness.role-llm' || entry.event === 'repair-result'));
      attempts.set(key, {
        card: card.id,
        runId: repair.runId,
        at: repair.at,
        tier: card.tier ?? 'unknown',
        model: repair.toModel || 'unknown',
        status: repair.status,
        called,
      });
    }
  }
  const rows = [...attempts.values()].sort((a, b) => a.at.localeCompare(b.at) || a.card.localeCompare(b.card) || a.runId.localeCompare(b.runId));
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.tier}\0${row.model}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  const tiers = ['하', '중', '상', '특', ...(rows.some((row) => !['하', '중', '상', '특'].includes(row.tier)) ? ['unknown'] : [])];
  const models = [...new Set([...rows.map((row) => row.model), 'openai-codex/gpt-6-sol'])];
  const byTierModel = tiers.flatMap((tier) => models.map((model) => {
    const observedN = grouped.get(`${tier}\0${model}`) ?? 0;
    return { tier, model, n: observedN || null, measured: observedN > 0, observedN };
  })).sort((a, b) => a.tier.localeCompare(b.tier) || a.model.localeCompare(b.model));
  const publicRow = ({ called: _called, ...row }: RepairTierModelCall & { called: boolean }): RepairTierModelCall => row;
  const solRows = rows.filter((row) => row.model.includes('gpt-6-sol'));
  return {
    samples: rows.length,
    measured: rows.length > 0,
    unmeasuredReason: rows.length ? null : 'no repair attempts in the requested window',
    byTierModel,
    solCalls: solRows.filter((row) => row.called).map(publicRow),
    solCallUnmeasured: solRows.filter((row) => !row.called).map(publicRow),
    invalidTimestamp,
    missingRunId,
  };
}
