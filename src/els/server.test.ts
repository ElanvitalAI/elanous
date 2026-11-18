import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../agent/registry.js';
import { requestEls } from './client.js';
import { wireElsChildProducer } from './child-producer.js';
import type { ElsPty } from './core.js';
import { elsJournalPath } from './journal.js';
import { elsSocketPath, startElsServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const state = () => { const dir = mkdtempSync(join(tmpdir(), 'els-srv-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const noPty = (): ElsPty => { throw new Error('no PTY in this test'); };

test('a live server that is slow to answer keeps its socket: a second serve refuses and does not unlink it', async () => {
  const root = state();
  mkdirSync(join(root, 'els'), { recursive: true });
  // A «server» that accepts connections but never answers.
  const busy = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => busy.listen(elsSocketPath(root), resolve));
  cleanups.push(() => new Promise<void>((resolve) => busy.close(() => resolve())));
  const second = await startElsServer({ stateRoot: root, spawn: noPty });
  expect('exitCode' in second ? second.message : 'started').toContain('already answers');
  // The busy server still owns the path: a new client still reaches it.
  const reached = await new Promise<boolean>((resolve) => {
    const socket = createConnection(elsSocketPath(root));
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
  expect(reached).toBe(true);
});

test('two serves started together on an empty state dir: exactly one owns it, the other refuses', async () => {
  const root = state();
  const results = await Promise.all([startElsServer({ stateRoot: root, spawn: noPty }), startElsServer({ stateRoot: root, spawn: noPty })]);
  for (const result of results) if (!('exitCode' in result)) cleanups.push(() => result.close());
  const owners = results.filter((result) => !('exitCode' in result));
  const refusals = results.filter((result) => 'exitCode' in result).map((result) => ('exitCode' in result ? result.message : ''));
  expect([owners.length, refusals.length]).toEqual([1, 1]);
  expect(refusals[0]).toContain('already answers');
});

test('the journal is not read until the socket is owned: a refused serve leaves a corrupt journal untouched and a live owner keeps serving', async () => {
  const root = state();
  const first = await startElsServer({ stateRoot: root, spawn: noPty });
  if ('exitCode' in first) throw new Error(first.message);
  cleanups.push(() => first.close());
  writeFileSync(elsJournalPath(root), '{broken');
  const second = await startElsServer({ stateRoot: root, spawn: noPty });
  expect('exitCode' in second ? second.message : 'started').toContain('already answers');
  expect(readFileSync(elsJournalPath(root), 'utf8')).toBe('{broken');
});

/** One request over the real Unix socket, as `els` clients send it. */
const ask = (root: string, request: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
  const socket = createConnection(elsSocketPath(root));
  let data = '';
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (chunk) => { data += chunk.toString(); });
  socket.on('end', () => resolve(JSON.parse(data) as { exitCode: number; message: string }));
  socket.on('error', reject);
});

test('child op over the socket: start, status, end write the parent result line, summary and tree answer', async () => {
  const root = state();
  const started = await startElsServer({ stateRoot: root, spawn: noPty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  expect((await ask(root, { op: 'child', action: 'start', id: 'h1', ws: 'OP', source: 'harness', label: 'review' })).exitCode).toBe(0);
  expect((await ask(root, { op: 'child', action: 'start', id: 'h1', ws: 'OP', source: 'harness', label: 'review' })).exitCode).toBe(1);
  expect((await ask(root, { op: 'child', action: 'summary', ws: 'OP' })).message).toBe('⎇1 ●1');
  expect((await ask(root, { op: 'child', action: 'status', id: 'h1', state: 'blocked', line: '승인 대기' })).exitCode).toBe(0);
  const rows = JSON.parse((await ask(root, { op: 'child', action: 'tree', ws: 'OP' })).message) as { state: string; text: string }[];
  expect(rows.map((row) => [row.state, row.text])).toEqual([['blocked', '↳ ⎇ harness · review · 승인 대기']]);
  expect((await ask(root, { op: 'child', action: 'end', id: 'h1', summary: 'x' })).exitCode).toBe(2);
  const ended = await ask(root, { op: 'child', action: 'end', id: 'h1', ok: false, summary: 'boom' });
  expect(ended.message).toContain('FAILED: boom');
  const logged = readFileSync(join(root, 'els', 'child-results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ws: string; line: string });
  expect(logged).toEqual([{ at: expect.any(String), ws: 'OP', line: ended.message }] as never);
  expect((await ask(root, { op: 'child', action: 'summary', ws: 'OP' })).message).toBe('⎇1 ✕1');
});

test('a pane started by `els new` carries the workspace and socket in its env, and a sub-agent started there becomes a child tab', async () => {
  const root = state();
  const seen: Record<string, string>[] = [];
  const started = await startElsServer({ stateRoot: root, spawn: (_c, _d, _t, env) => {
    seen.push({ ...env });
    return { id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  expect((await ask(root, { op: 'new', ws: 'OP', cwd: '/work', command: ['eln'] })).exitCode).toBe(0);
  const env = seen[0]!;
  expect(env.ELANOUS_ELS_WS).toBe('OP');
  expect(env.ELANOUS_ELS_SOCKET).toBe(elsSocketPath(root));
  // Exactly the two names the eln side reads (dashboard + child-producer); an unread name would be a silent no-op.
  expect(Object.keys(env).sort()).toEqual(['ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_WS']);
  // What the eln in that pane does at boot: wire the producer from the env it was given.
  const registry = new AgentRegistry();
  const wired = wireElsChildProducer({ registry, ws: env.ELANOUS_ELS_WS!, socketPath: env.ELANOUS_ELS_SOCKET!, request: requestEls });
  cleanups.push(() => wired.dispose());
  const task = registry.register({ name: 'general-purpose', description: 'd' } as never, 'p');
  let release: () => void = () => {};
  const running = registry.runManaged(task.id, () => new Promise<string>((resolve) => { release = () => resolve('ok'); }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = JSON.parse((await ask(root, { op: 'child', action: 'tree', ws: 'OP' })).message) as { id: string; state: string }[];
  expect(rows.map((row) => [row.id, row.state])).toEqual([[task.id, 'working']]);
  release();
  await running;
});

test('reorder over the socket survives a restart of the owner: workspaces and tabs come back in the order a person left them', async () => {
  const root = state();
  const fake = (): ElsPty => ({ id: `pty_${Math.random().toString(16).slice(2)}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  const first = await startElsServer({ stateRoot: root, spawn: fake });
  if ('exitCode' in first) throw new Error(first.message);
  const made: { address: string; pane: string }[] = [];
  for (const ws of ['one', 'two', 'three', 'two']) made.push(JSON.parse((await ask(root, { op: 'new', ws, cwd: '/w', command: ['sh'], title: `${ws}-${made.length}` })).message));
  const listed = async () => (JSON.parse((await ask(root, { op: 'ls' })).message) as { panes: { title: string; tab: string }[] }).panes;
  expect((await listed()).map((p) => p.title)).toEqual(['one-0', 'two-1', 'two-3', 'three-2']);
  expect((await ask(root, { op: 'reorder', kind: 'workspace', id: 'three', before: 'one' })).exitCode).toBe(0);
  const lastTwo = (await listed()).find((p) => p.title === 'two-3')!.tab;
  const firstTwo = (await listed()).find((p) => p.title === 'two-1')!.tab;
  expect((await ask(root, { op: 'reorder', kind: 'tab', id: lastTwo, before: firstTwo })).exitCode).toBe(0);
  expect((await ask(root, { op: 'reorder', kind: 'tab', id: lastTwo, before: 'nothing' })).exitCode).toBe(1);
  expect((await ask(root, { op: 'reorder', kind: 'workspace', id: 'one', before: '' })).exitCode).toBe(0);      // empty = the end, over the socket too
  expect((await listed()).map((p) => p.title)).toEqual(['three-2', 'two-3', 'two-1', 'one-0']);
  expect((await ask(root, { op: 'reorder', kind: 'workspace', id: 'one', before: 'two' })).exitCode).toBe(0);
  expect((await listed()).map((p) => p.title)).toEqual(['three-2', 'one-0', 'two-3', 'two-1']);
  await first.close();
  const second = await startElsServer({ stateRoot: root, spawn: fake });
  if ('exitCode' in second) throw new Error(second.message);
  cleanups.push(() => second.close());
  expect((await listed()).map((p) => p.title)).toEqual(['three-2', 'one-0', 'two-3', 'two-1']);
});
