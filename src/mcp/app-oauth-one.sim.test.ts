import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { authorizeMcpDevice, completeAppOAuthConnection, discoverAuthorizationServer, discoverProtectedResource, prepareMcpOAuthAuthorization, refreshStoredAccessToken, type AuthorizationServerMetadata } from './mcp-oauth.js';
import { loadTokens, oauthConnectionStatus, replaceClientTokensIfCurrent, saveTokens } from '../oauth/store.js';
import { acquireLockSync } from '../storage/file-lock.js';

const issuer = 'https://auth.fake.example';
const metadata: AuthorizationServerMetadata = {
  issuer, tokenEndpoint: `${issuer}/token`, deviceAuthorizationEndpoint: `${issuer}/device`,
  codeChallengeMethodsSupported: ['S256'],
};
const reply = (body: object, status = 200) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('fake app OAuth client switch uses one private store and exposes metadata only', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-one-')), 'auth.json');
  saveTokens(issuer, { accessToken: 'old-access-canary', refreshToken: 'old-refresh-canary', expiresAt: 10 }, {
    authMode: 'mcp-oauth', accountUuid: 'old-client', organizationUuid: 'old-client-secret', redirectUri: 'http://127.0.0.1/old', mirrorCodex: false,
  }, path);
  saveTokens('other-issuer', { accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: null }, { mirrorCodex: false }, path);

  replaceClientTokensIfCurrent(issuer, 'old-client', { accessToken: 'new-access-canary', refreshToken: 'new-refresh-canary', expiresAt: 20 }, {
    clientId: 'new-client', authMode: 'mcp-oauth', redirectUri: 'http://127.0.0.1/new',
  }, path);
  expect(loadTokens(issuer, path)).toMatchObject({ accountUuid: 'new-client', redirectUri: 'http://127.0.0.1/new', tokens: { accessToken: 'new-access-canary' } });
  expect(loadTokens(issuer, path)?.organizationUuid).toBeUndefined();
  expect(loadTokens('other-issuer', path)?.tokens.accessToken).toBe('other-access');
  expect(oauthConnectionStatus(issuer, path)).toMatchObject({ connected: true, expiresAt: 20 });
  expect(JSON.stringify(oauthConnectionStatus(issuer, path))).not.toMatch(/access-canary|refresh-canary|client-secret/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, 'utf8')).toContain('new-access-canary');
  expect(() => replaceClientTokensIfCurrent(issuer, 'old-client', { accessToken: 'stale', refreshToken: 'stale', expiresAt: 30 }, {
    clientId: 'stale-client', authMode: 'mcp-oauth',
  }, path)).toThrow('OAuth registration changed');
  expect(loadTokens(issuer, path)?.tokens.accessToken).toBe('new-access-canary');
});

test('two processes serialize app client replacement and another issuer save', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-race-')), 'auth.json');
  saveTokens(issuer, { accessToken: 'old', refreshToken: 'old', expiresAt: null }, {
    authMode: 'mcp-oauth', accountUuid: 'old-client', mirrorCodex: false,
  }, path);
  const moduleUrl = new URL('../oauth/store.ts', import.meta.url).href;
  const replacement = `const {replaceClientTokensIfCurrent}=await import(${JSON.stringify(moduleUrl)});replaceClientTokensIfCurrent(${JSON.stringify(issuer)},'old-client',{accessToken:'new',refreshToken:'new',expiresAt:null},{clientId:'new-client',authMode:'mcp-oauth'},${JSON.stringify(path)});`;
  const anotherIssuer = `const {saveTokens}=await import(${JSON.stringify(moduleUrl)});saveTokens('other-issuer',{accessToken:'other',refreshToken:'other',expiresAt:null},{mirrorCodex:false},${JSON.stringify(path)});`;
  const release = acquireLockSync(`${path}.lock`);
  const children = [replacement, anotherIssuer].map((code) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(children.every((child) => child.exitCode === null)).toBe(true);
  } finally { release(); }
  const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; error: string }>((resolve) => {
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.on('close', (code) => resolve({ code, error }));
  })));
  expect(results).toEqual([{ code: 0, error: '' }, { code: 0, error: '' }]);
  expect(loadTokens(issuer, path)).toMatchObject({ accountUuid: 'new-client', tokens: { accessToken: 'new' } });
  expect(loadTokens('other-issuer', path)?.tokens.accessToken).toBe('other');
});

