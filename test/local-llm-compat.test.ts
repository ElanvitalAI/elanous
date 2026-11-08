// Unit tests for src/local-llm-test.ts — the compat probe module.
//
// All probes share one structure: POST (or GET) to the OpenAI-compatible
// endpoint, parse the response, classify as pass/fail/skip. We stub the
// global fetch so each test can script an exact response shape without
// ever touching the network.
//
// Covered surface:
//   - resolveLocalEndpoints normalizes trailing slashes + /v1 suffix
//   - models probe passes when target id is listed, fails when absent
//   - completion extracts content from choices[0].message.content
//   - streaming counts SSE events and accumulates delta.content
//   - json_mode parses the reply and checks for expected keys
//   - tool_calls recognizes the tool_calls array on the assistant message
//   - vision 400 → skip (model doesn't support multimodal)
//   - usage is derived from the completion probe's raw body
//   - unreachable endpoint short-circuits the suite to skips

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveLocalEndpoints,
  runLocalLLMCompat,
  renderCompatMatrix,
} from '../src/local-llm-test.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

// ── fetch stub scaffolding ───────────────────────────────────
// Scripts a sequence of fetch responses keyed by request URL so a
// test can simulate "models passes, completion fails" in one call.

type StubHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let fakeFetch: FakeFetchDevice | undefined;
let expectedCalls: string[] = [];

function installFetch(handler: StubHandler, chatCalls = 7, baseUrl = 'http://mock:1234'): void {
  fakeFetch?.restore();
  const respond = (request: { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null }) =>
    handler(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
    });
  fakeFetch = createFakeFetchDevice([
    { url: `${baseUrl}/v1/models`, method: 'GET', response: respond },
    { url: `${baseUrl}/v1/chat/completions`, method: 'POST', response: respond },
  ]);
  expectedCalls = [
    `GET ${baseUrl}/v1/models`,
    ...Array.from({ length: chatCalls }, () => `POST ${baseUrl}/v1/chat/completions`),
  ];
}

