// PLAN-ios-rich-dev-feedback-hydrate · M1-S (2026-05-13) —
// `getActiveAcpFeedbackBroadcaster` wire tests.
//
// Invariants under test:
//  1. Returns null when no `runAcpServer` is up.
//  2. Fans out `{sessionUpdate: 'feedback', envelope}` to every peer
//     attached to the sessionId (multi-peer parity with PWA SSE).
//  3. Envelope payload survives wire round-trip unchanged (Codable
//     mirror on the iOS side relies on this for fixture-based decode
//     tests).
//  4. `delivered` count matches the underlying peer fan-out.
//  5. Empty sessionId / unknown sessionId → delivered:0, no throw.
//  6. Only peers advertising `clientCapabilities._meta.elanous` get
//     envelopes (#22475) — a plain ACP client (Zed …) gets nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ClientSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

import {
  getActiveAcpFeedbackBroadcaster,
  runAcpServer,
} from '../src/acp/server.js';
import { createInProcessAcpBridge } from '../src/tui-client/acp-transport-local.js';
import type {
  AcpConnectionHandler,
  AcpTransportConnection,
  AcpTransportServer,
} from '../src/acp/transport/index.js';
import { DualRoleManager } from '../src/acp/dual-role-manager.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
  type AgentThinkingPayload,
  type ToolSearchHitPayload,
} from '../src/feedback/envelope.js';
import { parseElanousFeedbackEnvelope } from '../src/acp/elanous-extensions.js';

interface ClientChannel {
  conn: ClientSideConnection;
  updates: Array<{ sessionId: string; update: unknown }>;
  disconnect: () => Promise<void>;
}

interface FanoutHarness {
  shutdown(): Promise<void>;
  channels: ClientChannel[];
  initializeAndNewSession: (idx: number, opts?: { aware?: boolean }) => Promise<string>;
  initializeAndLoadSession: (idx: number, sessionId: string, opts?: { aware?: boolean }) => Promise<void>;
}

// #22475 — feedback envelopes go only to connections that declare `_meta.elanous`.
const AWARE_CAPS = { _meta: { elanous: { ui: { showToast: true } } } };
const capsFor = (aware = true) => (aware ? AWARE_CAPS : {});

async function bootFanoutServer(opts: { numClients: number }): Promise<FanoutHarness> {
  const bridges = Array.from({ length: opts.numClients }, () => createInProcessAcpBridge());
  const shutdownCtrl = new AbortController();
  const closes: Array<() => Promise<void>> = bridges.map((b) => async () => {
    try { await b.a.writable.close(); } catch { /* already */ }
  });

  const transportFactory = async (
    onConnection: AcpConnectionHandler,
  ): Promise<AcpTransportServer> => {
    for (let i = 0; i < bridges.length; i += 1) {
      const b = bridges[i]!;
      const conn: AcpTransportConnection = {
        readable: b.a.readable,
        writable: b.a.writable,
        peerId: `feedback-peer-${i}`,
        close: closes[i]!,
      };
      Promise.resolve(onConnection(conn)).catch(() => { /* swallow */ });
    }
    return {
      kind: 'in-process' as const,
      address: 'feedback-stub://',
      close: async () => {
        for (const c of closes) {
          try { await c(); } catch { /* ignore */ }
        }
      },
    };
  };

  const dualRole = new DualRoleManager();
  const acpDone = runAcpServer({
    transportFactory,
    shutdownSignal: shutdownCtrl.signal,
    dualRoleManager: dualRole,
    hasSession: () => true,
  });
  acpDone.catch(() => { /* aborted */ });

  const channels: ClientChannel[] = bridges.map((b, i) => {
    const updates: ClientChannel['updates'] = [];
    const stream = ndJsonStream(b.b.writable, b.b.readable);
    const conn = new ClientSideConnection(() => ({
      async sessionUpdate(notification: { sessionId: string; update: unknown }) {
        updates.push({ sessionId: notification.sessionId, update: notification.update });
      },
      async requestPermission() {
        return { outcome: { outcome: 'cancelled' as const } };
      },
    }), stream);
    return {
      conn,
      updates,
      disconnect: async () => {
        try { await b.b.writable.close(); } catch { /* already */ }
        try { await b.a.writable.close(); } catch { /* already */ }
        closes[i] = async () => { /* already */ };
      },
    };
  });

  const initializeAndNewSession: FanoutHarness['initializeAndNewSession'] = async (idx, o) => {
    const ch = channels[idx]!;
    await ch.conn.initialize({ protocolVersion: 1, clientCapabilities: capsFor(o?.aware) });
    const resp = await ch.conn.newSession({ cwd: process.cwd(), mcpServers: [] });
    return resp.sessionId;
  };

  const initializeAndLoadSession: FanoutHarness['initializeAndLoadSession'] = async (idx, sessionId, o) => {
    const ch = channels[idx]!;
    await ch.conn.initialize({ protocolVersion: 1, clientCapabilities: capsFor(o?.aware) });
    await ch.conn.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });
  };

  return {
    channels,
    initializeAndNewSession,
    initializeAndLoadSession,
    async shutdown() {
      shutdownCtrl.abort();
      for (const c of closes) {
        try { await c(); } catch { /* ignore */ }
      }
      try { await acpDone; } catch { /* aborted */ }
    },
  };
}

