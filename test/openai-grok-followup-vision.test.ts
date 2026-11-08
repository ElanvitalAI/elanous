// Image-pipeline P3.5 (2026-05-05) — OpenAI Chat / Grok synthetic
// follow-up user-message workaround.
//
// OpenAI Chat Completions API spec restricts `role: 'tool'` content to
// text-only (`{type:'text'}` blocks). vision-capable models (gpt-4o,
// gpt-5.x via Chat path, grok-2-vision, grok-4.x) DO accept image_url
// on `role: 'user'` though, so we bridge tool-result images by:
//   1. emitting the standard `{role:'tool', content: <stringified>}`
//      with the image-bearing array collapsed to a size-note text
//      placeholder (legacy P1 fallback);
//   2. immediately following it with a synthetic
//      `{role:'user', content: [text-marker, image_url]}` carrying
//      the actual base64 bytes.
//
// The opt-in is `toOpenAIMessages(m, { acceptToolImagesViaFollowup })`.
// Provider call sites pass `isVisionCapableModel(brand, model,
// 'userMessage')` so non-vision routes (gpt-3.5, grok-1, local) keep
// the strict text-only contract.

import { describe, expect, test } from 'bun:test';
import { toOpenAIMessages, type LLMMessage } from '../src/llm.js';

function imageBearingMessages(): LLMMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'c1', name: 'WebTerminalScreenshot', input: { terminalId: 'preview-1' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [
            { type: 'text', text: '{"cols":80,"rows":24,"width":640,"height":384}' },
            { type: 'image', mediaType: 'image/png', base64: 'iVBORw0KGgo' },
          ],
        },
      ],
    },
  ];
}

describe('toOpenAIMessages — synthetic follow-up vision workaround', () => {
  test('default (acceptToolImagesViaFollowup=false) emits ONLY text-fallback tool message', () => {
    const wire = imageBearingMessages().flatMap((m) => toOpenAIMessages(m));
    // Expect: assistant w/ tool_calls + tool message (text fallback).
    // NO synthetic user follow-up.
    expect(wire).toHaveLength(2);
    expect(wire[0]!.role).toBe('assistant');
    expect((wire[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect(wire[1]!.role).toBe('tool');
    expect((wire[1] as { tool_call_id: string }).tool_call_id).toBe('c1');
    expect(typeof (wire[1] as { content: unknown }).content).toBe('string');
    expect((wire[1] as { content: string }).content).toContain('image: image/png');
  });

  test('acceptToolImagesViaFollowup=true appends synthetic user message with image_url', () => {
    const wire = imageBearingMessages().flatMap(
      (m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }),
    );
    // Now: assistant + tool + synthetic user follow-up.
    expect(wire).toHaveLength(3);
    expect(wire[1]!.role).toBe('tool');
    expect(wire[2]!.role).toBe('user');
    const followupContent = wire[2]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(followupContent)).toBe(true);
    // First item: text marker referencing the tool_use_id (provenance).
    expect(followupContent[0]!.type).toBe('text');
    expect((followupContent[0] as { text: string }).text).toContain('tool_use_id=c1');
    // Second item: actual image_url block.
    expect(followupContent[1]!.type).toBe('image_url');
    const imageUrl = (followupContent[1] as { image_url: { url: string } }).image_url;
    expect(imageUrl.url).toBe('data:image/png;base64,iVBORw0KGgo');
  });

  test('text-only tool_result emits no follow-up even with opt-in', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file contents here' }],
      },
    ];
    const wire = msgs.flatMap((m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }));
    expect(wire).toHaveLength(2);
    expect(wire[1]!.role).toBe('tool');
    // No synthetic user follow-up.
    expect(wire.some((w) => w.role === 'user' && Array.isArray(w.content))).toBe(false);
  });

  test('array tool_result without images emits no follow-up', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [{ type: 'text', text: 'just text' }],
          },
        ],
      },
    ];
    const wire = msgs.flatMap((m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }));
    expect(wire).toHaveLength(2);
    expect(wire.some((w) => w.role === 'user' && Array.isArray(w.content))).toBe(false);
  });

  test('multi-image tool_result: single follow-up with text marker + multiple image_urls', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'multi', name: 'WebTerminalScreenshot', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'multi',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', mediaType: 'image/png', base64: 'AAAA' },
              { type: 'image', mediaType: 'image/jpeg', base64: 'BBBB' },
              { type: 'text', text: 'after' },
            ],
          },
        ],
      },
    ];
    const wire = msgs.flatMap((m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }));
    // assistant + tool + 1 follow-up user message
    expect(wire).toHaveLength(3);
    const followup = wire[2]!.content as Array<Record<string, unknown>>;
    // text marker + 2 image_urls
    expect(followup).toHaveLength(3);
    expect(followup[0]!.type).toBe('text');
    expect((followup[0] as { text: string }).text).toContain('Images');
    expect(followup[1]!.type).toBe('image_url');
    expect(followup[2]!.type).toBe('image_url');
    expect((followup[1] as { image_url: { url: string } }).image_url.url)
      .toBe('data:image/png;base64,AAAA');
    expect((followup[2] as { image_url: { url: string } }).image_url.url)
      .toBe('data:image/jpeg;base64,BBBB');
  });

  test('preserves ordering: tool message comes BEFORE synthetic user follow-up', () => {
    // Critical for the model's reasoning — the tool result text
    // gives metadata/error context, then the follow-up image lands
    // as visual evidence. Reverse order would confuse the model.
    const wire = imageBearingMessages().flatMap(
      (m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }),
    );
    const toolIdx = wire.findIndex((w) => w.role === 'tool');
    const followupIdx = wire.findIndex((w, i) => i > toolIdx && w.role === 'user');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(followupIdx).toBe(toolIdx + 1);
  });

  test('multiple tool_results in one message: each gets its own follow-up', () => {
    // Edge case — the OpenAI spec actually splits multiple tool_results
    // into separate `{role:'tool'}` messages. The follow-up workaround
    // should mirror this 1:1 so each image stays paired with the
    // correct tool_call_id.
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'WebTerminalScreenshot', input: {} },
          { type: 'tool_use', id: 'b', name: 'WebTerminalScreenshot', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [
              { type: 'text', text: '{a:1}' },
              { type: 'image', mediaType: 'image/png', base64: 'AAAA' },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: [
              { type: 'text', text: '{b:2}' },
              { type: 'image', mediaType: 'image/png', base64: 'BBBB' },
            ],
          },
        ],
      },
    ];
    const wire = msgs.flatMap((m) => toOpenAIMessages(m, { acceptToolImagesViaFollowup: true }));
    // assistant + tool(a) + user(a-img) + tool(b) + user(b-img)
    expect(wire).toHaveLength(5);
    expect(wire[0]!.role).toBe('assistant');
    expect(wire[1]!.role).toBe('tool');
    expect((wire[1] as { tool_call_id: string }).tool_call_id).toBe('a');
    expect(wire[2]!.role).toBe('user');
    const followupA = wire[2]!.content as Array<Record<string, unknown>>;
    expect((followupA[0] as { text: string }).text).toContain('tool_use_id=a');
    expect(wire[3]!.role).toBe('tool');
    expect((wire[3] as { tool_call_id: string }).tool_call_id).toBe('b');
    expect(wire[4]!.role).toBe('user');
    const followupB = wire[4]!.content as Array<Record<string, unknown>>;
    expect((followupB[0] as { text: string }).text).toContain('tool_use_id=b');
  });
});
