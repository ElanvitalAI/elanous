import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../agent/registry.js';
import { requestEls } from './client.js';
import { wireElsChildProducer } from './child-producer.js';
import type { ElsPty } from './core.js';
import { elsJournalPath } from './journal.js';
import { connectHolderElsPty, spawnHolderDetached } from './holder.js';
import { AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { processIdentity } from './peer-seat.js';
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
  expect(spoof.message).toBe('els: invalid credential');
  const fakeCredential = 'test-invalid-credential-never-audit';
  const fakeAuth = await askRaw(root, { op: 'do', pane: made.pane, action: 'text', text: 'ls' }, { op: 'auth', token: fakeCredential, pid: 1 });
  expect(fakeAuth.exitCode).toBe(1);
  expect(fakeAuth.message).toBe('els: invalid credential');
  // Each refusal must have its own audit record, including authentication rejection.
  const auditText = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8');
  const audit = auditText.trim().split('\n').map((l) => JSON.parse(l) as { action: string; result: string; reason: string; peerPid?: number });
  expect(audit).toHaveLength(3);
  expect(audit.every((row) => row.result === 'denied')).toBe(true);
  expect(audit.filter((row) => row.action === 'auth')).toEqual([
    expect.objectContaining({ result: 'denied', reason: 'invalid credential' }),
    expect.objectContaining({ result: 'denied', reason: 'invalid credential' }),
  ]);
  expect(auditText).not.toContain(fakeCredential);
  expect(audit.find((row) => row.action === 'auth')?.peerPid).not.toBe(1);
  // ③ 서버 소유자 토큰(진짜 자격)은 통과.
  const legit = await ask(root, { op: 'close', pane: made.pane, confirmed: true });
  expect(legit.exitCode, `legit close answer: ${JSON.stringify(legit)}`).toBe(0);
});

test('tab close over the socket reaps an exited own tab, rejects a foreign tab and requires confirmation even with a file rule', async () => {
  const root = state();
  const minted: Record<string, string>[] = [];
  const killed: boolean[] = [];
  const alive: boolean[] = [];
  const exits: Array<Array<() => void>> = [];
  const started = await startElsServer({ stateRoot: root, spawn: (_command, _cwd, _title, env) => {
    const index = minted.push({ ...env }) - 1;
    killed.push(false);
    alive.push(true);
    exits.push([]);
    return { id: `pty_${index}`, isAlive: () => alive[index]!, write: () => {}, renderScreen: async () => '', onExit: (cb) => { exits[index]!.push(cb); }, kill: () => { killed[index] = true; } };
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const own = JSON.parse((await askRaw(root, { op: 'new', ws: 'A', cwd: '/a', command: ['sh'] })).message) as { pane: string };
  const foreign = JSON.parse((await askRaw(root, { op: 'new', ws: 'B', cwd: '/b', command: ['sh'] })).message) as { pane: string };
  alive[0] = false;
  for (const exit of exits[0]!) exit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const listed = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string; tab: string }> };
  const ownTab = listed.panes.find(row => row.pane === own.pane)!.tab;
  const foreignTab = listed.panes.find(row => row.pane === foreign.pane)!.tab;
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [
    { principal: `els-pane:${own.pane}`, workspace: 'A', pane: '*', actions: ['close'] },
  ] }));
  const auth = { op: 'auth', token: minted[0]![AUTH_PANE_TOKEN_ENV] };
  const denied = await askRaw(root, { op: 'close-tab', tab: foreignTab, confirmed: true }, auth);
  expect(denied.exitCode).toBe(1);
  expect(killed).toEqual([false, false]);
  const ownerToken = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  const ownerAuth = { op: 'auth', token: ownerToken };
  expect((await askRaw(root, { op: 'seat-set', seat: 'OP' }, ownerAuth)).exitCode).toBe(0);
  const noConfirm = await askRaw(root, { op: 'close-tab', tab: ownTab }, ownerAuth);
  expect(noConfirm.exitCode).toBe(1);
  expect(noConfirm.message).toContain('confirm');
  expect((await askRaw(root, { op: 'close-tab', tab: ownTab, confirmed: true }, ownerAuth)).exitCode).toBe(0);
  const after = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string }> };
  expect(after.panes.map(row => row.pane)).toEqual([foreign.pane]);
  expect(killed).toEqual([false, false]); // already exited: nothing left to kill
});

