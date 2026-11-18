import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { routeElsHttp, type ElsDoPolicy } from './http.js';
import { emptyJournal, type SpaceJournal } from './space.js';

function core() {
  let stored: SpaceJournal = emptyJournal();
  let alive = true;
  const pty: ElsPty = { id: 'pty_1', isAlive: () => alive, write: () => {}, renderScreen: async () => 'live screen\n', onExit: () => {}, kill: () => { alive = false; } };
  const owner = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => pty });
  owner.start();
  const created = JSON.parse(owner.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }).message) as { address: string; pane: string };
  return { owner, address: created.address, stored: () => stored };
}

test('GET /els/ls lists this host and its panes from the owner journal', async () => {
  const { owner, address } = core();
  const answer = await routeElsHttp(owner, 'node-b', 'GET', '/els/ls');
  const [ws, tab, pane] = address.split('/');
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body)).toEqual({ host: 'node-b', panes: [{ ws, tab, pane, title: 'sh', cwd: '/work', state: 'working' }] });
});

test('GET /els/read answers only for an address of this host that names exactly one pane', async () => {
  const { owner, address } = core();
  const [ws, tab, pane] = address.split('/');
  const read = (query: string) => routeElsHttp(owner, 'node-b', 'GET', `/els/read?address=${encodeURIComponent(query)}`);
  expect(await read(address)).toEqual({ status: 200, body: JSON.stringify({ screen: 'live screen\n' }) });
  expect((await read(`node-b:${address}`)).status).toBe(200);
  expect((await read(`mshq:${address}`)).status).toBe(400);
  expect((await read(`${ws}/${tab}/pdeadbeef`)).status).toBe(404);
  expect((await read(`wdeadbeef/${tab}/${pane}`)).status).toBe(404);
  expect((await read('not an address')).status).toBe(400);
});

test('the window is read-only and has no other paths', async () => {
  const { owner, stored } = core();
  const before = JSON.stringify(stored().panes.map((row) => [row.id, row.state]));
  expect((await routeElsHttp(owner, 'node-b', 'POST', '/els/ls')).status).toBe(405);
  expect((await routeElsHttp(owner, 'node-b', 'PUT', '/els/read?address=x')).status).toBe(405);
  expect((await routeElsHttp(owner, 'node-b', 'GET', '/els/send')).status).toBe(404);
  expect(JSON.stringify(stored().panes.map((row) => [row.id, row.state]))).toBe(before);
});

function policy(allowed: string[]) {
  const audit: Record<string, unknown>[] = [];
  const value: ElsDoPolicy = { allows: (source) => allowed.includes(source), audit: (entry) => { audit.push(entry); } };
  return { value, audit };
}

test('POST /els/do types into a pane only for an allowed source, and audits every attempt without the text', async () => {
  const { owner, address } = core();
  const { value, audit } = policy(['100.64.0.5']);
  const post = (source: string, body: unknown) => routeElsHttp(owner, 'node-b', 'POST', '/els/do', { source, body: typeof body === 'string' ? body : JSON.stringify(body), policy: value });
  const ok = await post('100.64.0.5', { address, text: 'secret text', from: 'mshq/OP' });
  expect(ok.status).toBe(200);
  expect((await post('100.64.0.9', { address, text: 'x', from: 'bad' })).status).toBe(403);
  expect((await post('100.64.0.5', 'not json')).status).toBe(400);
  expect((await post('100.64.0.5', { address: `mshq:${address}`, text: 'x', from: 'a' })).status).toBe(400);
  expect((await post('100.64.0.5', { address: 'wdeadbeef/tdeadbeef/pdeadbeef', text: 'x', from: 'a' })).status).toBe(404);
  expect(audit.map((row) => String(row.result).split(':')[0]!.split(' ')[0])).toEqual(['els', 'refused', 'bad', 'bad', 'unknown']);   // delivered · refused source · not JSON · other host's address · no such pane
  expect(JSON.stringify(audit)).not.toContain('secret text');
  expect(audit[0]).toMatchObject({ source: '100.64.0.5', from: 'mshq/OP', address, chars: 11 });
});

test('without a policy POST /els/do is still read-only (405)', async () => {
  const { owner, address } = core();
  expect((await routeElsHttp(owner, 'node-b', 'POST', '/els/do', { source: '100.64.0.5', body: JSON.stringify({ address, text: 'x', from: 'a' }) })).status).toBe(405);
});
