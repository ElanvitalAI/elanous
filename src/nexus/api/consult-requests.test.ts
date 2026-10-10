import { afterEach, expect, spyOn, test } from 'bun:test';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig, setUserConfigOverlay } from '../../user-config.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../../user-config.js';
import { roleForKind } from '../../domains/telegram-kind-route.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { ConsultLimiter, ConsultQueue, handleConsultPost, validateConsult } from '../../hooks/consult-intake.js';
import { routeRequest } from './http-server.js';

const roots: string[] = [];
afterEach(() => {
  setUserConfigOverlay(null);
  resetElanousConfigDir();
  resetUserConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
      send: (text: string, kind = 'ops-alert') => { notifications.push({ text, kind }); return true; },
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
  expect(notifications).toEqual([{ text: `📮 상담 문의 ${receipt.receiptId} · 홍길동(AX 연구소) · 관심 A\n앱에서 보기`, kind: 'ops-alert' }]);
  expect(JSON.stringify(notifications)).not.toContain(valid.contact);
  const routingConfig = { telegram: { channels: [] } } as unknown as UserConfig;
  expect(roleForKind(routingConfig, notifications[0]!.kind)).toBe('system');
  expect(roleForKind(routingConfig, 'alert')).toBe('report');

  const second = await call('/v1/consult-requests', 'POST', { ...valid, name: '김나래', org: undefined, kind: 'personal', interest: 'B' });
  expect(second?.status).toBe(202);
  const secondReceipt = await second!.json() as { receiptId: string; receivedAt: string };
  expect(secondReceipt.receiptId).not.toBe(receipt.receiptId);
  expect(notifications).toHaveLength(2);
  expect(notifications[1]).toEqual({ text: `📮 상담 문의 ${secondReceipt.receiptId} · 김나래(개인) · 관심 B\n앱에서 보기`, kind: 'ops-alert' });
  expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  const list = await call('/v1/consult-requests?limit=1');
  expect(list?.status).toBe(200);
  expect(await list!.json()).toEqual({ items: [{ ...secondReceipt, name: '김나래', org: null, kind: 'personal', interest: 'B' }] });
  const all = await (await call('/v1/consult-requests'))!.json() as { items: unknown[] };
  expect(all.items).toHaveLength(2);
  expect(JSON.stringify(all)).not.toContain(valid.contact);
});

