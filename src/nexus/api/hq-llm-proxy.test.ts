import { expect, test } from 'bun:test';
import { allowHqLlmProxyCall, handleHqLlmProxy } from './hq-llm-proxy.js';

const request = (purpose = 'review') => new Request('https://hq.ts.net/v1/llm/proxy', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ seat: 'R-PROXY', purpose, pr: 42, messages: [{ role: 'user', content: 'hello' }] }),
});

test('fake upstream: authenticated review returns only result and records usage', async () => {
  const recorded: unknown[] = [];
  const response = await handleHqLlmProxy(request(), {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true,
    run: async () => ({ events: [{ type: 'text', delta: 'simulated' }], usage: { inputTokens: 8, outputTokens: 3, reportedCostUsd: 0.002 } }),
    record: event => recorded.push(event), rateLimit: () => true,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ events: [{ type: 'text', delta: 'simulated' }], usage: { inputTokens: 8, outputTokens: 3, reportedCostUsd: 0.002 } });
  expect(recorded).toMatchObject([{ event: 'llm-proxy-call', host: 'pod-a', seat: 'R-PROXY', purpose: 'review', pr: 42, inputTokens: 8, outputTokens: 3, costUsd: 0.002 }]);
});

test('denies unknown purpose before upstream', async () => {
  let called = false;
  const response = await handleHqLlmProxy(request('unbounded'), {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true,
    run: async () => { called = true; return { events: [], usage: {} }; },
    record: () => {}, rateLimit: () => true,
  });
  expect(response.status).toBe(403);
  expect(called).toBe(false);
});

test('denies missing purpose without recording a review call', async () => {
  const recorded: unknown[] = [];
  const withoutPurpose = new Request('https://hq.ts.net/v1/llm/proxy', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seat: 'R-PROXY', messages: [{ role: 'user', content: 'hello' }] }) });
  const response = await handleHqLlmProxy(withoutPurpose, {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true,
    run: async () => { throw new Error('must not run'); }, record: event => recorded.push(event), rateLimit: () => true,
  });
  expect(response.status).toBe(403);
  expect(recorded).toEqual([]);
});

test('tailnet, owner auth, machine token, and rate limit each fail closed', async () => {
  let called = false;
  const base = { authorize: () => true, machine: () => 'pod-a', tailnet: () => true,
    run: async () => { called = true; return { events: [], usage: {} }; },
    record: () => {}, rateLimit: () => true };
  expect((await handleHqLlmProxy(request(), { ...base, tailnet: () => false })).status).toBe(403);
  expect((await handleHqLlmProxy(request(), { ...base, authorize: () => false })).status).toBe(401);
  expect((await handleHqLlmProxy(request(), { ...base, machine: () => undefined })).status).toBe(401);
  expect((await handleHqLlmProxy(request(), { ...base, rateLimit: () => false })).status).toBe(429);
  expect(called).toBe(false);
});

test('fake upstream streams events and records usage after completion', async () => {
  const recorded: unknown[] = [];
  const usage = { inputTokens: 5, outputTokens: 2 };
  async function* events() { yield { type: 'text' as const, delta: 'first' }; usage.outputTokens = 4; yield { type: 'text' as const, delta: 'second' }; }
  const response = await handleHqLlmProxy(request(), { authorize: () => true, machine: () => 'pod-a', tailnet: () => true,
    run: async () => ({ events: events(), usage, billing: 'subscription' }), record: event => recorded.push(event), rateLimit: () => true });
  expect(response.headers.get('content-type')).toBe('application/x-ndjson');
  const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as unknown);
  expect(lines).toEqual([{ event: { type: 'text', delta: 'first' } }, { event: { type: 'text', delta: 'second' } }, { usage: { inputTokens: 5, outputTokens: 4 } }]);
  expect(recorded).toMatchObject([{ host: 'pod-a', inputTokens: 5, outputTokens: 4, costUsd: 0, costBasis: 'subscription' }]);
});

test('sliding host limit rejects bursts across a minute boundary', () => {
  const host = `boundary-${Date.now()}`;
  for (let index = 0; index < 10; index++) expect(allowHqLlmProxyCall(host, 59_990)).toBe(true);
  expect(allowHqLlmProxyCall(host, 60_000)).toBe(false);
  expect(allowHqLlmProxyCall(host, 119_989)).toBe(false);
  expect(allowHqLlmProxyCall(host, 119_990)).toBe(true);
});

test('oversize streaming body is rejected while reading, before upstream', async () => {
  let called = false;
  const bytes = new Uint8Array(600_000).fill(65);
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.enqueue(bytes); controller.close(); },
  });
  const oversized = new Request('https://hq.ts.net/v1/llm/proxy', { method: 'POST', body, duplex: 'half' } as RequestInit);
  expect(oversized.headers.get('content-length')).toBeNull();
  const response = await handleHqLlmProxy(oversized, {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true, rateLimit: () => true,
    run: async () => { called = true; return { events: [], usage: {} }; }, record: () => {},
  });
  expect(response.status).toBe(413);
  expect(called).toBe(false);
});

test('client cancellation aborts paid upstream and records partial usage once', async () => {
  const recorded: unknown[] = [];
  let signal: AbortSignal | undefined;
  async function* events() {
    yield { type: 'text' as const, delta: 'first' };
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
  }
  const response = await handleHqLlmProxy(request(), {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true, rateLimit: () => true,
    run: async (_messages, opts) => { signal = opts.signal; return { events: events(), usage: { inputTokens: 5 } }; },
    record: event => recorded.push(event),
  });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect(signal?.aborted).toBe(true);
  expect(recorded).toMatchObject([{ status: 'error', inputTokens: 5, outputTokens: null, costBasis: 'unknown' }]);
  expect(recorded).toHaveLength(1);
});

test('cancel after upstream completion does not record a second outcome', async () => {
  const recorded: unknown[] = [];
  const response = await handleHqLlmProxy(request(), {
    authorize: () => true, machine: () => 'pod-a', tailnet: () => true, rateLimit: () => true,
    run: async () => ({ events: (async function* () { yield { type: 'text' as const, delta: 'done' }; })(),
      usage: { inputTokens: 1, outputTokens: 1 } }),
    record: event => recorded.push(event),
  });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  await reader.cancel();
  expect(recorded).toMatchObject([{ status: 'ok' }]);
  expect(recorded).toHaveLength(1);
});
