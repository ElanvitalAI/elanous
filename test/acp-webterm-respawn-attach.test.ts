import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/project/project-store.js';
import { createSession } from '../src/session/index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';
import type { PreviewTerminalOpts, PreviewRegistryDeps } from '../src/preview/terminal.js';
import type { StartOpts } from '../src/pty-shell/registry.js';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { PreviewTerminal } from '../src/preview/terminal.js';
import { runAcpServer } from '../src/acp/server.js';
import { createInProcessAcpBridge } from '../src/tui-client/acp-transport-local.js';
import type { AcpTransportServer } from '../src/acp/transport/index.js';
import { parseElanousTermEnvelope } from '../src/acp/elanous-extensions.js';
import { handleTerminalsList } from '../src/nexus/api/terminals.js';
import { __resetPreviewTapRegistry, listAllPreviewTerminals, listPreviewTerminals, lookupPreviewTerminal } from '../src/web-terminal/preview-tap-registry.js';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  __resetPreviewTapRegistry();
});

async function boot(createWebTerminal?: (opts: PreviewTerminalOpts) => PreviewTerminal) {
  const bridge = createInProcessAcpBridge();
  const abort = new AbortController();
  const done = runAcpServer({
    ...(createWebTerminal ? { createWebTerminal } : {}),
    transportFactory: async (onConnection): Promise<AcpTransportServer> => {
      void Promise.resolve(onConnection({
        readable: bridge.a.readable, writable: bridge.a.writable, peerId: 'respawn-test',
        close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
      })).catch(() => {});
      return { kind: 'in-process', address: 'respawn-test://', close: async () => {
        try { await bridge.a.writable.close(); } catch { /* closed */ }
      } };
    },
    shutdownSignal: abort.signal,
  });
  done.catch(() => {});
  const updates: Array<{ sessionId: string; update: unknown }> = [];
  const conn = new ClientSideConnection(() => ({
    async sessionUpdate(notification: { sessionId: string; update: unknown }) { updates.push(notification); },
    async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
  }), ndJsonStream(bridge.b.writable, bridge.b.readable));
  stop = async () => {
    abort.abort();
    try { await bridge.b.writable.close(); } catch { /* closed */ }
    try { await done; } catch { /* aborted */ }
  };
  await conn.initialize({ protocolVersion: 1, clientCapabilities: {
    _meta: { elanous: { term: { terminalOutput: true } } },
  } });
  const a = (await conn.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId;
  const b = (await conn.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId;
  return { conn, updates, a, b };
}

test('conversation terminal/spawn forwards the project cwd to the injected PTY backend and preserves explicit cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-project-pty-'));
  const previous = process.env.ELANOUS_SESSION_ROOT;
  const starts: StartOpts[] = [];
  try {
    setElanousConfigDir(root);
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    const project = new ProjectStore(root).create({ name: 'project', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const deps: PreviewRegistryDeps = {
      startPty: (opts) => {
        starts.push(opts);
        return { id: `pty-${starts.length}`, write: () => {}, resize: () => {}, kill: () => {} } as unknown as ReturnType<PreviewRegistryDeps['startPty']>;
      },
      onPtyEvent: () => () => {},
      unregisterPty: () => true,
    };
    const { conn } = await boot((opts) => new PreviewTerminal(opts, undefined, deps));
    expect(await conn.extMethod('terminal/spawn', { sessionId: assigned.id, terminalId: 'project-term' }))
      .toMatchObject({ status: 'spawned' });
    expect(starts[0]?.workdir).toBe(folder);
    expect(await conn.extMethod('terminal/spawn', { sessionId: plain.id, terminalId: 'plain-term' }))
      .toMatchObject({ status: 'spawned' });
    expect(starts[1]?.workdir).toBe(process.cwd());
    expect(await conn.extMethod('terminal/spawn', { sessionId: assigned.id, terminalId: 'explicit-term', cwd: root }))
      .toMatchObject({ status: 'spawned' });
    expect(starts[2]?.workdir).toBe(root);
  } finally {
    await stop?.(); stop = undefined;
    __resetPreviewTapRegistry();
    resetElanousConfigDir();
    if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('terminal output not delivered');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('terminal/spawn adopts a live shell into another session without another PTY', async () => {
  let ptyCount = 0;
  const start = spyOn(PreviewTerminal.prototype, 'start').mockImplementation(function (this: PreviewTerminal) {
    ptyCount++;
    (this as unknown as { alive: boolean }).alive = true;
  });
  try {
    const { conn, updates, a, b } = await boot();
    expect(await conn.extMethod('terminal/spawn', { sessionId: a, terminalId: 'term-x' }))
      .toMatchObject({ status: 'spawned', sessionId: a, terminalId: 'term-x' });
    const pt = lookupPreviewTerminal(a, 'term-x')!;
    // Existing registry tap is installed on this fake PTY; drive its raw fan-out.
    const rawTaps = (pt as unknown as { rawOutputTaps: Set<(chunk: string) => void> }).rawOutputTaps;
    expect(await conn.extMethod('terminal/spawn', { sessionId: b, terminalId: 'term-x', replay: true }))
      .toMatchObject({ status: 'attached', sessionId: b, terminalId: 'term-x', snapshot: expect.any(String) });
    expect(ptyCount).toBe(1);
    expect(listAllPreviewTerminals()).toHaveLength(1);
    const response = handleTerminalsList(new Request('http://localhost/v1/terminals'), { noAuth: true }, {
      ptyManifestTargets: () => [], ptyManifestDbPath: () => '/tmp/respawn-test-manifest',
      listPtyManifestRows: () => [], listPtyManifestRowsAt: () => [], isProcessAlive: () => false,
      listPty: () => [], reapDeadPtyManifest: () => 0,
      purgeClosedPtyManifest: () => 0, reapStalePtyManifest: () => 0,
      reapOrphanedOwnedPtyManifest: () => 0, getDefaultLogStore: () => null,
      queryRunningRuns: () => ({ entries: [] }) as unknown as ReturnType<typeof import('../src/self-implement/running-runs.js').queryRunningRuns>,
      runTerminated: () => 'ledger-indeterminate',
    });
    const body = await response.json() as { terminals: Array<{ id: string; producer: string }> };
    expect(body.terminals.filter((row) => row.id === 'term-x' && row.producer === 'web-registration')).toHaveLength(1);
    expect(listPreviewTerminals(a)).toHaveLength(1);
    expect(listPreviewTerminals(b)).toHaveLength(1);
    expect(await conn.extMethod('terminal/list', { sessionId: a }))
      .toMatchObject({ sessionId: a, terminals: [expect.objectContaining({ sessionId: a, terminalId: 'term-x' })] });
    expect(await conn.extMethod('terminal/list', { sessionId: b }))
      .toMatchObject({ sessionId: b, terminals: [expect.objectContaining({ sessionId: b, terminalId: 'term-x' })] });
    expect(lookupPreviewTerminal(b, 'term-x')).toBe(pt);
    for (const tap of rawTaps) tap('cross-session-output');
    await waitFor(() => [a, b].every((sid) => updates.some((u) => {
      const text = (u.update as { content?: { text?: string } }).content?.text;
      if (u.sessionId !== sid || typeof text !== 'string') return false;
      const envelope = parseElanousTermEnvelope(text);
      return envelope?.method === 'terminalOutput' && envelope.payload.data === 'cross-session-output';
    })));
    expect(await conn.extMethod('terminal/spawn', { sessionId: a, terminalId: 'term-x' }))
      .toMatchObject({ status: 'attached', sessionId: a });
    expect(ptyCount).toBe(1);
  } finally { start.mockRestore(); }
});

test('terminal/spawn removes a dead registration and replaces it', async () => {
  let ptyCount = 0;
  const start = spyOn(PreviewTerminal.prototype, 'start').mockImplementation(function (this: PreviewTerminal) {
    ptyCount++;
    (this as unknown as { alive: boolean }).alive = true;
  });
  try {
    const { conn, a, b } = await boot();
    await conn.extMethod('terminal/spawn', { sessionId: a, terminalId: 'term-x' });
    const dead = lookupPreviewTerminal(a, 'term-x')!;
    (dead as unknown as { alive: boolean }).alive = false;
    expect(await conn.extMethod('terminal/spawn', { sessionId: b, terminalId: 'term-x' }))
      .toMatchObject({ status: 'spawned', sessionId: b });
    expect(ptyCount).toBe(2);
    expect(lookupPreviewTerminal(a, 'term-x')).toBeNull();
    expect(lookupPreviewTerminal(b, 'term-x')).not.toBe(dead);
    expect(listAllPreviewTerminals()).toHaveLength(1);
    const replacement = lookupPreviewTerminal(b, 'term-x')!;
    (replacement as unknown as { alive: boolean }).alive = false;
    expect(await conn.extMethod('terminal/spawn', { sessionId: b, terminalId: 'term-x' }))
      .toMatchObject({ status: 'spawned', sessionId: b });
    expect(ptyCount).toBe(3);
    expect(listAllPreviewTerminals()).toHaveLength(1);
  } finally { start.mockRestore(); }
});
