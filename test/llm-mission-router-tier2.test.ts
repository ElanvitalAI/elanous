// ── Mission router · Tier 2 fallback + LRU cache guard (P1-3) ──
//
// Pins:
//   • Tier 2 client is only invoked when Tier 1 confidence < 0.6.
//   • Tier 2 result is cached per (text + attachment-kinds) for 30 s.
//   • Tier 2 throw → graceful fall-back to Tier 1 (no exception leaks
//     into the input chip path).
//   • Repeated invocations under the same wall clock hit the cache —
//     the Tier 2 classifier is called exactly once.

import { describe, expect, test } from 'bun:test';
import {
  createMissionRouter,
  type MissionKind,
  type MissionLocalLLMClient,
} from '../src/llm/mission-router';

function makeCounted(handler: (i: { text: string }) => Promise<{ mission: MissionKind; confidence: number }>): {
  client: MissionLocalLLMClient;
  count: () => number;
} {
  let n = 0;
  const client: MissionLocalLLMClient = {
    async classify(input) {
      n += 1;
      // A conforming client reports the classify-role model it was told to use (the router discards anything else).
      return { ...(await handler(input)), model: input.model };
    },
  };
  return { client, count: () => n };
}

describe('createMissionRouter · Tier 2 invocation gating', () => {
  test('high-confidence Tier 1 does NOT invoke Tier 2', async () => {
    const { client, count } = makeCounted(async () => ({ mission: 'plan', confidence: 0.9 }));
    const router = createMissionRouter({ localLLM: client });
    const r = await router.predict({ text: 'implement the cache layer with TTL eviction' });
    expect(r.tier).toBe(1);
    expect(r.mission).toBe('build');
    expect(count()).toBe(0);
  });

  test('low-confidence Tier 1 DOES invoke Tier 2', async () => {
    const { client, count } = makeCounted(async () => ({ mission: 'review', confidence: 0.85 }));
    const router = createMissionRouter({ localLLM: client });
    // Plain narrative — no pattern match, no short rule → confidence 0.4
    const r = await router.predict({
      text: 'The weather is nice and the cat is sleeping on the windowsill while the kettle whistles.',
    });
    expect(count()).toBe(1);
    expect(r.tier).toBe(2);
    expect(r.mission).toBe('review');
    expect(r.confidence).toBe(0.85);
  });

  test('no localLLM client → no Tier 2 (Tier 1 result passes through)', async () => {
    const router = createMissionRouter();
    const r = await router.predict({
      text: 'random text with nothing matching',
    });
    expect(r.tier).toBe(1);
    expect(r.confidence).toBeLessThan(0.6);
  });
});

describe('createMissionRouter · Tier 2 LRU cache', () => {
  test('identical input within TTL → classifier called exactly once', async () => {
    const { client, count } = makeCounted(async () => ({ mission: 'research', confidence: 0.8 }));
    const router = createMissionRouter({ localLLM: client, now: () => 1000 });
    const text = 'sleepy unicorns wandering across the meadow at noontime';
    await router.predict({ text });
    await router.predict({ text });
    await router.predict({ text });
    expect(count()).toBe(1);
  });

  test('expired entry forces a re-classification', async () => {
    const { client, count } = makeCounted(async () => ({ mission: 'quick', confidence: 0.7 }));
    let t = 1000;
    const router = createMissionRouter({ localLLM: client, now: () => t });
    const text = 'short narrative with no clear mission';
    await router.predict({ text });
    expect(count()).toBe(1);
    // Jump past the 30 s TTL.
    t = 1000 + 30_001;
    await router.predict({ text });
    expect(count()).toBe(2);
  });

  test('attachments change cache key — same text with audio attachment misses', async () => {
    const { client, count } = makeCounted(async () => ({ mission: 'plan', confidence: 0.8 }));
    const router = createMissionRouter({ localLLM: client, now: () => 1000 });
    // Long opaque text → no pattern match → Tier 1 confidence 0.4 → Tier 2 invoked.
    const text = 'opaque narrative beyond twenty chars with no clear mission';
    await router.predict({ text });
    await router.predict({ text, attachments: [{ kind: 'audio' }] });
    expect(count()).toBe(2);
  });
});

describe('createMissionRouter · Tier 2 error graceful fallback', () => {
  test('classifier throw → falls back to Tier 1 result (no exception leak)', async () => {
    const client: MissionLocalLLMClient = {
      async classify() {
        throw new Error('local LLM unavailable');
      },
    };
    const router = createMissionRouter({ localLLM: client });
    const r = await router.predict({
      text: 'verbose narrative that triggers tier 2 fallback path here',
    });
    expect(r.tier).toBe(1);
    // Mission falls back to Tier 1's "quick" with low confidence.
    expect(r.mission).toBe('quick');
  });
});
