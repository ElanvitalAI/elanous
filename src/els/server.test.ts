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
import { AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, serveConnection, startElsServer } from './server.js';

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

/** Roots whose owner already ran `seat-set OP` on their server (JUD #39057 ⓒ1③ — one explicit registration per server). */
const seatedRoots = new Set<string>();
/** One request over the real Unix socket, as `els` clients send it — with the owner pane credential when the test process has one. */
const ask = (root: string, request: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
  const auth = { op: 'auth', token: process.env.ELANOUS_ELS_OWNER_TOKEN };
  const send = (): void => {
    const socket = createConnection(elsSocketPath(root));
  let data = '';
  socket.on('connect', () => {
    if (auth.token) socket.write(`${JSON.stringify(auth)}\n`);
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on('data', (chunk) => { data += chunk.toString(); });
  socket.on('end', () => resolve(JSON.parse(data.split('\n').filter(Boolean).pop()!) as { exitCode: number; message: string }));
  socket.on('error', reject);
  };
  if (auth.token && !seatedRoots.has(root)) {
    // The test harness acts as the person: the first owner act on each server is the explicit OP registration.
    seatedRoots.add(root);
    const reg = createConnection(elsSocketPath(root));
    let registered = false;
    reg.on('connect', () => {
      reg.write(`${JSON.stringify(auth)}\n`);
      reg.write(`${JSON.stringify({ op: 'seat-set', seat: 'OP' })}\n`);
    });
    reg.on('data', (chunk) => { if (chunk.toString().includes('OP registered')) registered = true; });
    reg.on('close', () => { registered ? send() : reject(new Error('seat-set registration failed')); });
  } else send();
});

/** A raw ask that skips the auth preamble — exactly what an unauthenticated direct socket write is. */
const askRaw = (root: string, request: object, authLine?: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
  const socket = createConnection(elsSocketPath(root));
  let data = '';
  socket.on('connect', () => { if (authLine) socket.write(`${JSON.stringify(authLine)}\n`); socket.write(`${JSON.stringify(request)}\n`); });
  socket.on('data', (chunk) => { data += chunk.toString(); });
  socket.on('end', () => resolve(JSON.parse(data.split('\n').filter(Boolean).pop()!) as { exitCode: number; message: string }));
  socket.on('error', reject);
});

