// W7 Z11.a-1 · POST/DELETE/GET /v1/devices/tokens.

import { describe, expect, test } from 'bun:test';
import { handleOutboundTokens } from '../../../src/nexus/api/outbound-tokens';
import { InMemoryDeviceTokenStore } from '../../../src/showroom/outbound/token-store';
import { expectMalformedJson400 } from '../../helpers/http-error-contract';

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request('http://localhost/v1/devices/tokens', init);
}

describe('handleOutboundTokens', () => {
  test('GET returns counts per channel', async () => {
    const store = new InMemoryDeviceTokenStore();
    store.upsert({ channel: 'ios-push', deviceId: 'd', token: 't', registeredAt: 0 });
    const res = await handleOutboundTokens(jsonRequest('GET'), { tokenStore: store });
    expect(res.status).toBe(200);
    const body = await res.json() as { counts: Record<string, number> };
    expect(body.counts['ios-push']).toBe(1);
    expect(body.counts['live-activity']).toBe(0);
  });

  test('POST upserts a token', async () => {
    const store = new InMemoryDeviceTokenStore();
    const res = await handleOutboundTokens(
      jsonRequest('POST', { channel: 'ios-push', deviceId: 'd1', token: 't1' }),
      { tokenStore: store, now: () => 999 },
    );
    expect(res.status).toBe(200);
    expect(store.count('ios-push')).toBe(1);
    expect(store.list('ios-push')[0]!.registeredAt).toBe(999);
  });

  test('POST rejects unknown channel', async () => {
    const store = new InMemoryDeviceTokenStore();
    const res = await handleOutboundTokens(
      jsonRequest('POST', { channel: 'bogus', deviceId: 'd', token: 't' }),
      { tokenStore: store },
    );
    expect(res.status).toBe(400);
  });

  test('POST rejects missing token', async () => {
    const store = new InMemoryDeviceTokenStore();
    const res = await handleOutboundTokens(
      jsonRequest('POST', { channel: 'ios-push', deviceId: 'd' }),
      { tokenStore: store },
    );
    expect(res.status).toBe(400);
  });

  test('DELETE removes existing record', async () => {
    const store = new InMemoryDeviceTokenStore();
    store.upsert({ channel: 'ios-push', deviceId: 'd1', token: 't1', registeredAt: 0 });
    const res = await handleOutboundTokens(
      jsonRequest('DELETE', { channel: 'ios-push', deviceId: 'd1' }),
      { tokenStore: store },
    );
    expect(res.status).toBe(200);
    expect(store.count('ios-push')).toBe(0);
  });

  test('DELETE non-existing → 404', async () => {
    const store = new InMemoryDeviceTokenStore();
    const res = await handleOutboundTokens(
      jsonRequest('DELETE', { channel: 'ios-push', deviceId: 'd-none' }),
      { tokenStore: store },
    );
    expect(res.status).toBe(404);
  });

  test('checkAuth gate', async () => {
    const store = new InMemoryDeviceTokenStore();
    const res = await handleOutboundTokens(
      jsonRequest('GET'),
      { tokenStore: store, checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });

  test('invalid JSON body → 400', async () => {
    const store = new InMemoryDeviceTokenStore();
    const bad = new Request('http://localhost/v1/devices/tokens', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleOutboundTokens(bad, { tokenStore: store });
    await expectMalformedJson400(res);
  });
});
