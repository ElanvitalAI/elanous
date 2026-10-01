import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest } from './http-server.js';
import { handleSeatRequests } from './seat-requests.js';
import type { submitIntakeWork } from '../../intake-plane/submit-intake-work.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('HTTP router authenticates and accepts @cmo; GET returns the receipt and seat chips, @cfo is unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-requests-'));
  roots.push(root);
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
    seatRequests: { root: () => root, submit: async () => ({ ok: true as const, track: 'graph' as const, acceptanceId: 'receipt-router' }) } };
  const call = (path: string, method = 'GET', body?: unknown, auth: 'owner' | 'same-origin' | 'none' = 'owner') => routeRequest(
      new Request(`http://localhost${path}`, { method,
        headers: auth === 'owner' ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }
          : auth === 'same-origin' ? { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } : { 'sec-fetch-site': 'cross-site' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), opts, { requestIP: () => ({ address: auth === 'same-origin' ? '127.0.0.1' : '203.0.113.1' }) } as never,
      null, createDevProxyRuntimeRef());
    expect((await call('/v1/seat-requests', 'GET', undefined, 'none'))?.status).toBe(401);
    expect((await call('/v1/seat-requests', 'POST', { text: '@cmo 자료 정리' }, 'none'))?.status).toBe(401);
    const unknown = await call('/v1/seat-requests', 'POST', { text: '@cfo 자료 정리' });
    expect(unknown?.status).toBe(400);
    const rejected = await unknown!.json() as { error: string; seats: Array<{ id: string; title: string }> };
    expect(rejected.error).toBe('unknown-seat');
    expect(rejected.seats).toContainEqual({ id: 'MK', title: 'CMO' });
    const accepted = await call('/v1/seat-requests', 'POST', { text: '@cmo 자료 정리' }, 'same-origin');
    expect(accepted?.status).toBe(202);
    const receipt = await accepted!.json() as { receiptId: string; seat: string; queuedAt: string };
    expect(receipt.seat).toBe('MK');
    expect(receipt.receiptId).toEqual(expect.any(String));
    expect(receipt.queuedAt).toEqual(expect.any(String));
    const listing = await call('/v1/seat-requests?seat=cmo&limit=1');
    expect(listing?.status).toBe(200);
    const list = await listing!.json() as { items: unknown[]; seats: unknown[] };
    expect(list.items).toEqual([{ ...receipt, text: '자료 정리', status: 'queued' }]);
    expect(list.seats).toContainEqual({ id: 'MK', title: 'CMO' });
    expect((await call('/v1/seat-requests?seat=cfo'))?.status).toBe(400);
    expect((await call('/v1/seat-requests?seat=UX'))?.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').at(-1)!))
      .toMatchObject(list.items[0] as object);
    expect((await call('/v1/health', 'GET', undefined, 'none'))?.status).toBe(200);
});

