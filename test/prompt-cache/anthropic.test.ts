import { describe, expect, test } from 'bun:test';
import {
  toAnthropicSystemBlocks,
  toAnthropicToolsCached,
  parseAnthropicUsage,
  formatUsageLine,
  EPHEMERAL_CACHE,
} from '../../src/prompt-cache/index.js';
import type { LLMMessage, LLMToolSpec } from '../../src/llm.js';

// ── toAnthropicSystemBlocks ────────────────────────────────────────

describe('toAnthropicSystemBlocks', () => {
  test('returns undefined when no system messages present', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'hi' }];
    expect(toAnthropicSystemBlocks(msgs, { cache: true })).toBeUndefined();
    expect(toAnthropicSystemBlocks(msgs, { cache: false })).toBeUndefined();
  });

  test('cache:false returns plain string for legacy wire shape', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'x' },
    ];
    expect(toAnthropicSystemBlocks(msgs, { cache: false })).toBe('a\n\nb');
  });

  test('cache:true returns single text block with cache_control ephemeral', () => {
    const msgs: LLMMessage[] = [{ role: 'system', content: 'hello' }];
    const out = toAnthropicSystemBlocks(msgs, { cache: true });
    expect(Array.isArray(out)).toBe(true);
    const arr = out as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.type).toBe('text');
    expect(arr[0]!.text).toBe('hello');
    expect(arr[0]!.cache_control).toEqual(EPHEMERAL_CACHE);
  });

  test('multiple system messages joined with double newline', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'ignored' },
      { role: 'system', content: 'B' },
    ];
    const out = toAnthropicSystemBlocks(msgs, { cache: true }) as Array<{ text: string }>;
    expect(out[0]!.text).toBe('A\n\nB');
  });

  test('content-block system with image — image dropped, text kept', () => {
    const msgs: LLMMessage[] = [{
      role: 'system',
      content: [
        { type: 'text', text: 'system text' },
        { type: 'image', mediaType: 'image/png', base64: 'xxx' },
      ],
    }];
    const out = toAnthropicSystemBlocks(msgs, { cache: true }) as Array<{ text: string }>;
    expect(out[0]!.text).toBe('system text');
  });

  test('empty string system message is skipped', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: 'x' },
    ];
    expect(toAnthropicSystemBlocks(msgs, { cache: true })).toBeUndefined();
  });
});

// ── toAnthropicToolsCached ─────────────────────────────────────────

const mkTool = (name: string): LLMToolSpec => ({
  name,
  description: `desc ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

describe('toAnthropicToolsCached', () => {
  test('undefined input → undefined', () => {
    expect(toAnthropicToolsCached(undefined, { cache: true })).toBeUndefined();
    expect(toAnthropicToolsCached(undefined, { cache: false })).toBeUndefined();
  });

  test('empty array → undefined', () => {
    expect(toAnthropicToolsCached([], { cache: true })).toBeUndefined();
  });

  test('cache:false leaves all tools without cache_control', () => {
    const out = toAnthropicToolsCached([mkTool('a'), mkTool('b')], { cache: false });
    expect(out).toHaveLength(2);
    for (const t of out!) expect(t.cache_control).toBeUndefined();
  });

  test('cache:true puts cache_control ONLY on the last tool', () => {
    const out = toAnthropicToolsCached(
      [mkTool('a'), mkTool('b'), mkTool('c')],
      { cache: true },
    )!;
    expect(out).toHaveLength(3);
    expect(out[0]!.cache_control).toBeUndefined();
    expect(out[1]!.cache_control).toBeUndefined();
    expect(out[2]!.cache_control).toEqual(EPHEMERAL_CACHE);
  });

  test('single tool gets cache_control on the (only) item', () => {
    const out = toAnthropicToolsCached([mkTool('solo')], { cache: true })!;
    expect(out[0]!.cache_control).toEqual(EPHEMERAL_CACHE);
  });

  test('preserves name/description/input_schema fields', () => {
    const out = toAnthropicToolsCached([mkTool('a')], { cache: true })!;
    expect(out[0]!.name).toBe('a');
    expect(out[0]!.description).toBe('desc a');
    expect(out[0]!.input_schema).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
  });

  test('validates every tool for unsupported top-level composition before Anthropic serialization', () => {
    expect(() => toAnthropicToolsCached([
      mkTool('first'),
      { ...mkTool('second'), parameters: { type: 'object', properties: {}, oneOf: [{ required: ['value'] }] } },
      { ...mkTool('third'), parameters: { type: 'object', properties: {}, anyOf: [{ required: ['value'] }] } },
    ], { cache: false })).toThrow('second (oneOf); third (anyOf)');
  });
});

// ── parseAnthropicUsage ────────────────────────────────────────────

describe('parseAnthropicUsage', () => {
  test('message_start with full usage', () => {
    const ev = {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 140,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1024,
        },
      },
    };
    expect(parseAnthropicUsage(ev)).toEqual({
      provider: 'anthropic',
      inputTokens: 140,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1024,
    });
  });

  test('message_delta with output + cache totals', () => {
    const ev = {
      type: 'message_delta',
      usage: {
        output_tokens: 320,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1024,
      },
    };
    expect(parseAnthropicUsage(ev)).toEqual({
      provider: 'anthropic',
      outputTokens: 320,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1024,
    });
  });

  test('message_stop without usage → null', () => {
    expect(parseAnthropicUsage({ type: 'message_stop' })).toBeNull();
  });

  test('unknown event type → null', () => {
    expect(parseAnthropicUsage({ type: 'ping' })).toBeNull();
  });

  test('null / undefined / non-object → null', () => {
    expect(parseAnthropicUsage(null)).toBeNull();
    expect(parseAnthropicUsage(undefined)).toBeNull();
    expect(parseAnthropicUsage('string')).toBeNull();
  });

  test('message_start with empty usage object → null', () => {
    expect(parseAnthropicUsage({
      type: 'message_start',
      message: { usage: {} },
    })).toBeNull();
  });

  test('partial usage — only cache_read present', () => {
    expect(parseAnthropicUsage({
      type: 'message_start',
      message: { usage: { cache_read_input_tokens: 500 } },
    })).toEqual({ provider: 'anthropic', cacheReadInputTokens: 500 });
  });
});

// ── formatUsageLine ────────────────────────────────────────────────

describe('formatUsageLine', () => {
  test('full usage — shows all 4 counters + hit ratio', () => {
    const line = formatUsageLine({
      inputTokens: 140,
      outputTokens: 320,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1024,
    });
    expect(line).toContain('read=1024');
    expect(line).toContain('create=0');
    expect(line).toContain('in=140');
    expect(line).toContain('out=320');
    expect(line).toContain('hit 88%');
  });

  test('zero read + create → no hit ratio when denom is zero', () => {
    const line = formatUsageLine({ outputTokens: 100 });
    expect(line).toContain('read=0');
    expect(line).toContain('out=100');
    expect(line).not.toContain('hit');
  });

  test('100% hit when read > 0 and everything else zero', () => {
    const line = formatUsageLine({ cacheReadInputTokens: 500 });
    expect(line).toContain('hit 100%');
  });

  test('0% hit when only input tokens (first call, no cache yet)', () => {
    const line = formatUsageLine({ inputTokens: 500 });
    expect(line).toContain('hit 0%');
  });
});
