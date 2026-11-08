// WT-N-3+N-4 Phase 2 — Pushcut PWA runtime hook tests.
//
// Pure unit — mock global fetch (mirrors upload-attachment.test.ts
// pattern). Verify URL paths, request body shapes, auth header
// attachment via DaemonClient.fetchJson.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  rotatePushcutSecret,
  listPushcutBindings,
  upsertPushcutBinding,
  deletePushcutBinding,
  generatePushcutToken,
  PUSHCUT_SECRET_ID,
  PUSHCUT_BINDING_CHANNEL,
} from './pushcut-runtime';
import { DaemonClient } from './daemon-client';
import { createFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

let fakeFetch: FakeFetchDevice | undefined;

interface FetchCall {
  url: string | URL;
  init?: RequestInit;
}

function mockFetch(path: string, method: string, response: {
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  fakeFetch?.restore();
  fakeFetch = createFakeFetchDevice([{
    url: path,
    method,
    response: (request) => {
      calls.push({ url: request.url, init: { method: request.method, headers: request.headers, body: request.body ?? undefined } });
      return Response.json(response.jsonBody ?? {}, { status: response.status ?? 200 });
    },
  }]);
  return { calls };
}

afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
});

function makeClient(token = 'tok-1'): DaemonClient {
  return new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token,
    provider: '',
  });
}

describe('rotatePushcutSecret', () => {
  test('POSTs {id, value} to /v1/config/secrets with Bearer auth', async () => {
    const { calls } = mockFetch('/v1/config/secrets', 'POST', {
      ok: true,
      status: 201,
      jsonBody: { stored: true, id: PUSHCUT_SECRET_ID, ref: `ref:secret:${PUSHCUT_SECRET_ID}` },
    });
    const res = await rotatePushcutSecret(makeClient('my-token'), 'new-secret-hex');
    expect(res.stored).toBe(true);
    expect(res.ref).toBe(`ref:secret:${PUSHCUT_SECRET_ID}`);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(String(c.url)).toBe('http://localhost:31415/v1/config/secrets');
    expect(c.init?.method).toBe('POST');
    const body = JSON.parse(String(c.init?.body));
    expect(body.id).toBe(PUSHCUT_SECRET_ID);
    expect(body.value).toBe('new-secret-hex');
    const authHeader = (c.init?.headers as Record<string, string>)?.authorization;
    expect(authHeader).toBe('Bearer my-token');
  });

  test('throws on non-OK response (per fetchJson contract)', async () => {
    mockFetch('/v1/config/secrets', 'POST', { ok: false, status: 400, jsonBody: { error: 'invalid-id' } });
    await expect(rotatePushcutSecret(makeClient(), 'whatever')).rejects.toThrow();
  });
});

describe('listPushcutBindings', () => {
  test('GETs /v1/registry/bindings with channel=pushcut filter', async () => {
    const { calls } = mockFetch('/v1/registry/bindings', 'GET', {
      ok: true,
      status: 200,
      jsonBody: {
        channel: PUSHCUT_BINDING_CHANNEL,
        bindings: [
          { key: 'tok-A', sessionId: 'sess-1', label: 'iPhone 15', updatedAt: '2026-05-06T00:00:00Z' },
          { key: 'tok-B', sessionId: 'sess-2', label: 'iPad', updatedAt: '2026-05-06T01:00:00Z' },
        ],
      },
    });
    const res = await listPushcutBindings(makeClient());
    expect(res.channel).toBe(PUSHCUT_BINDING_CHANNEL);
    expect(res.bindings).toHaveLength(2);
    expect(res.bindings[0]?.label).toBe('iPhone 15');
    expect(String(calls[0]?.url)).toBe(
      `http://localhost:31415/v1/registry/bindings?channel=${PUSHCUT_BINDING_CHANNEL}`,
    );
  });

  test('returns empty list shape when channel has no bindings', async () => {
    mockFetch('/v1/registry/bindings', 'GET', {
      ok: true,
      status: 200,
      jsonBody: { channel: PUSHCUT_BINDING_CHANNEL, bindings: [] },
    });
    const res = await listPushcutBindings(makeClient());
    expect(res.bindings).toHaveLength(0);
  });
});

