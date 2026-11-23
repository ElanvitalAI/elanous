import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsCore, type ElsResult } from './core.js';
import { emptyJournal } from './space.js';
import { parseRemoteRows } from './attach-view.js';
import { routeElsHttp } from './http.js';
import { createFederation } from './federation.js';
import { createServer, type Server } from 'node:http';
import { elsHostsPath, fetchHostJson, isTailnetOrLoopback, loadHostRegistry, type FederatedHost, type HostRegistry } from './hosts.js';
import { isAllowedBindAddress, parseHttpBind } from './http.js';
import type { ElsRequest } from './server.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const LOCAL_LS = JSON.stringify({ workspaces: [{ id: 'w1', name: 'HQ' }], tabs: [{ id: 't1' }],
  panes: [{ address: 'w1/t1/p1', workspace: 'HQ', tab: 't1', pane: 'p1', title: 'sh', cwd: '/work', state: 'idle' }] });

function federation(options: { local?: ElsResult; hosts?: FederatedHost[]; registry?: Partial<HostRegistry>; remote?: Record<string, (path: string) => { status: number; body: unknown } | Error> }) {
  const asked: ElsRequest[] = [];
  const registry: HostRegistry = { hosts: options.hosts ?? [], rejected: [], ...options.registry };
  const fed = createFederation({
    localHost: 'mshq',
    askLocal: async (request) => { asked.push(request); return options.local ?? { exitCode: 0, message: request.op === 'ls' ? LOCAL_LS : 'local screen' }; },
    registry,
    fetchJson: async (host, path) => {
      const answer = options.remote?.[host.name]?.(path) ?? new Error('fetch failed');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { fed, asked };
}

const hostA: FederatedHost = { name: 'host-a', baseUrl: 'http://host-a.tail.ts.net:8790' };
const hostB: FederatedHost = { name: 'host-b', baseUrl: 'http://100.64.0.9:8790' };
const odd: FederatedHost = { name: 'odd', baseUrl: 'http://100.64.0.10:8790' };

test('ls merges this host and the answering hosts; a host that fails or answers malformed stays as down', async () => {
  const { fed } = federation({ hosts: [hostA, hostB, odd], remote: {
    'host-a': () => ({ status: 200, body: { host: 'host-a', panes: [{ ws: 'w9', tab: 't9', pane: 'p9', title: 'pregate', cwd: '/gate', state: 'working' }] } }),
    'host-b': () => new Error('The operation timed out.'),
    odd: () => ({ status: 200, body: { host: 'odd', panes: [{ ws: 'w1' }] } }),
  } });
  const body = JSON.parse((await fed.list()).message) as { hosts: { name: string; reach: string; reason?: string }[]; panes: { address: string; reach: string }[] };
  expect(body.hosts.map((host) => [host.name, host.reach])).toEqual([['mshq', 'local'], ['host-a', 'up'], ['host-b', 'down'], ['odd', 'down']]);
  expect(body.hosts.find((host) => host.name === 'odd')?.reason).toBe('malformed answer');
  expect(body.panes.map((pane) => [pane.address, pane.reach])).toEqual([['mshq:w1/t1/p1', 'local'], ['host-a:w9/t9/p9', 'up']]);
});

test('seat travels through HTTP and federation without forwarding untrusted fields', async () => {
  const origin = { list: () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [], panes: [
    { address: 'w/t/p1', tab: 't', pane: 'p1', title: 'one', cwd: '/a', state: 'working', seat: 'OP', token: 'secret' },
    { address: 'w/t/p2', tab: 't', pane: 'p2', title: 'two', cwd: '/b', state: 'working', seat: 'TC' },
    { address: 'w/t/p3', tab: 't', pane: 'p3', title: 'shell', cwd: '/c', state: 'idle', seat: null },
    { address: 'w/t/p4', tab: 't', pane: 'p4', title: 'bad', cwd: '/d', state: 'idle', seat: 'OP\nFAKE' },
  ] }) }) } as unknown as ElsCore;
  const response = await routeElsHttp(origin, 'host-a', 'GET', '/els/ls');
  const body = JSON.parse(response.body);
  expect(body.panes.map((row: { seat?: string | null }) => row.seat)).toEqual(['OP', 'TC', null, undefined]);
  expect(response.body).not.toContain('secret');
  const { fed } = federation({ hosts: [hostA], remote: { 'host-a': () => ({ status: 200, body }) } });
  const rows = JSON.parse((await fed.list()).message).panes.filter((row: { host: string }) => row.host === 'host-a');
  expect(rows.map((row: { seat?: string | null }) => row.seat)).toEqual(['OP', 'TC', null, undefined]);
  expect(JSON.stringify(rows)).not.toContain('secret');
});

