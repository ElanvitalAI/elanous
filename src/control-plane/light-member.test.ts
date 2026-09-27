import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runLightMember } from './light-member.js';
import { writeMachineProfile } from '../roles/machine-profile.js';

type RequestRow = { path: string; body: Record<string, unknown>; authorization: string | null; method: string };
const roots: string[] = [];
const credential = 'a'.repeat(64);
function joined(): string {
  const dir = mkdtempSync(join(tmpdir(), 'light-member-'));
  roots.push(dir);
  mkdirSync(join(dir, 'control'));
  writeFileSync(join(dir, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'node-b', token: credential }), { mode: 0o600 });
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('two ticks register joined machine and image, then heartbeat failed probe without deleting records', async () => {
  const root = joined();
  const calls: RequestRow[] = [];
  const stop = new AbortController();
  let probes = 0;
  const result = await runLightMember({
    root, resources: [{ kind: 'image', name: 'registry', url: 'http://127.0.0.1:5050' }], intervalMs: 1,
    signal: stop.signal, now: () => 1234,
    probe: async () => ++probes === 1,
    fetch: async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, method: init!.method!, authorization: new Headers(init!.headers).get('authorization'),
        body: JSON.parse(init!.body as string) });
      if (calls.length === 4) stop.abort();
      return Response.json({});
    },
  });
  expect(result.machine).toBe('node-b');
  expect(calls.map(call => call.path)).toEqual([
    '/v1/resources/register', '/v1/resources/register', '/v1/resources/machine%3Amsb1/heartbeat',
    '/v1/resources/image%3Amsb1%3Aregistry/heartbeat',
  ]);
  expect(calls.every(call => call.method === 'POST' && call.authorization === `Bearer ${credential}`)).toBe(true);
  expect(calls[0]!.body).toMatchObject({ kind: 'machine', machine: 'node-b', attrs: { load: { observedAt: 1234 } }, ttlMs: 600_000 });
  expect(Object.keys(calls[0]!.body.attrs as object)).toEqual(['load']);
  expect(calls[1]!.body).toMatchObject({ kind: 'image', name: 'registry', machine: 'node-b', endpoint: 'http://127.0.0.1:5050/', attrs: { reachable: true, bind: 'loopback' } });
  expect(calls[3]!.body).toEqual({ attrs: { reachable: false, bind: 'loopback' } });
  expect(probes).toBe(2);
  expect(JSON.stringify(calls.map(call => call.body))).not.toContain(credential);
});

test('profile duties and seat ranks ride on machine registration and heartbeat', async () => {
  const root = joined();
  writeMachineProfile({ id: 'node-b', duties: ['compute', 'character'], seats: { control: { rank: 2 } } }, root);
  const attrs: unknown[] = [];
  const stop = new AbortController();
  await runLightMember({ root, resources: [], intervalMs: 1, signal: stop.signal,
    fetch: async (_input, init) => {
      attrs.push(JSON.parse(init!.body as string).attrs);
      if (attrs.length === 2) stop.abort();
      return Response.json({});
    },
  });
  for (const row of attrs) expect(row).toMatchObject({ duties: ['compute', 'character'], seats: { control: { rank: 2 } } });
});

test('joined member refuses conflicting profile before posting registration', async () => {
  const root = joined();
  writeFileSync(join(root, 'control', 'machine.json'), JSON.stringify({ id: 'demo', duties: ['edge'], seats: { control: { rank: 1 } } }));
  let posts = 0;
  await expect(runLightMember({ root, resources: [], once: true, fetch: async () => { posts++; return Response.json({}); } }))
    .rejects.toThrow('machine id demo differs from joined machine node-b');
  expect(posts).toBe(0);
});

test('mixed-case join refuses a lowercased profile instead of registering a different machine id', async () => {
  const root = joined();
  writeFileSync(join(root, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'MSB1', token: credential }), { mode: 0o600 });
  writeFileSync(join(root, 'control', 'machine.json'), JSON.stringify({ id: 'node-b', duties: ['compute'], seats: {} }));
  let posts = 0;
  await expect(runLightMember({ root, resources: [], once: true, fetch: async () => { posts++; return Response.json({}); } }))
    .rejects.toThrow('machine id node-b differs from joined machine MSB1');
  expect(posts).toBe(0);
});

test('machine heartbeat observes an updated profile without a member restart', async () => {
  const root = joined();
  const attrs: Array<Record<string, unknown>> = [];
  const stop = new AbortController();
  await runLightMember({ root, resources: [], intervalMs: 1, signal: stop.signal,
    fetch: async (_input, init) => {
      attrs.push(JSON.parse(init!.body as string).attrs);
      if (attrs.length === 1) writeMachineProfile({ id: 'node-b', duties: ['edge'], seats: { control: { rank: 3 } } }, root);
      if (attrs.length === 2) stop.abort();
      return Response.json({});
    },
  });
  expect(Object.keys(attrs[0]!)).toEqual(['load']);
  expect(attrs[1]).toMatchObject({ duties: ['edge'], seats: { control: { rank: 3 } } });
});

