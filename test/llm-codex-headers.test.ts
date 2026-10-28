// ── Codex Responses fetch: header + body wire shape ──
//
// L1 + L2a contract (per chatgpt.com/backend-api/codex spec, verified
// via omni-crawl sweep 2026-04):
//   - chatgpt-account-id must be sent when OAuth claims are available
//     (routes billing to the user's Plus/Pro subscription)
//   - OpenAI-Beta: responses=experimental + originator: codex_cli_rs
//     must always be sent (selects the codex schema server-side)
//   - prompt_cache_key must be in the body (maximises KV-cache reuse,
//     ~10× cheaper cached input tokens on gpt-5-codex)
//   - chatgpt-account-id is omitted when no accountId is supplied —
//     the backend then falls back to the non-subscription route
//     instead of rejecting the request.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  streamCodexResponsesEvents,
  computePromptCacheKey,
} from '../src/llm';
import { debug } from '../src/debug/log';

type Capture = { url: string; headers: Record<string, string>; body: any; wireJson: string };

function installFetch(capture: Capture[]): typeof fetch {
  const prior = globalThis.fetch;
  const stub: any = async (url: string, init: any) => {
    const hdrs = init?.headers as Record<string, string>;
    const wireJson = String(init?.body ?? '');
    let parsed: any = init?.body;
    try { if (typeof init?.body === 'string') parsed = JSON.parse(init.body); } catch {}
    capture.push({ url, headers: { ...hdrs }, body: parsed, wireJson });
    // Minimal SSE body with one text delta + [DONE] — enough to let
    // the generator finish without throwing.
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  globalThis.fetch = stub;
  return prior;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) { /* consume */ }
}

let prior: typeof fetch;
let calls: Capture[];
beforeEach(() => {
  calls = [];
  prior = installFetch(calls);
});
afterEach(() => {
  globalThis.fetch = prior;
});

describe('streamCodexResponsesEvents logging gate', () => {
  test('does not serialize input or tools for request logging when every sink is off', async () => {
    const previousLevel = debug.level();
    let inputSerializations = 0;
    let toolSerializations = 0;
    const input = [{
      toJSON() {
        inputSerializations++;
        return { role: 'user', content: 'hi' };
      },
    }];
    const tools = [{
      toJSON() {
        toolSerializations++;
        return { type: 'function', name: 'echo' };
      },
    }];

    debug.setLevel('off');
    try {
      await drain(streamCodexResponsesEvents(
        'https://chatgpt.com/backend-api/codex/responses',
        'b',
        { model: 'gpt-5-codex', instructions: 'sys', input, tools },
      ));
      // One serialization per value is required for the fetch body. A second
      // would mean the disabled request logger eagerly serialized it too.
      expect(inputSerializations).toBe(1);
      expect(toolSerializations).toBe(1);
    } finally {
      debug.setLevel(previousLevel);
    }
  });

  test('keeps request size fields when a sink is enabled', async () => {
    const previousLevel = debug.level();
    const originalLog = debug.log;
    const logged: unknown[] = [];
    debug.setLevel('trail');
    debug.log = ((_category: string, _event: string, data?: unknown) => {
      logged.push(data);
    }) as typeof debug.log;
    try {
      const input = [{ role: 'user', content: 'hi' }];
      const tools = [{ type: 'function', name: 'echo' }];
      await drain(streamCodexResponsesEvents(
        'https://chatgpt.com/backend-api/codex/responses',
        'b',
        { model: 'gpt-5-codex', instructions: 'system', input, tools },
      ));
      expect(logged).toContainEqual(expect.objectContaining({
        inputChars: JSON.stringify(input).length,
        toolChars: JSON.stringify(tools).length,
        instructionChars: 'system'.length,
      }));
    } finally {
      debug.log = originalLog;
      debug.setLevel(previousLevel);
    }
  });
});

