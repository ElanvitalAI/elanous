import { expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { routeElsHttp, type ElsDoPolicy } from './http.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doPolicy } from './http.js';

function core() {
  let stored: SpaceJournal = emptyJournal();
  let alive = true;
  const pty: ElsPty = { id: 'pty_1', isAlive: () => alive, write: () => {}, renderScreen: async () => 'live screen\n', onExit: () => {}, kill: () => { alive = false; } };
  const owner = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => pty, now: () => 1_700_000_000_000 });
  owner.start();
  const created = JSON.parse(owner.newPane({ ws: 'HQ', cwd: '/work', command: ['sh'] }).message) as { address: string; pane: string };
  return { owner, address: created.address, stored: () => stored };
}

test('GET /els/ls lists this host and its panes from the owner journal', async () => {
  const { owner, address } = core();
  const answer = await routeElsHttp(owner, 'node-b', 'GET', '/els/ls');
  const [ws, tab, pane] = address.split('/');
  expect(answer.status).toBe(200);
  // #38986 — every ls row now carries a build badge (sha · age · the machine's DESIRED sha), which is the
  // badge feature's concern, not this read window's: the window still lists exactly this host's panes.
  const body = JSON.parse(answer.body) as { host: string; panes: ({ build?: unknown } & Record<string, unknown>)[] };
  const panes = body.panes.map(({ build, ...row }) => row);
  expect(body.host).toBe('node-b');
  expect(panes).toEqual([{ ws, tab, pane, title: 'sh', cwd: '/work', state: 'working', size: { cols: 80, rows: 24 }, activityState: 'idle', seat: null,
    badge: 'working', badgeLabel: '[▶ working]', stalled: false, lastEventAtMs: 1_700_000_000_000,
    status: { state: 'IDLE', since: 1_700_000_000_000, source: 'derived' } }]);
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


// Stage 5 — POST /els/new and POST /els/close: the `els do` door policy, not just for typing. A source outside
// do-allow.json is refused (403) and audited; a bad body is 400 + audited; an allowed source gets its pane made and
// closed by THIS host's owner. (The streaming /els/attach door is exercised end-to-end in src/cli/els-cli.test.ts.)
test('POST /els/new · /els/close: 403 + audit for a stranger, 400 for a bad body, made + closed for an allowed source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-http-new-'));
  mkdirSync(join(root, 'els'), { recursive: true });
  writeFileSync(join(root, 'els', 'do-allow.json'), JSON.stringify({ sources: ['100.64.0.7'] }));
  const core = {
    newPane: async (input: { ws: string; cwd: string; command: string[] }) => ({
      exitCode: 0,
      message: JSON.stringify({ pane: 'p_new_1', address: `${input.ws}/t1/p_new_1`, cwd: input.cwd }),
    }),
    paneExists: (ref: string) => (ref === 'p_new_1' ? 'p_new_1' : undefined),
    close: (paneId: string) => ({ exitCode: 0, message: `closed ${paneId}` }),
  } as unknown as Parameters<typeof routeElsHttp>[0];
  const stranger = await routeElsHttp(core, 'hostb', 'POST', '/els/new', {
    source: '100.64.1.9', policy: doPolicy(root),
    body: JSON.stringify({ ws: 'w1', cwd: '/work', command: ['sh'], from: 'hosta/test' }),
  });
  expect(stranger.status).toBe(403);
  expect((JSON.parse(stranger.body) as { error: string }).error).toBe('this source may not open panes here');
  const badBody = await routeElsHttp(core, 'hostb', 'POST', '/els/new', {
    source: '100.64.0.7', policy: doPolicy(root), body: 'not json',
  });
  expect(badBody.status).toBe(400);
  const audit = readFileSync(join(root, 'els', 'do-audit.jsonl'), 'utf8').trim().split('\n');
  expect(audit.some((line) => line.includes('"op":"new"') && line.includes('refused: source not in do-allow.json'))).toBe(true);
  expect(audit.some((line) => line.includes('"op":"new"') && line.includes('bad request: body is not JSON'))).toBe(true);
  // Now the sender's address is allowed: the pane is made by THIS host and closed by it.
  writeFileSync(join(root, 'els', 'do-allow.json'), JSON.stringify({ sources: ['100.64.0.7', '100.64.1.9'] }));
  const open = doPolicy(root);
  const made = await routeElsHttp(core, 'hostb', 'POST', '/els/new', {
    source: '100.64.1.9', policy: open,
    body: JSON.stringify({ ws: 'w1', cwd: '/work', command: ['sh'], from: 'hosta/test' }),
  });
  expect(made.status).toBe(200);
  expect((JSON.parse(made.body) as { pane: string }).pane).toBe('p_new_1');
  const closed = await routeElsHttp(core, 'hostb', 'POST', '/els/close', {
    source: '100.64.1.9', policy: open, body: JSON.stringify({ address: 'p_new_1', from: 'hosta/test' }),
  });
  expect(closed.status).toBe(200);
  expect((JSON.parse(closed.body) as { message: string }).message).toBe('closed p_new_1');
  const unknown = await routeElsHttp(core, 'hostb', 'POST', '/els/close', {
    source: '100.64.1.9', policy: open, body: JSON.stringify({ address: 'p_missing', from: 'hosta/test' }),
  });
  expect(unknown.status).toBe(404);
});