describe('upsertPushcutBinding', () => {
  test('POST default — full body with sessionId + label', async () => {
    const { calls } = mockFetch('/v1/registry/bindings/pushcut/token-xyz', 'POST', {
      ok: true,
      status: 201,
      jsonBody: {
        binding: {
          key: 'token-xyz',
          sessionId: 'sess-1',
          label: 'iPhone',
          updatedAt: '2026-05-06T00:00:00Z',
        },
        outcome: 'created',
      },
    });
    const res = await upsertPushcutBinding(makeClient(), {
      token: 'token-xyz',
      sessionId: 'sess-1',
      label: 'iPhone',
    });
    expect(res.outcome).toBe('created');
    expect(res.binding.key).toBe('token-xyz');
    const c = calls[0]!;
    expect(c.init?.method).toBe('POST');
    expect(String(c.url)).toBe(
      `http://localhost:31415/v1/registry/bindings/${PUSHCUT_BINDING_CHANNEL}/token-xyz`,
    );
    const body = JSON.parse(String(c.init?.body));
    expect(body).toEqual({ sessionId: 'sess-1', label: 'iPhone' });
  });

  test('PATCH method override + mergeMeta:true', async () => {
    const { calls } = mockFetch('/v1/registry/bindings/pushcut/tok-1', 'PATCH', {
      ok: true,
      status: 200,
      jsonBody: {
        binding: { key: 'tok-1', sessionId: 'sess-2', updatedAt: 'now' },
        outcome: 'updated',
      },
    });
    await upsertPushcutBinding(makeClient(), {
      token: 'tok-1',
      sessionId: 'sess-2',
      mergeMeta: true,
      method: 'PATCH',
    });
    const c = calls[0]!;
    expect(c.init?.method).toBe('PATCH');
    const body = JSON.parse(String(c.init?.body));
    expect(body.mergeMeta).toBe(true);
  });

  test('encodes special chars in token (URL-safe key regex allows / : . - _ ~)', async () => {
    const { calls } = mockFetch('/v1/registry/bindings/pushcut/a%2Fb', 'POST', { ok: true, status: 201, jsonBody: { binding: { key: 'a/b' }, outcome: 'created' } });
    await upsertPushcutBinding(makeClient(), { token: 'a/b' });
    // encodeURIComponent encodes '/' to '%2F' so the daemon's parseBindingPath
    // treats it as a literal key char, not a path separator.
    expect(String(calls[0]?.url)).toContain('%2F');
  });

  test('omits undefined fields from body', async () => {
    const { calls } = mockFetch('/v1/registry/bindings/pushcut/t', 'POST', { ok: true, status: 201, jsonBody: { binding: { key: 't' }, outcome: 'created' } });
    await upsertPushcutBinding(makeClient(), { token: 't' });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(Object.keys(body)).toHaveLength(0);
  });
});

describe('deletePushcutBinding', () => {
  test('DELETE /v1/registry/bindings/pushcut/<token>', async () => {
    const { calls } = mockFetch('/v1/registry/bindings/pushcut/tok-A', 'DELETE', {
      ok: true,
      status: 200,
      jsonBody: { deleted: true, channel: PUSHCUT_BINDING_CHANNEL, key: 'tok-A' },
    });
    const res = await deletePushcutBinding(makeClient(), 'tok-A');
    expect(res.deleted).toBe(true);
    expect(res.key).toBe('tok-A');
    const c = calls[0]!;
    expect(c.init?.method).toBe('DELETE');
    expect(String(c.url)).toBe(
      `http://localhost:31415/v1/registry/bindings/${PUSHCUT_BINDING_CHANNEL}/tok-A`,
    );
  });

  test('throws on 404 (binding-not-found surfaces via fetchJson)', async () => {
    mockFetch('/v1/registry/bindings/pushcut/missing', 'DELETE', { ok: false, status: 404, jsonBody: { error: 'binding-not-found' } });
    await expect(deletePushcutBinding(makeClient(), 'missing')).rejects.toThrow();
  });
});

describe('generatePushcutToken', () => {
  test('returns 32-char hex (16 bytes random)', () => {
    const t = generatePushcutToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  test('two calls produce distinct tokens', () => {
    const a = generatePushcutToken();
    const b = generatePushcutToken();
    expect(a).not.toBe(b);
  });
});
