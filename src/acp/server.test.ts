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

test('plain initialize sees model text and real thought, never feedback; aware peer alone receives per-session and HUD envelopes', async () => {
  const bridges = [createInProcessAcpBridge(), createInProcessAcpBridge()];
  const updates: unknown[][] = [[], []];
  const abort = new AbortController();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
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
    expect(log.mock.calls.filter(([category, event]) => category === 'acp.envelope' && event === 'skipped-plain-client')).toEqual([
      ['acp.envelope', 'skipped-plain-client', { sessionId, kind: 'feedback' }],
      ['acp.envelope', 'skipped-plain-client', { sessionId: plainSession, kind: 'feedback' }],
    ]);
  } finally {
    abort.abort();
    await server;
    log.mockRestore();
  }
});