test('default receipt path delivers exactly once to the configured OP Telegram channel, never to report or another surface', async () => {
  const { root, opts } = fixture();
  const liveOpts = { ...opts, consultRequests: { root: opts.consultRequests.root, now: opts.consultRequests.now } };
  setElanousConfigDir(root);
  resetUserConfig();
  const opToken = '10001:test-only-ops';
  const tradeToken = '20002:test-only-trade';
  setUserConfigOverlay(cfg => ({
    ...cfg,
    telegram: {
      ...cfg.telegram, enabled: true, botToken: opToken, allowedUsers: [303], homeChannel: 303,
      reportChannel: { botToken: tradeToken, chatId: 404 },
      channels: [
        { name: 'trade', botToken: tradeToken, chatId: 404, interactive: false, roles: ['report'] },
        { name: 'ops', botToken: opToken, chatId: 303, interactive: true, roles: ['system'] },
      ],
    },
  }));
  const deliveries: Array<{ url: string; method: string | undefined; body: Record<string, unknown> }> = [];
  let completeDelivery!: () => void;
  const delivered = new Promise<void>(resolve => { completeDelivery = resolve; });
  const network = spyOn(globalThis, 'fetch').mockImplementation((async (url: RequestInfo | URL, init?: RequestInit) => {
    deliveries.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    completeDelivery();
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch);
  try {
    const response = await routeRequest(new Request('http://localhost/v1/consult-requests', {
      method: 'POST', headers: { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(valid),
    }), liveOpts, { requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(202);
    const receipt = await response!.json() as { receiptId: string; receivedAt: string };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([delivered, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OP Telegram request not sent')), 3_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(deliveries).toEqual([{
      url: `https://api.telegram.org/bot${opToken}/sendMessage`, method: 'POST',
      body: { chat_id: 303, text: `📮 상담 문의 ${receipt.receiptId} · 홍길동(AX 연구소) · 관심 A\n앱에서 보기` },
    }]);
    expect(JSON.stringify(deliveries)).not.toContain(valid.contact);
    expect(readFileSync(join(root, 'consult-requests', 'requests.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)))
      .toEqual([{ ...valid, ...receipt }]);
  } finally {
    network.mockRestore();
  }
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
    [{ ...valid, org: 7 }, 'org'],
    [{ ...valid, name: 'n'.repeat(257) }, 'name'], [{ ...valid, org: 'o'.repeat(257) }, 'org'],
    [{ ...valid, contact: 'c'.repeat(513) }, 'contact'], [[], 'body'],
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

test('site intake and app receipt agree at each site field length boundary', async () => {
  const { root, notifications, call } = fixture();
  const queue = new ConsultQueue(root);
  const sitePost = (input: unknown) => handleConsultPost(new Request('http://localhost/v1/consult', {
    method: 'POST', body: JSON.stringify(input),
  }), { queue, limiter: new ConsultLimiter(), now: () => Date.parse('2026-10-02T06:00:00.000Z') });
  const boundary = { ...valid, name: 'n'.repeat(256), org: 'o'.repeat(256), contact: 'c'.repeat(512) };
  expect(validateConsult(boundary)).toMatchObject({ ok: true });
  const siteResponse = await sitePost(boundary);
  expect(siteResponse.status).toBe(202);
  const siteConsult = queue.entries(Date.parse('2026-10-02T06:00:00.000Z'))[0]!.consult;
  expect(siteConsult).toMatchObject(boundary);
  const response = await call('/v1/consult-requests', 'POST', siteConsult);
  expect(response?.status).toBe(siteResponse.status);
  const receipt = await response!.json() as { receiptId: string; receivedAt: string };
  expect(JSON.parse(readFileSync(join(root, 'consult-requests', 'requests.jsonl'), 'utf8').trim()))
    .toEqual({ ...siteConsult, ...receipt });
  expect(notifications).toHaveLength(1);
  expect(JSON.stringify(notifications)).not.toContain(siteConsult.contact);

  for (const field of ['name', 'org', 'contact'] as const) {
    const beyond = { ...boundary, [field]: `${boundary[field]}x` };
    expect(validateConsult(beyond)).toEqual({ ok: false, field });
    const site = await sitePost(beyond);
    expect(site.status).toBe(400);
    expect(await site.json()).toEqual({ error: 'invalid', field });
    const app = await call('/v1/consult-requests', 'POST', beyond);
    expect(app?.status).toBe(site.status);
    expect(await app!.json()).toEqual({ error: 'bad_request', field });
  }
  expect(queue.count()).toBe(1);
  expect(readFileSync(join(root, 'consult-requests', 'requests.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(1);
  expect(notifications).toHaveLength(1);
});

test('journal write failure does not accept or notify', async () => {
  const { root, notifications, call } = fixture();
  writeFileSync(join(root, 'consult-requests'), 'not a directory');
  const response = await call('/v1/consult-requests', 'POST', valid);
  expect(response?.status).toBe(503);
  expect(notifications).toEqual([]);
});

test('CS1 — the receipt answers at once even when the alert channel never answers (no self-call through sendOutbound)', async () => {
  const { opts, call } = fixture();
  let started = 0;
  opts.consultRequests.send = (() => { started += 1; return new Promise(() => {}); }) as never;
  const t0 = Date.now();
  const response = await call('/v1/consult-requests', 'POST', valid, 'same-origin');
  expect(response?.status).toBe(202);
  expect(Date.now() - t0).toBeLessThan(1_000);
  await Promise.resolve();
  expect(started).toBe(1);
  // sendOutbound is a synchronous curl to this daemon's own /v1/outbound — inside the daemon it blocks
  // the event loop until it times out (10-01: 25 s · unreachable · alert lost).
  const source = readFileSync(new URL('./consult-requests.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/import\s*\{[^}]*\bsendOutbound\b/);
  expect(source).not.toMatch(/import\s*\{[^}]*\brouteOutbound\b/);
  expect(source).toContain('sendTelegramReport(getUserConfig(), text, { markdown: false, kind })');
});
