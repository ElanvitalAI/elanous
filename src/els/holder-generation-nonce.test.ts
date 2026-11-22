import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectHolderElsPty, holderMetaPath, holderSocketPath, reattachHolder, saveHolderMeta, type HolderMeta } from './holder.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  sent: string[] = [];
  write(line: string) { this.sent.push(JSON.parse(line).op); return true; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  receive(message: object) { this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }
}

const meta: HolderMeta = {
  paneId: 'pane', ptyId: 'pty', pid: 42, cwd: '/', command: ['fake'],
  title: 'fake', socketPath: '/fake', startedAt: 0, cols: 80, rows: 24,
};
const expectedNonce = 'holder-generation-one';
const pong = { type: 'pong', paneId: 'pane', ptyId: 'pty', pid: 42 };

function setup() {
  const socket = new FakeSocket();
  // The sixth parameter is the planned expected holder generation nonce.
  const connect = connectHolderElsPty as unknown as (
    root: string, pane: string, meta: HolderMeta, lookup: () => undefined,
    connectSocket: () => Socket, expectedNonce: string,
  ) => ReturnType<typeof connectHolderElsPty>;
  const pty = connect('/fake', 'pane', meta, () => undefined, () => socket as unknown as Socket, expectedNonce);
  return { socket, pty };
}

for (const [description, nonceField] of [
  ['different', { generationNonce: 'holder-generation-two' }],
  ['missing', {}],
] as const) {
  test(`${description} holder generation nonce never releases queued controls`, async () => {
    const { socket, pty } = setup();
    try {
      pty.write('queued input');
      const writeResult = pty.writeAll?.('queued write').then(() => 'resolved', () => 'rejected');
      const screenResult = pty.renderScreen().then(() => 'resolved', () => 'rejected');
      pty.resize?.(100, 30);
      pty.kill();
      socket.emit('connect');
      expect(socket.sent).toEqual(['ping']);
      socket.receive({ ...pong, ...nonceField });
      expect(socket.sent).toEqual(['ping']);
      expect(socket.destroyed).toBe(true);
      expect(pty.isAlive()).toBe(false);
      expect(await writeResult).toBe('rejected');
      expect(await screenResult).toBe('rejected');
      // A later valid pong cannot revive a rejected generation.
      socket.receive({ ...pong, generationNonce: expectedNonce });
      expect(socket.sent).toEqual(['ping']);
    } finally {
      pty.detach?.();
    }
  });
}

test('wrong nonce never exposes pre-pong output or exit screen', async () => {
  const { socket, pty } = setup();
  const output: string[] = [];
  pty.onOutput?.((text) => output.push(text));
  pty.write('queued input');
  socket.emit('connect');
  socket.receive({ type: 'output', paneId: 'pane', chunk: 'unverified output' });
  socket.receive({ type: 'exit', paneId: 'pane', exitCode: 0, screen: 'unverified screen' });
  socket.receive({ ...pong, generationNonce: 'wrong-generation' });
  expect(output).toEqual([]);
  expect(socket.sent).toEqual(['ping']);
  expect(socket.destroyed).toBe(true);
  expect(await pty.renderScreen().then(() => 'resolved', () => 'rejected')).toBe('rejected');
  pty.detach?.();
});

test('matching holder generation nonce releases controls only after pong', async () => {
  const { socket, pty } = setup();
  try {
    pty.write('queued input');
    const write = pty.writeAll?.('queued write');
    const screen = pty.renderScreen();
    pty.resize?.(100, 30);
    pty.kill();
    socket.emit('connect');
    expect(socket.sent).toEqual(['ping']);
    socket.receive({ ...pong, generationNonce: expectedNonce });
    expect(socket.sent).toEqual(['ping', 'input', 'write-all', 'snapshot', 'resize', 'kill']);
    socket.receive({ type: 'wrote', paneId: 'pane' });
    socket.receive({ type: 'snapshot', paneId: 'pane', ptyId: 'pty', pid: 42,
      generationNonce: expectedNonce, alive: true, bracketedPaste: false, lastOutputAt: null, screen: 'ok' });
    await write;
    expect(await screen).toBe('ok');
  } finally {
    pty.detach?.();
  }
});

