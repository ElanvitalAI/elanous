import { describe, expect, test } from 'bun:test';
import { simWorldScenarios, fakeWorld } from './scenarios';

describe('review real git fixture scenarios', () => {
  for (const id of ['LR-REVIEW-GIT-MERGE-BASE', 'LR-REVIEW-GIT-RANGE-DIFF', 'LR-REVIEW-GIT-HEAD-MOVED']) {
    test(id, async () => {
      const scenario = simWorldScenarios.find(s => s.id === id);
      expect(scenario).toBeDefined();
      const events: any[] = [];
      const result = await scenario!.run({seed: 1, device: () => ({fakeWorld}), recorder: {event: (kind: string, data: unknown) => events.push({kind, data})}} as any);
      expect(result.ok).toBe(true);
      expect(events.map(e => e.data.seed)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every(e => e.kind === 'llm-route:seed' && e.data.scenario === id && e.data.ok)).toBe(true);
    });
  }
});
