import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSetupLinkToken, issueSetupLinkToken } from '../../auth/setup-link-tokens.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { bearerCredential, checkAuth, handleAuthTraceGet, registerAuthPeerAddress, setupBearerScopeDenied } from './meta-api.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function credentials() {
  const dir = mkdtempSync(join(tmpdir(), 'setup-bearer-auth-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  const { token } = issueSetupLinkToken({ dir });
  const claimed = claimSetupLinkToken(token, { dir });
  if (!claimed.ok) throw new Error('setup link claim failed');
  return { bearer: claimed.bearer, owner: 'owner-test-secret' };
}

function request(path: string, bearer: string, method = 'GET'): Request {
  return new Request(`http://example.test${path}`, {
    method, headers: { authorization: `Bearer ${bearer}` },
  });
}

describe('setup-scoped bearer in checkAuth', () => {
  test('accepts setup routes and the first-chat REST paths only', () => {
    const { bearer, owner } = credentials();
    for (const [method, path] of [
      ['GET', '/v1/setup/llm-providers'], ['POST', '/v1/setup/llm-provider'],
      ['GET', '/v1/setup/answer-priority'],
      ['POST', '/v1/prompt/stream?debug-tap=on'], ['GET', '/v1/chat/events?sessionId=first'],
      ['GET', '/v1/sessions/store/first?ifExists=1'],
    ]) {
      expect(checkAuth(request(path, bearer, method), { bearerToken: owner })).toBe(true);
    }
    expect(bearerCredential(request('/v1/setup/llm-providers', bearer), { bearerToken: owner })).toBeUndefined();
  });

  test('rejects every other route and method, including owner-only configuration writes', async () => {
    const { bearer, owner } = credentials();
    for (const [method, path] of [
      ['PUT', '/v1/config/switches/llm.provider'], ['POST', '/v1/config/secrets'],
      ['PUT', '/v1/config/model-tier'], ['GET', '/v1/config'],
      ['POST', '/v1/prompt'], ['GET', '/v1/sessions'],
      ['GET', '/v1/sessions/first'], ['POST', '/v1/sessions/external'],
      ['DELETE', '/v1/sessions/first'], ['POST', '/v1/chat/events'], ['POST', '/v1/tools/runtime'],
      ['GET', '/v1/setup'], ['GET', '/v1/setup-other'],
      ['GET', '/v1/diag/auth-trace'],
    ]) {
      const req = request(path, bearer, method);
      expect(checkAuth(req, { bearerToken: owner })).toBe(false);
      expect(setupBearerScopeDenied(req, { bearerToken: owner })).toBe(true);
    }
    const res = handleAuthTraceGet(request('/v1/diag/auth-trace', bearer), { bearerToken: owner });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  test('does not let same-origin headers upgrade a setup bearer or grant invalid credentials', () => {
    const { bearer, owner } = credentials();
    const req = request('/v1/config/model-tier', bearer, 'PUT');
    req.headers.set('sec-fetch-site', 'same-origin');
    registerAuthPeerAddress(req, '127.0.0.1');
    expect(checkAuth(req, { bearerToken: owner })).toBe(false);
    expect(checkAuth(request('/v1/setup/llm-providers', 'elsb_invalid'), { bearerToken: owner })).toBe(false);
    expect(checkAuth(request('/v1/setup/llm-providers', bearer), { bearerToken: owner, noAuth: true })).toBe(true);
  });

  test('expired setup bearer is unauthorized even on setup endpoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-bearer-expired-'));
    dirs.push(dir);
    setElanousConfigDir(dir);
    const past = Date.now() - 48 * 60 * 60_000;
    const { token } = issueSetupLinkToken({ dir, now: past });
    const claim = claimSetupLinkToken(token, { dir, now: past });
    if (!claim.ok) throw new Error('setup link claim failed');
    expect(checkAuth(request('/v1/setup/llm-providers', claim.bearer), { bearerToken: 'owner' })).toBe(false);
    expect(setupBearerScopeDenied(request('/v1/config/model-tier', claim.bearer), { bearerToken: 'owner' })).toBe(false);
  });

  test('HTTP router refuses setup bearer on config writes before reaching owner-only handlers', async () => {
    const { bearer, owner } = credentials();
    const req = request('/v1/config/model-tier', bearer, 'PUT');
    const response = await routeRequest(req, { metaApi: { bearerToken: owner } } as NexusHttpServerOpts, {} as never, null, {} as never);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: 'forbidden' });
  });

  test('preserves owner bearer access to setup and owner-only routes', () => {
    const { owner } = credentials();
    for (const path of ['/v1/setup/llm-provider', '/v1/config/model-tier', '/v1/config/secrets']) {
      const req = request(path, owner, 'POST');
      expect(checkAuth(req, { bearerToken: owner })).toBe(true);
      expect(bearerCredential(req, { bearerToken: owner })).toBe('bearer-match');
    }
  });
});
