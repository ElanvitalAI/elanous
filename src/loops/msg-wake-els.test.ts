import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import type { ElsPty } from '../els/core.js';
import { registerSeatPaneAddress, resolveWake, wakeRecipient } from './msg-wake.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/**
 * The waker is the OP seat. Since the #39143 door a no-credential caller cannot `send-verified`; the person's explicit
 * `els seat set OP` (owner token, minted by the server into this process env) is what makes the owner credential OP.
 * The test registers the seat once per server, then wakes over the same real socket — the door still judges every request.
 */
async function registerOpSeat(socket: string): Promise<void> {
  const registered = await requestEls(socket, { op: 'seat-set', seat: 'OP' });
  expect(registered).toEqual({ exitCode: 0, message: 'els seat: OP registered' });
}

test('registered ELS route sends one verified wake through the actual ELS socket', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let screen = '❯ \n';
  const writes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: () => {}, writeAll: async text => { writes.push(text); screen = 'Turn running'; },
    bracketedPasteEnabled: () => true, renderScreen: async () => screen, onExit: () => {}, kill: () => {} };
  const server = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in server) throw new Error(server.message);
  cleanup.push(() => server.close());
  const socket = elsSocketPath(root);
  await registerOpSeat(socket);
  const call = (r: Parameters<typeof requestEls>[1]) => requestEls(socket, r);
  const created = await call({ op: 'new', ws: 'HQ', cwd: root, command: ['fake'] });
  const address = (JSON.parse(created.message) as { address: string }).address;
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true, elsRequest: call };
  registerSeatPaneAddress({ address: 'CX1', paneId: `els:${address}`, kind: 'els', host: 'local', enableWake: true }, deps);
  expect(resolveWake('CX1', deps)).toMatchObject({ wake: 'els', target: `els:${address}` });
  expect((await wakeRecipient('CX1', 10, { from: 'OP' }, deps)).result).toBe('injected');
  expect(writes).toEqual(['\x1b[200~[우편 깨움] OP → CX1 #10 — eln msg list --to CX1 로 읽고 처리\x1b[201~\r']);
});

test('the door stays shut: before OP is registered a wake is refused and nothing reaches the pane', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: () => {}, writeAll: async text => { writes.push(text); },
    bracketedPasteEnabled: () => true, renderScreen: async () => '❯ \n', onExit: () => {}, kill: () => {} };
  const server = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in server) throw new Error(server.message);
  cleanup.push(() => server.close());
  const socket = elsSocketPath(root);
  const call = (r: Parameters<typeof requestEls>[1]) => requestEls(socket, r);
  const created = await call({ op: 'new', ws: 'HQ', cwd: root, command: ['fake'] });
  const address = (JSON.parse(created.message) as { address: string }).address;
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true, elsRequest: call };
  registerSeatPaneAddress({ address: 'CX6', paneId: `els:${address}`, kind: 'els', host: 'local', enableWake: true }, deps);
  const result = await wakeRecipient('CX6', 16, { from: 'OP' }, deps);
  expect(result.result).toBe('failed');
  expect(result.reason).toContain('denied');
  expect(writes).toEqual([]);
});

test('busy or unknown ELS input is deferred without sending', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true,
    elsRequest: async (r: { op: string }) => { requests.push(r.op); return { exitCode: 0, message: r.op === 'ls'
      ? JSON.stringify({ panes: [{ address: 'w1/t1/p1', pane: 'p1' }] })
      : JSON.stringify({ state: 'working', inputEmpty: 'unknown', reason: 'running' }) }; } };
  registerSeatPaneAddress({ address: 'CX2', paneId: 'els:w1/t1/p1', kind: 'els', host: 'local', enableWake: true }, deps);
  const out = await wakeRecipient('CX2', 11, { from: 'OP' }, deps);
  expect(out.result).toBe('busy');
  expect(out.reason).toContain('els-working');
  expect(requests).toEqual(['ls', 'status']);
});

test('a draft typed after status was read prevents the final ELS write', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const pty: ElsPty = { id: 'pty_1', isAlive: () => true, write: () => {}, writeAll: async text => { writes.push(text); },
    bracketedPasteEnabled: () => true, renderScreen: async () => '❯ typing now\n', onExit: () => {}, kill: () => {} };
  const server = await startElsServer({ stateRoot: root, spawn: () => pty });
  if ('exitCode' in server) throw new Error(server.message);
  cleanup.push(() => server.close());
  const socket = elsSocketPath(root);
  await registerOpSeat(socket);
  const call = (r: Parameters<typeof requestEls>[1]) => requestEls(socket, r);
  const created = await call({ op: 'new', ws: 'HQ', cwd: root, command: ['fake'] });
  const address = (JSON.parse(created.message) as { address: string }).address;
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true,
    elsRequest: (r: Parameters<typeof requestEls>[1]) => r.op === 'status'
      ? Promise.resolve({ exitCode: 0, message: JSON.stringify({ state: 'idle', inputEmpty: true }) }) : call(r) };
  registerSeatPaneAddress({ address: 'CX3', paneId: `els:${address}`, kind: 'els', host: 'local', enableWake: true }, deps);
  const result = await wakeRecipient('CX3', 12, { from: 'OP' }, deps);
  expect(result.result).toBe('busy');
  expect(result.reason).toContain('not sent');
  expect(writes).toEqual([]);
});