// ── JUD #128534 (OP #128534): 재결속(reattachHolder)도 신뢰 세대(trusted generation)를 확인한다 ──
// meta 에 기록된 generation nonce 가 재결속의 기대 nonce 가 된다. 잘못된 세대의 홀더가 소켓에 답하면
// 거부하고, nonce 없는 meta(기존 홀더)는 확인 없이 재결속한다(호환 범위 명시).

interface HolderServerStub {
  readonly received: string[];
  close(): Promise<void>;
}

function startHolderServerStub(root: string, pane: string, pongNonce: string | undefined): Promise<HolderServerStub> {
  const path = holderSocketPath(root, pane);
  mkdirSync(dirname(path), { recursive: true });
  const received: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline)) as { readonly op: string };
        buffer = buffer.slice(newline + 1);
        received.push(request.op);
        if (request.op === 'ping')
          socket.write(`${JSON.stringify({ type: 'pong', paneId: pane, ptyId: 'rebind-pty', pid: process.pid, ...(pongNonce === undefined ? {} : { generationNonce: pongNonce }) })}\n`);
        if (request.op === 'snapshot')
          socket.write(`${JSON.stringify({ type: 'snapshot', paneId: pane, ptyId: 'rebind-pty', pid: process.pid, alive: true, cols: 80, rows: 24, exitCode: null, bracketedPaste: false, lastOutputAt: null, screen: 'holder-screen-ok' })}\n`);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve({ received, close: () => new Promise<void>((done) => server.close(() => done())) }));
  });
}

function recordRebindMeta(root: string, pane: string, generationNonce: string | undefined): void {
  saveHolderMeta(holderMetaPath(root, pane), { paneId: pane, ptyId: 'rebind-pty', pid: process.pid, cwd: root, command: ['fake'], title: 'fake',
    socketPath: holderSocketPath(root, pane), startedAt: 0, ...(generationNonce === undefined ? {} : { generationNonce }), cols: 80, rows: 24 });
}

test('rebind rejects a holder answering with the wrong generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eh-rebind-'));
  recordRebindMeta(root, 'rb-stale', 'rebind-generation-trusted');
  const stale = await startHolderServerStub(root, 'rb-stale', 'rebind-generation-stale');
  let pty: ReturnType<typeof reattachHolder> | undefined;
  try {
    pty = reattachHolder(root, 'rb-stale');
    if (!pty) throw new Error('rebind must find the recorded live holder');
    pty.write('MUST-NOT-REACH-STALE-GENERATION');
    pty.resize?.(80, 24);
    pty.kill();
    const screen = pty.renderScreen().then(() => 'resolved', () => 'rejected');
    expect(await screen).toBe('rejected');
    expect(pty.isAlive()).toBe(false);
    expect(pty.processBinding).toBeUndefined();
    expect(stale.received).toEqual(['ping']);
  } finally {
    pty?.detach?.();
    await stale.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('rebind accepts the trusted generation recorded in meta', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eh-rebind-'));
  recordRebindMeta(root, 'rb-good', 'rebind-generation-trusted');
  const holder = await startHolderServerStub(root, 'rb-good', 'rebind-generation-trusted');
  let pty: ReturnType<typeof reattachHolder> | undefined;
  try {
    pty = reattachHolder(root, 'rb-good');
    if (!pty) throw new Error('rebind must find the recorded live holder');
    pty.write('REBOUND-CONTROL');
    const screen = pty.renderScreen().then((text) => text, () => 'rejected');
    expect(await screen).toBe('holder-screen-ok');
    expect(pty.isAlive()).toBe(true);
    expect(holder.received).toEqual(['ping', 'input', 'snapshot']);
  } finally {
    pty?.detach?.();
    await holder.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('rebind keeps working for a legacy holder recorded without a nonce', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eh-rebind-'));
  recordRebindMeta(root, 'rb-legacy', undefined);
  const holder = await startHolderServerStub(root, 'rb-legacy', undefined);
  let pty: ReturnType<typeof reattachHolder> | undefined;
  try {
    pty = reattachHolder(root, 'rb-legacy');
    if (!pty) throw new Error('rebind must find the recorded live holder');
    pty.write('LEGACY-REBOUND-CONTROL');
    const screen = pty.renderScreen().then((text) => text, () => 'rejected');
    expect(await screen).toBe('holder-screen-ok');
    expect(pty.isAlive()).toBe(true);
    expect(holder.received).toEqual(['ping', 'input', 'snapshot']);
  } finally {
    pty?.detach?.();
    await holder.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
