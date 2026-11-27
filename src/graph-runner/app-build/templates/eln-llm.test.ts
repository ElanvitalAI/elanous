import { expect, test } from 'bun:test';
import { ElnLlmUnavailableError, elnComplete, elnLlmMode, elnSummarize, elnTranslate } from './eln-llm.js';

const KEY = 'sk-test-0123456789abcdef';

test('mock mode answers without a network call', async () => {
  const env = { ELN_LLM_MOCK: '1' };
  let called = false;
  const fetcher = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
  expect(await elnTranslate('안녕', 'English', 'auto', { env, fetcher })).toBe('[mock:auto→English] 안녕');
  expect(await elnSummarize('abc', { env, fetcher })).toBe('[mock:summary] abc');
  expect(called).toBe(false);
});

test('unconfigured mode is a 503-class error that names the fix', async () => {
  expect(elnLlmMode({})).toBe('unconfigured');
  const error = await elnComplete('s', 'u', { env: {} }).catch(caught => caught);
  expect(error).toBeInstanceOf(ElnLlmUnavailableError);
  expect((error as ElnLlmUnavailableError).status).toBe(503);
  expect(String(error)).toContain('eln app run-local');
});

test('live mode posts an OpenAI-compatible chat completion with the injected key in the header only', async () => {
  const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return Response.json({ choices: [{ message: { content: ' Hello ' } }] });
  }) as unknown as typeof fetch;
  const env = { ELN_LLM_BASE_URL: 'https://openrouter.ai/api/v1/', ELN_LLM_MODEL: 'z-ai/glm-5.3', ELN_LLM_API_KEY: KEY };
  expect(await elnTranslate('안녕하세요', 'English', 'Korean', { env, fetcher })).toBe('Hello');
  expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
  expect(seen[0]!.body.model).toBe('z-ai/glm-5.3');
  expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
  expect(JSON.stringify(seen[0]!.body)).toContain('from Korean into English');
});

test('a keyless local endpoint sends no Authorization header', async () => {
  let auth: string | null = 'unset';
  const fetcher = (async (_url: string, init: RequestInit) => {
    auth = new Headers(init.headers).get('authorization');
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  }) as unknown as typeof fetch;
  await elnComplete('s', 'u', { env: { ELN_LLM_BASE_URL: 'http://localhost:11434/v1', ELN_LLM_MODEL: 'llama3' }, fetcher });
  expect(auth).toBeNull();
});

test('a provider error surfaces the status only, never the provider body', async () => {
  const fetcher = (async () => new Response(`bad key ${KEY}`, { status: 401 })) as unknown as typeof fetch;
  const error = await elnComplete('s', 'u', { env: { ELN_LLM_BASE_URL: 'https://x/v1', ELN_LLM_MODEL: 'm', ELN_LLM_API_KEY: KEY }, fetcher })
    .then(() => new Error('resolved'), (caught: unknown) => caught as Error);
  expect(error.message).toBe('LLM provider answered HTTP 401');
  expect(error.message).not.toContain(KEY);
});

test('a per-capability mock flag mocks only that capability', async () => {
  const fetcher = (async () => Response.json({ choices: [{ message: { content: 'live summary' } }] })) as unknown as typeof fetch;
  const env = { ELN_LLM_BASE_URL: 'https://x/v1', ELN_LLM_MODEL: 'm', ELN_LLM_API_KEY: KEY, ELN_MOCK_TRANSLATION: '1' };
  expect(await elnTranslate('안녕', 'English', 'auto', { env, fetcher })).toBe('[mock:auto→English] 안녕');
  expect(await elnSummarize('abc', { env, fetcher })).toBe('live summary');
});
