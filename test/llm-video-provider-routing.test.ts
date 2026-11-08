import { providerSupportsVideo } from '../src/llm/provider-capabilities.js';
// PR8 (2026-05-14) — LLM provider native video routing tests.
//
// Invariants:
//   1. providerSupportsVideo(model) → true for Gemini 1.5+ family · false elsewhere
//   2. acpPromptToLlmContent emits 'video' LLMContentBlock (not text placeholder)
//      when ACP video block has data + mimeType
//   3. Each provider adapter handles 'video' type:
//      · Gemini: inlineData passthrough (user role)
//      · Anthropic: text placeholder (graceful skip)
//      · OpenAI Chat Completions: text placeholder (graceful skip)
//   4. Incomplete video block (no data) → text placeholder fallback

import { describe, test, expect } from 'bun:test';

import { acpPromptToLlmContent } from '../src/acp/content-blocks.js';
import { toAnthropicMessage, toOpenAIMessage, messagesToGeminiInput, type ContentBlock } from '../src/llm.js';

describe('providerSupportsVideo', () => {
  test('Gemini 1.5+ family returns true', () => {
    expect(providerSupportsVideo('gemini-1.5-pro')).toBe(true);
    expect(providerSupportsVideo('gemini-1.5-flash')).toBe(true);
    expect(providerSupportsVideo('gemini-2.0-flash-exp')).toBe(true);
    expect(providerSupportsVideo('gemini-2.5-pro')).toBe(true);
  });

  test('local-router prefix variant (e.g. lmstudio/gemini-...) detected', () => {
    expect(providerSupportsVideo('local/gemini-2.0-flash')).toBe(true);
    expect(providerSupportsVideo('lmstudio/gemini-1.5-flash-q4')).toBe(true);
  });

  test('non-Gemini providers return false (Anthropic / OpenAI / Grok / Local)', () => {
    expect(providerSupportsVideo('claude-sonnet-4-6')).toBe(false);
    expect(providerSupportsVideo('claude-opus-4-7')).toBe(false);
    expect(providerSupportsVideo('gpt-5')).toBe(false);
    expect(providerSupportsVideo('gpt-4o')).toBe(false);
    expect(providerSupportsVideo('grok-4.6')).toBe(false);
    expect(providerSupportsVideo('qwen-2.5-vl-32b-instruct')).toBe(false);
    expect(providerSupportsVideo('llama-3.2-vision')).toBe(false);
  });

  test('empty / unknown returns false', () => {
    expect(providerSupportsVideo('')).toBe(false);
    expect(providerSupportsVideo('something-random')).toBe(false);
  });
});

describe('acpPromptToLlmContent · video emission (PR7 placeholder 졸업)', () => {
  test('full video block (data + mimeType) → LLMContentBlock video (provider routing 가능)', () => {
    const blocks = [
      { type: 'video', data: 'VID-BASE64-HERE', mimeType: 'video/mp4' } as const,
    ];
    const result = acpPromptToLlmContent(blocks as unknown as Parameters<typeof acpPromptToLlmContent>[0]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('video');
    const v = result[0] as { type: 'video'; mediaType: string; base64: string };
    expect(v.mediaType).toBe('video/mp4');
    expect(v.base64).toBe('VID-BASE64-HERE');
  });

  test('mixed text + image + video → 3 blocks · video preserved as native block', () => {
    const blocks = [
      { type: 'text', text: 'analyze this clip frame-by-frame' },
      { type: 'image', data: 'IMG-BASE64', mimeType: 'image/jpeg' },
      { type: 'video', data: 'VID-BASE64', mimeType: 'video/quicktime' },
    ];
    const result = acpPromptToLlmContent(blocks as unknown as Parameters<typeof acpPromptToLlmContent>[0]);
    expect(result.length).toBe(3);
    expect(result[0].type).toBe('text');
    expect(result[1].type).toBe('image');
    expect(result[2].type).toBe('video');
  });

  test('video block missing data → text placeholder fallback (no crash · no malformed video)', () => {
    const blocks = [
      { type: 'video', mimeType: 'video/mp4' } as const,
    ];
    const result = acpPromptToLlmContent(blocks as unknown as Parameters<typeof acpPromptToLlmContent>[0]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('text');
    expect((result[0] as { text: string }).text).toContain('video/mp4');
    expect((result[0] as { text: string }).text).toContain('incomplete');
  });

  test('video block missing mimeType + data → safe text placeholder', () => {
    const blocks = [
      { type: 'video' } as const,
    ];
    const result = acpPromptToLlmContent(blocks as unknown as Parameters<typeof acpPromptToLlmContent>[0]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('text');
    expect((result[0] as { text: string }).text).toContain('video/*');
  });
});

describe('Provider adapter · video routing', () => {
  const videoBlock: ContentBlock = { type: 'video', mediaType: 'video/mp4', base64: 'VIDDATA' };

  test('Gemini messagesToGeminiInput → user-role inlineData passthrough', () => {
    const out = messagesToGeminiInput([
      { role: 'user', content: [
        { type: 'text', text: 'analyze' },
        videoBlock,
      ] },
    ]);
    expect(out.contents.length).toBe(1);
    const parts = out.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual({ text: 'analyze' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'video/mp4', data: 'VIDDATA' } });
  });

  test('Gemini assistant role with video → text placeholder (defensive)', () => {
    const out = messagesToGeminiInput([
      { role: 'assistant', content: [videoBlock] },
    ]);
    const parts = out.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual({ text: '[video]' });
  });

  test('Anthropic toAnthropicMessage → text placeholder (no native video)', () => {
    const out = toAnthropicMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'analyze' },
        videoBlock,
      ],
    });
    const content = out.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'text', text: 'analyze' });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect((content[1] as { text: string }).text).toContain('video/mp4');
    expect((content[1] as { text: string }).text).toContain('Anthropic');
    expect((content[1] as { text: string }).text).toContain('key-frame');
  });

  test('OpenAI Chat toOpenAIMessage → text placeholder (no native video)', () => {
    const out = toOpenAIMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'analyze' },
        videoBlock,
      ],
    });
    const content = out.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'text', text: 'analyze' });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect((content[1] as { text: string }).text).toContain('video/mp4');
    expect((content[1] as { text: string }).text).toContain('OpenAI');
    expect((content[1] as { text: string }).text).toContain('key-frame');
  });
});