test('origin workspace role travels through HTTP and federation to remote rows, scoped to each host', async () => {
  const origin = { list: () => ({ exitCode: 0, message: JSON.stringify({
    workspaces: [{ id: 'a' }, { id: 'b', role: 'coordinator' }],
    panes: [
      { address: 'a/t/a1', tab: 't', pane: 'a1', title: 'OP', state: 'idle' },
      { address: 'b/t/b1', tab: 't', pane: 'b1', title: 'one', state: 'idle' },
      { address: 'b/t/b2', tab: 't', pane: 'b2', title: 'two', state: 'idle' },
    ],
  }) }) } as unknown as ElsCore;
  const response = await routeElsHttp(origin, 'host-a', 'GET', '/els/ls');
  expect(response.status).toBe(200);
  const originBody = JSON.parse(response.body) as { panes: { role?: string }[] };
  expect(originBody.panes.map((row) => row.role)).toEqual([undefined, 'coordinator', 'coordinator']);
  const { fed } = federation({ hosts: [hostA, hostB], remote: {
    'host-a': () => ({ status: 200, body: originBody }),
    'host-b': () => ({ status: 200, body: { host: 'host-b', panes: [
      { ws: 'b', tab: 't', pane: 'legacy', title: 'OP' },
      { ws: 'x', tab: 't', pane: 'invalid', role: 'other' },
    ] } }),
  } });
  const result = await fed.list();
  expect(result.exitCode).toBe(0);
  const rows = parseRemoteRows(result.message);
  expect(rows.map((row) => [row.wsId, row.role])).toEqual([
    ['host-a:b', 'coordinator'], ['host-a:b', 'coordinator'], ['host-a:a', undefined],
    ['host-b:b', undefined], ['host-b:x', undefined],
  ]);
  expect(rows.map((row) => row.pane)).toEqual(['host-a:b/t/b1', 'host-a:b/t/b2', 'host-a:a/t/a1', 'host-b:b/t/legacy', 'host-b:x/t/invalid']);
});

test('ls without a local server: with hosts the local host is down and the hosts are still listed; without hosts it is the stage-1 answer', async () => {
  const noServer = { exitCode: 1 as const, message: 'els: no els server is running — start it with `els serve`' };
  const withHosts = federation({ local: noServer, hosts: [hostA], remote: { 'host-a': () => ({ status: 200, body: { host: 'host-a', panes: [] } }) } });
  const listed = await withHosts.fed.list();
  expect(listed.exitCode).toBe(0);
  expect((JSON.parse(listed.message) as { hosts: { name: string; reach: string }[] }).hosts.map((host) => [host.name, host.reach]))
    .toEqual([['mshq', 'down'], ['host-a', 'up']]);
  expect(await federation({ local: noServer }).fed.list()).toEqual(noServer);
});

test('read: a bare ref and a local address go to the local server (the address names exactly that pane); a remote address goes to its host', async () => {
  const { fed, asked } = federation({ hosts: [hostA], remote: { 'host-a': (path) => path === '/els/read?address=w9%2Ft9%2Fp9'
    ? { status: 200, body: { screen: 'remote screen' } } : { status: 404, body: { error: 'unknown pane' } } } });
  expect((await fed.read('p1')).message).toBe('local screen');
  expect((await fed.read('mshq:w1/t1/p1')).message).toBe('local screen');
  expect((await fed.read('w1/t1/p1')).message).toBe('local screen');
  expect(asked.filter((request) => request.op === 'read')).toEqual([
    { op: 'read', pane: 'p1' },
    { op: 'read', pane: 'p1', at: { ws: 'w1', tab: 't1' } },
    { op: 'read', pane: 'p1', at: { ws: 'w1', tab: 't1' } },
  ]);
  expect(await fed.read('host-a:w9/t9/p9')).toEqual({ exitCode: 0, message: 'remote screen' });
  expect((await fed.read('host-a:w9/t9/p0')).message).toContain('unknown pane');
  expect((await fed.read('gone:w1/t1/p1')).message).toContain('not registered');
});

test('read on a host that does not answer says ? with the reason', async () => {
  const { fed } = federation({ hosts: [hostB], remote: { 'host-b': () => new Error('connect ECONNREFUSED') } });
  expect(await fed.read('host-b:w1/t1/p1')).toEqual({ exitCode: 1, message: 'els read: host-b ? connect ECONNREFUSED' });
});

