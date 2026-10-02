import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueSetupLinkToken, matchSetupBearer, SETUP_LINK_TTL_MS } from '../../auth/setup-link-tokens.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer, type NexusHttpServer } from './http-server.js';

let server: NexusHttpServer | undefined;
let dir: string | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
  resetElanousConfigDir();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function start(): string {
  dir = mkdtempSync(join(tmpdir(), 'nexus-setup-claim-'));
  setElanousConfigDir(dir);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'owner', noAuth: false },
    startPort: 46000 + Math.floor(Math.random() * 10000), portProbe: () => 'available',
  });
  return server.url;
}

function post(url: string, body: string) {
  return fetch(`${url}/v1/setup/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body,
  });
}

test('anonymous setup claim validates JSON and t before consuming the one-use link', async () => {
  const url = start();
  const { token } = issueSetupLinkToken();
  const preflight = await fetch(`${url}/v1/setup/claim`, { method: 'OPTIONS', headers: { origin: 'https://example.test' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  for (const body of ['', '{', 'null', '[]', '{}', '{"t":null}', '{"t":7}', '{"t":"  "}']) {
    const response = await post(url, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
  }
  const response = await post(url, JSON.stringify({ t: token }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const claimed = await response.json() as { scope: string; bearer: string; expiresAt: string };
  expect(claimed.scope).toBe('setup');
  expect(claimed.bearer).toMatch(/^elsb_[A-Za-z0-9_-]{43}$/);
  expect(claimed.expiresAt).toBe(new Date(Date.parse(claimed.expiresAt)).toISOString());
  expect(matchSetupBearer(claimed.bearer)).toEqual({ expiresAt: claimed.expiresAt });
  const reused = await post(url, JSON.stringify({ t: token }));
  expect(reused.status).toBe(401);
  expect(await reused.json()).toEqual({ error: 'used' });
});

test('unknown and expired links fail 401; only POST /v1/setup/claim bypasses owner authentication', async () => {
  const url = start();
  const unknown = await post(url, JSON.stringify({ t: 'els_' + 'A'.repeat(43) }));
  expect(unknown.status).toBe(401);
  expect(await unknown.json()).toEqual({ error: 'unknown' });
  const { token } = issueSetupLinkToken({ now: Date.now() - SETUP_LINK_TTL_MS });
  const expired = await post(url, JSON.stringify({ t: token }));
  expect(expired.status).toBe(401);
  expect(await expired.json()).toEqual({ error: 'expired' });
  for (const [method, path] of [
    ['POST', '/v1/setup/claim/extra'], ['GET', '/v1/setup/claim'], ['POST', '/v1/setup/llm-provider'],
  ]) {
    const response = await fetch(`${url}${path}`, {
      method, headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  }
});
