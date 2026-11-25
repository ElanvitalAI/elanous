// REMOTE-PANE-SIZE (대표 11-25 21:3x «why is the remote tab so small?»): a remote pane takes the viewer's pane area —
// at create (POST /els/new cols/rows), and on select/resize (POST /els/resize) — and `els ls` shows each PTY's size.
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { doPolicy, routeElsHttp } from './http.js';
import { createFederation } from './federation.js';
import { emptyJournal, type SpaceJournal } from './space.js';

function owner() {
  let stored: SpaceJournal = emptyJournal();
  const resizes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => 'screen\n', onExit: () => {}, kill: () => {},
    resize: (cols, rows) => { resizes.push(`${cols}x${rows}`); } };
  const core = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => pty, now: () => 1_700_000_000_000 });
  core.start();
  const root = mkdtempSync(join(tmpdir(), 'els-size-'));
  mkdirSync(join(root, 'els'), { recursive: true });
  writeFileSync(join(root, 'els', 'do-allow.json'), JSON.stringify({ sources: ['100.64.0.7'] }));
  return { core, resizes, root, policy: doPolicy(root) };
}

test('POST /els/new with cols/rows starts the remote PTY at the viewer pane area, and ls shows it', async () => {
  const { core, resizes, policy } = owner();
  const made = await routeElsHttp(core, 'node-b', 'POST', '/els/new', { source: '100.64.0.7', policy,
    body: JSON.stringify({ ws: 'T', cwd: '/w', command: ['sh'], from: 'mshq/OP', cols: 177, rows: 48 }) });
  expect(made.status).toBe(200);
  expect(resizes).toEqual(['177x48']);
  const ls = JSON.parse((await routeElsHttp(core, 'node-b', 'GET', '/els/ls')).body) as { panes: { size?: unknown }[] };
  expect(ls.panes[0]!.size).toEqual({ cols: 177, rows: 48 });
});

test('POST /els/resize resizes an allowed remote pane, refuses a stranger, and audits both', async () => {
  const { core, resizes, root, policy } = owner();
  const address = (JSON.parse(core.newPane({ ws: 'T', cwd: '/w', command: ['sh'] }).message) as { address: string }).address;
  const stranger = await routeElsHttp(core, 'node-b', 'POST', '/els/resize', { source: '100.64.9.9', policy,
    body: JSON.stringify({ address, cols: 120, rows: 36, from: 'mshq/OP' }) });
  expect(stranger.status).toBe(403);
  const ok = await routeElsHttp(core, 'node-b', 'POST', '/els/resize', { source: '100.64.0.7', policy,
    body: JSON.stringify({ address: `node-b:${address}`, cols: 200, rows: 50, from: 'mshq/OP' }) });
  expect(ok).toEqual({ status: 200, body: JSON.stringify({ message: '200x50' }) });
  expect(resizes).toEqual(['200x50']);
  const tiny = await routeElsHttp(core, 'node-b', 'POST', '/els/resize', { source: '100.64.0.7', policy,
    body: JSON.stringify({ address, cols: 0, rows: 0, from: 'mshq/OP' }) });
  expect(tiny.status).toBe(400);
  const missing = await routeElsHttp(core, 'node-b', 'POST', '/els/resize', { source: '100.64.0.7', policy,
    body: JSON.stringify({ address: 'w_x/t_x/p_x', cols: 120, rows: 36, from: 'mshq/OP' }) });
  expect(missing.status).toBe(404);
  const audit = readFileSync(join(root, 'els', 'do-audit.jsonl'), 'utf8');
  expect(audit).toContain('"op":"resize"');
  expect(audit).toContain('refused: source not in do-allow.json');
});

test('federation: new --host carries the size and resize posts to the owning host', async () => {
  const posts: { path: string; payload: unknown }[] = [];
  const fed = createFederation({
    localHost: 'mshq',
    registry: { hosts: [{ name: 'node-b', baseUrl: 'http://100.64.0.2:8790' }], rejected: [] },
    askLocal: async () => ({ exitCode: 0, message: JSON.stringify({ panes: [], workspaces: [], tabs: [] }) }),
    fetchJson: async () => ({ status: 200, body: {} }),
    postJson: async (_host: unknown, path: string, payload: unknown) => { posts.push({ path, payload }); return { status: 200, body: path === '/els/new' ? { address: 'w1/t1/p1', pane: 'p1' } : { message: '120x36' } }; },
  } as unknown as Parameters<typeof createFederation>[0]);
  const target = fed.newTarget('node-b');
  await fed.new(target, { ws: 'T', cwd: '/w', command: ['sh'], size: { cols: 120, rows: 36 } }, 'OP');
  const resized = await fed.resize('node-b:w1/t1/p1', 200, 50, 'OP');
  expect(resized.exitCode).toBe(0);
  expect(posts).toEqual([
    { path: '/els/new', payload: { ws: 'T', cwd: '/w', command: ['sh'], cols: 120, rows: 36, from: 'mshq/OP' } },
    { path: '/els/resize', payload: { address: 'w1/t1/p1', cols: 200, rows: 50, from: 'mshq/OP' } },
  ]);
  expect((await fed.resize('w1/t1/p1', 200, 50, 'OP')).exitCode).toBe(2);
});