function restoreFetch(): void {
  try {
    if (fakeFetch) {
      expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`).sort()).toEqual([...expectedCalls].sort());
    }
  } finally {
    fakeFetch?.restore();
    fakeFetch = undefined;
    expectedCalls = [];
  }
}

/** Assemble a JSON response. */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Assemble an SSE response with an array of events (each gets a
 *  `data: …\n\n` record). Final [DONE] sentinel is added automatically. */
function sseRes(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ── resolveLocalEndpoints ───────────────────────────────────

describe('resolveLocalEndpoints', () => {
  it('appends /v1 when the URL has no version suffix', () => {
    const e = resolveLocalEndpoints('http://192.168.0.50:1234');
    expect(e.base).toBe('http://192.168.0.50:1234/v1');
    expect(e.chat).toBe('http://192.168.0.50:1234/v1/chat/completions');
    expect(e.models).toBe('http://192.168.0.50:1234/v1/models');
  });

  it('preserves an explicit /v1 root without double-append', () => {
    const e = resolveLocalEndpoints('http://host:8000/v1');
    expect(e.base).toBe('http://host:8000/v1');
  });

  it('tolerates a trailing slash', () => {
    const e = resolveLocalEndpoints('http://host:8000/v1/');
    expect(e.base).toBe('http://host:8000/v1');
  });

  it('strips an accidentally-pasted /chat/completions tail', () => {
    const e = resolveLocalEndpoints('http://host:8000/v1/chat/completions');
    expect(e.base).toBe('http://host:8000/v1');
    expect(e.chat).toBe('http://host:8000/v1/chat/completions');
  });

  it('respects a non-v1 version suffix (future-proof)', () => {
    const e = resolveLocalEndpoints('http://host:8000/v2');
    expect(e.base).toBe('http://host:8000/v2');
    expect(e.chat).toBe('http://host:8000/v2/chat/completions');
  });
});

// ── Full matrix with scripted fetch ─────────────────────────

describe('runLocalLLMCompat — scripted responses', () => {
  afterEach(restoreFetch);

  const BASE = 'http://mock:1234';
  const MODEL = 'mlx-community/gemma-4-26b-a4b-it';

  /** A "happy path" fetch stub — every probe returns a valid response.
   *  Individual tests call it and then override specific URLs via an
   *  overrides map to simulate failures. */
  function happyHandler(overrides: Record<string, (init?: RequestInit) => Response> = {}): StubHandler {
    return (url, init) => {
      if (url in overrides) return overrides[url]!(init);

      if (url.endsWith('/models')) {
        return jsonRes({ data: [{ id: MODEL, owned_by: 'org' }] });
      }

      // Must be /chat/completions — parse the body to shape a
      // context-aware response.
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const msgs: Array<{ role: string; content: any }> = body.messages ?? [];
      const isStream = body.stream === true;
      const hasVision = msgs.some(m =>
        Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url'),
      );
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const isJsonMode = body.response_format?.type === 'json_object';
      const lastUser = msgs.filter(m => m.role === 'user').slice(-1)[0];
      const userText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.find((b: any) => b?.type === 'text')?.text ?? ''
          : '';

      if (isStream) {
        return sseRes([
          { choices: [{ delta: { content: 'one, ' } }] },
          { choices: [{ delta: { content: 'two, ' } }] },
          { choices: [{ delta: { content: 'three' } }] },
        ]);
      }

      if (hasTools) {
        return jsonRes({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 25, completion_tokens: 14, total_tokens: 39 },
        });
      }

      if (isJsonMode) {
        return jsonRes({
          choices: [{ message: { role: 'assistant', content: '{"a":1,"b":2}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        });
      }

      if (hasVision) {
        return jsonRes({
          choices: [{ message: { role: 'assistant', content: 'Yes.' } }],
          usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
        });
      }

      // Default answer matches whatever question the probe asks so
      // content-based assertions pass.
      let text = 'OK';
      if (/favorite number/i.test(userText)) text = '42';
      else if (/parrot|pineapple/i.test(userText)) text = 'PINEAPPLE';
      else if (/reply.*OK/i.test(userText)) text = 'OK';

      return jsonRes({
        choices: [{ message: { role: 'assistant', content: text } }],
        usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 },
      });
    };
  }

  it('happy path: all probes pass except vision which is SKIP-default', async () => {
    installFetch(happyHandler());
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    expect(summary.counts.fail).toBe(0);
    expect(summary.counts.pass).toBeGreaterThanOrEqual(7);
    // Vision returns a response here, so it passes (not a skip). The
    // SKIP path is covered in a dedicated test below.
    const byId = Object.fromEntries(summary.results.map(r => [r.id, r]));
    expect(byId.models!.status).toBe('pass');
    expect(byId.completion!.status).toBe('pass');
    expect(byId.streaming!.status).toBe('pass');
    expect(byId.system_prompt!.status).toBe('pass');
    expect(byId.multi_turn!.status).toBe('pass');
    expect(byId.json_mode!.status).toBe('pass');
    expect(byId.tool_calls!.status).toBe('pass');
    expect(byId.vision!.status).toBe('pass');
    expect(byId.usage!.status).toBe('pass');
  });

  it('models probe fails when target id not listed', async () => {
    installFetch((url) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: 'other-model' }] });
      return jsonRes({ choices: [{ message: { content: 'OK' } }] });
    });
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    const models = summary.results.find(r => r.id === 'models')!;
    expect(models.status).toBe('fail');
    expect(models.detail).toContain('other-model');
  });

  it('completion fail cascades usage to skip', async () => {
    installFetch((url) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      // Return an error for chat/completions
      return jsonRes({ error: 'nope' }, 500);
    });
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    const completion = summary.results.find(r => r.id === 'completion')!;
    const usage = summary.results.find(r => r.id === 'usage')!;
    expect(completion.status).toBe('fail');
    expect(usage.status).toBe('skip');
    expect(usage.detail).toContain('depends on completion');
  });

  it('unreachable endpoint short-circuits to all-skips after models', async () => {
    installFetch(() => { throw new Error('fetch failed'); }, 0);
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    expect(summary.results[0]!.id).toBe('models');
    expect(summary.results[0]!.status).toBe('fail');
    // Everything after models should be skipped
    const rest = summary.results.slice(1);
    expect(rest.every(r => r.status === 'skip')).toBe(true);
  });

  it('vision 400 → SKIP (text-only model)', async () => {
    const visionSent = { called: false };
    installFetch((url, init) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const msgs = body.messages ?? [];
      const hasVision = msgs.some((m: any) =>
        Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url'),
      );
      if (hasVision) {
        visionSent.called = true;
        return jsonRes({ error: 'multimodal unsupported' }, 400);
      }
      return jsonRes({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    });
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    const vision = summary.results.find(r => r.id === 'vision')!;
    expect(visionSent.called).toBe(true);
    expect(vision.status).toBe('skip');
    expect(vision.detail).toContain('400');
  });

  it('json_mode 400 → SKIP (feature not supported)', async () => {
    installFetch((url, init) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.response_format?.type === 'json_object') {
        return jsonRes({ error: 'not supported' }, 400);
      }
      return jsonRes({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    });
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    const json = summary.results.find(r => r.id === 'json_mode')!;
    expect(json.status).toBe('skip');
  });

  it('skip option gates individual probes (vision)', async () => {
    let visionAttempted = false;
    installFetch((url, init) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const msgs = body.messages ?? [];
      if (msgs.some((m: any) =>
        Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url'),
      )) visionAttempted = true;
      return jsonRes({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }, 6);
    const summary = await runLocalLLMCompat({
      baseUrl: BASE, model: MODEL, timeoutMs: 5000,
      skip: { vision: true },
    });
    expect(visionAttempted).toBe(false);
    const vision = summary.results.find(r => r.id === 'vision')!;
    expect(vision.status).toBe('skip');
    expect(vision.detail).toContain('caller');
  });

  it('streaming probe counts SSE events and accumulates text', async () => {
    installFetch((url, init) => {
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.stream === true) {
        return sseRes([
          { choices: [{ delta: { content: 'a' } }] },
          { choices: [{ delta: { content: 'b' } }] },
          { choices: [{ delta: { content: 'c' } }] },
        ]);
      }
      return jsonRes({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    const summary = await runLocalLLMCompat({ baseUrl: BASE, model: MODEL, timeoutMs: 5000 });
    const stream = summary.results.find(r => r.id === 'streaming')!;
    expect(stream.status).toBe('pass');
    expect(stream.detail).toMatch(/abc/);
  });

  it('onProgress fires once per result', async () => {
    installFetch(happyHandler());
    const seen: string[] = [];
    const summary = await runLocalLLMCompat({
      baseUrl: BASE, model: MODEL, timeoutMs: 5000,
      onProgress: (r) => seen.push(r.id),
    });
    expect(seen.length).toBe(summary.results.length);
    expect(seen).toContain('models');
    expect(seen).toContain('completion');
  });

  it('api key is forwarded as Bearer auth when set', async () => {
    let sawAuth: string | null = null;
    installFetch((url, init) => {
      sawAuth = (init?.headers as Record<string, string> | undefined)?.authorization
        ?? (init?.headers as any)?.Authorization
        ?? null;
      if (url.endsWith('/models')) return jsonRes({ data: [{ id: MODEL }] });
      return jsonRes({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    await runLocalLLMCompat({
      baseUrl: BASE, model: MODEL, timeoutMs: 5000, apiKey: 'sk-test',
    });
    expect(sawAuth).toBe('Bearer sk-test');
  });
});

// ── render helper ───────────────────────────────────────────

describe('renderCompatMatrix', () => {
  it('prints pass/fail counts and lists every row', async () => {
    installFetch(async () => jsonRes({
      choices: [{ message: { content: 'OK' } }],
      usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 },
      data: [{ id: 'mlx-community/gemma-4-26b-a4b-it' }],
    }), 7, 'http://mock');
    try {
      const summary = await runLocalLLMCompat({
        baseUrl: 'http://mock',
        model: 'mlx-community/gemma-4-26b-a4b-it',
        timeoutMs: 5000,
      });
      const out = renderCompatMatrix(summary);
      expect(out).toContain('Local LLM compatibility');
      expect(out).toContain('mlx-community/gemma-4-26b-a4b-it');
      expect(out).toContain('pass=');
      for (const r of summary.results) {
        expect(out).toContain(r.label);
      }
    } finally {
      restoreFetch();
    }
  });
});