test('handler submits once through graph intake with PWA reportTo and never queues unknown or empty requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-submit-'));
  roots.push(root);
  const inputs: Parameters<typeof submitIntakeWork>[0][] = [];
  const deps = { root: () => root, now: () => '2026-10-01T00:00:00.000Z',
    submit: async (input: Parameters<typeof submitIntakeWork>[0]) => {
      inputs.push(input);
      return { ok: true as const, track: 'graph' as const, acceptanceId: 'receipt-1' };
    },
  };
  const post = (body: unknown) => handleSeatRequests(new Request('http://localhost/v1/seat-requests', { method: 'POST', body: JSON.stringify(body) }), deps);
  expect((await post({ text: '@cfo no' })).status).toBe(400);
  expect((await post({ text: 'text without an address' })).status).toBe(400);
  expect((await post({ text: '@invalid\n@cmo work' })).status).toBe(400);
  expect((await post({ text: '@CMO@other\n@cmo work' })).status).toBe(400);
  expect((await post({ seat: 'CMO', text: '  ' })).status).toBe(400);
  expect(inputs).toHaveLength(0);
  const res = await post({ seat: 'MK', text: '한 장' });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ receiptId: 'receipt-1', seat: 'MK', queuedAt: '2026-10-01T00:00:00.000Z' });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ text: '@CMO 한 장', track: 'graph', origin: { kind: 'external', ledgerSource: 'pwa', provider: 'other', reportTo: { channel: 'pwa' } } });
  expect((inputs[0]!.origin as { ref: string }).ref).toMatch(/^pwa:/);
  expect((await (await handleSeatRequests(new Request('http://localhost/v1/seat-requests?seat=MK&limit=1'), deps)).json()).items)
    .toEqual([{ receiptId: 'receipt-1', seat: 'MK', text: '한 장', queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
});

test('HTTP router: failed completion write stays visible and retry returns original receipt without resubmission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-journal-'));
  roots.push(root);
  const path = join(root, 'seat-requests', 'requests.jsonl');
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  let writes = 0;
  let submissions = 0;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
    seatRequests: {
      root: () => root, now: () => '2026-10-01T00:00:00.000Z',
      append: (_path: string, entry: object) => {
        if (++writes === 2) throw new Error('disk unavailable');
        mkdirSync(join(root, 'seat-requests'), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      },
      submit: async () => { submissions++; return { ok: true as const, track: 'graph' as const, acceptanceId: `receipt-${submissions}` }; },
    },
  };
  const call = (method: string, body?: object, key = 'stable-request') => routeRequest(
    new Request('http://localhost/v1/seat-requests', { method,
      headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site', 'idempotency-key': key },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never,
    null, createDevProxyRuntimeRef());
  const accepted = await call('POST', { text: '@cmo 기록 실패' });
  expect(accepted?.status).toBe(202);
  expect(await accepted!.json()).toEqual({ receiptId: 'receipt-1', seat: 'MK', queuedAt: '2026-10-01T00:00:00.000Z' });
  expect(submissions).toBe(1);
  const listing = await call('GET');
  expect((await listing!.json()).items).toEqual([{ receiptId: 'receipt-1', seat: 'MK', text: '기록 실패',
    queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
  const retry = await call('POST', { text: '@cmo 기록 실패' });
  expect(retry?.status).toBe(202);
  expect(await retry!.json()).toEqual({ receiptId: 'receipt-1', seat: 'MK', queuedAt: '2026-10-01T00:00:00.000Z' });
  expect(submissions).toBe(1);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, 'seat-requests', 'outcomes', `${(JSON.parse(readFileSync(path, 'utf8').trim()) as { key: string }).key}.json`), 'utf8')).receiptId).toBe('receipt-1');
  const afterFlush = await call('GET');
  expect((await afterFlush!.json()).items).toHaveLength(1);
  const restarted = await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), { root: () => root });
  expect((await restarted.json()).items).toEqual([{ receiptId: 'receipt-1', seat: 'MK', text: '기록 실패',
    queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
  const noHeader = await routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ text: '@cmo 기록 실패' }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect(noHeader?.status).toBe(202);
  expect((await noHeader!.json()).receiptId).toBe('receipt-2');
  expect(submissions).toBe(2);
  const repeatedNoHeader = await routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ text: '@cmo 기록 실패' }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect(repeatedNoHeader?.status).toBe(202);
  expect((await repeatedNoHeader!.json()).receiptId).toBe('receipt-3');
  expect(submissions).toBe(3);
  expect((await call('POST', { text: '@cmo 다른 내용' }))?.status).toBe(409);
  expect(submissions).toBe(3);
});

test('HTTP router: journal failure before submission and uncertain pending request can resume with the same reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-pending-'));
  roots.push(root);
  const path = join(root, 'seat-requests', 'requests.jsonl');
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  let writes = 0;
  let submissions = 0;
  let unavailable = true;
  const refs: string[] = [];
  const opts = { state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
    seatRequests: {
      root: () => root,
      append: (_path: string, entry: object) => {
        writes++;
        if (unavailable) throw new Error('disk unavailable');
        mkdirSync(join(root, 'seat-requests'), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      },
      submit: async (input: Parameters<typeof submitIntakeWork>[0]) => {
        submissions++;
        refs.push((input.origin as { ref: string }).ref);
        if (submissions === 1) throw new Error('submission uncertain');
        return { ok: true as const, track: 'graph' as const, acceptanceId: 'resumed' };
      },
    },
  };
  const call = () => routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site', 'idempotency-key': 'pending' },
    body: JSON.stringify({ text: '@cmo 불확실' }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await call())?.status).toBe(503);
  expect(submissions).toBe(0);
  unavailable = false;
  expect((await call())?.status).toBe(503);
  expect(submissions).toBe(1);
  expect((await call())?.status).toBe(202);
  expect(submissions).toBe(2);
  expect(refs[0]).toBe(refs[1]);
  expect(writes).toBe(3);
  const list = await routeRequest(new Request('http://localhost/v1/seat-requests', {
    headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await list!.json()).items).toMatchObject([{ receiptId: 'resumed', status: 'queued' }]);
});