test('JUD #39053 ⓒ1 E2E: direct-socket and env-spoofed writes are denied at the server door, real pane credentials pass', async () => {
  const root = state();
  const fake = (): ElsPty => ({ id: `pty_${Math.random().toString(16).slice(2)}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  const started = await startElsServer({ stateRoot: root, spawn: fake });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const made = JSON.parse((await ask(root, { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] })).message) as { pane: string };
  // ① 직통 소켓(무토큰): 변형 연산 거부.
  const direct = await askRaw(root, { op: 'do', pane: made.pane, action: 'text', text: 'ls' });
  expect(direct.exitCode).toBe(1);
  expect(direct.message).toContain('no pane credential');
  // ② ELANOUS_SEAT=OP 위장: env 문자열을 토큰으로 제출해도 원장없는 토큰은 outsider.
  const spoof = await askRaw(root, { op: 'do', pane: made.pane, action: 'text', text: 'ls' }, { op: 'auth', token: 'OP', pid: 1 });
  expect(spoof.exitCode).toBe(1);
  expect(spoof.message).toContain('unknown pane token');
  // 거부는 감사 원장에 남는다.
  const audit = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string; result: string });
  expect(audit.length).toBeGreaterThanOrEqual(2);
  expect(audit.every((row) => row.result === 'denied')).toBe(true);
  // ③ 서버 소유자 토큰(진짜 자격)은 통과.
  const legit = await ask(root, { op: 'close', pane: made.pane, confirmed: true });
  expect(legit.exitCode, `legit close answer: ${JSON.stringify(legit)}`).toBe(0);
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
  // Exactly the three names the pane carries: the two eln reads + the server-minted pane token (env inheritance = descent proof).
  expect(Object.keys(env).sort()).toEqual(['ELANOUS_ELS_PANE', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_WS']);
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

test('JUD #39071 E2E: the spawn lambda passes the requesting role to registerSpawn as the parent', async () => {
  const root = state();
  const minted: string[] = [];
  const fake = (): ElsPty => ({ id: `pty_${Math.random().toString(16).slice(2)}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  const started = await startElsServer({ stateRoot: root, spawn: (_c, _d, _t, env) => { minted.push(env[AUTH_PANE_TOKEN_ENV] ?? ''); return fake(); } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  // OP 등록된 소유자 토큰으로 첫 new — role=op → parent {kind:'op'} → 자식 토큰은 op 자격으로 발급되어야 한다.
  const first = JSON.parse((await ask(root, { op: 'new', ws: 'ONE', cwd: '/work', command: ['sh'] })).message) as { pane: string };
  expect(minted.length).toBe(1);
  const target = JSON.parse((await ask(root, { op: 'new', ws: 'TWO', cwd: '/work', command: ['sh'] })).message) as { pane: string };
  expect(minted.length).toBe(2);
  // 자식 토큰으로 다른 워크스페이스 패넨에 do — op 자격이면 통과, 부모가 잘려 hand/unknown 이면 거부.
  const cross = await askRaw(root, { op: 'do', pane: target.pane, text: 'ls', from: 'server-owner' }, { op: 'auth', token: minted[0], pid: 1 });
  expect(cross.exitCode, `cross-workspace do as the spawned child: ${JSON.stringify(cross)}`).toBe(0);
});


test('JUD must ⓒ2-② (OP #104711): listen 은 guard 준비 뒤 — guard 없는 mutating 요청은 fail-closed 거부', async () => {
  const relay = createServer();
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const port = (relay.address() as { port: number }).port;
  const client = createConnection(port, '127.0.0.1');
  const serverSide = await new Promise<import('node:net').Socket>((resolve) => relay.once('connection', resolve));
  serveConnection(Promise.resolve(undefined), serverSide, '/state-root', undefined as never, { current: undefined });
  client.setEncoding('utf8');
  client.write(JSON.stringify({ op: 'input-line', pane: 'p-op', text: 'x', from: 'y' }) + '\n');
  const denial = await new Promise<string>((resolve, reject) => {
    client.once('data', (d) => resolve(String(d)));
    setTimeout(() => reject(new Error('no answer from serveConnection')), 5_000);
  });
  expect(denial).toContain('els: input-line denied — not ready (no guard)');
  client.destroy();
  serverSide.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

// JUD #39096 must ⓒ (OP #106966·#107197): 무토큰 els pane 자손의 attach 는 역할 문에서 거부된다.
test('JUD #39096 ⓒ — els pane 프로세스의 무토큰 요청은 문에서 거부', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-door-'));
  const relay = createServer();
  await new Promise<void>((resolve) => relay.listen(join(root, 'door.sock'), resolve));
  const client = createConnection(join(root, 'door.sock'));
  const serverSide = await new Promise<import('node:net').Socket>((resolve) => relay.once('connection', resolve));
  const stubGuard = {
    classify: () => ({ kind: 'outsider', note: 'tokenless' }) as never,
    authorize: () => ({ allow: true }) as never,
    audit: () => {},
  } as never;
  const fakeCore = { shellPids: () => [{ pane: 'w1:p1', pid: process.pid }] } as never;
  serveConnection(Promise.resolve(fakeCore), serverSide, join(root, 'state'), undefined as never, { current: stubGuard });
  client.setEncoding('utf8');
  client.write(JSON.stringify({ op: 'input-line', pane: 'w1:p1', text: 'x' }) + '\n');
  const answer = await new Promise<string>((resolve, reject) => {
    client.once('data', (d) => resolve(String(d)));
    setTimeout(() => reject(new Error('no answer from the door')), 5_000);
  });
  expect(answer).toContain('present the pane token');
  client.destroy(); serverSide.destroy();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});
