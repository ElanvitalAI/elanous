import { expect, spyOn, test } from 'bun:test';
import { ClientSideConnection, ndJsonStream, type ClientCapabilities } from '@agentclientprotocol/sdk';
import { createInProcessAcpBridge } from '../tui-client/acp-transport-local.js';
import { runAcpServer, getActiveAcpBroadcaster, getActiveAcpFeedbackBroadcaster, getActiveAcpAllSessionsFeedbackBroadcaster } from './server.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';
import type { AcpConnectionHandler, AcpTransportServer } from './transport/index.js';
import { debug } from '../debug/log.js';

const feedback = (sessionId: string): FeedbackEnvelope => ({
  envelopeVersion: 1, sessionId, blockId: 'turn-1', kind: 'hud.segment',
  phase: 'update', emittedAt: Date.now(), seq: 1, asciiFallback: [],
  payload: { key: 'test', value: 'ready' },
});

function content(chunks: unknown[], kind: string): string[] {
  return chunks.flatMap((u) => {
    const update = u as { sessionUpdate: string; content?: { text?: string } };
    return update.sessionUpdate === kind && update.content?.text ? [update.content.text] : [];
  });
}

test('DEBUG-GATE-INSIDE-LOG: lazy payload evaluation waits for logger gates', () => {
  const previousLevel = debug.level();
  const previousDiagEnabled = debug.isDiagEnabled();
  const previousRenderSuppressed = debug.isRenderSuppressed();
  const records: { category: string; event: string }[] = [];
  const unregister = debug.registerSink({ emit: ({ category, event }) => { records.push({ category, event }); } } as Parameters<typeof debug.registerSink>[0]);
  let evaluated = 0;
  try {
    debug.setLevel('off');
    debug.log('acp.test', 'lazy-off', () => { evaluated += 1; return { value: 'unused' }; });
    expect(evaluated).toBe(0);

    debug.setDiagEnabled(true);
    debug.setRenderSuppressed(true);
    debug.log('render.frame', 'lazy-muted', () => { evaluated += 1; return { value: 'muted' }; });
    expect(evaluated).toBe(0);

    debug.setRenderSuppressed(false);
    debug.log('acp.test', 'lazy-on', () => { evaluated += 1; return { value: 'used' }; });
    expect(evaluated).toBe(1);

    debug.setLevel('trail');
    debug.log('acp.test', 'eager-trail', { value: 'preserved' });
    expect(records.some(({ category, event }) => category === 'acp.test' && event === 'eager-trail')).toBe(true);
  } finally {
    unregister();
    debug.setRenderSuppressed(previousRenderSuppressed);
    debug.setDiagEnabled(previousDiagEnabled);
    debug.setLevel(previousLevel);
  }
});

test('runAcpServer routes filtered and enabled terminal attachment diagnostics through debug.log', async () => {
  const bridge = createInProcessAcpBridge();
  const abort = new AbortController();
  const previousLevel = debug.level();
  const previousDiagEnabled = debug.isDiagEnabled();
  const records: { category: string; event: string; data?: unknown }[] = [];
  let lazyPayloadEvaluations = 0;
  const originalLog = debug.log.bind(debug);
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data, opts) => {
    if (category === 'webterm.acp' && event === 'repl.attachments.dropped' && typeof data === 'function') {
      const lazyPayload = data as () => unknown;
      originalLog(category, event, () => {
        lazyPayloadEvaluations += 1;
        return lazyPayload();
      }, opts);
      return;
    }
    originalLog(category, event, data, opts);
  });
  const unregister = debug.registerSink({ emit: (record) => { records.push(record); } } as Parameters<typeof debug.registerSink>[0]);
  debug.setLevel('off');
  debug.setDiagEnabled(false);
  const server = runAcpServer({
    shutdownSignal: abort.signal,
    transportFactory: async (onConnection: AcpConnectionHandler): Promise<AcpTransportServer> => {
      void onConnection({
        readable: bridge.a.readable,
        writable: bridge.a.writable,
        peerId: 'lazy-log-test',
        close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
      });
      return {
        kind: 'in-process', address: 'test://lazy-log',
        close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
      };
    },
    runTurn: async () => {},
  });
  const client = new ClientSideConnection(() => ({
    async sessionUpdate() {},
    async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
  }), ndJsonStream(bridge.b.writable, bridge.b.readable));
  try {
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    await client.extMethod('terminal/repl/exec', {
      sessionId, line: ':help', attachments: [{}],
    });
    expect(logSpy.mock.calls.some(([category, event]) => category === 'webterm.acp' && event === 'repl.attachments.dropped')).toBe(true);
    expect(records.some(({ category, event }) => category === 'webterm.acp' && event === 'repl.attachments.dropped')).toBe(false);
    expect(lazyPayloadEvaluations).toBe(0);

    debug.setDiagEnabled(true);
    await client.extMethod('terminal/repl/exec', {
      sessionId, line: ':help', attachments: [{}],
    });
    expect(lazyPayloadEvaluations).toBe(1);
    const dropped = records.find(({ category, event }) => category === 'webterm.acp' && event === 'repl.attachments.dropped');
    expect(dropped?.data).toMatchObject({
      sessionId, requestedCount: 1, acceptedCount: 0, droppedCount: 1,
    });
  } finally {
    abort.abort();
    await server;
    unregister();
    logSpy.mockRestore();
    debug.setDiagEnabled(previousDiagEnabled);
    debug.setLevel(previousLevel);
  }
});

