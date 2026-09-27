import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { isSameOriginRequest } from './check-same-origin.js';
import { checkAuth, registerAuthPeerAddress } from '../nexus/api/meta-api.js';
import { _resetForTest, snapshot } from '../nexus/api/auth-trace.js';
import { startNexusHttpServer } from '../nexus/api/http-server.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';

function request(headers: Record<string, string>): Request {
  return new Request('http://example.test/v1/tools', { headers });
}

function sameOrigin(headers: Record<string, string>, peerAddress = '127.0.0.1'): boolean {
  return isSameOriginRequest(request(headers), peerAddress);
}

beforeEach(() => _resetForTest());

describe('isSameOriginRequest peer gate', () => {
  test('preserves all four header tiers for a loopback peer', () => {
    expect(sameOrigin({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(sameOrigin({
      'sec-fetch-site': 'none', origin: 'http://example.test', host: 'example.test',
    })).toBe(true);
    expect(sameOrigin({ origin: 'http://example.test', host: 'example.test' })).toBe(true);
    expect(sameOrigin({ host: 'example.test', referer: 'http://example.test/app/' })).toBe(true);
  });

  test('allows only loopback peers — tailnet 100.64/10 now needs a bearer (RFC pwa-auth A′)', () => {
    const headers = { 'sec-fetch-site': 'same-origin' };
    expect(sameOrigin(headers, '::1')).toBe(true);
    expect(sameOrigin(headers, '100.96.1.10')).toBe(false);
    expect(sameOrigin(headers, '192.168.1.20')).toBe(false);
    expect(isSameOriginRequest(request(headers))).toBe(false);
  });

  test('still rejects cross-site, mismatched-origin, and incomplete headers for trusted peers', () => {
    expect(sameOrigin({ 'sec-fetch-site': 'cross-site', origin: 'http://example.test', host: 'example.test' })).toBe(false);
    expect(sameOrigin({ origin: 'http://evil.example', host: 'example.test' })).toBe(false);
    expect(sameOrigin({ host: 'example.test' })).toBe(false);
  });
});

describe('proxy markers void the header bypass (tailscale serve reaches us over loopback)', () => {
  test('a forged Host: localhost with same-origin via tailscale serve is rejected', () => {
    expect(sameOrigin({
      'sec-fetch-site': 'same-origin', host: 'localhost',
      'x-forwarded-for': '100.83.1.69', 'tailscale-user-login': 'someone@example.com',
    })).toBe(false);
  });
  test('any one proxy marker is enough to reject', () => {
    for (const marker of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'tailscale-user-name']) {
      expect(sameOrigin({ 'sec-fetch-site': 'same-origin', [marker]: 'x' })).toBe(false);
    }
  });
  test('the Mac browser path (loopback, no proxy marker) still passes', () => {
    expect(sameOrigin({ 'sec-fetch-site': 'same-origin', host: 'localhost:31415' })).toBe(true);
  });
});

describe('peer-gated meta API auth', () => {
  test('denies a forged header from an unfamiliar peer and preserves bearer behavior', () => {
    const forged = request({ 'sec-fetch-site': 'same-origin' });
    registerAuthPeerAddress(forged, '192.168.1.20');
    expect(checkAuth(forged, { bearerToken: 'secret' })).toBe(false);
    expect(snapshot().at(-1)).toMatchObject({
      ok: false,
      reason: 'untrusted-same-origin-peer',
      peerAddress: '192.168.1.20',
    });

    const validBearer = request({
      'sec-fetch-site': 'same-origin', authorization: 'Bearer secret',
    });
    registerAuthPeerAddress(validBearer, '192.168.1.20');
    expect(checkAuth(validBearer, { bearerToken: 'secret' })).toBe(true);

    const mismatch = request({ authorization: 'Bearer secres' });
    registerAuthPeerAddress(mismatch, '192.168.1.20');
    expect(checkAuth(mismatch, { bearerToken: 'secret' })).toBe(false);
    expect(snapshot().at(-1)).toMatchObject({ reason: 'bearer-mismatch' });
  });

  test('a tailnet peer needs a bearer (RFC pwa-auth A′) and passes with one', () => {
    const tailnet = request({ 'sec-fetch-site': 'same-origin' });
    registerAuthPeerAddress(tailnet, '100.100.20.2');
    expect(checkAuth(tailnet, { bearerToken: 'secret' })).toBe(false);
    expect(snapshot().at(-1)).toMatchObject({ ok: false, peerAddress: '100.100.20.2' });
    const withBearer = request({ 'sec-fetch-site': 'same-origin', authorization: 'Bearer secret' });
    registerAuthPeerAddress(withBearer, '100.100.20.2');
    expect(checkAuth(withBearer, { bearerToken: 'secret' })).toBe(true);
  });
});

describe('HTTP peer registration wiring', () => {
  let server: ReturnType<typeof startNexusHttpServer> | undefined;

  afterEach(() => server?.stop());

  test('routes a loopback request through requestIP peer registration before checkAuth', async () => {
    const eventBus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'same-origin-peer' });
    state.bus = eventBus;
    server = startNexusHttpServer({
      state,
      registry: new TabRegistry(state),
      eventBus,
      hostname: '127.0.0.1',
      startPort: 46000 + Math.floor(Math.random() * 1000),
      metaApi: {
        bearerToken: 'secret',
        voiceRest: {
          handleCost: () => new Response('{}', { status: 200 }),
          handleTranscribe: async () => new Response('{}', { status: 200 }),
        },
      },
    });

    const response = await fetch(`${server.url}/v1/voice/cost`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });

    expect(response.status).toBe(200);
    expect(snapshot().at(-1)).toMatchObject({
      ok: true,
      reason: 'same-origin',
      peerAddress: expect.stringMatching(/^127\./),
    });
  });
});
