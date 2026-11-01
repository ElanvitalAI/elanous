import { expect, spyOn, test } from 'bun:test';
import { getProviderForConfigAsync } from './llm.js';
import type { UserConfig } from './user-config.js';

test('setup service key resolves from SecretStore into the mocked production provider request only', async () => {
  const secret = 'fake-openrouter-secret-value';
  const config = { llm: { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' } } as unknown as UserConfig;
  const secretIds: string[] = [];
  const requests: Array<{ authorization?: string; body?: string }> = [];
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ authorization: headers.get('authorization') ?? undefined, body: String(init?.body ?? '') });
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch);
  try {
    const provider = await getProviderForConfigAsync(
      config,
      undefined,
      async (id) => { secretIds.push(id); return id === 'OPENROUTER_API_KEY' ? secret : undefined; },
      {},
    );
    expect(provider.name).toBe('openrouter');
    expect(provider.available()).toBe(true);
    for await (const _event of provider.streamChat!([{ role: 'user', content: 'hello' }])) { /* mock response */ }
    expect(secretIds).toEqual(['OPENROUTER_API_KEY']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(requests[0]?.body).not.toContain(secret);
  } finally {
    fetchMock.mockRestore();
  }
});
