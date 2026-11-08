// Y2·1 (2026-05-17) — Codex Responses API `image_generation` server-tool
// wire. Two surface contracts:
//
//   1. toCodexResponsesTools(tools, serverTools) — translation layer
//      appends the built-in `image_generation` tool entry when the
//      caller opts in via opts.serverTools.imageGeneration. Options
//      (size/quality/background) pass through as native fields. When
//      not opted in, the tool entry is absent so the model can't
//      spontaneously invoke image generation. Mirrors the Gemini
//      `serverTools` opt-in pattern from toGeminiTools (Wave C2).
//
//   2. streamCodexResponsesEvents — SSE handler that recognizes the
//      `image_generation_call` output item (final base64 PNG) and
//      yields an LLMStreamEvent of type:'image'. Other output item
//      types (function_call) keep their existing wire path.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  toCodexResponsesTools,
  streamCodexResponsesEvents,
  type LLMStreamEvent,
} from '../src/llm';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

describe('toCodexResponsesTools — server-tool opt-in', () => {
  test('returns undefined when neither tools nor serverTools are present', () => {
    expect(toCodexResponsesTools(undefined)).toBeUndefined();
    expect(toCodexResponsesTools([])).toBeUndefined();
    expect(toCodexResponsesTools(undefined, {})).toBeUndefined();
  });

  test('passes through function tools unchanged when no serverTools', () => {
    const out = toCodexResponsesTools([
      { name: 'web_fetch', description: 'fetch url', parameters: { type: 'object', properties: {} } },
    ]);
    expect(out).toEqual([
      { type: 'function', name: 'web_fetch', description: 'fetch url', parameters: { type: 'object', properties: {} } },
    ]);
  });

  test('appends image_generation tool when serverTools.imageGeneration=true', () => {
    const out = toCodexResponsesTools(undefined, { imageGeneration: true });
    expect(out).toEqual([{ type: 'image_generation' }]);
  });

  test('image_generation appears alongside function tools (function tools first)', () => {
    const out = toCodexResponsesTools(
      [{ name: 'web_fetch', description: 'd', parameters: { type: 'object' } }],
      { imageGeneration: true },
    );
    expect(out).toHaveLength(2);
    expect(out![0]).toMatchObject({ type: 'function', name: 'web_fetch' });
    expect(out![1]).toEqual({ type: 'image_generation' });
  });

  test('size / quality / background flow through when object form is used', () => {
    const out = toCodexResponsesTools(undefined, {
      imageGeneration: { size: '1024x1024', quality: 'high', background: 'transparent' },
    });
    expect(out).toEqual([{
      type: 'image_generation',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
    }]);
  });

  test('partial object form only emits provided keys', () => {
    const out = toCodexResponsesTools(undefined, {
      imageGeneration: { size: '1536x1024' },
    });
    expect(out).toEqual([{ type: 'image_generation', size: '1536x1024' }]);
  });

  test('imageGeneration=false leaves the tool entry off', () => {
    const out = toCodexResponsesTools(
      [{ name: 'fn', description: 'd', parameters: { type: 'object' } }],
      { imageGeneration: false },
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ type: 'function', name: 'fn' });
  });
});

// ── streamCodexResponsesEvents — image_generation_call SSE handling ──

type Capture = { url: string; headers: Record<string, string>; body: any };

function installFetch(capture: Capture[], sseBody: string): FakeFetchDevice {
  return createFakeFetchDevice([{
    url: '/backend-api/codex/responses', method: 'POST', response: (request) => {
    const hdrs = request.headers;
    let parsed: any = request.body;
    try { if (typeof request.body === 'string') parsed = JSON.parse(request.body); } catch {}
    capture.push({ url: request.url, headers: { ...hdrs }, body: parsed });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  } }]);
}

async function collect(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let device: FakeFetchDevice;
let calls: Capture[];

describe('streamCodexResponsesEvents — image_generation_call output', () => {
  beforeEach(() => { calls = []; });
  afterEach(() => { device.restore(); });

  test('yields image event with base64 result + mediaType image/png', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_1","result":"iVBORw0KGgo="}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    device = installFetch(calls, sse);
    const events = await collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer',
      {
        model: 'gpt-5-codex',
        instructions: 'sys',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'draw a fox' }] }],
        tools: [{ type: 'image_generation' }],
      },
    ));
    const imageEvents = events.filter(e => e.type === 'image');
    expect(imageEvents).toHaveLength(1);
    expect(imageEvents[0]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      source: 'image_generation',
    });
  });

  test('forwards revised_prompt when the server reports one', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_2","result":"AAAA","revised_prompt":"A red fox sitting in a forest, photorealistic"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    device = installFetch(calls, sse);
    const events = await collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer',
      { model: 'gpt-5-codex', instructions: 'sys', input: [] },
    ));
    const image = events.find(e => e.type === 'image');
    expect(image).toBeDefined();
    expect((image as any).revisedPrompt).toBe('A red fox sitting in a forest, photorealistic');
  });

  test('omits revisedPrompt when the server does not provide one', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_3","result":"BBBB"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    device = installFetch(calls, sse);
    const events = await collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer',
      { model: 'gpt-5-codex', instructions: 'sys', input: [] },
    ));
    const image = events.find(e => e.type === 'image');
    expect(image).toBeDefined();
    expect((image as any).revisedPrompt).toBeUndefined();
  });

  test('drops the event silently when result is empty / non-string', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_4","result":""}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_5","result":null}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    device = installFetch(calls, sse);
    const events = await collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer',
      { model: 'gpt-5-codex', instructions: 'sys', input: [] },
    ));
    expect(events.filter(e => e.type === 'image')).toHaveLength(0);
  });

  test('coexists with function_call output items (mixed-output turn)', async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","call_id":"call_1","name":"web_fetch","arguments":"{\\"url\\":\\"https://example.com\\"}"}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","id":"img_6","result":"PNGDATA"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    device = installFetch(calls, sse);
    const events = await collect(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer',
      { model: 'gpt-5-codex', instructions: 'sys', input: [] },
    ));
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.filter(e => e.type === 'image')).toHaveLength(1);
    const toolCall = events.find(e => e.type === 'tool_call') as any;
    expect(toolCall.name).toBe('web_fetch');
    expect(toolCall.args.url).toBe('https://example.com');
  });
});