test('hosts.json: only tailnet or loopback URLs; bad names, duplicates and public URLs are rejected with a reason; an unreadable file is a problem, not silence', () => {
  const state = mkdtempSync(join(tmpdir(), 'els-hosts-'));
  dirs.push(state);
  const path = elsHostsPath(state);
  expect(loadHostRegistry(path)).toEqual({ hosts: [], rejected: [] });
  mkdirSync(join(state, 'els'), { recursive: true });
  writeFileSync(path, JSON.stringify({ hosts: [
    { name: 'host-a', baseUrl: 'http://host-a.tail1234.ts.net:8790/x' },
    { name: 'host-b', baseUrl: 'http://100.100.1.2:8790' },
    { name: 'public', baseUrl: 'https://example.com' },
    { name: 'cgnat-edge', baseUrl: 'http://100.128.0.1:8790' },
    { name: 'bad name', baseUrl: 'http://127.0.0.1:1' },
    { name: 'host-a', baseUrl: 'http://127.0.0.1:2' },
  ] }));
  const registry = loadHostRegistry(path);
  expect(registry.hosts).toEqual([{ name: 'host-a', baseUrl: 'http://host-a.tail1234.ts.net:8790' }, { name: 'host-b', baseUrl: 'http://100.100.1.2:8790' }]);
  expect(registry.rejected).toEqual(['public: baseUrl is not a tailnet or loopback http(s) URL',
    'cgnat-edge: baseUrl is not a tailnet or loopback http(s) URL', 'hosts[4]: bad name', 'host-a: duplicate name']);
  writeFileSync(path, '{broken');
  expect(loadHostRegistry(path).problem).toContain('not JSON');
});

test('the read window binds only to loopback or tailnet addresses', () => {
  expect(parseHttpBind('127.0.0.1:8790')).toEqual({ host: '127.0.0.1', port: 8790 });
  expect(parseHttpBind('100.101.102.103:8790')).toEqual({ host: '100.101.102.103', port: 8790 });
  expect(parseHttpBind('[::1]:8790')).toEqual({ host: '::1', port: 8790 });
  expect(String(parseHttpBind('0.0.0.0:8790'))).toContain('not a loopback or tailnet');
  expect(String(parseHttpBind('192.168.1.5:8790'))).toContain('not a loopback or tailnet');
  expect(String(parseHttpBind('127.0.0.1:0'))).toContain('bad port');
  expect([isTailnetOrLoopback('100.63.255.255'), isTailnetOrLoopback('100.64.0.0'), isTailnetOrLoopback('100.127.255.255')]).toEqual([false, true, true]);
});

test('a remote answer without its host name, or with an address part that would not parse back, marks that host down', async () => {
  const { fed } = federation({ hosts: [hostA, hostB], remote: {
    'host-a': () => ({ status: 200, body: { panes: [{ ws: 'w1', tab: 't1', pane: 'p1' }] } }),
    'host-b': () => ({ status: 200, body: { host: 'host-b', panes: [{ ws: 'w1/x', tab: 't1', pane: 'p1' }] } }),
  } });
  const body = JSON.parse((await fed.list()).message) as { hosts: { name: string; reach: string; reason?: string }[]; panes: unknown[] };
  expect(body.hosts.map((host) => [host.name, host.reach, host.reason ?? ''])).toEqual([
    ['mshq', 'local', ''], ['host-a', 'down', 'malformed answer'], ['host-b', 'down', 'malformed answer']]);
  expect(body.panes).toHaveLength(1);
});

test('a registered host with this host\'s own name is rejected, never listed twice or read remotely', async () => {
  const self: FederatedHost = { name: 'mshq', baseUrl: 'http://127.0.0.1:9' };
  const { fed, asked } = federation({ hosts: [self, hostA], remote: { 'host-a': () => ({ status: 200, body: { host: 'host-a', panes: [] } }) } });
  const body = JSON.parse((await fed.list()).message) as { hosts: { name: string }[]; rejectedHosts: string[] };
  expect(body.hosts.map((host) => host.name)).toEqual(['mshq', 'host-a']);
  expect(body.rejectedHosts).toEqual(["mshq: is this host's own name"]);
  await fed.read('mshq:w1/t1/p1');
  expect(asked.at(-1)).toEqual({ op: 'read', pane: 'p1', at: { ws: 'w1', tab: 't1' } });
});

test('without a local server and without hosts, a hosts.json problem is still shown', async () => {
  const noServer = { exitCode: 1 as const, message: 'els: no els server is running' };
  const { fed } = federation({ local: noServer, registry: { problem: 'els hosts: /x/hosts.json is not JSON' } });
  const listed = await fed.list();
  expect(listed.exitCode).toBe(1);
  expect(listed.message.split('\n')).toEqual(['els: no els server is running', 'els hosts: /x/hosts.json is not JSON']);
});

