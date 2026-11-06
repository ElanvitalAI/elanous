import { describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { NoLlmProviderAvailableError } from '../../llm.js';
import { getUserConfig, roleLlmEnvName } from '../../user-config.js';
import { podReviewProvider } from './self-implement-pod.js';

describe('podReviewProvider — review provider lookup never blocks a Pod launch', () => {
  test('a host without any LLM provider yields «unknown» and records the decision', () => {
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-review-provider-unresolved', emit: (r) => {
      if (r.category === 'self-implement.pod' && r.event === 'review-provider-unresolved') events.push(r.data as Record<string, unknown>);
    } });
    try {
      const provider = podReviewProvider(getUserConfig(), {}, 'space-1', () => { throw new NoLlmProviderAvailableError(); });
      expect(provider).toBeUndefined();
      expect(events).toEqual([{ spaceId: 'space-1', reason: 'no-host-llm-provider' }]);
    } finally {
      off();
    }
  });

  test('any other resolution error still propagates', () => {
    expect(() => podReviewProvider(getUserConfig(), {}, 'space-2', () => { throw new Error('config broken'); })).toThrow('config broken');
  });

  test('a review role pinned to OpenRouter resolves without a global provider', () => {
    const env = { [roleLlmEnvName('review')]: JSON.stringify({ provider: 'openrouter' }) };
    expect(podReviewProvider(getUserConfig(), env, 'space-3')).toBe('openrouter');
  });
});
