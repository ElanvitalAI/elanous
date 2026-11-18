// MAIN-RED-MAXTOKENS — a caller maxTokens stays one request after an HTTP retry and on a second host.
// Counts and host names below are literals. The product does not supply them.
// Fake HTTP only (no API calls).
import { expect, test } from 'bun:test';
import { getProviderForConfig, streamLLMWithTools } from './llm.js';
import type { UserConfig } from './user-config/types.js';
import { withRealProviderFakeFetchDevice } from './ux-sim/fake-fetch.js';

const CALLER_CAP = 1_024;
const messages = [{ role: 'user' as const, content: 'q' }];
const handlers = { onText() { /* fake stream */ }, dispatchTool: async () => 'unused' };

function requestMaxTokens(request: { body: string | null }): number {
  const body = JSON.parse(request.body ?? '') as { max_tokens?: number; max_completion_tokens?: number };
  if (body.max_completion_tokens !== undefined) throw new Error('request used max_completion_tokens');
  if (body.max_tokens === undefined) throw new Error('request body has no max_tokens');
  return body.max_tokens;
}

function lengthBody(): string {
  const chunk = { choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }] };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

const GROK_API_HOST = 'api.x.ai';
const GROK_PROXY_HOST = 'cli-chat-proxy.grok.com';
const OPENAI_HOST = 'api.openai.com';

function grokRoutes(response: (request: { url: string; body: string | null }) => Response) {
  return [GROK_API_HOST, GROK_PROXY_HOST].map(host => ({
    url: `https://${host}/v1/chat/completions`, method: 'POST' as const, response,
  }));
}

test('a caller maxTokens stays one request after one HTTP 503 retry', async () => {
  const hosts: string[] = [];
  const caps: number[] = [];
  let hits = 0;
  await withRealProviderFakeFetchDevice(grokRoutes((request) => {
    hits += 1;
    hosts.push(new URL(request.url).host);
    caps.push(requestMaxTokens(request));
    if (hits === 1) return new Response('unavailable', { status: 503, headers: { 'retry-after': '0' } });
    return new Response(lengthBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }), async () => {
    const provider = getProviderForConfig({ llm: { provider: 'grok', model: 'grok-4.7', apiKey: 'test-key' } } as unknown as UserConfig);
    await streamLLMWithTools(messages, handlers, { maxTokens: CALLER_CAP, provider, model: 'grok-4.7', tools: [] });
  });
  expect(hits).toBe(2);
  expect(hosts[0]).toBe(hosts[1]);
  expect([GROK_API_HOST, GROK_PROXY_HOST]).toContain(hosts[0]);
  expect(caps).toEqual([1_024, 1_024]);
});

test('a caller maxTokens stays one request on grok and on openai', async () => {
  const hosts: string[] = [];
  const caps: number[] = [];
  const record = (request: { url: string; body: string | null }) => {
    hosts.push(new URL(request.url).host);
    caps.push(requestMaxTokens(request));
    return new Response(lengthBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  await withRealProviderFakeFetchDevice([
    ...grokRoutes(record),
    { url: `https://${OPENAI_HOST}/v1/chat/completions`, method: 'POST', response: record },
  ], async () => {
    const grok = getProviderForConfig({ llm: { provider: 'grok', model: 'grok-4.7', apiKey: 'test-key' } } as unknown as UserConfig);
    await streamLLMWithTools(messages, handlers, { maxTokens: CALLER_CAP, provider: grok, model: 'grok-4.7', tools: [] });
    const openai = getProviderForConfig({ llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' } } as unknown as UserConfig);
    await streamLLMWithTools(messages, handlers, { maxTokens: CALLER_CAP, provider: openai, model: 'gpt-4o', tools: [] });
  });
  expect([GROK_API_HOST, GROK_PROXY_HOST]).toContain(hosts[0]);
  expect(hosts[1]).toBe(OPENAI_HOST);
  expect(caps).toEqual([1_024, 1_024]);
});