test('fake app connects through the shared OAuth flow and receives a metadata-only receipt', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-connect-')), 'auth.json');
  const resource = 'https://app.fake.example/mcp';
  saveTokens(issuer, { accessToken: '', refreshToken: '', expiresAt: null }, {
    authMode: 'mcp-oauth', accountUuid: 'client', redirectUri: 'http://127.0.0.1/oauth/callback', mirrorCodex: false,
  }, path);
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url === 'https://app.fake.example/.well-known/oauth-protected-resource') return reply({ resource, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return reply({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ['S256'],
    });
    if (url === `${issuer}/token`) return reply({ access_token: 'app-access-canary', refresh_token: 'app-refresh-canary', expires_in: 3600 });
    throw new Error('unexpected fake endpoint');
  };
  const opts = {
    resourceMetadataUrl: 'https://app.fake.example/.well-known/oauth-protected-resource', resourceUrl: resource,
    storePath: path, fetch,
  };
  const authorization = await prepareMcpOAuthAuthorization(opts);
  const receipt = await completeAppOAuthConnection(authorization.metadata, authorization.request, {
    code: 'fake-code', state: authorization.request.state,
  }, opts);
  expect(receipt).toMatchObject({ issuer, connected: true });
  expect(JSON.stringify(receipt)).not.toMatch(/app-access-canary|app-refresh-canary|fake-code/);
  expect(loadTokens(issuer, path)?.tokens.accessToken).toBe('app-access-canary');
  expect(calls).toEqual(['https://app.fake.example/.well-known/oauth-protected-resource', `${issuer}/.well-known/oauth-authorization-server`, `${issuer}/token`]);
});

test('fake token endpoint and fetch errors never echo token canaries', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-errors-')), 'auth.json');
  saveTokens(issuer, { accessToken: 'stored-access-canary', refreshToken: 'stored-refresh-canary', expiresAt: 1 }, {
    authMode: 'mcp-oauth', accountUuid: 'client', mirrorCodex: false,
  }, path);
  for (const fetch of [
    async () => reply({ error: 'invalid_grant', error_description: 'stored-refresh-canary' }, 400),
    async () => { throw new Error('stored-refresh-canary'); },
    async () => ({ status: 200, headers: { get: () => null }, text: async () => { throw new Error('stored-refresh-canary'); } }),
  ]) {
    let message = '';
    try { await refreshStoredAccessToken({ issuer, tokenEndpoint: metadata.tokenEndpoint }, { storePath: path, fetch }); }
    catch (error) { message = String(error); }
    expect(message).toContain('McpOAuthError');
    expect(message).not.toContain('stored-refresh-canary');
  }
  let deviceMessage = '';
  try {
    await authorizeMcpDevice(metadata, { clientId: 'client' }, {
      storePath: path, fetch: async () => reply({ error: 'stored-access-canary' }, 400), onDeviceCode: () => {},
    });
  } catch (error) { deviceMessage = String(error); }
  expect(deviceMessage).toContain('McpOAuthError');
  expect(deviceMessage).not.toContain('stored-access-canary');
});

test('in-flight refresh cannot overwrite a newer client, refresh token, or access token', async () => {
  for (const change of ['client', 'refresh', 'access'] as const) {
    const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-stale-refresh-')), 'auth.json');
    saveTokens(issuer, { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }, {
      authMode: 'mcp-oauth', accountUuid: 'old-client', mirrorCodex: false,
    }, path);
    const fetch = async () => {
      if (change === 'client') {
        replaceClientTokensIfCurrent(issuer, 'old-client', {
          accessToken: 'new-client-access', refreshToken: 'new-client-refresh', expiresAt: 100,
        }, { clientId: 'new-client', authMode: 'mcp-oauth' }, path);
      } else {
        saveTokens(issuer, { accessToken: 'newer-access', refreshToken: change === 'refresh' ? 'newer-refresh' : 'old-refresh', expiresAt: 100 }, {
          authMode: 'mcp-oauth', accountUuid: 'old-client', mirrorCodex: false,
        }, path);
      }
      return reply({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 });
    };
    let failure: unknown;
    try { await refreshStoredAccessToken({ issuer, tokenEndpoint: metadata.tokenEndpoint }, { storePath: path, fetch }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'token' });
    expect(loadTokens(issuer, path)?.tokens.refreshToken).toBe(change === 'client' ? 'new-client-refresh' : change === 'refresh' ? 'newer-refresh' : 'old-refresh');
    expect(loadTokens(issuer, path)?.tokens.accessToken).toBe(change === 'client' ? 'new-client-access' : 'newer-access');
  }
});

