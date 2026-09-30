import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { handleGraphApprovals } from './graph-approvals.js';

test('approval implementation types remain private to the handler module', () => {
  const source = readFileSync(new URL('./graph-approvals.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/export\s+interface\s+(?:GraphApprovalItem|GraphApprovalsDeps)\b/);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-approvals-'));
  roots.push(root);
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  const pending = {
    graphId: 'release-loop', runId: 'waiting', status: 'awaiting-approval', path: ['prepare', 'approve-publish'],
    nodes: [{ nodeId: 'prepare', ok: true, output: 'raw secret stdout\n{"outcome":"ready","summary":"Ready"}' }],
    pending: { nodeId: 'approve-publish', message: 'Publish?', since: '2026-09-29T00:00:00Z' },
  };
  writeFileSync(join(dir, 'waiting.json'), JSON.stringify(pending));
  writeFileSync(join(dir, 'done.json'), JSON.stringify({ ...pending, runId: 'done', pending: { ...pending.pending, decision: 'approved' } }));
  writeFileSync(join(dir, 'waiting.json.2.decision.json'), '{}');
  return { root, dir, pending };
}

function request(path: string, method = 'GET', body?: unknown, authorized = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request(`http://localhost${path}`, {
    method,
    headers: authorized ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false } },
  { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('pending runs only; structured recent values without stdout; newest first', async () => {
  const { root, dir, pending } = fixture();
  rmSync(join(dir, 'waiting.json.2.decision.json'));
  writeFileSync(join(dir, 'older.json'), JSON.stringify({ ...pending, runId: 'older', pending: { ...pending.pending, since: '2026-09-28T00:00:00Z' }, nodes: [] }));
  writeFileSync(join(dir, 'waiting.json.contexts'), '{}');
  writeFileSync(join(dir, 'many.json'), JSON.stringify({ ...pending, runId: 'many', pending: { ...pending.pending, since: '2026-09-27T00:00:00Z' },
    nodes: Array.from({ length: 6 }, (_, index) => ({ nodeId: `step-${index}`, ok: index !== 5, output: `stdout-${index}` })) }));
  const response = await handleGraphApprovals(new Request('http://localhost/v1/graph-approvals'), { root, authorize: () => true });
  expect(response.status).toBe(200);
  const { items } = await response.json() as { items: Array<Record<string, unknown>> };
  expect(items).toHaveLength(3);
  expect(items.map((item) => item.runId)).toEqual(['waiting', 'older', 'many']);
  expect(items[2]!.recent).toEqual(Array.from({ length: 5 }, (_, index) => ({ nodeId: `step-${index + 1}`, ok: index !== 4 })));
  expect(items[0]).toEqual({ graphId: 'release-loop', runId: 'waiting', nodeId: 'approve-publish', message: 'Publish?', since: pending.pending.since,
    path: pending.path, recent: [{ nodeId: 'prepare', ok: true, outcome: 'ready', summary: 'Ready' }] });
  expect(JSON.stringify(items)).not.toContain('raw secret stdout');
});

test('POST decides with runner claim, hides the run on next GET; 404/409/400 and owner authentication', async () => {
  const { root, dir } = fixture();
  const url = 'http://localhost/v1/graph-approvals/release-loop/waiting';
  const deps = {
    root,
    authorize: (req: Request) => req.headers.get('authorization') === 'Bearer owner-secret',
    authReason: (req: Request) => req.headers.get('authorization') === 'Bearer owner-secret' ? 'bearer-match' : undefined,
  };
  const call = (path: string, method = 'GET', body?: unknown, auth = true) => handleGraphApprovals(new Request(path, {
    method, headers: auth ? { authorization: 'Bearer owner-secret' } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), deps);
  expect((await call('http://localhost/v1/graph-approvals', 'GET', undefined, false)).status).toBe(401);
  expect((await call(url, 'POST', { decision: 'approved' }, false)).status).toBe(401);
  expect((await call(url, 'POST', { decision: 'yes' })).status).toBe(400);
  expect((await call('http://localhost/v1/graph-approvals/release-loop/missing', 'POST', { decision: 'approved' })).status).toBe(404);
  expect((await call('http://localhost/v1/graph-approvals/%2e%2e/waiting', 'POST', { decision: 'approved' })).status).toBe(404);
  rmSync(join(dir, 'waiting.json.2.decision.json'));
  expect((await call('http://localhost/v1/graph-approvals')).status).toBe(200);
  const approved = await call(url, 'POST', { decision: 'approved' });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ graphId: 'release-loop', runId: 'waiting', decision: 'approved' });
  expect(JSON.parse(readFileSync(join(dir, 'waiting.json.2.decision.json'), 'utf8'))).toMatchObject({ nodeId: 'approve-publish', decision: 'approved', decidedBy: 'pwa:bearer-match' });
  expect(JSON.parse(readFileSync(join(dir, 'waiting.json'), 'utf8')).pending.decision).toBeUndefined();
  await expect((await call('http://localhost/v1/graph-approvals')).json()).resolves.toEqual({ items: [] });
  expect((await call(url, 'POST', { decision: 'rejected' })).status).toBe(409);
});

test('HTTP dispatcher uses owner checkAuth for both routes', async () => {
  const { root, dir } = fixture();
  rmSync(join(dir, 'waiting.json.2.decision.json'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    expect((await request('/v1/graph-approvals', 'GET', undefined, false))?.status).toBe(401);
    expect((await request('/v1/graph-approvals/release-loop/waiting', 'POST', { decision: 'approved' }, false))?.status).toBe(401);
    expect((await (await request('/v1/graph-approvals'))?.json() as { items: unknown[] }).items).toHaveLength(1);
    const approved = await request('/v1/graph-approvals/release-loop/waiting', 'POST', { decision: 'approved' });
    expect(approved?.status).toBe(200);
    expect(await approved?.json()).toEqual({ graphId: 'release-loop', runId: 'waiting', decision: 'approved' });
    expect(await (await request('/v1/graph-approvals'))?.json()).toEqual({ items: [] });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});

test('a decision needs a bearer token: same-origin alone is refused with 403 and writes nothing', async () => {
  const { root, dir } = fixture();
  rmSync(join(dir, 'waiting.json.2.decision.json'));
  for (const authReason of ['same-origin', undefined]) {
    const response = await handleGraphApprovals(new Request('http://localhost/v1/graph-approvals/release-loop/waiting', {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    }), { root, authorize: () => true, authReason: () => authReason });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'pairing-required' });
  }
  expect(existsSync(join(dir, 'waiting.json.2.decision.json'))).toBe(false);
  const list = await handleGraphApprovals(new Request('http://localhost/v1/graph-approvals'), { root, authorize: () => true, authReason: () => 'same-origin' });
  expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
});

function sameOriginRequest(path: string, method = 'GET', body?: unknown, bearer = false) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request(`http://localhost${path}`, {
    method,
    headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost', ...(bearer ? { authorization: 'Bearer owner-secret' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false } },
  { requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('same-origin PWA: list passes, decision needs the paired token even though checkAuth reports same-origin first', async () => {
  const { root, dir } = fixture();
  rmSync(join(dir, 'waiting.json.2.decision.json'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    expect((await sameOriginRequest('/v1/graph-approvals'))?.status).toBe(200);
    const refused = await sameOriginRequest('/v1/graph-approvals/release-loop/waiting', 'POST', { decision: 'approved' });
    expect(refused?.status).toBe(403);
    expect(existsSync(join(dir, 'waiting.json.2.decision.json'))).toBe(false);
    const paired = await sameOriginRequest('/v1/graph-approvals/release-loop/waiting', 'POST', { decision: 'approved' }, true);
    expect(paired?.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'waiting.json.2.decision.json'), 'utf8'))).toMatchObject({ decision: 'approved', decidedBy: 'pwa:bearer-match' });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
});
