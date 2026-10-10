import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeMcpDevice, type AuthorizationServerMetadata, type McpOAuthFetch } from './mcp-oauth.js';
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
