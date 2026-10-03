import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSetupLinkToken, issueSetupLinkToken } from '../../auth/setup-link-tokens.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createCodexLoginHandlers, saveCodexProvider } from './setup-codex-login.js';
import { getUserConfig, reloadUserConfig, saveUserConfig } from '../../user-config.js';

let dir: string | undefined;
afterEach(() => {
  resetElanousConfigDir();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function request(mode: string): Request {
  return new Request('http://example.test/v1/setup/codex-login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('browser returns authorize URL without opening a daemon browser; simultaneous requests share pending login and ok saves provider', async () => {
  const done = deferred();
  const events: unknown[] = [];
  let attempts = 0;
  let launched = 0;
  const handlers = createCodexLoginHandlers({
    browser: async (open) => { attempts++; launched += Number(!open('https://auth.openai.com/oauth/authorize?state=public&code_challenge=public')); await done.promise; return { tokens: { accessToken: 'SECRET_ACCESS' } }; },
    device: async () => { throw new Error('wrong-flow'); },
    saveProvider: () => { events.push('provider=openai-codex'); },
    observe: (event, mode) => { events.push({ event, mode }); },
  });
  expect(await handlers.get().json()).toEqual({ state: 'idle' });
  const [first, duplicate] = await Promise.all([handlers.post(request('browser')), handlers.post(request('browser'))]);
  expect(await first.json()).toEqual({ state: 'pending', mode: 'browser', authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=public&code_challenge=public' });
  expect(await duplicate.json()).toEqual(await handlers.post(request('browser')).then(r => r.json()));
  expect(await handlers.get().json()).toEqual({ state: 'pending', mode: 'browser', authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=public&code_challenge=public' });
  expect(attempts).toBe(1);
  expect(launched).toBe(0);
  done.resolve();
  await Bun.sleep(0);
  expect(await handlers.get().json()).toEqual({ state: 'ok', mode: 'browser' });
  expect(JSON.stringify([events, await handlers.get().json()])).not.toContain('SECRET_ACCESS');
  expect(events).toEqual([{ event: 'started', mode: 'browser' }, 'provider=openai-codex', { event: 'ok', mode: 'browser' }]);
});

test('device returns code/link, polls independently of GET, and errors disclose only safe reason', async () => {
  const done = deferred();
  const events: unknown[] = [];
  const handlers = createCodexLoginHandlers({
    browser: async () => { throw new Error('wrong-flow'); },
    device: async (ready) => { ready('ABCD-EFGH', 'https://auth.openai.com/codex/device'); await done.promise; },
    saveProvider: () => { events.push('saved'); },
    observe: (event, mode) => { events.push({ event, mode }); },
  });
  expect(await handlers.post(request('device')).then(r => r.json())).toEqual({ state: 'pending', mode: 'device', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device' });
  expect(await handlers.get().json()).toEqual({ state: 'pending', mode: 'device', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device' });
  done.reject(new Error('TOKEN_SECRET never expose'));
  await Bun.sleep(0);
  expect(await handlers.get().json()).toEqual({ state: 'error', mode: 'device', error: 'device-poll-failed' });
  expect(JSON.stringify(events)).not.toContain('TOKEN_SECRET');
  expect(events).toEqual([{ event: 'started', mode: 'device' }, { event: 'error', mode: 'device' }]);
});

test('successful login persists openai-codex without retaining an old API key or model', () => {
  dir = mkdtempSync(join(tmpdir(), 'codex-provider-'));
  setElanousConfigDir(dir);
  const current = getUserConfig();
  saveUserConfig({ ...current, llm: { ...current.llm, provider: 'openai', apiKey: 'SECRET_KEY', model: 'old-model' } });
  saveCodexProvider();
  const next = reloadUserConfig().llm;
  expect(next.provider).toBe('openai-codex');
  expect(next.apiKey).toBeUndefined();
  expect(next.model).toBeUndefined();
});

test('first setup saves the provider when config.json does not yet exist', async () => {
  dir = mkdtempSync(join(tmpdir(), 'codex-first-setup-'));
  setElanousConfigDir(dir);
  expect(await Bun.file(join(dir, 'config.json')).exists()).toBe(false);
  saveCodexProvider();
  expect(reloadUserConfig().llm.provider).toBe('openai-codex');
  expect(await Bun.file(join(dir, 'config.json')).exists()).toBe(true);
});

test('router requires a setup or owner bearer for GET/POST, without changing setup token scope', async () => {
  dir = mkdtempSync(join(tmpdir(), 'codex-setup-'));
  setElanousConfigDir(dir);
  const claim = claimSetupLinkToken(issueSetupLinkToken({ dir }).token, { dir });
  if (!claim.ok) throw new Error('claim failed');
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { metaApi: { bearerToken: 'owner' }, state, registry: new TabRegistry(state), eventBus: new NexusEventBus() } as NexusHttpServerOpts;
  const send = (method: string, token?: string) => routeRequest(new Request('http://example.test/v1/setup/codex-login', {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'sec-fetch-site': 'cross-site', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{"mode":"invalid"}' } : {}),
  }), opts, {} as never, null, { get: () => null } as never);
  for (const method of ['GET', 'POST']) {
    expect((await send(method))?.status).toBe(401);
    expect((await send(method, claim.bearer))?.status).toBe(method === 'GET' ? 200 : 400);
    expect((await send(method, 'owner'))?.status).toBe(method === 'GET' ? 200 : 400);
  }
});

test('a different method while pending starts over — the older attempt can no longer finish the login', async () => {
  const browserDone = deferred();
  const deviceDone = deferred();
  const saved: string[] = [];
  const handlers = createCodexLoginHandlers({
    browser: async (open) => { open('https://auth.openai.com/oauth/authorize?state=public'); await browserDone.promise; },
    device: async (ready) => { ready('SWCH-0001', 'https://auth.openai.com/codex/device'); await deviceDone.promise; },
    saveProvider: () => { saved.push('saved'); },
    observe: () => {},
  });
  expect(await handlers.post(request('browser')).then(r => r.json())).toMatchObject({ state: 'pending', mode: 'browser' });
  expect(await handlers.post(request('device')).then(r => r.json())).toEqual({ state: 'pending', mode: 'device', userCode: 'SWCH-0001', verificationUrl: 'https://auth.openai.com/codex/device' });
  browserDone.resolve();
  await Bun.sleep(0);
  expect(await handlers.get().json()).toMatchObject({ state: 'pending', mode: 'device' });
  expect(saved).toEqual([]);
  deviceDone.resolve();
  await Bun.sleep(0);
  expect(await handlers.get().json()).toEqual({ state: 'ok', mode: 'device' });
  expect(saved).toEqual(['saved']);
});
