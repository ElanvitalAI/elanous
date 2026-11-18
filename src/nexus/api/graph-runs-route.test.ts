import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphRunHost } from '../../graph-runner/graph-run-host.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { registerAuthPeerAddress } from './meta-api.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const auth = { authorization: 'Bearer owner-token', 'content-type': 'application/json' };
const json = { 'content-type': 'application/json' };
const sameOrigin = { ...json, origin: 'http://nexus.test', 'sec-fetch-site': 'same-origin' };
const LOOPBACK = '127.0.0.1';

function fixture(metaApi: unknown = { bearerToken: 'owner-token', noAuth: false }, members: unknown = null) {
  const root = mkdtempSync(join(tmpdir(), 'graph-runs-route-'));
  roots.push(root);
  const finish: Array<() => void> = [];
  const started: string[] = [];
  const host = createGraphRunHost({ root, resolveGraphFile: id => id === 'build' ? '/graphs/build.yaml' : undefined,
    run: (_file, options) => { started.push(options.runId!); return new Promise<void>(resolve => { finish.push(resolve); }); } });
  const opts = { metaApi, graphRuns: { host }, membersApi: members } as unknown as NexusHttpServerOpts;
  const call = (path: string, init: RequestInit = {}, peer?: string) => {
    const request = new Request(`http://nexus.test${path}`, init);
    if (peer) registerAuthPeerAddress(request, peer);
    return routeRequest(request, opts, {} as never, null, createDevProxyRuntimeRef());
  };
  return { call, finish, started };
}
const post = (body: unknown, headers: Record<string, string> = auth) => ({ method: 'POST', headers, body: JSON.stringify(body) });
const seatBody = { graphId: 'build', origin: { kind: 'seat', seat: 'SEAT-A' } };

test('POST answers 202 with a runId while the run is still going; every POST is a new run', async () => {
  const { call, finish, started } = fixture();
  const first = await call('/v1/graph-runs', post(seatBody));
  expect(first!.status).toBe(202);
  const one = await first!.json() as { runId: string; status: string };
  expect(one.status).toBe('started');
  const two = await (await call('/v1/graph-runs', post(seatBody)))!.json() as { runId: string };
  expect(two.runId).not.toBe(one.runId);
  await Promise.resolve();
  expect(started).toEqual([one.runId, two.runId]);
  for (const done of finish) done();
});

test('only a real bearer starts a run: no token, wrong token, same-origin headers, a loopback peer, a member session and noAuth are all 401 and start nothing', async () => {
  const members = { handle: async () => Response.json({ member: { id: 'member-1' }, appSlot: { appSlug: 'app-one' } }) };
  const strict = fixture(undefined, members);
  const refusals = [
    strict.call('/v1/graph-runs', post(seatBody, json)),
    strict.call('/v1/graph-runs', post(seatBody, { ...json, authorization: 'Bearer wrong-token' })),
    strict.call('/v1/graph-runs', post(seatBody, sameOrigin)),
    strict.call('/v1/graph-runs', post(seatBody, sameOrigin), LOOPBACK),
    strict.call('/v1/graph-runs', post({ graphId: 'build', origin: { kind: 'human' } }, { ...json, authorization: 'Bearer member-session' })),
  ];
  for (const refused of refusals) expect((await refused)!.status).toBe(401);
  expect(strict.started).toEqual([]);
  const open = fixture({ bearerToken: 'owner-token', noAuth: true });
  expect((await open.call('/v1/graph-runs', post(seatBody, json)))!.status).toBe(401);
  expect(open.started).toEqual([]);
});

test('with a bearer: a human origin, a retry key or any other field, an unknown graph and a bad body are refused and start nothing', async () => {
  const { call, started } = fixture();
  const status = async (body: unknown) => (await call('/v1/graph-runs', post(body)))!.status;
  expect(await status({ graphId: 'build', origin: { kind: 'human' } })).toBe(400);
  expect(await status({ ...seatBody, idempotencyKey: 'k' })).toBe(400);
  expect(await status({ ...seatBody, extra: true })).toBe(400);
  expect(await status({ graphId: 'build', origin: { kind: 'seat', ownerId: 'owner-1' } })).toBe(400);
  expect(await status({ graphId: 'build', origin: { kind: 'graph', parentRunId: 'run-a', parentNodeId: 'node-b', extra: 'x' } })).toBe(400);
  expect(await status({ graphId: 'nope', origin: { kind: 'seat' } })).toBe(404);
  expect(await status({ graphId: 'build', origin: { kind: 'graph', parentRunId: 'only-run' } })).toBe(400);
  expect((await call('/v1/graph-runs', { method: 'POST', headers: auth, body: 'not json' }))!.status).toBe(400);
  expect(started).toEqual([]);
});

test('this stage has no read and no cancel: GET and DELETE are not a success for a bearer, and the run keeps going', async () => {
  const { call, started } = fixture();
  const run = await (await call('/v1/graph-runs', post(seatBody)))!.json() as { runId: string };
  for (const method of ['GET', 'DELETE']) {
    const response = await call(`/v1/graph-runs/${run.runId}`, { method, headers: auth });
    expect(response?.ok ?? false).toBe(false);
  }
  const collection = await call('/v1/graph-runs', { method: 'GET', headers: auth });
  expect(collection?.ok ?? false).toBe(false);
  expect(started).toEqual([run.runId]);
});