function feedbackEnvelopesOf(channel: ClientChannel, sessionId: string): FeedbackEnvelope[] {
  return channel.updates
    .filter((u) => u.sessionId === sessionId)
    .map((u) => u.update as { sessionUpdate: string; content?: { type: string; text?: string } })
    .filter(
      (u) =>
        u.sessionUpdate === 'agent_thought_chunk' &&
        u.content?.type === 'text' &&
        typeof u.content.text === 'string' &&
        u.content.text.startsWith('[elanous/feedback/'),
    )
    .map((u) => parseElanousFeedbackEnvelope(u.content!.text!))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
    .map((parsed) => parsed.payload);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildThinkingEnvelope(sessionId: string): FeedbackEnvelope {
  const seqTracker = createSeqTracker();
  const payload: AgentThinkingPayload = {
    msg: 'reading source',
    metrics: { elapsedMs: 420, tokenCount: 17 },
  };
  return makeEnvelope(
    {
      kind: 'agent.thinking',
      phase: 'start',
      sessionId,
      blockId: `${sessionId}:thinking:turn-1`,
      payload,
      asciiFallback: ['⌁ thinking (420ms · 17 tokens)'],
      now: () => 1_700_000_000_000,
    },
    seqTracker,
  );
}

function buildSearchHitEnvelope(sessionId: string): FeedbackEnvelope {
  const seqTracker = createSeqTracker();
  const payload: ToolSearchHitPayload = {
    query: 'broadcastFeedback',
    hits: [
      { filePath: 'src/acp/server.ts', line: 573, snippet: 'function getActiveAcp…' },
      { filePath: 'src/nexus/api/meta-api.ts', line: 810, snippet: 'dualEmitFeedback' },
    ],
    accumCount: 2,
  };
  return makeEnvelope(
    {
      kind: 'tool.search-hit',
      phase: 'delta',
      sessionId,
      blockId: `${sessionId}:grep:tc-7`,
      parentToolCallId: 'tc-7',
      payload,
      asciiFallback: ['src/acp/server.ts:573', 'src/nexus/api/meta-api.ts:810'],
      now: () => 1_700_000_000_000,
    },
    seqTracker,
  );
}

let harness: FanoutHarness | null = null;

beforeEach(() => { harness = null; });
afterEach(async () => {
  if (harness) {
    try { await harness.shutdown(); } catch { /* ignore */ }
    harness = null;
  }
});

describe('getActiveAcpFeedbackBroadcaster — wire shape', () => {
  test('returns null when no runAcpServer is up', () => {
    expect(getActiveAcpFeedbackBroadcaster()).toBeNull();
  });

  test('fans out feedback envelope to every peer on the sessionId', async () => {
    harness = await bootFanoutServer({ numClients: 2 });
    const sid = await harness.initializeAndNewSession(0);
    await harness.initializeAndLoadSession(1, sid);

    const broadcaster = getActiveAcpFeedbackBroadcaster();
    expect(broadcaster).not.toBeNull();

    const env = buildThinkingEnvelope(sid);
    const { delivered } = await broadcaster!(sid, env);
    expect(delivered).toBe(2);

    await waitFor(() =>
      feedbackEnvelopesOf(harness!.channels[0]!, sid).length > 0 &&
      feedbackEnvelopesOf(harness!.channels[1]!, sid).length > 0,
    );

    const a = feedbackEnvelopesOf(harness.channels[0]!, sid);
    const b = feedbackEnvelopesOf(harness.channels[1]!, sid);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // Same envelope on both peers — wire shape is identical.
    expect(a[0]).toEqual(env);
    expect(b[0]).toEqual(env);
  });

  test('skips a plain peer (no _meta.elanous) while an aware peer on the same session still receives', async () => {
    harness = await bootFanoutServer({ numClients: 2 });
    const sid = await harness.initializeAndNewSession(0);
    await harness.initializeAndLoadSession(1, sid, { aware: false });

    const env = buildThinkingEnvelope(sid);
    const { delivered } = await getActiveAcpFeedbackBroadcaster()!(sid, env);
    expect(delivered).toBe(1);

    await waitFor(() => feedbackEnvelopesOf(harness!.channels[0]!, sid).length > 0);
    expect(feedbackEnvelopesOf(harness.channels[0]!, sid)).toEqual([env]);
    expect(feedbackEnvelopesOf(harness.channels[1]!, sid)).toEqual([]);
  });

  test('delivers nothing when every peer on the session is plain', async () => {
    harness = await bootFanoutServer({ numClients: 1 });
    const sid = await harness.initializeAndNewSession(0, { aware: false });

    const { delivered } = await getActiveAcpFeedbackBroadcaster()!(sid, buildThinkingEnvelope(sid));
    expect(delivered).toBe(0);
    expect(feedbackEnvelopesOf(harness.channels[0]!, sid)).toEqual([]);
  });

  test('preserves payload narrowing across wire round-trip', async () => {
    harness = await bootFanoutServer({ numClients: 1 });
    const sid = await harness.initializeAndNewSession(0);

    const broadcaster = getActiveAcpFeedbackBroadcaster();
    const env = buildSearchHitEnvelope(sid);
    await broadcaster!(sid, env);

    await waitFor(() => feedbackEnvelopesOf(harness!.channels[0]!, sid).length > 0);

    const received = feedbackEnvelopesOf(harness.channels[0]!, sid)[0]!;
    expect(received.kind).toBe('tool.search-hit');
    expect(received.parentToolCallId).toBe('tc-7');
    expect(received.phase).toBe('delta');
    if (received.kind === 'tool.search-hit') {
      expect(received.payload.query).toBe('broadcastFeedback');
      expect(received.payload.hits).toHaveLength(2);
      expect(received.payload.accumCount).toBe(2);
    }
    expect(received.asciiFallback).toEqual([
      'src/acp/server.ts:573',
      'src/nexus/api/meta-api.ts:810',
    ]);
  });

  test('reports delivered:0 for an unknown sessionId without throwing', async () => {
    harness = await bootFanoutServer({ numClients: 1 });
    await harness.initializeAndNewSession(0);

    const broadcaster = getActiveAcpFeedbackBroadcaster();
    const env = buildThinkingEnvelope('no-such-session');
    const { delivered } = await broadcaster!('no-such-session', env);
    expect(delivered).toBe(0);
  });

  test('wraps payload as elanous/feedback/emit inside agent_thought_chunk', async () => {
    harness = await bootFanoutServer({ numClients: 1 });
    const sid = await harness.initializeAndNewSession(0);

    const broadcaster = getActiveAcpFeedbackBroadcaster();
    const env = buildThinkingEnvelope(sid);
    await broadcaster!(sid, env);

    await waitFor(() => harness!.channels[0]!.updates.length > 0);

    const raw = harness.channels[0]!.updates.find(
      (u) => (u.update as { sessionUpdate?: string }).sessionUpdate === 'agent_thought_chunk',
    );
    expect(raw).toBeDefined();
    const update = raw!.update as {
      sessionUpdate: string;
      content: { type: string; text: string };
    };
    expect(update.sessionUpdate).toBe('agent_thought_chunk');
    expect(update.content.type).toBe('text');
    expect(update.content.text.startsWith(`[elanous/feedback/emit] ${env.blockId}`)).toBe(true);
    expect(update.content.text.includes(`<<elanous-feedback-end ${env.blockId}>>`)).toBe(true);
    const parsed = parseElanousFeedbackEnvelope(update.content.text);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('emit');
    expect(parsed!.payload).toEqual(env);
  });
});