test('member stops posting after a profile changes to a conflicting id', async () => {
  const root = joined();
  const stop = new AbortController();
  const posts: string[] = [];
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    events.push({ category, event, data });
    if (category === 'control.light-member' && event === 'heartbeat-failed') stop.abort();
  });
  try {
    await runLightMember({ root, resources: [], intervalMs: 1, signal: stop.signal,
      fetch: async (input) => {
        posts.push(new URL(String(input)).pathname);
        writeFileSync(join(root, 'control', 'machine.json'), JSON.stringify({ id: 'demo', duties: ['edge'], seats: { control: { rank: 1 } } }));
        return Response.json({});
      },
    });
    expect(posts).toEqual(['/v1/resources/register']);
    expect(events).toContainEqual({ category: 'control.light-member', event: 'heartbeat-failed', data: { reason: 'machine id demo differs from joined machine node-b' } });
  } finally { log.mockRestore(); }
});

test('retries coordinator failures with a reason-only changed log and re-registers missing records', async () => {
  const root = joined();
  const stop = new AbortController();
  const events: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  const paths: string[] = [];
  try {
    await runLightMember({ root, resources: [], intervalMs: 1, signal: stop.signal,
      fetch: async (input) => {
        paths.push(new URL(String(input)).pathname);
        if (paths.length === 4) stop.abort();
        return paths.length <= 2 ? new Response(null, { status: 503 })
          : paths.length === 3 ? new Response(null, { status: 404 }) : Response.json({});
      },
    });
    expect(paths).toEqual(['/v1/resources/register', '/v1/resources/register', '/v1/resources/register', '/v1/resources/register']);
    expect(events).toEqual([
      { category: 'control.light-member', event: 'heartbeat-failed', data: { reason: 'http-503' } },
      { category: 'control.light-member', event: 'heartbeat-failed', data: { reason: 'http-404' } },
    ]);
    expect(JSON.stringify(events)).not.toContain(credential);
  } finally { log.mockRestore(); }
});

test('heartbeat 404 re-registers the joined resource on the next tick', async () => {
  const root = joined();
  const stop = new AbortController();
  const paths: string[] = [];
  let recovered: unknown;
  await runLightMember({ root, intervalMs: 1, signal: stop.signal,
    resources: [{ kind: 'image', name: 'registry', url: 'http://127.0.0.1:5050' }], probe: async () => true,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (paths.length === 6) { recovered = JSON.parse(init!.body as string); stop.abort(); }
      if (paths.length === 4) return new Response(null, { status: 404 });
      return Response.json({});
    },
  });
  expect(paths).toEqual(['/v1/resources/register', '/v1/resources/register',
    '/v1/resources/machine%3Amsb1/heartbeat', '/v1/resources/image%3Amsb1%3Aregistry/heartbeat',
    '/v1/resources/machine%3Amsb1/heartbeat', '/v1/resources/register']);
  expect(recovered).toMatchObject({ machine: 'node-b', name: 'registry' });
});

test('default probe GETs each URL with a deadline and records HTTP failure as unreachable', async () => {
  const root = joined();
  const requests: Array<{ url: string; method: string | undefined; signal: AbortSignal | undefined }> = [];
  const probeFetch = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    requests.push({ url: String(input), method: init?.method, signal: init?.signal ?? undefined });
    return new Response(null, { status: 503 });
  }) as typeof fetch);
  const registrations: Array<Record<string, unknown>> = [];
  try {
    await runLightMember({ root, once: true, resources: [{ kind: 'image', name: 'registry', url: 'http://127.0.0.1:5050' }],
      fetch: async (_input, init) => {
        registrations.push(JSON.parse(init!.body as string));
        return Response.json({});
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'http://127.0.0.1:5050/', method: 'GET' });
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(registrations[1]).toMatchObject({ attrs: { reachable: false, bind: 'loopback' } });
  } finally { probeFetch.mockRestore(); }
});

test('Tailscale IPv6 /48 bind is tailnet in registration and result, neighboring /48 is other', async () => {
  const root = joined();
  const registrations: Array<Record<string, unknown>> = [];
  const result = await runLightMember({ root, once: true, resources: [
    { kind: 'image', name: 'tail6', url: 'http://[fd7a:115c:a1e0::42]:5050' },
    { kind: 'image', name: 'tail6-edge', url: 'http://[fd7a:115c:a1e0:ffff::1]:5050' },
    { kind: 'image', name: 'neighbor6', url: 'http://[fd7a:115c:a1e1::42]:5050' },
  ], probe: async () => true, fetch: async (_input, init) => {
    registrations.push(JSON.parse(init!.body as string));
    return Response.json({});
  } });
  expect(result.resources.map(resource => resource.bind)).toEqual(['tailnet', 'tailnet', 'other']);
  expect(registrations.slice(1).map(row => (row.attrs as { bind: string }).bind)).toEqual(['tailnet', 'tailnet', 'other']);
  expect(registrations.slice(1).every(row => row.machine === 'node-b')).toBe(true);
});

test('rejects absent machine join, and classifies tailnet versus other hosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-member-empty-'));
  roots.push(dir);
  await expect(runLightMember({ root: dir, resources: [], once: true })).rejects.toThrow('missing machine join');
  const root = joined();
  const result = await runLightMember({ root, once: true, resources: [
    { kind: 'image', name: 'tail', url: 'http://100.100.1.2:5050' },
    { kind: 'image', name: 'public', url: 'https://registry.example' },
  ], probe: async () => false, fetch: async () => Response.json({}) });
  expect(result.resources.map(resource => [resource.bind, resource.reachable])).toEqual([['tailnet', false], ['other', false]]);
});
