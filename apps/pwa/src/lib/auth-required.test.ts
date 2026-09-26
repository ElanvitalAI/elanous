import { afterEach, beforeEach, expect, test } from 'bun:test';
import { dismissAuthRequired, onAuthRequired, reportAuthRequired, resetAuthRequiredForTests } from './auth-required';
import { DaemonClient } from './daemon-client';
import { createNexusClient, NexusApiError } from '../nexus/client';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetAuthRequiredForTests();
  globalThis.window = new EventTarget() as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthRequiredForTests();
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else globalThis.window = originalWindow;
});

test('reportAuthRequired emits the first path once per tab, without a token', () => {
  const received: { path: string }[] = [];
  const events: Event[] = [];
  window.addEventListener('elanous:auth-required', (event) => events.push(event));
  const off = onAuthRequired((detail) => received.push(detail));
  reportAuthRequired('/v1/health');
  reportAuthRequired('/v1/other');
  expect(events).toHaveLength(1);
  expect(events[0]).toBeInstanceOf(CustomEvent);
  expect((events[0] as CustomEvent).detail).toEqual({ path: '/v1/health' });
  expect(received).toEqual([{ path: '/v1/health' }]);
  off();
});

test('unsubscribed listeners do not receive an auth-required event', () => {
  const received: { path: string }[] = [];
  const off = onAuthRequired((detail) => received.push(detail));
  off();
  reportAuthRequired('/v1/health');
  expect(received).toEqual([]);
});

test('late subscribers receive the initial notice once', () => {
  reportAuthRequired('/v1/health');
  const received: { path: string }[] = [];
  const off = onAuthRequired((detail) => received.push(detail));
  expect(received).toEqual([{ path: '/v1/health' }]);
  off();
});

test('dismissed notice is not replayed to new subscribers', () => {
  reportAuthRequired('/v1/health');
  dismissAuthRequired();
  const received: { path: string }[] = [];
  const off = onAuthRequired((detail) => received.push(detail));
  reportAuthRequired('/v1/other');
  expect(received).toEqual([]);
  off();
});

test('daemon fetchResponse signals on 401 and preserves its Response and fetchJson error', async () => {
  const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' });
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const seen: { path: string }[] = [];
  const off = onAuthRequired((detail) => seen.push(detail));
  const response = await client.fetchResponse('/v1/health');
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'unauthorized' });
  await expect(client.fetchJson('/v1/health')).rejects.toThrow('unauthorized');
  expect(seen).toEqual([{ path: '/v1/health' }]);
  off();
});

test('daemon direct prompt and streaming paths also signal on 401 without changing errors', async () => {
  const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' });
  globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
  const seen: { path: string }[] = [];
  const off = onAuthRequired((detail) => seen.push(detail));
  await expect(client.prompt({ userText: 'hello' })).rejects.toThrow('prompt 401: unauthorized');
  await expect(client.promptStream({ userText: 'hello' })).rejects.toThrow('prompt/stream 401: unauthorized');
  expect(seen).toEqual([{ path: '/v1/prompt' }]);
  off();
});

test('nexus request signals on 401 and keeps the NexusApiError shape', async () => {
  const client = createNexusClient({ baseUrl: 'http://localhost:31415', timeoutMs: 0,
    fetchImpl: (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch });
  const seen: { path: string }[] = [];
  const off = onAuthRequired((detail) => seen.push(detail));
  try {
    await client.getHealth();
    throw new Error('expected a 401');
  } catch (err) {
    expect(err).toBeInstanceOf(NexusApiError);
    expect((err as NexusApiError).status).toBe(401);
    expect((err as NexusApiError).path).toBe('/v1/health');
    expect((err as NexusApiError).body).toEqual({ error: 'unauthorized' });
  }
  expect(seen).toEqual([{ path: '/v1/health' }]);
  off();
});

test('non-401 error shapes stay unchanged and do not signal', async () => {
  const seen: { path: string }[] = [];
  const off = onAuthRequired((detail) => seen.push(detail));
  const daemon = new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' });
  globalThis.fetch = (async () => new Response('{"reason":"bad_input","error":"other"}', { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  await expect(daemon.fetchJson('/v1/health')).rejects.toThrow('bad_input');
  const nexus = createNexusClient({ baseUrl: 'http://localhost:31415', timeoutMs: 0,
    fetchImpl: (async () => new Response('{"error":"missing"}', { status: 404 })) as unknown as typeof fetch });
  await expect(nexus.getHealth()).rejects.toMatchObject({ status: 404, path: '/v1/health', body: { error: 'missing' } });
  expect(seen).toEqual([]);
  off();
});

test('non-401 responses keep their values and do not signal', async () => {
  const seen: { path: string }[] = [];
  const off = onAuthRequired((detail) => seen.push(detail));
  const daemon = new DaemonClient({ baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' });
  globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  expect(await daemon.health()).toEqual({ ok: true });
  const nexus = createNexusClient({ baseUrl: 'http://localhost:31415', timeoutMs: 0,
    fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch });
  expect((await nexus.getHealth()).ok).toBe(true);
  expect(seen).toEqual([]);
  off();
});

test('without window, reporting and subscribing are no-ops', () => {
  delete (globalThis as { window?: Window }).window;
  const received: { path: string }[] = [];
  const off = onAuthRequired((detail) => received.push(detail));
  reportAuthRequired('/v1/health');
  off();
  expect(received).toEqual([]);
  globalThis.window = new EventTarget() as Window & typeof globalThis;
  reportAuthRequired('/v1/health');
  const seen: { path: string }[] = [];
  const dispose = onAuthRequired((detail) => seen.push(detail));
  expect(seen).toEqual([{ path: '/v1/health' }]);
  dispose();
});