describe('streamCodexResponsesEvents headers', () => {
  test('emits chatgpt-account-id when accountId is provided', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer-token-abc',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      undefined,
      { accountId: 'acct-uuid-42' },
    ));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['chatgpt-account-id']).toBe('acct-uuid-42');
  });

  test('omits chatgpt-account-id when accountId is missing', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer-token-abc',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      undefined,
      {},
    ));
    expect(calls[0]!.headers['chatgpt-account-id']).toBeUndefined();
  });

  test('always emits OpenAI-Beta + originator markers', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer-token-abc',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    ));
    expect(calls[0]!.headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(calls[0]!.headers['originator']).toBe('codex_cli_rs');
  });

  test('Authorization bearer carries the access token verbatim', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'bearer-token-xyz',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    ));
    expect(calls[0]!.headers['Authorization']).toBe('Bearer bearer-token-xyz');
  });
});

describe('streamCodexResponsesEvents body', () => {
  test('includes prompt_cache_key by default', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'b',
      { model: 'gpt-5-codex', instructions: 'Research loop', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    ));
    const body = calls[0]!.body;
    expect(typeof body.prompt_cache_key).toBe('string');
    expect(body.prompt_cache_key).toHaveLength(32);
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
  });

  test('still sets stream:true and store:false', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'b',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    ));
    const body = calls[0]!.body;
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  test('promptCache:false opt-out omits the key (test hook)', async () => {
    await drain(streamCodexResponsesEvents(
      'https://chatgpt.com/backend-api/codex/responses',
      'b',
      { model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
      undefined,
      { promptCache: false },
    ));
    expect(calls[0]!.body.prompt_cache_key).toBeUndefined();
  });

  test('sends the exact pre-serialized body used by request-size measurement', async () => {
    const previousLevel = debug.level();
    let inputSerializations = 0;
    const input = [{
      toJSON() {
        inputSerializations++;
        return { role: 'user', content: 'hi' };
      },
    }];
    const measuredWireJson = JSON.stringify({
      model: 'gpt-5-codex', instructions: 'sys', input: [{ role: 'user', content: 'hi' }],
      stream: true, store: false,
    });
    debug.setLevel('off');
    try {
      await drain(streamCodexResponsesEvents(
        'https://chatgpt.com/backend-api/codex/responses',
        'b',
        { model: 'gpt-5-codex', instructions: 'sys', input },
        undefined,
        { promptCache: false, serializedWireBody: measuredWireJson },
      ));
      expect(calls[0]!.wireJson).toBe(measuredWireJson);
      expect(inputSerializations).toBe(0);
    } finally {
      debug.setLevel(previousLevel);
    }
  });
});

describe('computePromptCacheKey', () => {
  test('is deterministic for identical inputs', () => {
    const a = computePromptCacheKey('gpt-5-codex', 'You are a researcher…');
    const b = computePromptCacheKey('gpt-5-codex', 'You are a researcher…');
    expect(a).toBe(b);
  });

  test('differs by model even with the same instructions', () => {
    const a = computePromptCacheKey('gpt-5-codex', 'sys');
    const b = computePromptCacheKey('gpt-5.1-codex', 'sys');
    expect(a).not.toBe(b);
  });

  test('is stable when only the trailing part of instructions changes', () => {
    // The first 500 chars are the routing prefix. Dynamic tail
    // (budget/plan updates per turn) must not flip the key so the
    // cache stays warm across a running session.
    const head = 'A'.repeat(500);
    const a = computePromptCacheKey('gpt-5-codex', head + ' budget=12%');
    const b = computePromptCacheKey('gpt-5-codex', head + ' budget=87%');
    expect(a).toBe(b);
  });

  test('flips when the first 500 chars differ', () => {
    const a = computePromptCacheKey('gpt-5-codex', 'PERSONA: researcher');
    const b = computePromptCacheKey('gpt-5-codex', 'PERSONA: coder');
    expect(a).not.toBe(b);
  });

  test('outputs 32 lowercase hex chars', () => {
    const k = computePromptCacheKey('gpt-5-codex', 'x');
    expect(k).toHaveLength(32);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
  });
});
