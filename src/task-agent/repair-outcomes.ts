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