test('remote ELS wake sends structured requests to the registered host and requires an empty input', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: { host: string; op: string; requireEmpty?: boolean }[] = [];
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true,
    elsRequestForHost: async (host: string, request: Parameters<typeof requestEls>[1]) => {
      calls.push({ host, op: request.op, ...(request.op === 'send-verified' ? { requireEmpty: request.requireEmpty } : {}) });
      return { exitCode: 0, message: request.op === 'ls' ? JSON.stringify({ panes: [{ address: 'w1/t1/p1', pane: 'p1' }] })
        : request.op === 'status' ? JSON.stringify({ state: 'idle', inputEmpty: true }) : 'els send: turn started' };
    } };
  registerSeatPaneAddress({ address: 'CX4', paneId: 'els:w1/t1/p1', kind: 'els', host: 'minim5', enableWake: true }, deps);
  expect(resolveWake('CX4', deps)).toMatchObject({ wake: 'els', host: 'minim5', target: 'els:w1/t1/p1' });
  expect((await wakeRecipient('CX4', 13, { from: 'OP' }, deps)).result).toBe('injected');
  expect(calls).toEqual([{ host: 'minim5', op: 'ls' }, { host: 'minim5', op: 'status' }, { host: 'minim5', op: 'send-verified', requireEmpty: true }]);
});

test('a timed-out ELS submission keeps its claim to avoid duplicate injection', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let finish!: (result: { exitCode: number; message: string }) => void;
  const stalled = new Promise<{ exitCode: number; message: string }>(resolve => { finish = resolve; });
  const deps = { seatStateRoot: join(root, 'seats'), stateRoot: root, live: true, timeoutMs: 30,
    elsRequest: async (r: { op: string }) => r.op === 'ls' ? { exitCode: 0, message: JSON.stringify({ panes: [{ address: 'w1/t1/p1', pane: 'p1' }] }) }
      : r.op === 'status' ? { exitCode: 0, message: JSON.stringify({ state: 'idle', inputEmpty: true }) } : stalled };
  registerSeatPaneAddress({ address: 'CX5', paneId: 'els:w1/t1/p1', kind: 'els', host: 'local', enableWake: true }, deps);
  expect((await wakeRecipient('CX5', 14, { from: 'OP' }, deps)).result).toBe('timeout');
  expect((await wakeRecipient('CX5', 15, { from: 'OP' }, deps)).result).toBe('debounced');
  finish({ exitCode: 0, message: 'turn started' });
});

test('SSH bridge command uses its local ELS socket and rejects unrelated operations', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'elswake-bridge-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = await startElsServer({ stateRoot: root, spawn: () => { throw new Error('not used'); } });
  if ('exitCode' in server) throw new Error(server.message);
  cleanup.push(() => server.close());
  // The remote side of the bridge reads its request from a real FIFO (sshd hands the command one). simCli's `stdinText`
  // is a socketpair, which readPipedStdin treats as non-piped, so the request goes through a FIFO opened by simCli.
  const invoke = async (request: object) => {
    const fifo = join(root, `wake-${randomUUID()}.fifo`);
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const holder = openSync(fifo, 'r+'); // a writer exists, so simCli's read-only open does not block
    writeSync(holder, JSON.stringify(request));
    const pending = simCli(['side', '_wake-request'], { mode: 'spawn', allowPaths: [['side']], stateRoot: root,
      cwd: root, stdinFile: fifo, env: { HOME: root, NODE_ENV: 'test' } });
    closeSync(holder); // the child holds its own descriptor; on macOS bun may miss a writer that closed before it polled, then readPipedStdin ends the read at its idle limit
    const result = await pending;
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { exitCode: number; message: string };
  };
  const list = await invoke({ op: 'ls' });
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.message).panes).toEqual([]);
  expect((await invoke({ op: 'close', pane: 'p1' })).exitCode).toBe(1);
}, 30_000); // Source: measured 5.6s on minim5 (2 requests, each ends at the 2s PIPED_STDIN_IDLE_TIMEOUT_MS) against the former 15s budget; 30s leaves load headroom.
