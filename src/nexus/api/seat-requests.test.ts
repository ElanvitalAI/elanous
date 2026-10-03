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
import type { CeoCommandDeps } from '../../seat-dispatch/ceo-commands.js';
import type { MessageEnvelope } from '../../msg/msg-store.js';
import { resolveAttachmentPath, saveAttachmentBlob } from '../../boot/attachment-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('HTTP router authenticates and accepts @E; GET returns the receipt and seat chips, @cfo is unknown', async () => {
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
    expect((await call('/v1/seat-requests', 'POST', { text: '@E 자료 정리' }, 'none'))?.status).toBe(401);
    const unknown = await call('/v1/seat-requests', 'POST', { text: '@cfo 자료 정리' });
    expect(unknown?.status).toBe(400);
    const rejected = await unknown!.json() as { error: string; seats: Array<{ id: string; title: string }> };
    expect(rejected.error).toBe('unknown-seat');
    expect(rejected.seats).toContainEqual({ id: 'MK', title: 'CMO' });
    const accepted = await call('/v1/seat-requests', 'POST', { text: '@E 자료 정리' }, 'same-origin');
    expect(accepted?.status).toBe(202);
    const receipt = await accepted!.json() as { receiptId: string; seat: string; queuedAt: string };
    expect(receipt.seat).toBe('E');
    expect(receipt.receiptId).toEqual(expect.any(String));
    expect(receipt.queuedAt).toEqual(expect.any(String));
    expect(receipt).toMatchObject({ attachments: 0, channel: 'unknown' });
    const listing = await call('/v1/seat-requests?seat=E&limit=1');
    expect(listing?.status).toBe(200);
    const list = await listing!.json() as { items: unknown[]; seats: unknown[] };
    expect(list.items).toEqual([{ receiptId: receipt.receiptId, seat: receipt.seat, queuedAt: receipt.queuedAt, text: '자료 정리', status: 'queued' }]);
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
  expect((await post({ text: '@invalid\n@E work' })).status).toBe(400);
  expect((await post({ text: '@CMO@other\n@E work' })).status).toBe(400);
  expect((await post({ seat: 'CMO', text: '  ' })).status).toBe(400);
  expect(inputs).toHaveLength(0);
  const res = await post({ seat: 'E', text: '한 장' });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ receiptId: 'receipt-1', seat: 'E', queuedAt: '2026-10-01T00:00:00.000Z', attachments: 0, channel: 'unknown' });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ text: '@E 한 장', track: 'graph', origin: { kind: 'external', ledgerSource: 'pwa', provider: 'other', reportTo: { channel: 'pwa' } } });
  expect((inputs[0]!.origin as { ref: string }).ref).toMatch(/^pwa:/);
  expect((await (await handleSeatRequests(new Request('http://localhost/v1/seat-requests?seat=E&limit=1'), deps)).json()).items)
    .toEqual([{ receiptId: 'receipt-1', seat: 'E', text: '한 장', queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
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
  const accepted = await call('POST', { text: '@E 기록 실패' });
  expect(accepted?.status).toBe(202);
  expect(await accepted!.json()).toEqual({ receiptId: 'receipt-1', seat: 'E', queuedAt: '2026-10-01T00:00:00.000Z', attachments: 0, channel: 'unknown' });
  expect(submissions).toBe(1);
  const listing = await call('GET');
  expect((await listing!.json()).items).toEqual([{ receiptId: 'receipt-1', seat: 'E', text: '기록 실패',
    queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
  const retry = await call('POST', { text: '@E 기록 실패' });
  expect(retry?.status).toBe(202);
  expect(await retry!.json()).toEqual({ receiptId: 'receipt-1', seat: 'E', queuedAt: '2026-10-01T00:00:00.000Z', attachments: 0, channel: 'unknown' });
  expect(submissions).toBe(1);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, 'seat-requests', 'outcomes', `${(JSON.parse(readFileSync(path, 'utf8').trim()) as { key: string }).key}.json`), 'utf8')).receiptId).toBe('receipt-1');
  const afterFlush = await call('GET');
  expect((await afterFlush!.json()).items).toHaveLength(1);
  const restarted = await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), { root: () => root });
  expect((await restarted.json()).items).toEqual([{ receiptId: 'receipt-1', seat: 'E', text: '기록 실패',
    queuedAt: '2026-10-01T00:00:00.000Z', status: 'queued' }]);
  const noHeader = await routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ text: '@E 기록 실패' }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect(noHeader?.status).toBe(202);
  expect((await noHeader!.json()).receiptId).toBe('receipt-2');
  expect(submissions).toBe(2);
  const repeatedNoHeader = await routeRequest(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ text: '@E 기록 실패' }),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect(repeatedNoHeader?.status).toBe(202);
  expect((await repeatedNoHeader!.json()).receiptId).toBe('receipt-3');
  expect(submissions).toBe(3);
  expect((await call('POST', { text: '@E 다른 내용' }))?.status).toBe(409);
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
    body: JSON.stringify({ text: '@E 불확실' }),
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
    ...(method === 'POST' ? { body: JSON.stringify({ text: '@E 나중에' }) } : {}),
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await call('POST'))?.status).toBe(503);
  clock = '2026-10-03T00:00:00.000Z';
  const accepted = await call('POST');
  expect(accepted?.status).toBe(202);
  const receipt = { receiptId: 'delayed-receipt', seat: 'E', queuedAt: initial, attachments: 0, channel: 'unknown' };
  expect(await accepted!.json()).toEqual(receipt);
  expect(refs[1]).toBe(refs[0]);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  const listing = await call('GET');
  expect(listing?.status).toBe(200);
  expect((await listing!.json()).items).toEqual([{ receiptId: receipt.receiptId, seat: receipt.seat, queuedAt: receipt.queuedAt, text: '나중에', status: 'queued' }]);
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
    method: 'POST', headers: { 'idempotency-key': 'retry-after-reject' }, body: JSON.stringify({ text: '@E 다시' }),
  }), deps);
  expect((await post()).status).toBe(503);
  const journal = join(root, 'seat-requests', 'requests.jsonl');
  expect(JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1)!).status).toBe('pending');
  expect((await post()).status).toBe(202);
  expect(writes).toBe(4);
  expect(attempts).toBe(2);
  expect((await (await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), deps)).json()).items)
    .toMatchObject([{ receiptId: 'recovered', seat: 'E', status: 'queued' }]);
});