test('the read window never binds to a DNS name; only loopback or tailnet IP literals', () => {
  expect(String(parseHttpBind('host-a.tail1234.ts.net:8790'))).toContain('DNS name');
  expect([isAllowedBindAddress('127.0.0.1'), isAllowedBindAddress('::1'), isAllowedBindAddress('100.64.1.1'),
    isAllowedBindAddress('0.0.0.0'), isAllowedBindAddress('a.tailnet')]).toEqual([true, true, true, false, false]);
});

test('fetching a host refuses a redirect and a name that resolves outside the tailnet', async () => {
  const server: Server = createServer((_req, res) => { res.writeHead(302, { location: 'https://example.com/els/ls' }); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await expect(fetchHostJson({ name: 'b', baseUrl: `http://127.0.0.1:${port}` }, '/els/ls', 2_000)).rejects.toThrow('redirect refused');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // An address outside the tailnet is refused before any connection (an IP literal: no DNS needed in the test).
  await expect(fetchHostJson({ name: 'pub', baseUrl: 'http://93.184.216.34' }, '/els/ls', 2_000)).rejects.toThrow('not a tailnet or loopback');
});

test('do: local goes to this host\'s owner; a remote address is posted to that host with «this host/seat» as the sender; failures say not sent', async () => {
  const posts: { host: string; path: string; payload: unknown }[] = [];
  const asked: ElsRequest[] = [];
  const answers: Record<string, { status: number; body: unknown } | Error> = {
    'host-a': { status: 200, body: { message: 'els do: p9 delivered 2 chars' } },
    'host-b': { status: 409, body: { error: 'els do: p9 already has 20 lines waiting, not queued' } },
    odd: new Error('timeout'),
  };
  const fed = createFederation({
    localHost: 'mshq',
    askLocal: async (request) => { asked.push(request); return { exitCode: 0, message: 'local ok' }; },
    registry: { hosts: [hostA, hostB, odd], rejected: [] },
    fetchJson: async () => { throw new Error('unused'); },
    postJson: async (host, path, payload) => {
      posts.push({ host: host.name, path, payload });
      const answer = answers[host.name]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  expect((await fed.do('w1/t1/p1', 'hi', 'OP')).message).toBe('local ok');
  expect(asked[0]).toEqual({ op: 'do', pane: 'p1', text: 'hi', from: 'OP', at: { ws: 'w1', tab: 't1' } });
  expect((await fed.do('p1', 'hi', 'OP'))).toEqual({ exitCode: 0, message: 'local ok' });
  expect(asked[1]).toEqual({ op: 'do', pane: 'p1', text: 'hi', from: 'OP' });
  const sent = await fed.do('host-a:w9/t9/p9', 'go', 'OP');
  expect(sent).toEqual({ exitCode: 0, message: 'els do: p9 delivered 2 chars' });
  expect(posts[0]).toEqual({ host: 'host-a', path: '/els/do', payload: { address: 'w9/t9/p9', text: 'go', from: 'mshq/OP' } });
  const full = await fed.do('host-b:w9/t9/p9', 'go', 'OP');
  expect(full.exitCode).toBe(1);
  expect(full.message).toContain('refused');
  const down = await fed.do('odd:w9/t9/p9', 'go', 'OP');
  expect(down.exitCode).toBe(1);
  expect(down.message).toContain('not sent');
  expect((await fed.do('nowhere:w9/t9/p9', 'go', 'OP')).message).toContain('not registered');
});

test('origin foreground kind survives the HTTP and federation listing', async () => {
  let journal = emptyJournal();
  const owner = createElsCore({ load: () => journal, save: value => { journal = value; },
    spawn: () => ({ id: 'fixture', pid: 42, isAlive: () => true, write() {}, kill() {}, renderScreen: async () => '', onExit() {} }),
    mailBadges: () => new Map() });
  owner.start();
  try {
    const created = JSON.parse(owner.newPane({ ws: 'W', cwd: '/test/seats/TC', command: ['sh'] }).message);
    owner.setForegrounds(new Map([[created.pane, { kind: 'codex', command: ['codex'], pid: 42 }]]));
    const origin = await routeElsHttp(owner, 'host-a', 'GET', '/els/ls');
    const { fed } = federation({ hosts: [hostA], remote: { 'host-a': () => ({ status: origin.status, body: JSON.parse(origin.body) }) } });
    const listed = JSON.parse((await fed.list()).message);
    const pane = listed.panes.find((row: { host: string }) => row.host === 'host-a');
    expect([pane.seat, pane.kind, pane.activityState]).toEqual(['TC', 'codex', 'idle']);
  } finally { owner.stopAll(); }
});