test('browser approval prepared for client A cannot replace client B after the wait', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-approval-race-')), 'auth.json');
  saveTokens(issuer, { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }, {
    authMode: 'mcp-oauth', accountUuid: 'old-client', mirrorCodex: false,
  }, path);
  const browserMetadata: AuthorizationServerMetadata = {
    ...metadata, authorizationEndpoint: `${issuer}/authorize`, registrationEndpoint: `${issuer}/register`,
  };
  const fetch = async (url: string) => url === `${issuer}/register`
    ? reply({ client_id: 'client-A' })
    : reply({ access_token: 'client-A-access', refresh_token: 'client-A-refresh', expires_in: 3600 });
  const opts = { resourceMetadataUrl: 'https://app.fake/.well-known/oauth-protected-resource',
    discovered: { resource: { resource: 'https://app.fake/mcp', authorizationServers: [issuer] }, metadata: browserMetadata },
    resourceUrl: 'https://app.fake/mcp', redirectUri: 'http://127.0.0.1:32123/oauth/callback',
    forceReregister: true, fetch, storePath: path };
  const authorization = await prepareMcpOAuthAuthorization(opts);
  expect(JSON.stringify(authorization.request)).not.toContain('old-refresh');
  replaceClientTokensIfCurrent(issuer, 'old-client', { accessToken: 'client-B-access', refreshToken: 'client-B-refresh', expiresAt: 100 }, {
    clientId: 'client-B', authMode: 'mcp-oauth',
  }, path);
  let failure: unknown;
  try {
    await completeAppOAuthConnection(authorization.metadata, authorization.request, {
      code: 'client-A-code', state: authorization.request.state,
    }, opts);
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'token' });
  expect(loadTokens(issuer, path)).toMatchObject({ accountUuid: 'client-B', tokens: { refreshToken: 'client-B-refresh' } });
});

test('access-only credential keeps its client through cancelled and failed browser approval', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'app-oauth-access-only-')), 'auth.json');
  saveTokens(issuer, { accessToken: 'old-access', refreshToken: '', expiresAt: null }, {
    authMode: 'mcp-oauth', accountUuid: 'old-client', organizationUuid: 'old-secret', mirrorCodex: false,
  }, path);
  const browserMetadata: AuthorizationServerMetadata = {
    ...metadata, authorizationEndpoint: `${issuer}/authorize`, registrationEndpoint: `${issuer}/register`,
  };
  const fetch = async (url: string) => url === `${issuer}/register`
    ? reply({ client_id: 'new-client', client_secret: 'new-secret' })
    : reply({ error: 'invalid_grant', error_description: 'old-access' }, 400);
  const opts = { resourceMetadataUrl: 'https://app.fake/.well-known/oauth-protected-resource',
    discovered: { resource: { resource: 'https://app.fake/mcp', authorizationServers: [issuer] }, metadata: browserMetadata },
    resourceUrl: 'https://app.fake/mcp', redirectUri: 'http://127.0.0.1:32123/oauth/callback',
    forceReregister: true, fetch, storePath: path };
  const authorization = await prepareMcpOAuthAuthorization(opts);
  expect(authorization.request.pendingRegistration).toBeDefined();
  expect(loadTokens(issuer, path)).toMatchObject({ accountUuid: 'old-client', organizationUuid: 'old-secret', tokens: { accessToken: 'old-access' } });
  // Cancelling leaves the prepared request uncommitted; a failed exchange must do the same.
  let failure: unknown;
  try {
    await completeAppOAuthConnection(authorization.metadata, authorization.request, {
      code: 'denied-code', state: authorization.request.state,
    }, opts);
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'token' });
  expect(String(failure)).not.toContain('old-access');
  expect(loadTokens(issuer, path)).toMatchObject({ accountUuid: 'old-client', organizationUuid: 'old-secret', tokens: { accessToken: 'old-access' } });
});

test('fake metadata identity errors omit attacker-controlled URL token text', async () => {
  const canary = 'access-token-canary-in-url';
  const resourceFetch = async () => reply({ resource: `https://other.fake/?token=${canary}`, authorization_servers: [issuer] });
  let resourceError: unknown;
  try {
    await discoverProtectedResource('https://mcp.fake/.well-known/oauth-protected-resource', {
      resourceUrl: 'https://mcp.fake/mcp', fetch: resourceFetch,
    });
  } catch (error) { resourceError = error; }
  expect(resourceError).toMatchObject({ code: 'identity-mismatch' });
  expect(String(resourceError)).not.toContain(canary);
  const issuerFetch = async () => reply({
    issuer: `https://other.fake/?token=${canary}`, token_endpoint: `${issuer}/token`, authorization_endpoint: `${issuer}/authorize`,
  });
  let issuerError: unknown;
  try {
    await discoverAuthorizationServer(issuer, { fetch: issuerFetch });
  } catch (error) { issuerError = error; }
  expect(issuerError).toMatchObject({ code: 'identity-mismatch' });
  expect(String(issuerError)).not.toContain(canary);
});
