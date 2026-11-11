import { expect, test } from 'bun:test';
import { handleOpenRouterImportCandidates, handleOpenRouterImportConfirm, handleOpenRouterOAuthCallback, handleOpenRouterOAuthStart } from './openrouter-oauth.js';

test('OpenRouter PKCE callback stores a verified key on Nexus and redirects without returning it', async () => {
  const flows = new Map();
  const start = handleOpenRouterOAuthStart(new Request('https://nexus.example.test/v1/credentials/openrouter/oauth/start', { method: 'POST' }), {
    now: () => 10_000, flows,
  });
  const { authorizationUrl } = await start.json() as { authorizationUrl: string };
  const authorize = new URL(authorizationUrl);
  expect(authorize.origin).toBe('https://openrouter.ai');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const callbackUrl = new URL(authorize.searchParams.get('callback_url')!);
  expect(callbackUrl.origin).toBe('https://nexus.example.test');
  expect(callbackUrl.pathname).toBe('/v1/credentials/openrouter/oauth/callback');
  const state = callbackUrl.searchParams.get('state')!;
  expect(authorize.searchParams.get('state')).toBe(state);
  const verifier = flows.get(state)?.verifier as string;
  const saved: string[] = [];
  callbackUrl.searchParams.set('code', 'one-use-code');
  const callback = await handleOpenRouterOAuthCallback(new Request(callbackUrl), {
    now: () => 10_001, flows,
    fetch: (async (_input, init) => {
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(String(init?.body))).toEqual({ code: 'one-use-code', code_verifier: verifier, code_challenge_method: 'S256' });
      return Response.json({ key: 'sk-or-v1-private-key' });
    }) as typeof fetch,
    verify: async key => { expect(key).toBe('sk-or-v1-private-key'); return { result: 'verified', httpStatus: 200 }; },
    save: async key => { saved.push(key); },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe('https://nexus.example.test/app/credentials/?openrouter=connected');
  expect(callback.headers.get('location')).not.toContain('sk-or-v1-private-key');
  expect(saved).toEqual(['sk-or-v1-private-key']);
  expect(flows.has(state)).toBe(false);
});

test('OpenRouter OAuth state expiry removes its verifier without another request', async () => {
  const flows = new Map();
  let expire: (() => void) | undefined;
  const start = handleOpenRouterOAuthStart(new Request('https://nexus.example.test/v1/credentials/openrouter/oauth/start', { method: 'POST' }), {
    now: () => 20_000, flows,
    scheduleExpiry: callback => { expire = callback; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; },
  });
  const authorize = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
  const state = new URL(authorize.searchParams.get('callback_url')!).searchParams.get('state')!;
  expect(flows.has(state)).toBe(true);
  expire?.();
  expect(flows.has(state)).toBe(false);
  expect(flows.size).toBe(0);
});

test('OpenRouter PKCE state is one-use and expired or denied callbacks never exchange a code', async () => {
  const flows = new Map();
  const start = handleOpenRouterOAuthStart(new Request('https://nexus.example.test/v1/credentials/openrouter/oauth/start', { method: 'POST' }), { now: () => 10_000, flows });
  const state = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')!;
  let exchanges = 0;
  const first = await handleOpenRouterOAuthCallback(new Request(`https://nexus.example.test/v1/credentials/openrouter/oauth/callback?error=access_denied&state=${state}`), {
    now: () => 10_001, flows, fetch: (async () => { exchanges++; return Response.json({}); }) as unknown as typeof fetch,
  });
  const replay = await handleOpenRouterOAuthCallback(new Request(`https://nexus.example.test/v1/credentials/openrouter/oauth/callback?code=again&state=${state}`), {
    now: () => 10_002, flows, fetch: (async () => { exchanges++; return Response.json({}); }) as unknown as typeof fetch,
  });
  expect(first.headers.get('location')).toContain('openrouter=failed');
  expect(replay.headers.get('location')).toContain('openrouter=failed');
  expect(exchanges).toBe(0);
});

test('OpenRouter import scan returns only masked metadata and requires explicit single-use confirmation', async () => {
  const candidates = new Map();
  const scan = {
    proposals: [{ id: 'dotenv-candidate', name: 'OPENROUTER_API_KEY', sourcePath: '/home/test/.env', slot: 'cred:openrouter.api_key' }],
    readSelected: () => ({ 'cred:openrouter.api_key': 'dotenv-secret-value' }),
  };
  const response = handleOpenRouterImportCandidates(new Request('https://nexus.example.test/v1/credentials/openrouter/import'), {
    now: () => 50_000, importCandidates: candidates, scanImports: () => scan,
    env: { OPENROUTER_API_KEY: 'shell-secret-value' },
  });
  const body = await response.text();
  const metadata = JSON.parse(body) as { candidates: Array<{ id: string; lastFour: string }> };
  expect(metadata.candidates.map(candidate => candidate.lastFour).sort()).toEqual(['alue', 'alue']);
  expect(body).not.toContain('dotenv-secret-value');
  expect(body).not.toContain('shell-secret-value');
  const saved: string[] = [];
  const imported = await handleOpenRouterImportConfirm(new Request('https://nexus.example.test/v1/credentials/openrouter/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: metadata.candidates[0]!.id }),
  }), { now: () => 50_001, importCandidates: candidates,
    verify: async () => ({ result: 'verified' }), save: async value => { saved.push(value); } });
  const importedBody = await imported.text();
  expect(imported.status).toBe(200);
  expect(importedBody).not.toContain('dotenv-secret-value');
  expect(importedBody).not.toContain('shell-secret-value');
  expect(saved).toHaveLength(1);
  expect(candidates.size).toBe(1);
});

