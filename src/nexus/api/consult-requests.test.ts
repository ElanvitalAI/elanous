import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest } from './http-server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'consult-requests-'));
  roots.push(root);
  const notifications: Array<{ text: string; kind: string }> = [];
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const opts = {
    state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
    consultRequests: {
      root: () => root, now: () => '2026-10-02T06:00:00.000Z',
      send: (text: string, kind = 'alert') => { notifications.push({ text, kind }); return true; },
    },
  };
  const call = (path: string, method = 'GET', body?: unknown, auth: 'owner' | 'same-origin' | 'none' | 'forged' = 'owner') => routeRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: auth === 'owner' ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }
        : auth === 'same-origin' || auth === 'forged'
          ? { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' }
          : { 'sec-fetch-site': 'cross-site' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), opts, { requestIP: () => ({ address: auth === 'same-origin' ? '127.0.0.1' : '203.0.113.1' }) } as never,
    null, createDevProxyRuntimeRef(),
  );
  return { root, opts, notifications, call };
}

const valid = { name: '홍길동', org: 'AX 연구소', kind: 'company', interest: 'A', contact: '010-0000-1234', consent: true };

test('authenticated POST records a private 0600 JSONL receipt and sends one contact-free alert; GET projects and limits items', async () => {
  const { root, notifications, call } = fixture();
  const first = await call('/v1/consult-requests', 'POST', valid, 'same-origin');
  expect(first?.status).toBe(202);
  const receipt = await first!.json() as { receiptId: string; receivedAt: string };
  expect(receipt).toEqual({ receiptId: expect.stringMatching(/^R-[a-f0-9-]+$/), receivedAt: '2026-10-02T06:00:00.000Z' });
  const path = join(root, 'consult-requests', 'requests.jsonl');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'consult-requests')).mode & 0o077).toBe(0);
  const journal = readFileSync(path, 'utf8').trimEnd().split('\n');
  expect(journal).toHaveLength(1);
  expect(JSON.parse(journal[0]!)).toEqual({ ...valid, ...receipt });
  expect(readdirSync(join(root, 'consult-requests'))).toEqual(['requests.jsonl']);
  expect(notifications).toEqual([{ text: `📮 상담 문의 ${receipt.receiptId} · 홍길동(AX 연구소) · 관심 A\n앱에서 보기`, kind: 'alert' }]);
  expect(JSON.stringify(notifications)).not.toContain(valid.contact);

  const second = await call('/v1/consult-requests', 'POST', { ...valid, name: '김나래', org: undefined, kind: 'personal', interest: 'B' });
  expect(second?.status).toBe(202);
  const secondReceipt = await second!.json() as { receiptId: string; receivedAt: string };
  expect(secondReceipt.receiptId).not.toBe(receipt.receiptId);
  expect(notifications).toHaveLength(2);
  expect(notifications[1]).toEqual({ text: `📮 상담 문의 ${secondReceipt.receiptId} · 김나래(개인) · 관심 B\n앱에서 보기`, kind: 'alert' });
  expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  const list = await call('/v1/consult-requests?limit=1');
  expect(list?.status).toBe(200);
  expect(await list!.json()).toEqual({ items: [{ ...secondReceipt, name: '김나래', org: null, kind: 'personal', interest: 'B' }] });
  const all = await (await call('/v1/consult-requests'))!.json() as { items: unknown[] };
  expect(all.items).toHaveLength(2);
  expect(JSON.stringify(all)).not.toContain(valid.contact);
});

test('owner authentication gates GET and POST before body parsing; forged same-origin cannot bypass', async () => {
  const { root, notifications, call, opts } = fixture();
  for (const auth of ['none', 'forged'] as const) {
    expect((await call('/v1/consult-requests', 'GET', undefined, auth))?.status).toBe(401);
    expect((await call('/v1/consult-requests', 'POST', valid, auth))?.status).toBe(401);
  }
  expect((await routeRequest(new Request('http://localhost/v1/consult-requests', {
    method: 'POST', headers: { authorization: 'Bearer owner-secret' }, body: JSON.stringify(valid),
  }), { ...opts, metaApi: undefined }, { requestIP: () => ({ address: '127.0.0.1' }) } as never,
  null, createDevProxyRuntimeRef()))?.status).toBe(401);
  expect(notifications).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test('missing fields, invalid consent and invalid limit return field-specific 400 without writing or sending', async () => {
  const { root, notifications, call } = fixture();
  const invalid: Array<[unknown, string]> = [
    [{ ...valid, name: '  ' }, 'name'], [{ ...valid, contact: undefined }, 'contact'],
    [{ ...valid, kind: 'other' }, 'kind'], [{ ...valid, interest: 'C' }, 'interest'],
    [{ ...valid, consent: undefined }, 'consent'], [{ ...valid, consent: false }, 'consent'],
    [{ ...valid, org: 7 }, 'org'], [[], 'body'],
  ];
  for (const [body, field] of invalid) {
    const res = await call('/v1/consult-requests', 'POST', body);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: 'bad_request', field });
  }
  for (const value of ['0', '-1', '101', '1.5', 'nope']) {
    const res = await call(`/v1/consult-requests?limit=${value}`);
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: 'bad_request', field: 'limit' });
  }
  expect(notifications).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test('journal write failure does not accept or notify', async () => {
  const { root, notifications, call } = fixture();
  writeFileSync(join(root, 'consult-requests'), 'not a directory');
  const response = await call('/v1/consult-requests', 'POST', valid);
  expect(response?.status).toBe(503);
  expect(notifications).toEqual([]);
});
