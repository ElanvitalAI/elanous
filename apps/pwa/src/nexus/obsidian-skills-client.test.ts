import { expect, test } from 'bun:test';
import { createNexusClient, NexusApiError } from './client';

const state = {
  obsidian: { vault: '/vault', exists: true, looksLikeVault: false },
  skills: { activeSet: 'custom', dirs: ['/skills'], presets: [] },
};

test('setup client sends the three dedicated requests and bearer when configured', async () => {
  const calls: Array<{ url: string; method?: string; auth: string | null; body?: unknown }> = [];
  const client = createNexusClient({ baseUrl: 'http://localhost:1234/', token: 'private-test-token', fetchImpl: (async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(state);
  }) as typeof fetch });
  expect(await client.getObsidianSkills()).toEqual(state);
  await client.setObsidian({ vault: '/vault' });
  await client.setSkills({ activeSet: 'codex' });
  await client.setSkills({ dirs: ['/skills'] });
  expect(calls).toEqual([
    { url: 'http://localhost:1234/v1/setup/obsidian-skills', method: 'GET', auth: 'Bearer private-test-token', body: undefined },
    { url: 'http://localhost:1234/v1/setup/obsidian', method: 'POST', auth: 'Bearer private-test-token', body: { vault: '/vault' } },
    { url: 'http://localhost:1234/v1/setup/skills', method: 'POST', auth: 'Bearer private-test-token', body: { activeSet: 'codex' } },
    { url: 'http://localhost:1234/v1/setup/skills', method: 'POST', auth: 'Bearer private-test-token', body: { dirs: ['/skills'] } },
  ]);
});

// #20793: 토큰이 있으면 셋업 경로만이 아니라 «모든» 요청에 authorization 을 싣는다(다른 출처 PWA 가 기본 거부 뒤에도 안 깨지게).
test('other requests also carry the bearer token when one is supplied', async () => {
  const captured: Headers[] = [];
  const client = createNexusClient({ baseUrl: 'http://localhost', token: 'private-test-token', fetchImpl: (async (_input, init) => {
    captured.push(new Headers(init?.headers));
    return Response.json({ providers: [] });
  }) as typeof fetch });
  await client.getLlmProviders();
  expect(captured[0]?.get('authorization')).toBe('Bearer private-test-token');
  expect(captured[0]?.get('content-type')).toBeNull();
});

test('setup client surfaces path validation errors with the existing NexusApiError', async () => {
  const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: 'directory-does-not-exist' }, { status: 400 })) as typeof fetch });
  try {
    await client.setObsidian({ vault: '/missing' });
    throw new Error('expected request to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(NexusApiError);
    expect((error as NexusApiError).body).toEqual({ error: 'directory-does-not-exist' });
    expect((error as NexusApiError).status).toBe(400);
  }
});