test('HTTP router preserves the original queuedAt when a delayed pending retry succeeds but completion journal fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-delayed-pending-'));
  roots.push(root);
  const path = join(root, 'seat-requests', 'requests.jsonl');
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const initial = '2026-10-01T00:00:00.000Z';
  let clock = initial;
  let submissions = 0;
  const refs: string[] = [];
  const opts = { state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
    seatRequests: {
      root: () => root, now: () => clock,
      append: (_path: string, entry: { status: string }) => {
        if (entry.status === 'queued') throw new Error('completion journal unavailable');
        mkdirSync(join(root, 'seat-requests'), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      },
      submit: async (input: Parameters<typeof submitIntakeWork>[0]) => {
        submissions++;
        refs.push((input.origin as { ref: string }).ref);
        if (submissions === 1) throw new Error('uncertain submission');
        return { ok: true as const, track: 'graph' as const, acceptanceId: 'delayed-receipt' };
      },
    },
  };
  const call = (method: string) => routeRequest(new Request('http://localhost/v1/seat-requests', {
    method, headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site', 'idempotency-key': 'delayed-key' },
    ...(method === 'POST' ? { body: JSON.stringify({ text: '@cmo 나중에' }) } : {}),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await call('POST'))?.status).toBe(503);
  clock = '2026-10-03T00:00:00.000Z';
  const accepted = await call('POST');
  expect(accepted?.status).toBe(202);
  const receipt = { receiptId: 'delayed-receipt', seat: 'MK', queuedAt: initial };
  expect(await accepted!.json()).toEqual(receipt);
  expect(refs[1]).toBe(refs[0]);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  const listing = await call('GET');
  expect(listing?.status).toBe(200);
  expect((await listing!.json()).items).toEqual([{ ...receipt, text: '나중에', status: 'queued' }]);
  const retry = await call('POST');
  expect(retry?.status).toBe(202);
  expect(await retry!.json()).toEqual(receipt);
  expect(submissions).toBe(2);
});

test('definite intake rejection terminates pending and permits same-key retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-rejected-'));
  roots.push(root);
  let attempts = 0;
  let writes = 0;
  const deps = { root: () => root,
    append: (path: string, entry: object) => {
      writes++;
      if (writes === 2) throw new Error('completion write failed');
      mkdirSync(join(root, 'seat-requests'), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    },
    submit: async () => {
      attempts++;
      return attempts === 1
        ? { ok: false as const, track: 'graph' as const, reason: 'not accepted' }
        : { ok: true as const, track: 'graph' as const, acceptanceId: 'recovered' };
    },
  };
  const post = () => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'retry-after-reject' }, body: JSON.stringify({ text: '@cmo 다시' }),
  }), deps);
  expect((await post()).status).toBe(503);
  const journal = join(root, 'seat-requests', 'requests.jsonl');
  expect(JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1)!).status).toBe('pending');
  expect((await post()).status).toBe(202);
  expect(writes).toBe(4);
  expect(attempts).toBe(2);
  expect((await (await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), deps)).json()).items)
    .toMatchObject([{ receiptId: 'recovered', seat: 'MK', status: 'queued' }]);
});

test('stale rejected sidecar cannot hide a newer pending retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-stale-'));
  roots.push(root);
  const dir = join(root, 'seat-requests');
  mkdirSync(join(dir, 'outcomes'), { recursive: true });
  const key = createHash('sha256').update('client\0stale-sidecar').digest('hex');
  const old = { key, seat: 'MK', text: '다시', queuedAt: 'old', status: 'rejected', ref: 'pwa:old' };
  const pending = { ...old, queuedAt: 'new', status: 'pending', ref: 'pwa:new' };
  writeFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify(old)}\n${JSON.stringify(pending)}\n`);
  writeFileSync(join(dir, 'outcomes', `${key}.json`), JSON.stringify(old));
  const get = await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), { root: () => root });
  expect(get.status).toBe(200);
  expect((await get.json()).items).toEqual([]);
  let submissions = 0;
  const retry = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'stale-sidecar' }, body: JSON.stringify({ text: '@cmo 다시' }),
  }), { root: () => root, submit: async () => {
    submissions++;
    return { ok: true as const, track: 'graph' as const, acceptanceId: 'new-receipt' };
  } });
  expect(retry.status).toBe(202);
  expect(submissions).toBe(1);
});

test('HTTP router serializes simultaneous submissions sharing a key and rejects a conflicting payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-concurrent-'));
  roots.push(root);
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  let submissions = 0;
  let finish!: (value: { ok: true; track: 'graph'; acceptanceId: string }) => void;
  const result = new Promise<{ ok: true; track: 'graph'; acceptanceId: string }>((resolve) => { finish = resolve; });
  const opts = { state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
    seatRequests: { root: () => root, submit: async () => { submissions++; return result; } },
  };
  const call = (text: string) => routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site', 'idempotency-key': 'concurrent' },
    body: JSON.stringify({ text }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  const first = call('@cmo 동시에');
  const second = call('@cmo 동시에');
  expect((await call('@cmo 다른 내용'))?.status).toBe(409);
  finish({ ok: true, track: 'graph', acceptanceId: 'receipt-concurrent' });
  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response?.status)).toEqual([202, 202]);
  expect(submissions).toBe(1);
});