test('stale rejected sidecar cannot hide a newer pending retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-stale-'));
  roots.push(root);
  const dir = join(root, 'seat-requests');
  mkdirSync(join(dir, 'outcomes'), { recursive: true });
  const key = createHash('sha256').update('client\0stale-sidecar').digest('hex');
  const old = { key, seat: 'E', text: '다시', queuedAt: 'old', status: 'rejected', ref: 'pwa:old' };
  const pending = { ...old, queuedAt: 'new', status: 'pending', ref: 'pwa:new' };
  writeFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify(old)}\n${JSON.stringify(pending)}\n`);
  writeFileSync(join(dir, 'outcomes', `${key}.json`), JSON.stringify(old));
  const get = await handleSeatRequests(new Request('http://localhost/v1/seat-requests'), { root: () => root });
  expect(get.status).toBe(200);
  expect((await get.json()).items).toEqual([]);
  let submissions = 0;
  const retry = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'stale-sidecar' }, body: JSON.stringify({ text: '@E 다시' }),
  }), { root: () => root, submit: async () => {
    submissions++;
    return { ok: true as const, track: 'graph' as const, acceptanceId: 'new-receipt' };
  } });
  expect(retry.status).toBe(202);
  expect(submissions).toBe(1);
});

test('PWA chip dispatches attachments to seat session, never intake; invalid ids write nothing, retries do not dispatch again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-ceo-'));
  roots.push(root);
  const stored: MessageEnvelope[] = [];
  const channel: string[] = [];
  let submitted = 0;
  const ceoDeps: CeoCommandDeps = {
    ownerId: null, replyTarget: 'acme/repo#20798', now: () => new Date('2026-10-02T03:30:00Z'),
    append: (message) => { stored.push(message); },
    runGh: async (_args, stdin) => { channel.push(stdin); return 0; },
  };
  const deps = {
    root: () => root, now: () => '2026-10-02T03:30:00.000Z', ceoDeps: () => ceoDeps,
    resolveAttachment: (id: string) => id === 'att-1' ? '/tmp/seat/att-1.jpg' : null,
    submit: async () => { submitted++; return { ok: true as const, track: 'graph' as const, acceptanceId: 'intake-receipt' }; },
  };
  const post = (body: object, key: string) => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body),
  }), deps);
  const missing = await post({ seat: 'COO', text: '현장 사진 보고 공지 초안', attachments: [
    { id: 'att-1', name: '현장.jpg', mediaType: 'image/jpeg', bytes: 123 }, { id: 'missing', name: '없음' },
  ] }, 'missing');
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'unknown-attachment', id: 'missing' });
  expect(stored).toHaveLength(0);
  expect(channel).toHaveLength(0);
  expect(submitted).toBe(0);
  expect(() => readFileSync(join(root, 'seat-requests', 'requests.jsonl'))).toThrow();
  for (const attachments of [null, {}, [{ name: 'missing' }], Array.from({ length: 5 }, () => ({ id: 'att-1' }))]) {
    expect((await post({ seat: 'COO', text: 'invalid', attachments }, `bad-${JSON.stringify(attachments)}`)).status).toBe(400);
  }
  expect(() => readFileSync(join(root, 'seat-requests', 'requests.jsonl'))).toThrow();
  const body = { seat: 'COO', text: '현장 사진 보고 공지 초안', attachments: [{ id: 'att-1', name: '현장.jpg', mediaType: 'image/jpeg', bytes: 123 }] };
  const accepted = await post(body, 'photo');
  expect(accepted.status).toBe(202);
  const receipt = await accepted.json() as { receiptId: string; seat: string; queuedAt: string; attachments: number; channel: string };
  expect(receipt).toMatchObject({ seat: 'OP', attachments: 1, channel: 'posted' });
  expect(stored).toMatchObject([{ from: 'CEO', to: 'OP', kind: 'ceo-task' }]);
  expect(stored[0]!.body).toMatch(/^현장 사진 보고 공지 초안\n첨부: 현장\.jpg — \/tmp\/seat\/att-1\.jpg\n요청: pwa:\S+$/);
  expect(channel).toEqual(['**[대표]** 2026-10-02 12:30 KST → OP · 현장 사진 보고 공지 초안 · 첨부 1 (PWA)']);
  expect(submitted).toBe(0);
  expect(await (await post(body, 'photo')).json()).toEqual(receipt);
  const retryWithoutFile = { ...deps, resolveAttachment: (_id: string) => null };
  expect(await (await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'photo' }, body: JSON.stringify(body),
  }), retryWithoutFile)).json()).toEqual(receipt);
  expect((await post({ ...body, attachments: [] }, 'photo')).status).toBe(409);
  expect(stored).toHaveLength(1);
  expect(channel).toHaveLength(1);
  expect((await post({ seat: 'CTO', text: '확인' }, 'no-photo')).status).toBe(202);
  expect(stored.at(-1)).toMatchObject({ to: 'TC' });
  expect(stored.at(-1)!.body).toMatch(/^확인\n요청: pwa:\S+$/);
  expect((await post({ seat: 'E', text: '그 밖' }, 'other')).status).toBe(202);
  expect(submitted).toBe(1);
  const other = await post({ seat: 'E', text: '그 밖', attachments: [{ id: 'att-1', name: '현장.jpg' }] }, 'other');
  // Intake carries text only — a non-CEO seat with attachments is refused before anything is written.
  expect(other.status).toBe(400);
  expect(await other.json()).toEqual({ error: 'attachments-unsupported', seat: 'E' });
  expect(submitted).toBe(1);
});

test('four attachment IDs resolve before any journal write; missing and malformed IDs leave no intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-four-attachments-'));
  roots.push(root);
  const events: string[] = [];
  const deps = {
    root: () => root,
    resolveAttachment: (id: string) => {
      events.push(`resolve:${id}`);
      return id === 'missing' ? null : `/tmp/seat/${id}.jpg`;
    },
    append: (_path: string, entry: object) => { events.push(`write:${JSON.stringify(entry)}`); },
    dispatch: async (_seat: string, _text: string, _ceoDeps: CeoCommandDeps, extra?: { attachments?: Array<{ name: string; path: string }> }) => {
      events.push(`dispatch:${JSON.stringify(extra?.attachments)}`);
      return { reply: 'received', channel: 'posted' as const };
    },
    ceoDeps: () => ({ ownerId: null, replyTarget: null, append: () => {}, runGh: async () => 0 }),
  };
  const post = (ids: string[], key: string) => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': key },
    body: JSON.stringify({ seat: 'COO', text: '자료 확인', attachments: ids.map((id) => ({ id, name: `${id}.jpg` })) }),
  }), deps);
  const missing = await post(['one', 'two', 'three', 'missing'], 'missing-last');
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'unknown-attachment', id: 'missing' });
  expect(events).toEqual(['resolve:one', 'resolve:two', 'resolve:three', 'resolve:missing']);
  expect((await post(['one', ' ', 'three'], 'blank-id')).status).toBe(400);
  expect((await post(['one', 'two', 'three', 'four', 'five'], 'too-many')).status).toBe(400);
  expect(events).toEqual(['resolve:one', 'resolve:two', 'resolve:three', 'resolve:missing']);
  expect(() => readFileSync(join(root, 'seat-requests', 'requests.jsonl'))).toThrow();
  const response = await post(['one', 'two', 'three', 'four'], 'four');
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ seat: 'OP', attachments: 4 });
  expect(events.slice(4, 8)).toEqual(['resolve:one', 'resolve:two', 'resolve:three', 'resolve:four']);
  expect(events[8]).toStartWith('write:');
  expect(events[9]).toBe('dispatch:[{"name":"one.jpg","path":"/tmp/seat/one.jpg"},{"name":"two.jpg","path":"/tmp/seat/two.jpg"},{"name":"three.jpg","path":"/tmp/seat/three.jpg"},{"name":"four.jpg","path":"/tmp/seat/four.jpg"}]');
});

test('idempotency compares attachment IDs on in-flight and queued requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-attachment-key-'));
  roots.push(root);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const deps = {
    root: () => root,
    resolveAttachment: (id: string) => `/tmp/${id}`,
    dispatch: async () => {
      calls++;
      entered();
      await wait;
      return { reply: 'received', channel: 'posted' as const };
    },
    ceoDeps: () => ({ ownerId: null, replyTarget: null, append: () => {}, runGh: async () => 0 }),
  };
  const post = (ids: string[]) => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'attachment-key' },
    body: JSON.stringify({ seat: 'COO', text: '같은 요청', attachments: ids.map((id) => ({ id })) }),
  }), deps);
  const first = post(['one', 'two']);
  await dispatched;
  const same = post(['one', 'two']);
  const conflict = await post(['two', 'one']);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: 'idempotency-conflict' });
  release();
  expect((await first).status).toBe(202);
  expect((await same).status).toBe(202);
  expect((await post(['one', 'three'])).status).toBe(409);
  expect((await post(['one', 'two'])).status).toBe(202);
  expect(calls).toBe(1);
});

test('real uploaded attachment id resolves to the stored file before PWA seat dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-upload-'));
  roots.push(root);
  const uploaded = await saveAttachmentBlob({ blob: new Blob(['photo'], { type: 'image/jpeg' }), filename: 'photo.jpg', baseDir: root });
  expect(uploaded.ok).toBe(true);
  if (!uploaded.ok) return;
  const messages: MessageEnvelope[] = [];
  const res = await handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', body: JSON.stringify({ seat: 'COO', text: '사진 확인', attachments: [{ id: uploaded.entry.id, name: 'photo.jpg', mediaType: 'image/jpeg', bytes: 5 }] }),
  }), { root: () => root, resolveAttachment: (id) => resolveAttachmentPath(id, root),
    ceoDeps: () => ({ ownerId: null, replyTarget: 'acme/repo#20798', append: (message) => { messages.push(message); }, runGh: async () => 0 }) });
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ seat: 'OP', attachments: 1, channel: 'posted' });
  expect(messages[0]?.body.startsWith(`사진 확인\n첨부: photo.jpg — ${uploaded.entry.path}\n요청: pwa:`)).toBe(true);
});

test('PWA gh failure still returns 202 and a channelError with the seat message delivered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-gh-failed-'));
  roots.push(root);
  const stored: MessageEnvelope[] = [];
  const deps = { root: () => root,
    ceoDeps: () => ({ ownerId: null, replyTarget: 'acme/repo#20798',
      append: (message: MessageEnvelope) => { stored.push(message); }, runGh: async () => 1 }),
  };
  const post = () => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'gh-failure' }, body: JSON.stringify({ seat: 'CTO', text: '점검' }),
  }), deps);
  const result = await post();
  expect(result.status).toBe(202);
  const receipt = await result.json();
  expect(receipt).toMatchObject({ seat: 'TC', attachments: 0, channel: 'failed', channelError: 'gh 종료 코드 1' });
  expect(stored).toMatchObject([{ from: 'CEO', to: 'TC', kind: 'ceo-task' }]);
  expect(stored[0]!.body).toMatch(/^점검\n요청: pwa:\S+$/);
  expect(await (await post()).json()).toEqual(receipt);
  expect(stored).toHaveLength(1);
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
  const first = call('@E 동시에');
  const second = call('@E 동시에');
  expect((await call('@E 다른 내용'))?.status).toBe(409);
  finish({ ok: true, track: 'graph', acceptanceId: 'receipt-concurrent' });
  const responses = await Promise.all([first, second]);
  expect(responses.map((response) => response?.status)).toEqual([202, 202]);
  expect(submissions).toBe(1);
});

test('crash after the seat message but before the journal outcome: retry with the same key does not deliver twice', async () => {
  const { dispatchCeoTask } = await import('../../seat-dispatch/ceo-commands.js');
  const root = mkdtempSync(join(tmpdir(), 'seat-crash-'));
  roots.push(root);
  const stored: MessageEnvelope[] = [];
  let crashOnce = true;
  const deps = {
    root: () => root,
    // The first dispatch delivers and then «dies» before the outcome is journaled; the pending intent stays.
    dispatch: async (...args: Parameters<typeof dispatchCeoTask>) => {
      const result = await dispatchCeoTask(...args);
      if (crashOnce) { crashOnce = false; throw new Error('process died'); }
      return result;
    },
    ceoDeps: () => ({ ownerId: null, replyTarget: 'acme/repo#20798', runGh: async () => 0,
      append: (message: MessageEnvelope) => { stored.push(message); },
      hasMessage: (seat: string, ref: string) => stored.some((m) => m.to === seat && m.body.endsWith(`\n요청: ${ref}`)) }),
  };
  const post = () => handleSeatRequests(new Request('http://localhost/v1/seat-requests', {
    method: 'POST', headers: { 'idempotency-key': 'crash-key' }, body: JSON.stringify({ seat: 'COO', text: '점검' }),
  }), deps);
  expect((await post()).status).toBe(503);
  expect(stored).toHaveLength(1);
  const retry = await post();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({ seat: 'OP', channel: 'unknown' });
  expect(stored).toHaveLength(1);
});