test('OpenRouter import candidate expiry removes the retained key and rejection consumes it', async () => {
  const candidates = new Map();
  let expire: (() => void) | undefined;
  let cancelled = false;
  const scan = {
    proposals: [{ id: 'dotenv-candidate', name: 'OPENROUTER_API_KEY', sourcePath: '/home/test/.env', slot: 'cred:openrouter.api_key' }],
    readSelected: () => ({ 'cred:openrouter.api_key': 'short-lived-secret' }),
  };
  const response = handleOpenRouterImportCandidates(new Request('https://nexus.example.test/v1/credentials/openrouter/import'), {
    now: () => 60_000, importCandidates: candidates, scanImports: () => scan,
    scheduleExpiry: callback => { expire = callback; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; },
    cancelExpiry: () => { cancelled = true; },
  });
  const { candidates: metadata } = await response.json() as { candidates: Array<{ id: string }> };
  expect(candidates.size).toBe(1);
  expire?.();
  expect(candidates.size).toBe(0);

  const rejectedCandidates = new Map();
  const rejected = handleOpenRouterImportCandidates(new Request('https://nexus.example.test/v1/credentials/openrouter/import'), {
    now: () => 70_000, importCandidates: rejectedCandidates, scanImports: () => scan,
    scheduleExpiry: callback => { expire = callback; return { unref() {} } as unknown as ReturnType<typeof setTimeout>; },
    cancelExpiry: () => { cancelled = true; },
  });
  const rejectedMetadata = await rejected.json() as { candidates: Array<{ id: string }> };
  const result = await handleOpenRouterImportConfirm(new Request('https://nexus.example.test/v1/credentials/openrouter/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rejectedMetadata.candidates[0]!.id }),
  }), { now: () => 70_001, importCandidates: rejectedCandidates, cancelExpiry: () => { cancelled = true; }, verify: async () => ({ result: 'invalid' }) });
  expect(result.status).toBe(422);
  expect(rejectedCandidates.size).toBe(0);
  expect(cancelled).toBe(true);
  expect(candidates.has(metadata[0]!.id)).toBe(false);
});

test('short OpenRouter candidate values are masked in list and confirmation responses', async () => {
  const candidates = new Map();
  const scan = {
    proposals: [{ id: 'short-key', name: 'OPENROUTER_API_KEY', sourcePath: '/home/test/.env', slot: 'cred:openrouter.api_key' }],
    readSelected: () => ({ 'cred:openrouter.api_key': 'tiny' }),
  };
  const listed = handleOpenRouterImportCandidates(new Request('https://nexus.example.test/v1/credentials/openrouter/import'), {
    now: () => 80_000, importCandidates: candidates, scanImports: () => scan, env: {},
    scheduleExpiry: () => ({ unref() {} } as unknown as ReturnType<typeof setTimeout>),
  });
  const listedBody = await listed.text();
  const metadata = JSON.parse(listedBody) as { candidates: Array<{ id: string; lastFour: string }> };
  expect(listedBody).not.toContain('tiny');
  expect(metadata.candidates[0]?.lastFour).toBe('••••');
  const confirmed = await handleOpenRouterImportConfirm(new Request('https://nexus.example.test/v1/credentials/openrouter/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: metadata.candidates[0]?.id }),
  }), { now: () => 80_001, importCandidates: candidates, cancelExpiry: () => {}, verify: async () => ({ result: 'verified' }), save: async () => {} });
  const confirmedBody = await confirmed.text();
  expect(confirmedBody).not.toContain('tiny');
  expect(JSON.parse(confirmedBody)).toMatchObject({ lastFour: '••••' });
});
