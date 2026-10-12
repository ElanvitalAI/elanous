import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeMcpDevice,
  buildAuthorizationRequest,
  ensureClientRegistration,
  exchangeAuthorizationCode,
  type AuthorizationServerMetadata,
  type McpOAuthFetch,
} from './mcp-oauth.js';
import { loadTokens } from '../oauth/store.js';

const metadata: AuthorizationServerMetadata = {
  issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize',
  tokenEndpoint: 'https://auth.example/token', deviceAuthorizationEndpoint: 'https://auth.example/device',
  codeChallengeMethodsSupported: ['S256'],
};
const response = (body: object, status = 200) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function fixture(states: Array<{ body: object; status?: number }>) {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetch: McpOAuthFetch = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(init?.body) });
    const state = states.shift();
    if (!state) throw new Error('unexpected poll');
    return response(state.body, state.status);
  };
  return { fetch, calls };
}

const device = { device_code: 'secret-device', user_code: 'ABCD', verification_uri: 'https://auth.example/verify', expires_in: 60, interval: 1 };

describe('RFC 8628 MCP OAuth fallback', () => {
  test('pending and slow_down obey intervals; success persists issuer-keyed tokens without device code', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'mcp-device-')), 'auth.json');
    const { fetch, calls } = fixture([
      { body: device },
      { body: { error: 'authorization_pending' }, status: 400 },
      { body: { error: 'slow_down' }, status: 400 },
      { body: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 } },
    ]);
    const sleeps: number[] = [];
    let now = 0;
    const shown: unknown[] = [];
    const tokens = await authorizeMcpDevice(metadata, { clientId: 'client' }, {
      fetch, storePath, resource: 'https://mcp.example', scope: 'read', now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      onDeviceCode: (value) => { shown.push(value); },
    });
    expect(shown).toEqual([{ userCode: 'ABCD', verificationUri: 'https://auth.example/verify' }]);
    expect(sleeps).toEqual([1000, 1000, 6000]);
    expect(calls[0]?.url).toBe('https://auth.example/device');
    expect(calls[0]?.form.get('scope')).toBe('read');
    expect(calls[2]?.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(calls[2]?.form.get('device_code')).toBe('secret-device');
    expect(calls[2]?.form.get('resource')).toBe('https://mcp.example');
    expect(tokens.accessToken).toBe('access');
    expect(loadTokens(metadata.issuer, storePath)?.tokens.accessToken).toBe('access');
    expect(loadTokens(metadata.issuer, storePath)?.accountUuid).toBe('client');
  });

  test('unadvertised endpoint refuses fallback without a request', async () => {
    let called = false;
    await expect(authorizeMcpDevice({ ...metadata, deviceAuthorizationEndpoint: undefined }, { clientId: 'client' }, {
      fetch: async () => { called = true; return response({}); }, onDeviceCode: () => {},
    })).rejects.toThrow('does not advertise device_authorization_endpoint');
    expect(called).toBe(false);
  });

  test('expired authorization and terminal denial never persist a token', async () => {
    for (const state of [{ error: 'access_denied' }, { error: 'authorization_pending' }]) {
      const storePath = join(mkdtempSync(join(tmpdir(), 'mcp-device-')), 'auth.json');
      const { fetch } = fixture([{ body: { ...device, expires_in: 2 } }, { body: state, status: 400 }]);
      let now = 0;
      await expect(authorizeMcpDevice(metadata, { clientId: 'client' }, {
        fetch, storePath, now: () => now, sleep: async (ms) => { now += ms; }, onDeviceCode: () => {},
      })).rejects.toThrow(state.error === 'access_denied' ? 'access_denied' : 'expired');
      expect(loadTokens(metadata.issuer, storePath)?.tokens.accessToken ?? '').toBe('');
    }
  });
});

describe('client registration ordering across device → browser', () => {
  const registrable: AuthorizationServerMetadata = { ...metadata, registrationEndpoint: 'https://auth.example/register' };

  async function storeDeviceLogin() {
    const storePath = join(mkdtempSync(join(tmpdir(), 'mcp-reg-')), 'auth.json');
    const login = fixture([
      { body: device },
      { body: { access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 } },
    ]);
    let now = 0;
    await authorizeMcpDevice(registrable, { clientId: 'device-client' }, {
      fetch: login.fetch, storePath, now: () => now, sleep: async (ms) => { now += ms; }, onDeviceCode: () => {},
    });
    return storePath;
  }

  function registerFetch() {
    const registrations: string[] = [];
    const fetch: McpOAuthFetch = async (url) => {
      if (url !== registrable.registrationEndpoint) throw new Error(`unexpected URL ${url}`);
      registrations.push(url);
      return response({ client_id: 'browser-client' });
    };
    return { fetch, registrations };
  }

  test('a stored device client is reused for the device grant instead of being re-registered', async () => {
    const storePath = await storeDeviceLogin();
    const { fetch, registrations } = registerFetch();
    const registration = await ensureClientRegistration(registrable, { fetch, storePath, deviceCode: true });
    expect(registration.clientId).toBe('device-client');
    expect(registrations).toHaveLength(0);
    expect(loadTokens(registrable.issuer, storePath)?.accountUuid).toBe('device-client');
  });

  test('a browser registration over the device client is not stored before approval', async () => {
    const storePath = await storeDeviceLogin();
    const { fetch, registrations } = registerFetch();
    const registration = await ensureClientRegistration(registrable, { fetch, storePath });
    expect(registrations).toHaveLength(1);
    expect(registration).toMatchObject({ clientId: 'browser-client', pending: true });
    const request = buildAuthorizationRequest(registrable, registration);
    expect(request.pendingRegistration).toEqual({});
    const stored = loadTokens(registrable.issuer, storePath)!;
    expect(stored.accountUuid).toBe('device-client');
    expect(stored.redirectUri).toBeUndefined();
    expect(stored.tokens.refreshToken).toBe('device-refresh');
    await expect(exchangeAuthorizationCode(registrable, request, { code: 'c', state: 'wrong' }, { fetch, storePath }))
      .rejects.toThrow('state does not match');
    expect(loadTokens(registrable.issuer, storePath)?.accountUuid).toBe('device-client');
    expect(loadTokens(registrable.issuer, storePath)?.tokens.refreshToken).toBe('device-refresh');
  });

  test('after the device → browser switch the browser registration is committed together with the token', async () => {
    const storePath = await storeDeviceLogin();
    const { fetch } = registerFetch();
    const registration = await ensureClientRegistration(registrable, { fetch, storePath });
    const request = buildAuthorizationRequest(registrable, registration);
    const tokenFetch: McpOAuthFetch = async (url, init) => {
      expect(url).toBe(registrable.tokenEndpoint);
      expect(new URLSearchParams(init?.body).get('client_id')).toBe('browser-client');
      return response({ access_token: 'browser-access', refresh_token: 'browser-refresh', expires_in: 3600 });
    };
    await exchangeAuthorizationCode(registrable, request, { code: 'c', state: request.state }, { fetch: tokenFetch, storePath });
    const committed = loadTokens(registrable.issuer, storePath)!;
    expect(committed.accountUuid).toBe('browser-client');
    expect(committed.redirectUri).toBe(request.redirectUri);
    expect(committed.tokens.accessToken).toBe('browser-access');
    expect(committed.tokens.refreshToken).toBe('browser-refresh');
  });
});