test('tab close cannot authorize pane A and execute tab B in the same workspace', async () => {
  const root = state();
  const tokens: string[] = [];
  const started = await startElsServer({ stateRoot: root, spawn: (_command, _cwd, _title, env) => {
    tokens.push(env[AUTH_PANE_TOKEN_ENV]!);
    return { id: `pty_${tokens.length}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const a = JSON.parse((await askRaw(root, { op: 'new', ws: 'A', cwd: '/a', command: ['sh'] })).message) as { pane: string };
  const b = JSON.parse((await askRaw(root, { op: 'new', ws: 'A', cwd: '/b', command: ['sh'] })).message) as { pane: string };
  const rows = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string; tab: string }> };
  const bTab = rows.panes.find(row => row.pane === b.pane)!.tab;
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [
    { principal: `els-pane:${a.pane}`, workspace: 'A', pane: a.pane, actions: ['close'] },
  ] }));
  const denied = await askRaw(root, { op: 'close-tab', tab: bTab, pane: a.pane, confirmed: true }, { op: 'auth', token: tokens[0] });
  expect(denied.exitCode).toBe(1);
  expect((JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: unknown[] }).panes).toHaveLength(2);
});

test('RES-INFRA peer close over the socket cannot reap another seat live tab in the same workspace', async () => {
  const root = state();
  const killed: string[] = [];
  const started = await startElsServer({ stateRoot: root,
    seatLookup: async () => ({ pane: 'wRES:p1', seat: 'RES-INFRA' }),
    spawn: (_command, _cwd, _title, env) => ({ id: env.ELANOUS_ELS_PANE!, isAlive: () => true,
      write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => { killed.push(env.ELANOUS_ELS_PANE!); } }),
  });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = JSON.parse((await askRaw(root, { op: 'new', ws: 'W', cwd: '/w', command: ['sh'] })).message) as { pane: string };
  const listed = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string; tab: string }> };
  const tab = listed.panes.find((row) => row.pane === created.pane)!.tab;
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [
    { principal: `local:${process.getuid!()}`, seat: 'RES-INFRA', workspace: 'W', pane: '*', actions: ['close'] },
  ] }));
  const denied = await askRaw(root, { op: 'close-tab', tab, confirmed: true });
  expect(denied.exitCode).toBe(1);
  expect(denied.message).toContain('another or unverified seat owner');
  expect(killed).toEqual([]);
  expect((JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string }> }).panes.map((row) => row.pane)).toEqual([created.pane]);
});

test('server automatically archives and reaps only an exited pane after 30 minutes', async () => {
  const root = state();
  let clock = 1_000_000;
  const exits: Array<() => void> = [];
  const alive: boolean[] = [];
  const killed: boolean[] = [];
  const started = await startElsServer({ stateRoot: root, now: () => clock, reapIntervalMs: 10,
    spawn: () => {
      const index = alive.push(true) - 1;
      killed.push(false);
      return { id: `pty_${index}`, isAlive: () => alive[index]!, write: () => {},
        renderScreen: async () => `original screen ${index}\n`, onExit: (cb) => { exits[index] = cb; },
        kill: () => { killed[index] = true; } };
    },
  });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const dead = JSON.parse((await askRaw(root, { op: 'new', ws: 'W', cwd: '/dead', command: ['sh'] })).message) as { pane: string };
  const live = JSON.parse((await askRaw(root, { op: 'new', ws: 'W', cwd: '/live', command: ['sh'] })).message) as { pane: string };
  expect((await askRaw(root, { op: 'close', pane: live.pane, confirmed: true })).exitCode).toBe(1);
  alive[0] = false;
  exits[0]!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: unknown[] }).panes).toHaveLength(2);
  clock += 30 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const listed = JSON.parse((await askRaw(root, { op: 'ls' })).message) as { panes: Array<{ pane: string }> };
  expect(listed.panes.map((row) => row.pane)).toEqual([live.pane]);
  expect(killed).toEqual([false, false]);
  const dir = join(root, 'els', 'reaped-panes');
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const archive = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as { pane: string; screen: string; exitedAt: number };
  expect(archive).toMatchObject({ pane: dead.pane, screen: 'original screen 0\n', exitedAt: 1_000_000 });
  expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform !== 'darwin')('seat pane can close its confirmed own tab but not a foreign tab in the same workspace', async () => {
  if (process.env.ELS_CLOSE_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'seat pane can close its confirmed own tab'], {
      env: { ...process.env, ELS_CLOSE_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const root = state();
  const tokens: string[] = [];
  const killed: string[] = [];
  const started = await startElsServer({ stateRoot: root, spawn: (_c, _d, _t, env) => {
    tokens.push(env[AUTH_PANE_TOKEN_ENV]!);
    const id = env.ELANOUS_ELS_PANE!;
    return { id, ...(tokens.length === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'close-fixture' } } : {}), isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => { killed.push(id); } };
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const create = (seat: string) => JSON.parse(started.core.newPane({ ws: 'W', cwd: root, command: ['sh'], ownerSeat: seat, parent: { kind: 'hand', seat, workspaces: ['W'] } }).message) as { pane: string };
  const own = create('HAND-A');
  const foreign = create('HAND-B');
  const listed = JSON.parse(started.core.list().message) as { panes: Array<{ pane: string; tab: string }> };
  const ownTab = listed.panes.find(row => row.pane === own.pane)!.tab;
  const foreignTab = listed.panes.find(row => row.pane === foreign.pane)!.tab;
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [
    { principal: `els-pane:${own.pane}`, workspace: 'W', pane: '*', actions: ['close'] },
  ] }));
  const auth = { op: 'auth', token: tokens[0] };
  const noConfirm = await askRaw(root, { op: 'close-tab', tab: ownTab }, auth);
  expect(noConfirm.exitCode).toBe(1);
  expect(noConfirm.message).toContain('confirm');
  expect(killed).toEqual([]);
  const foreignDenied = await askRaw(root, { op: 'close-tab', tab: foreignTab, confirmed: true }, auth);
  expect(foreignDenied.exitCode).toBe(1);
  expect(foreignDenied.message).toContain('another or unverified seat owner');
  expect(killed).toEqual([]);
  const closed = await askRaw(root, { op: 'close-tab', tab: ownTab, confirmed: true }, auth);
  expect(closed.exitCode, closed.message).toBe(0);
  expect(killed).toEqual([own.pane]);
  expect((JSON.parse(started.core.list().message) as { panes: Array<{ pane: string }> }).panes.map(p => p.pane)).toEqual([foreign.pane]);
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

test.skipIf(process.platform !== 'darwin')('JUD #39071 E2E: the spawn lambda passes the requesting role to registerSpawn as the parent', async () => {
  const root = state();
  const targetFile = join(root, 'target.json');
  const resultFile = join(root, 'result.json');
  const fixture = join(root, 'child.ts');
  // A real PTY process must present the inherited token from its own socket; a fake PTY
  // has no live process generation and must never be treated as authenticated.
  writeFileSync(fixture, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createConnection } from 'node:net';
    delete process.env.ELANOUS_ELS_OWNER_TOKEN;
    while (!existsSync(${JSON.stringify(targetFile)})) await Bun.sleep(20);
    const target = JSON.parse(readFileSync(${JSON.stringify(targetFile)}, 'utf8'));
    const socket = createConnection(process.env.ELANOUS_ELS_SOCKET!);
    let data = '';
    socket.on('connect', () => {
      socket.write(JSON.stringify({ op: 'auth', token: process.env.ELANOUS_ELS_PANE_TOKEN }) + '\\n');
      socket.write(JSON.stringify({ op: 'do', pane: target, text: 'ls', from: 'server-owner' }) + '\\n');
    });
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => { writeFileSync(${JSON.stringify(resultFile)}, data.trim().split('\\n').pop()!); });
    await new Promise(() => {});
  `);
  const minted: string[] = [];
  let holderPid: number | undefined;
  const fake = (): ElsPty => ({ id: 'target', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  const started = await startElsServer({ stateRoot: root, stall: false, spawn: (command, cwd, title, env) => {
    minted.push(env[AUTH_PANE_TOKEN_ENV] ?? '');
    if (minted.length !== 1) return fake();
    holderPid = spawnHolderDetached({ stateRoot: root, paneId: env.ELANOUS_ELS_PANE!, cwd, title, env, command }).pid;
    return connectHolderElsPty(root, env.ELANOUS_ELS_PANE!, undefined);
  } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  cleanups.push(async () => {
    if (holderPid === undefined) return;
    try { process.kill(holderPid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 15_000; // Real holder shutdown: bounded wait, not a performance assertion.
    while (true) {
      try { process.kill(holderPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
      if (Date.now() > deadline) throw new Error('holder did not exit');
      await Bun.sleep(25);
    }
  });
  const first = JSON.parse((await ask(root, { op: 'new', ws: 'ONE', cwd: root, command: [process.execPath, fixture] })).message) as { pane: string };
  const target = JSON.parse((await ask(root, { op: 'new', ws: 'TWO', cwd: root, command: ['sh'] })).message) as { pane: string };
  expect(minted.length).toBe(2);
  const deadline = Date.now() + 15_000; // Wait for the real holder binding and socket response.
  while (!started.core.paneProcessBinding(first.pane)) {
    if (Date.now() > deadline) throw new Error('holder did not bind its live process');
    await Bun.sleep(25);
  }
  // The same valid token stolen by this unrelated socket peer must not authenticate.
  const stolen = await askRaw(root, { op: 'do', pane: target.pane, text: 'ls', from: 'server-owner' }, { op: 'auth', token: minted[0] });
  expect(stolen.exitCode).toBe(1);
  writeFileSync(targetFile, JSON.stringify(target.pane));
  while (!existsSync(resultFile)) {
    if (Date.now() > deadline) throw new Error('child did not answer');
    await Bun.sleep(25);
  }
  const cross = JSON.parse(readFileSync(resultFile, 'utf8')) as { exitCode: number; message: string };
  expect(cross.exitCode, `cross-workspace do as the spawned child: ${JSON.stringify(cross)}`).toBe(0);
}, 60_000);


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
