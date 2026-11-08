import type { LLMToolSpec } from '../../src/llm/tool-spec.js';
import { describe, expect, test } from 'bun:test';
import {
  toAnthropicSystemBlocks,
  toAnthropicToolsCached,
  cacheControlFor,
  EPHEMERAL_CACHE,
  EPHEMERAL_CACHE_1H,
} from '../../src/prompt-cache/index.js';
import type { LLMMessage } from '../../src/llm.js';

describe('cacheControlFor', () => {
  test('default 5m returns EPHEMERAL_CACHE', () => {
    expect(cacheControlFor(undefined)).toBe(EPHEMERAL_CACHE);
    expect(cacheControlFor('5m')).toBe(EPHEMERAL_CACHE);
  });

  test('1h returns extended marker with ttl field', () => {
    expect(cacheControlFor('1h')).toBe(EPHEMERAL_CACHE_1H);
    expect(EPHEMERAL_CACHE_1H).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('toAnthropicSystemBlocks — ttl', () => {
  const msgs: LLMMessage[] = [{ role: 'system', content: 'prompt' }];

  test('default ttl produces 5m marker', () => {
    const out = toAnthropicSystemBlocks(msgs, { cache: true }) as Array<{ cache_control: unknown }>;
    expect(out[0]!.cache_control).toEqual(EPHEMERAL_CACHE);
  });

  test('ttl:"1h" produces 1h marker', () => {
    const out = toAnthropicSystemBlocks(msgs, { cache: true, ttl: '1h' }) as Array<{ cache_control: unknown }>;
    expect(out[0]!.cache_control).toEqual(EPHEMERAL_CACHE_1H);
  });

  test('cache:false keeps string form regardless of ttl', () => {
    const out = toAnthropicSystemBlocks(msgs, { cache: false, ttl: '1h' });
    expect(typeof out).toBe('string');
  });
});

describe('toAnthropicToolsCached — ttl', () => {
  const mkTool = (name: string): LLMToolSpec => ({
    name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  });

  test('default ttl → 5m on last tool', () => {
    const out = toAnthropicToolsCached([mkTool('a'), mkTool('b')], { cache: true })!;
    expect(out[1]!.cache_control).toEqual(EPHEMERAL_CACHE);
  });

  test('ttl:"1h" → 1h on last tool, others still unmarked', () => {
    const out = toAnthropicToolsCached([mkTool('a'), mkTool('b')], { cache: true, ttl: '1h' })!;
    expect(out[0]!.cache_control).toBeUndefined();
    expect(out[1]!.cache_control).toEqual(EPHEMERAL_CACHE_1H);
  });
});
