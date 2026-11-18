import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug, withAmbientSessionScope } from '../src/debug/log.js';
import { fetchApiWithRetry, setLlmCallOutcomeWriterForTesting } from '../src/session-runtime/retry-api.js';
import { llmNetworkFetch, llmNetworkSend, llmObserveSend, withLlmCallContext } from '../src/session-runtime/llm-call-gateway.js';
import { makeLocalLlm } from '../src/domains/community-buzz/local-llm.js';
import { runLocalLLMCompat } from '../src/local-llm-test.js';
import { createGeminiVisionProvider } from '../src/voice/vision-providers/gemini-vision.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setLlmCallOutcomeWriterForTesting(undefined); });
const attempts = () => debug.events(100).filter(e => e.category === 'llm.call' && e.event === 'attempt');

/** Reduced from production default (retry-api.ts: maxAttempts ?? 4) for deterministic failover test. */
const FAILOVER_TEST_MAX_ATTEMPTS = 2;
/** Short timeout for compat probe test; production default (local-llm-test.ts: timeoutMs ?? 60_000). */
const PROBE_SHORT_TIMEOUT_MS = 500;

describe('LLM network-attempt ledger', () => {
  test('one line per retry; URL credentials/path/query and request secrets never appear', async () => {
    debug.clear();
    const outcomes: unknown[] = [];
    setLlmCallOutcomeWriterForTesting(row => outcomes.push(row));
    let sends = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(sends++ ? 'ok' : 'busy', { status: sends === 1 ? 503 : 200 })) as typeof fetch;
    const response = await withAmbientSessionScope('parent', () => withAmbientSessionScope('child', () =>
      withLlmCallContext({ requestedBy: 'classifier', selectionSource: 'fallback', role: 'aux' }, () =>
        fetchApiWithRetry('https://user:password@api.example.test:443/private/secret?token=SECRET', {
          method: 'POST', headers: { Authorization: 'Bearer SECRET' }, body: 'SENSITIVE_BODY',
        }, { provider: 'openrouter', errorPrefix: 'test', maxAttempts: FAILOVER_TEST_MAX_ATTEMPTS, callContext: { model: 'actual-model' } }))));
    expect(response.status).toBe(200);
    expect(sends).toBe(2);
    expect(outcomes).toHaveLength(2); // existing failover consumer unchanged
    const rows = attempts();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.data).toMatchObject({ provider: 'openrouter', model: 'actual-model', host: 'api.example.test',
        sessionId: 'child', parentSessionId: 'parent', role: 'aux', requestedBy: 'classifier',
        selectionSource: 'fallback', billing: 'credits', tuiPid: process.pid });
      expect(JSON.stringify(row)).not.toMatch(/SECRET|SENSITIVE_BODY|password|private/);
    }
  });

  test('injected transport and failed network send each get exactly one attempt; telemetry is fail-soft', async () => {
    debug.clear();
    const rejected = new Error('network failure');
    await expect(llmNetworkSend('https://aws.example.test/hidden?key=SECRET', {},
      { provider: 'bedrock', model: 'anthropic.claude' }, async () => { throw rejected; })).rejects.toBe(rejected);
    expect(attempts()).toHaveLength(1);
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok')) as typeof fetch;
    await llmNetworkFetch('https://proxy.example.test/path', {}, { provider: 'hq-proxy', model: 'gpt-test' });
    expect(attempts()).toHaveLength(2);
  });

  test('injected send is the only transport; logging failures cannot replace its result or error', async () => {
    debug.clear();
    const originalLog = debug.log;
    const originalTransport = globalThis.fetch;
    const result = new Response('stub');
    let sent = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('global fetch must not run'); }) as typeof fetch;
    try {
      expect(await llmNetworkSend('https://example.test/private', {}, { provider: 'bedrock', model: 'wire-model' },
        () => { sent++; return Promise.resolve(result); })).toBe(result);
      expect(sent).toBe(1);
      expect(attempts()).toHaveLength(1);
      debug.log = (() => { throw new Error('sink unavailable'); }) as typeof debug.log;
      expect(await llmNetworkSend('https://example.test/private', {}, {},
        () => { sent++; return Promise.resolve(result); })).toBe(result);
      const failure = new Error('transport rejected');
      await expect(llmNetworkSend('https://example.test/private', {}, {},
        () => { sent++; return Promise.reject(failure); })).rejects.toBe(failure);
      expect(sent).toBe(3);
    } finally {
      debug.log = originalLog;
      globalThis.fetch = originalTransport;
    }
  });

  test('Gemini SDK invocation is observed once without changing its native stream result', async () => {
    debug.clear();
    const nativeStream = { async *[Symbol.asyncIterator]() { yield { candidates: [] }; } };
    const promise = Promise.resolve(nativeStream);
    let sdkCalls = 0;
    const observed = llmObserveSend('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?key=PRIVATE',
      { provider: 'gemini', model: 'gemini-test' }, () => { sdkCalls++; return promise; });
    expect(observed).toBe(promise);
    expect(await observed).toBe(nativeStream);
    expect(sdkCalls).toBe(1);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]!.data).toMatchObject({ provider: 'gemini', model: 'gemini-test', host: 'generativelanguage.googleapis.com' });
    expect(JSON.stringify(attempts()[0])).not.toContain('PRIVATE');
  });

  test('community-buzz model lookup stays unchanged; generation records only the resolved wire model', async () => {
    debug.clear();
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return new Response(url.endsWith('/models')
        ? JSON.stringify({ data: [{ id: 'resolved-local-it' }] })
        : JSON.stringify({ choices: [{ message: { content: 'result' } }] }), { status: 200 });
    }) as typeof fetch;
    const client = makeLocalLlm({ endpoints: ['http://localhost:1234'] });
    expect(await client.complete([{ role: 'user', content: 'hello' }])).toBe('result');
    expect(urls).toEqual(['http://localhost:1234/v1/models', 'http://localhost:1234/v1/chat/completions']);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]!.data).toMatchObject({ provider: 'local', model: 'resolved-local-it',
      host: 'localhost', role: 'aux', requestedBy: 'community-buzz' });
  });

  test('Gemini vision injected transport preserves response, logs one request without URL key', async () => {
    debug.clear();
    const key = 'VISION_PRIVATE_KEY';
    let sends = 0;
    const provider = createGeminiVisionProvider({ apiKey: key, model: 'gemini-vision-wire',
      httpFetch: (async (url: string, init: RequestInit) => {
        sends++;
        expect(url).toContain(`?key=${key}`);
        expect(JSON.parse(init.body as string).contents[0].parts[0].text).toBe('screenshot');
        return Response.json({ candidates: [{ content: { parts: [{ text: 'seen' }] } }] });
      }) as typeof fetch });
    expect(await provider.describe({ transcript: 'screenshot', screenshot: {
      mimeType: 'image/png', bodyBase64: 'AAA=', bytes: 3, surfaceLabel: 'test',
    } })).toBe('seen');
    expect(sends).toBe(1);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]!.data).toMatchObject({ provider: 'gemini', model: 'gemini-vision-wire',
      host: 'generativelanguage.googleapis.com', role: 'aux', requestedBy: 'voice-vision' });
    expect(JSON.stringify(attempts()[0])).not.toContain(key);
  });

  test('local compatibility probes log generation only, not GET model discovery', async () => {
    debug.clear();
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'wire-local' }] })
        : Response.json({ error: 'unavailable' }, { status: 500 });
    }) as typeof fetch;
    const result = await runLocalLLMCompat({ baseUrl: 'http://localhost:1234', model: 'wire-local', timeoutMs: PROBE_SHORT_TIMEOUT_MS });
    expect(result.results.find(r => r.id === 'completion')?.status).toBe('fail');
    expect(urls[0]).toBe('http://localhost:1234/v1/models');
    expect(urls.slice(1).every(url => url === 'http://localhost:1234/v1/chat/completions')).toBe(true);
    const inferenceCount = attempts().length;
    expect(urls).toHaveLength(1 + inferenceCount);
    expect(attempts()).toHaveLength(inferenceCount);
    for (const row of attempts()) expect(row.data).toMatchObject({ provider: 'local', model: 'wire-local',
      host: 'localhost', role: 'aux', requestedBy: 'local-llm-compat', selectionSource: 'explicit' });
  });

  test('known direct-fetch provider paths cannot bypass gateway', () => {
    const root = resolve(import.meta.dir, '..');
    const sources = ['src/session-runtime/retry-api.ts', 'src/llm/hq-proxy-provider.ts', 'src/llm/bedrock-provider.ts'];
    for (const path of sources) {
      const source = readFileSync(resolve(root, path), 'utf8');
      expect(source).not.toMatch(/\bawait\s+(?:globalThis\.)?fetch\s*\(/);
    }
    expect(readFileSync(resolve(root, 'src/session-runtime/retry-api.ts'), 'utf8')).toContain('llmNetworkFetch(');
    expect(readFileSync(resolve(root, 'src/llm/hq-proxy-provider.ts'), 'utf8')).toContain('llmNetworkFetch(');
    expect(readFileSync(resolve(root, 'src/llm/bedrock-provider.ts'), 'utf8')).toContain('llmNetworkSend(');
  });
});
