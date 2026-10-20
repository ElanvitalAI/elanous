// ── tool_result image content pipeline (Phase 1, 2026-05-05) ──
//
// Verifies the image-bearing tool_result wiring added so vision-capable
// models receive WT-C-2 WebTerminalScreenshot bytes as actual image
// input rather than base64 buried in stringified JSON. Per-provider
// behavior:
//   - Anthropic: array content passes through with nested wire shape
//     (image.source.{type:'base64', media_type, data}).
//   - OpenAI Chat / Codex Responses / Gemini: array content collapses
//     to a text-only metadata note (image bytes dropped, size note in
//     place) since these providers don't accept inline image bytes in
//     tool-result wire format as of 2026-05.
//
// Detector + helpers live alongside the wire converters in src/llm.ts.

import { describe, test, expect } from 'bun:test';
import {
  toAnthropicMessage,
  toOpenAIMessages,
  messagesToResponsesInput,
  maybeImageBearingResult,
  stringifyToolResultContent,
  appendNoticeToToolResult,
  type ContentBlock,
  type LLMMessage,
} from '../src/llm';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('maybeImageBearingResult', () => {
  test('detects WT-C-2 screenshot shape', () => {
    const result = {
      sessionId: 's1',
      terminalId: 't1',
      cols: 80,
      rows: 24,
      width: 640,
      height: 384,
      mediaType: 'image/png',
      dataB64: TINY_PNG,
    };
    const out = maybeImageBearingResult(result);
    expect(out).not.toBeNull();
    expect(out!.mediaType).toBe('image/png');
    expect(out!.dataB64).toBe(TINY_PNG);
    expect(out!.rest).toEqual({
      sessionId: 's1',
      terminalId: 't1',
      cols: 80,
      rows: 24,
      width: 640,
      height: 384,
    });
  });

  test('returns null for plain string output', () => {
    expect(maybeImageBearingResult('hello')).toBeNull();
  });

  test('returns null when mediaType is not image/*', () => {
    expect(maybeImageBearingResult({ mediaType: 'text/plain', dataB64: 'abc' })).toBeNull();
  });

  test('returns null when dataB64 is missing', () => {
    expect(maybeImageBearingResult({ mediaType: 'image/png' })).toBeNull();
  });

  test('returns null when dataB64 is empty', () => {
    expect(maybeImageBearingResult({ mediaType: 'image/png', dataB64: '' })).toBeNull();
  });

  test('returns null for non-objects', () => {
    expect(maybeImageBearingResult(null)).toBeNull();
    expect(maybeImageBearingResult(42)).toBeNull();
    expect(maybeImageBearingResult(undefined)).toBeNull();
  });
});

