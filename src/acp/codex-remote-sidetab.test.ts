import { describe, expect, test } from 'bun:test';
import { ClientSideConnection, ndJsonStream, type ClientCapabilities } from '@agentclientprotocol/sdk';
import { createInProcessAcpBridge } from '../tui-client/acp-transport-local.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAppServerAgent } from './codex-app-server-agent.js';
import { AcpAgentManager } from './agent-manager.js';
import { runAcpServer } from './server.js';
import type { CasThreadIndex } from './codex-app-server-thread-index.js';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerSpawnArgs,
  buildCodexRemoteSideTabArgs,
  spawnCodexAppServer,
  spawnCodexRemoteTui,
} from './codex-app-server-client.js';
import { createCasThreadIndex } from './codex-app-server-thread-index.js';

function mockChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function assertUnixSocketDisconnect(closeMode: 'reset' | 'normal-close'): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `codex-remote-${closeMode}-`));
  const socketPath = join(dir, 'app-server.sock');
  let connectionCount = 0;
  let resolveFirstConnected!: () => void;
  let resolveFirstClosed!: () => void;
  const firstConnected = new Promise<void>((resolve) => { resolveFirstConnected = resolve; });
  const firstClosed = new Promise<void>((resolve) => { resolveFirstClosed = resolve; });
  const server = createServer((socket) => {
    const connection = ++connectionCount;
    socket.on('error', () => {});
    if (connection === 1) {
      resolveFirstConnected();
      socket.once('data', () => {
        if (closeMode === 'reset') socket.destroy(new Error('simulated connection reset'));
        else socket.end();
      });
      socket.once('close', resolveFirstClosed);
      return;
    }
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as { id: string | number };
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`);
      }
    });
  });
  await listen(server, socketPath);
  const spawned = spawnCodexAppServer({
    codexBinary: '/fake/codex',
    remoteSocketPath: socketPath,
    requestTimeoutMs: null,
    spawnImpl: (() => mockChild()) as unknown as typeof import('node:child_process').spawn,
  });
  try {
    await waitFor(firstConnected, 'first socket');
    const lostRequest = spawned.client.request('first', {}).then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(firstClosed, 'first socket close');
    expect(await waitFor(lostRequest, 'pending request rejection on disconnect')).toBeInstanceOf(Error);
  } finally {
    await spawned.client.close();
    spawned.child.kill();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('HAND-CODEX-REMOTE-SHADOW', () => {
  test('uses an explicit Unix socket for app-server and the same socket for remote TUI', () => {
    expect(buildCodexRemoteSideTabArgs('/tmp/codex-session.sock')).toEqual({
      appServerArgs: ['app-server', '--listen', 'unix:///tmp/codex-session.sock', '-c', 'features.code_mode_host=false'],
      remoteTuiArgs: ['--remote', 'unix:///tmp/codex-session.sock'],
    });
  });

  test('rejects an empty socket path', () => {
    expect(() => buildCodexRemoteSideTabArgs('')).toThrow('socket path is required');
  });

  test('rejects an in-flight request after a socket reset', async () => {
    await assertUnixSocketDisconnect('reset');
  }, 3000);

  test('rejects an in-flight request after a normal close', async () => {
    await assertUnixSocketDisconnect('normal-close');
  }, 3000);

  test('keeps the initial request pending until the unix socket starts listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-remote-late-listen-'));
    const socketPath = join(dir, 'app-server.sock');
    const server = createServer((socket) => {
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const request = JSON.parse(line) as { id: string | number };
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ready: true } })}\n`);
        }
      });
    });
    const spawned = spawnCodexAppServer({
      codexBinary: '/fake/codex',
      remoteSocketPath: socketPath,
      requestTimeoutMs: null,
      spawnImpl: (() => mockChild()) as unknown as typeof import('node:child_process').spawn,
    });
    try {
      const initialization = spawned.client.request('initialize', {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      await listen(server, socketPath);
      await expect(initialization).resolves.toEqual({ ready: true });
    } finally {
      await spawned.client.close();
      spawned.child.kill();
      if (server.listening) await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the default production spawn on stdio unless remote mode is explicitly selected', () => {
    expect(buildCodexAppServerSpawnArgs({})).toEqual(buildCodexAppServerArgs());
    expect(buildCodexAppServerSpawnArgs({ remoteSocketPath: '/tmp/side.sock' })).toEqual(
      buildCodexRemoteSideTabArgs('/tmp/side.sock').appServerArgs,
    );
    expect(buildCodexAppServerSpawnArgs({
      remoteSocketPath: '/tmp/side.sock',
      codexArgs: ['--model', 'gpt-5-codex'],
    })).toEqual([
      'app-server', '--model', 'gpt-5-codex', '--listen', 'unix:///tmp/side.sock',
      '-c', 'features.code_mode_host=false',
    ]);
    expect(() => buildCodexAppServerSpawnArgs({
      remoteSocketPath: '/tmp/side.sock',
      codexArgs: ['--listen', 'tcp://127.0.0.1:4444'],
    })).toThrow('remote socket path conflicts with codexArgs --listen');
  });

  test('drains the remote app-server child stdout pipe', async () => {
    const child = mockChild();
    const spawned = spawnCodexAppServer({
      codexBinary: '/fake/codex',
      remoteSocketPath: '/tmp/codex-remote-drain.sock',
      spawnImpl: (() => child) as unknown as typeof import('node:child_process').spawn,
    });
    try {
      expect(child.stdout.readableFlowing).toBe(true);
    } finally {
      await spawned.client.close();
      child.kill();
    }
  });

  test('runs the agent session, remote TUI, turn/steer correction, item update, and final turn over one socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-remote-sidetab-'));
    const socketPath = join(dir, 'app-server.sock');
    const threadIndex = createCasThreadIndex({ basePath: join(dir, 'threads.json') });
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => { signalTurnStarted = resolve; });
    const server = createServer((socket) => {
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const request = JSON.parse(line) as { id: string | number; method: string; params?: Record<string, unknown> };
          requests.push({ method: request.method, params: request.params });
          const result = request.method === 'initialize'
            ? { serverInfo: { name: 'fake-codex', version: 'test' }, capabilities: {} }
            : request.method === 'thread/start'
              ? { thread: { id: 'thread-shadow' }, model: 'test-model' }
              : request.method === 'turn/start'
                ? { turn: { id: 'turn-shadow' } }
                : request.method === 'turn/steer'
                  ? { turnId: 'turn-shadow' }
                  : { ok: true };
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
          if (request.method === 'turn/start') setTimeout(signalTurnStarted, 0);
          if (request.method === 'turn/steer') {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-shadow', itemId: 'item-shadow', delta: 'correction received' } })}\n`);
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-shadow', item: { id: 'item-shadow', type: 'agentMessage', text: 'correction received' } } })}\n`);
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-shadow', turn: { id: 'turn-shadow', status: 'completed' } } })}\n`);
          }
        }
      });
    });
    await listen(server, socketPath);
    const spawns: Array<{ command: string; args: readonly string[]; stdio: unknown }> = [];
    const spawnImpl = ((command: string, args: readonly string[], options: { stdio?: unknown }) => {
      spawns.push({ command, args, stdio: options.stdio });
      return mockChild();
    }) as unknown as typeof import('node:child_process').spawn;
    const previousSocket = process.env.ELANOUS_CODEX_REMOTE_SIDETAB_SOCKET;
    process.env.ELANOUS_CODEX_REMOTE_SIDETAB_SOCKET = socketPath;
    const manager = new AcpAgentManager();
    const updates: unknown[] = [];
    let agent: CodexAppServerAgent | undefined;
    try {
      agent = await manager.getAgent('codex-app-server', {
        cwd: dir,
        codexBinary: '/fake/codex',
        turnQuietMs: 0,
        turnHardMs: 0,
        _threadIndexForTesting: threadIndex as CasThreadIndex,
        _spawnFactory: (opts: Parameters<typeof spawnCodexAppServer>[0]) => spawnCodexAppServer({ ...opts, requestTimeoutMs: 100, spawnImpl }),
        _remoteTuiSpawnForTesting: (opts: Parameters<typeof spawnCodexRemoteTui>[0]) => spawnCodexRemoteTui({ ...opts, spawnImpl }),
      } as never) as unknown as CodexAppServerAgent;
      expect(agent).toBeInstanceOf(CodexAppServerAgent);
      let resolveItemCompleted!: (params: unknown) => void;
      const itemCompleted = new Promise<unknown>((resolve) => { resolveItemCompleted = resolve; });
      agent!.getClient()?.onNotification('item/completed', resolveItemCompleted);
      let codexSessionId: string | undefined;
      const bridge = createInProcessAcpBridge();
      const abort = new AbortController();
      const acpUpdates: unknown[] = [];
      const acpServer = runAcpServer({
        shutdownSignal: abort.signal,
        transportFactory: async (onConnection) => {
          void onConnection({
            readable: bridge.a.readable,
            writable: bridge.a.writable,
            peerId: 'codex-remote-sidetab-test',
            close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
          });
          return {
            kind: 'in-process',
            address: 'test://codex-remote-sidetab',
            close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
          };
        },
        runCodexTurn: async ({ promptText }) => {
          codexSessionId = await agent!.newSession();
          await agent!.prompt(codexSessionId, [{ type: 'text', text: promptText }], (update) => updates.push(update));
        },
      });
      const acpClient = new ClientSideConnection(() => ({
        async sessionUpdate(notification) { acpUpdates.push(notification.update); },
        async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
      }), ndJsonStream(bridge.b.writable, bridge.b.readable));
      try {
        const awareCapabilities = { _meta: { elanous: { ui: { showToast: true } } } } as unknown as ClientCapabilities;
        await acpClient.initialize({ protocolVersion: 1, clientCapabilities: awareCapabilities });
        const { sessionId: acpSessionId } = await acpClient.newSession({ cwd: dir, mcpServers: [] });
        const prompt = acpClient.prompt({ sessionId: acpSessionId, prompt: [{ type: 'text', text: 'Initial request' }] });
        await turnStarted;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await expect(agent!.steer(codexSessionId!, [{ type: 'text', text: 'Correction' }])).resolves.toBe(true);
        await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
        await expect(itemCompleted).resolves.toMatchObject({
          threadId: 'thread-shadow',
          item: { id: 'item-shadow', type: 'agentMessage' },
        });
        const missionFinal = acpUpdates
          .map((update) => (update as { content?: { text?: string } }).content?.text ?? '')
          .find((text) => text.startsWith('[elanous/feedback/emit]') && text.includes('"status":"done"'));
        expect(missionFinal).toBeDefined();
        expect(missionFinal ?? '').toContain('"kind":"mission.update"');
        expect(missionFinal ?? '').toContain('"phase":"end"');
      } finally {
        abort.abort();
        await acpServer;
      }

      expect(requests.map(({ method }) => method)).toEqual([
        'initialize', 'thread/start', 'turn/start', 'turn/steer',
      ]);
      expect(requests[2]?.params).toMatchObject({ threadId: 'thread-shadow' });
      expect(requests[3]?.params).toMatchObject({
        threadId: 'thread-shadow',
        turnId: 'turn-shadow',
        expectedTurnId: 'turn-shadow',
        input: [{ type: 'text', text: 'Correction' }],
      });
      expect(updates).toContainEqual(expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: expect.objectContaining({ text: 'correction received' }),
      }));
      expect(spawns).toHaveLength(2);
      expect(spawns[0]?.args).toContain(`unix://${socketPath}`);
      expect(spawns[1]?.args).toEqual(['--remote', `unix://${socketPath}`]);
      expect(spawns[1]?.stdio).toBe('inherit');
    } finally {
      await manager.dispose();
      if (previousSocket === undefined) delete process.env.ELANOUS_CODEX_REMOTE_SIDETAB_SOCKET;
      else process.env.ELANOUS_CODEX_REMOTE_SIDETAB_SOCKET = previousSocket;
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