test('plain initialize sees model text and real thought, never feedback; aware peer alone receives per-session and HUD envelopes', async () => {
  const bridges = [createInProcessAcpBridge(), createInProcessAcpBridge()];
  const updates: unknown[][] = [[], []];
  const abort = new AbortController();
  const log = spyOn(debug, 'log');
  const previousLevel = debug.level();
  debug.setLevel('off');
  const server = runAcpServer({
    shutdownSignal: abort.signal,
    transportFactory: async (onConnection: AcpConnectionHandler): Promise<AcpTransportServer> => {
      bridges.forEach((bridge, i) => {
        void onConnection({
          readable: bridge.a.readable, writable: bridge.a.writable,
          peerId: `peer-${i}`,
          close: async () => { try { await bridge.a.writable.close(); } catch { /* closed */ } },
        });
      });
      return {
        kind: 'in-process', address: 'test://feedback',
        close: async () => {
          for (const bridge of bridges) {
            try { await bridge.a.writable.close(); } catch { /* closed */ }
          }
        },
      };
    },
    runTurn: async (turn) => {
      await turn.push('model response');
      await turn.pushSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'real reasoning' } });
    },
  });
  const clients = bridges.map((bridge, i) => new ClientSideConnection(() => ({
    async sessionUpdate(notification: { update: unknown }) { updates[i]!.push(notification.update); },
    async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
  }), ndJsonStream(bridge.b.writable, bridge.b.readable)));
  try {
    const awareCaps = { _meta: { elanous: { ui: { showToast: true } } } } as unknown as ClientCapabilities;
    await clients[0]!.initialize({ protocolVersion: 1, clientCapabilities: awareCaps });
    const { sessionId } = await clients[0]!.newSession({ cwd: process.cwd(), mcpServers: [] });
    await clients[1]!.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await clients[1]!.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });
    await clients[1]!.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    const send = getActiveAcpFeedbackBroadcaster();
    expect(send).not.toBeNull();
    expect(await send!(sessionId, feedback(sessionId))).toEqual({ delivered: 1 });
    const hud = getActiveAcpAllSessionsFeedbackBroadcaster();
    expect(await hud!(feedback(sessionId))).toEqual({ delivered: 1, fannedTo: 1 });
    for (let i = 0; i < 50 && content(updates[0]!, 'agent_thought_chunk').filter((s) => s.startsWith('[elanous/feedback/emit] turn-1')).length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(content(updates[0]!, 'agent_thought_chunk').filter((s) => s.startsWith('[elanous/feedback/emit] turn-1'))).toHaveLength(2);
    expect(content(updates[1]!, 'agent_thought_chunk')).toContain('real reasoning');
    expect(content(updates[1]!, 'agent_thought_chunk').join('')).not.toContain('elanous/feedback/emit');
    expect(content(updates[1]!, 'agent_message_chunk')).toContain('model response');
    const plainSession = (await clients[1]!.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId;
    expect(await send!(plainSession, feedback(plainSession))).toEqual({ delivered: 0 });
    expect(await hud!(feedback(sessionId))).toEqual({ delivered: 1, fannedTo: 1 });
    const raw = getActiveAcpBroadcaster();
    const bypass = {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '[elanous/feedback/emit] raw-bypass' },
    };
    expect(await raw!(sessionId, bypass)).toEqual({ delivered: 1 });
    expect(await raw!(plainSession, bypass)).toEqual({ delivered: 0 });
    for (let i = 0; i < 50 && !content(updates[0]!, 'agent_thought_chunk').includes(bypass.content.text); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(content(updates[0]!, 'agent_thought_chunk')).toContain(bypass.content.text);
    expect(content(updates[1]!, 'agent_thought_chunk').join('')).not.toContain('elanous/feedback/emit');
    expect(log.mock.calls.some(([category]) => category === 'acp.peer.register')).toBe(true);
    expect(log.mock.calls.filter(([category, event]) => category === 'acp.envelope' && event === 'skipped-plain-client')).toEqual([
      ['acp.envelope', 'skipped-plain-client', { sessionId, kind: 'feedback' }],
      ['acp.envelope', 'skipped-plain-client', { sessionId: plainSession, kind: 'feedback' }],
    ]);
  } finally {
    abort.abort();
    await server;
    debug.setLevel(previousLevel);
    log.mockRestore();
  }
});