describe('stringifyToolResultContent', () => {
  test('plain string passes through', () => {
    expect(stringifyToolResultContent('result text')).toBe('result text');
  });

  test('text-only array joins with newlines', () => {
    const out = stringifyToolResultContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    expect(out).toBe('first\nsecond');
  });

  test('image item replaced with size note', () => {
    const out = stringifyToolResultContent([
      { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
      { type: 'text', text: '{"cols":80}' },
    ]);
    expect(out).toContain('[image: image/png');
    expect(out).toContain('KB');
    expect(out).toContain('provider does not accept image');
    expect(out).toContain('{"cols":80}');
  });
});

describe('appendNoticeToToolResult', () => {
  test('appends to string content with two newlines', () => {
    const block: Extract<ContentBlock, { type: 'tool_result' }> = {
      type: 'tool_result',
      tool_use_id: 'a',
      content: 'output',
    };
    appendNoticeToToolResult(block, 'NOTICE');
    expect(block.content).toBe('output\n\nNOTICE');
  });

  test('appends to last text item in array content', () => {
    const block: Extract<ContentBlock, { type: 'tool_result' }> = {
      type: 'tool_result',
      tool_use_id: 'a',
      content: [
        { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
        { type: 'text', text: '{"cols":80}' },
      ],
    };
    appendNoticeToToolResult(block, 'NOTICE');
    expect(Array.isArray(block.content)).toBe(true);
    const arr = block.content as Array<{ type: string; text?: string }>;
    expect(arr[0]!.type).toBe('image');
    expect(arr[1]!.type).toBe('text');
    expect(arr[1]!.text).toBe('{"cols":80}\n\nNOTICE');
  });

  test('pushes new text item when array has no text', () => {
    const block: Extract<ContentBlock, { type: 'tool_result' }> = {
      type: 'tool_result',
      tool_use_id: 'a',
      content: [
        { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
      ],
    };
    appendNoticeToToolResult(block, 'NOTICE');
    const arr = block.content as Array<{ type: string; text?: string }>;
    expect(arr).toHaveLength(2);
    expect(arr[1]!.type).toBe('text');
    expect(arr[1]!.text).toBe('NOTICE');
  });
});

describe('toAnthropicMessage — image-bearing tool_result', () => {
  test('array content maps to nested Anthropic wire shape', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
          { type: 'text', text: '{"cols":80,"rows":24}' },
        ],
      }],
    };
    const out = toAnthropicMessage(m) as { role: string; content: Array<Record<string, unknown>> };
    expect(out.role).toBe('user');
    const tr = out.content[0] as { type: string; tool_use_id: string; content: Array<Record<string, unknown>> };
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('call_1');
    expect(Array.isArray(tr.content)).toBe(true);
    expect(tr.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG },
    });
    expect(tr.content[1]).toEqual({ type: 'text', text: '{"cols":80,"rows":24}' });
  });

  test('string content passes through unchanged', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: 'plain text',
      }],
    };
    const out = toAnthropicMessage(m) as { content: Array<Record<string, unknown>> };
    expect(out.content[0]!.content).toBe('plain text');
  });
});

describe('toOpenAIMessages — image-bearing tool_result fallback', () => {
  test('array content collapses to text-only with image size note', () => {
    const m: LLMMessage = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
          { type: 'text', text: '{"cols":80}' },
        ],
      }],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(1);
    const wire = out[0] as { role: string; tool_call_id: string; content: string };
    expect(wire.role).toBe('tool');
    expect(wire.tool_call_id).toBe('call_1');
    expect(typeof wire.content).toBe('string');
    expect(wire.content).toContain('[image: image/png');
    expect(wire.content).toContain('{"cols":80}');
  });
});

describe('messagesToResponsesInput (Codex) — image-bearing tool_result fallback', () => {
  test('drops a tool result whose call is absent from the retained history and reports the dropped call', () => {
    const dropped: string[] = [];
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_orphan', content: 'old output' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_live', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_live', content: 'current output' }] },
    ];

    const out = messagesToResponsesInput(messages, { onOrphanToolResult: (callId) => dropped.push(callId) });
    expect(dropped).toEqual(['call_orphan']);
    expect(out.input.filter((item) => 'type' in item && item.type === 'function_call_output'))
      .toEqual([{ type: 'function_call_output', call_id: 'call_live', output: 'current output' }]);
    expect(out.input.some((item) => 'type' in item && item.type === 'function_call' && item.call_id === 'call_live')).toBe(true);
  });

  test('function_call_output.output is text-only string', () => {
    const messages: LLMMessage[] = [
      // matching tool_use so the orphan guard doesn't drop the tool_result
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'WebTerminalScreenshot', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [
            { type: 'image', mediaType: 'image/png', base64: TINY_PNG },
            { type: 'text', text: '{"cols":80}' },
          ],
        }],
      },
    ];
    const out = messagesToResponsesInput(messages);
    const tro = out.input.find(it => 'type' in it && it.type === 'function_call_output') as
      | { type: 'function_call_output'; call_id: string; output: string }
      | undefined;
    expect(tro).toBeDefined();
    expect(tro!.call_id).toBe('call_1');
    expect(typeof tro!.output).toBe('string');
    expect(tro!.output).toContain('[image: image/png');
    expect(tro!.output).toContain('{"cols":80}');
  });
});
