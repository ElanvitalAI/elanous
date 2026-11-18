// CONTEXT-OWNER-ISOLATION-AUDIT H-1 (2026-11-18) — the web response's debug envelope.
// Outermost in-process entry: the real ACP server (runAcpServer) + the real daemon turn wrapper
// (createDaemonRunTurn) + the real feedback broadcaster, driven by ACP clients over in-process
// streams. Only the LLM call is faked; it logs fixed markers that never echo the prompt.
// Key check («다른 세션 문자열 0»): a marker produced in another session is absent from the
// serialized updates this client received.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import '../src/nexus/index.js';
import { runAcpServer } from '../src/acp/server.js';
import { parseElanousFeedbackEnvelope } from '../src/acp/elanous-extensions.js';
import { createAuthVerifier } from '../src/acp/transport/auth.js';
import type { AcpAudience, AcpConnectionHandler, AcpTransportConnection } from '../src/acp/transport/types.js';
import { createDaemonRunTurn, DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import { createWsBridge, WS_ACP_PATH, type WsLike } from '../src/boot/ws-bridge.js';
import { debug, getAmbientSessionId, setAmbientSessionId, withAmbientSessionScope } from '../src/debug/log.js';
import { normalizeDebugAudience, readDebugTapRequest } from '../src/feedback/debug-bridge.js';
import type { FeedbackEnvelope } from '../src/feedback/envelope.js';
import * as llmModule from '../src/llm.js';
import type { LLMMessage } from '../src/llm.js';
import type { LogRecord } from '../src/mss/logging/record.js';
import { requestDebugAudience } from '../src/nexus/api/debug-audience.js';
import type { MetaApiOpts } from '../src/nexus/api/meta-api.js';
import { createInProcessAcpBridge } from '../src/tui-client/acp-transport-local.js';

const AWARE_CAPS = { _meta: { elanous: { ui: { showToast: true } } } };
const TAP = { elanous: { debugTap: true } };
// Test-owned table: prompt word → marker the fake logs. Markers share nothing with the prompt.
const MARKER_FOR: Record<string, string> = { alpha: 'A-OWN-91d0', gamma: 'C-OWN-4b2e', beta: 'M-OWN-3c7a' };

type Client = { conn: ClientSideConnection; updates: Array<{ sessionId: string; update: unknown }> };
let streamImpl: (word: string) => Promise<void> = async () => {};
let shutdown: (() => Promise<void>) | null = null;
const records: LogRecord[] = [];
let unregisterSink: (() => void) | null = null;

beforeEach(() => {
  records.length = 0;
  unregisterSink = debug.registerSink({ name: 'h1-test-capture', emit: (rec) => { records.push(rec); } });
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation((async (messages: LLMMessage[]) => {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const word = Object.keys(MARKER_FOR).find((w) => text.includes(w)) ?? '';
    await streamImpl(word);
    return 'ok';
  }) as typeof llmModule.streamLLMWithTools);
});

afterEach(async () => {
  try { if (shutdown) await shutdown(); } finally {
    shutdown = null;
    unregisterSink?.();
    unregisterSink = null;
    streamImpl = async () => {};
    mock.restore();
  }
});

async function boot(audiences: Array<AcpAudience | undefined>): Promise<Client[]> {
  const bridges = audiences.map(() => createInProcessAcpBridge());
  const ctrl = new AbortController();
  const done = runAcpServer({
    transportFactory: async (onConnection: AcpConnectionHandler) => {
      bridges.forEach((b, i) => {
        const conn: AcpTransportConnection = {
          readable: b.a.readable, writable: b.a.writable, peerId: `h1-peer-${i}`,
          ...(audiences[i] ? { audience: audiences[i] } : {}),
          close: async () => { try { await b.a.writable.close(); } catch { /* closed */ } },
        };
        void Promise.resolve(onConnection(conn)).catch(() => {});
      });
      return { kind: 'in-process' as const, address: 'h1://', close: async () => {} };
    },
    shutdownSignal: ctrl.signal,
    hasSession: () => true,
    runTurn: createDaemonRunTurn(new DaemonSessionHistory()),
  });
  done.catch(() => {});
  shutdown = async () => {
    ctrl.abort();
    for (const b of bridges) { try { await b.b.writable.close(); } catch { /* closed */ } }
    try { await done; } catch { /* aborted */ }
  };
  return bridges.map((b) => {
    const updates: Client['updates'] = [];
    const conn = new ClientSideConnection(() => ({
      async sessionUpdate(n: { sessionId: string; update: unknown }) { updates.push(n); },
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(b.b.writable, b.b.readable));
    return { conn, updates };
  });
}

async function openSession(c: Client): Promise<string> {
  await c.conn.initialize({ protocolVersion: 1, clientCapabilities: AWARE_CAPS });
  return (await c.conn.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId;
}

function prompt(c: Client, sessionId: string, word: string, meta?: Record<string, unknown>) {
  return c.conn.prompt({ sessionId, prompt: [{ type: 'text', text: word }], ...(meta ? { _meta: meta } : {}) });
}

/** Every debug.line frame exactly as it arrived on the wire (ACP text) with its parsed envelope. */
function debugFrames(c: Client): Array<{ bytes: number; env: Extract<FeedbackEnvelope, { kind: 'debug.line' }> }> {
  return c.updates
    .map((u) => u.update as { sessionUpdate?: string; content?: { type?: string; text?: string } })
    .filter((u) => u.sessionUpdate === 'agent_thought_chunk' && typeof u.content?.text === 'string')
    .map((u) => ({ bytes: Buffer.byteLength(u.content!.text!), env: parseElanousFeedbackEnvelope(u.content!.text!)?.payload }))
    .filter((f): f is { bytes: number; env: Extract<FeedbackEnvelope, { kind: 'debug.line' }> } => f.env?.kind === 'debug.line');
}

function debugLines(c: Client): Extract<FeedbackEnvelope, { kind: 'debug.line' }>[] {
  return debugFrames(c).map((f) => f.env);
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const logOwn = (word: string) => debug.log('chat.assistant-text', 'final', { preview: MARKER_FOR[word] ?? 'NO-MARKER' });

describe('H-1 web debug envelope · concurrent sessions on one daemon', () => {
  test('operator web-A receives only its own lines — 0 strings from web-C, a TUI-like session, unscoped or fallback-stamped lines', async () => {
    const [a, c] = await boot(['operator', 'operator']);
    const sidA = await openSession(a!);
    const sidC = await openSession(c!);
    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((r) => { bothStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    streamImpl = async (word) => {
      logOwn(word);
      started += 1;
      if (started === 2) bothStarted();
      await gate;
    };
    const turnA = prompt(a!, sidA, 'alpha', TAP);
    const turnC = prompt(c!, sidC, 'gamma', TAP);
    await ready;
    const previousFallback = getAmbientSessionId();
    try {
      withAmbientSessionScope('tui-B', () => debug.log('chat.user-message', 'submitted', { preview: 'B-SECRET-7f3c' }));
      setAmbientSessionId(null);
      debug.log('chat.tool-call', 'x', { args: 'NOSCOPE-22aa' });
      setAmbientSessionId(sidA); // process-wide REPL fallback pointing at web-A must not count as web-A
      debug.log('chat.tool-result', 'x', { preview: 'FALLBACK-6d1e' });
    } finally {
      setAmbientSessionId(previousFallback);
      release();
    }
    await Promise.all([turnA, turnC]);
    await settle();
    const wireA = JSON.stringify(a!.updates);
    const wireC = JSON.stringify(c!.updates);
    expect(wireA).toContain('A-OWN-91d0');
    for (const foreign of ['B-SECRET-7f3c', 'NOSCOPE-22aa', 'FALLBACK-6d1e', 'C-OWN-4b2e']) expect(wireA).not.toContain(foreign);
    expect(wireC).toContain('C-OWN-4b2e');
    for (const foreign of ['B-SECRET-7f3c', 'NOSCOPE-22aa', 'FALLBACK-6d1e', 'A-OWN-91d0']) expect(wireC).not.toContain(foreign);
    expect(debugLines(a!).every((env) => env.sessionId === sidA)).toBe(true);
    // Never silent: web-A's bridge leaves a counter row for what it dropped.
    const summaryA = records.find((r) => r.category === 'feedback.debug-bridge' && (r.data as { sessionId?: string }).sessionId === sidA);
    expect((summaryA?.data as { missingSession: number }).missingSession).not.toBe(0);
    expect((summaryA?.data as { otherSession: number }).otherSession).not.toBe(0);
  });
});

describe('H-1 web debug envelope · per-peer delivery on one shared session', () => {
  test('operator requests debug: operator peers receive it; member and unknown peers on the same session get 0', async () => {
    const [op1, member, unknown, op2] = await boot(['operator', 'member', undefined, 'operator']);
    const sid = await openSession(op1!);
    for (const c of [member!, unknown!, op2!]) {
      await c.conn.initialize({ protocolVersion: 1, clientCapabilities: AWARE_CAPS });
      await c.conn.loadSession({ sessionId: sid, cwd: process.cwd(), mcpServers: [] });
    }
    streamImpl = async () => {
      debug.log('chat.assistant-text', 'final', { preview: 'PEER-OWN-5d5d' });
      debug.log('chat.tool-result', 'x', { preview: 'PEER-TOOL-6e6e' });
    };
    await prompt(op1!, sid, 'alpha', TAP);
    await settle();
    for (const c of [op1!, op2!]) {
      expect(JSON.stringify(c.updates)).toContain('PEER-OWN-5d5d');
      expect(debugLines(c)).not.toHaveLength(0);
    }
    for (const c of [member!, unknown!]) {
      expect(debugLines(c)).toHaveLength(0);
      const wire = JSON.stringify(c.updates);
      for (const planted of ['PEER-OWN-5d5d', 'PEER-TOOL-6e6e', 'debug.line']) expect(wire).not.toContain(planted);
    }
    // Never silent: the withheld deliveries leave a row.
    expect(records.some((r) => r.category === 'feedback.debug-gate' && r.event === 'peer-withheld')).toBe(true);
  });
});

describe('H-1 web debug envelope · audience × requested', () => {
  const cells: Array<[string, AcpAudience | undefined, Record<string, unknown> | undefined, boolean]> = [
    ['operator · requested', 'operator', TAP, true],
    ['operator · not requested', 'operator', undefined, false],
    ['operator · debugTap "true" string', 'operator', { elanous: { debugTap: 'true' } }, false],
    ['member · requested', 'member', TAP, false],
    ['member · not requested', 'member', undefined, false],
    ['unknown (no audience) · requested', undefined, TAP, false],
    ['unknown (no audience) · not requested', undefined, undefined, false],
  ];
  for (const [name, audience, meta, expectOn] of cells) {
    test(name, async () => {
      const [cl] = await boot([audience]);
      const sid = await openSession(cl!);
      streamImpl = async (word) => { logOwn(word); };
      await prompt(cl!, sid, 'beta', meta);
      await settle();
      const wire = JSON.stringify(cl!.updates);
      if (expectOn) {
        expect(wire).toContain('M-OWN-3c7a');
        expect(debugLines(cl!)).not.toHaveLength(0);
      } else {
        expect(wire).not.toContain('M-OWN-3c7a');
        expect(debugLines(cl!)).toHaveLength(0);
      }
      const refused = records.some((r) => r.category === 'feedback.debug-gate' && r.event === 'refused');
      expect(refused).toBe(!expectOn && readDebugTapRequest(meta));
    });
  }
});

describe('H-1 web debug envelope · size caps', () => {
  // Byte-exact literals need payloads without run/arm enrichment (log.ts adds these env values to data).
  const ENRICH = ['ELANOUS_RUN_ID', 'ELANOUS_SUBSTRATE', 'ELANOUS_ARM_ID', 'ELANOUS_HOST_ID'] as const;
  const savedEnv: Partial<Record<(typeof ENRICH)[number], string>> = {};
  beforeEach(() => { for (const k of ENRICH) { if (process.env[k] !== undefined) savedEnv[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENRICH) { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; delete savedEnv[k]; } });
  // debug.log compacts each string to 256 chars (non-verbose), so big lines are built from arrays.
  test('a small line arrives whole; a 4 KB line arrives as a truncation marker inside a ≤ 2048 B frame', async () => {
    const [cl] = await boot(['operator']);
    const sid = await openSession(cl!);
    const bigData = { preview: Array.from({ length: 20 }, () => 'Z'.repeat(200)) };
    streamImpl = async () => {
      debug.log('chat.assistant-text', 'small', { preview: 'SMALL-5a5a' });
      debug.log('chat.assistant-text', 'big', bigData);
    };
    await prompt(cl!, sid, 'alpha', TAP);
    await settle();
    const frames = debugFrames(cl!);
    expect((frames.find((f) => f.env.payload.event === 'small')?.env.payload.data as { preview: string }).preview).toBe('SMALL-5a5a');
    const bigFrame = frames.find((f) => f.env.payload.event === 'big')!;
    const big = bigFrame.env.payload.data as { truncated: boolean; originalBytes: number; preview: string };
    expect(big.truncated).toBe(true);
    expect(big.originalBytes).toBe(4073);
    expect(JSON.stringify(bigData).startsWith(big.preview)).toBe(true);
    expect(big.preview).not.toBe('');
    expect(bigFrame.bytes).toBeLessThanOrEqual(2048); // 출처: #38497 H-1 provisional per-line frame cap
  });

  test('past 262144 sent bytes: one marker, counted in the total, and nothing after it (small lines included)', async () => {
    const [cl] = await boot(['operator']);
    const sid = await openSession(cl!);
    streamImpl = async () => {
      for (let i = 0; i < 200; i += 1) debug.log('chat.assistant-text', 'fill', { preview: Array.from({ length: 9 }, () => 'Y'.repeat(200)) });
      for (let i = 0; i < 5; i += 1) debug.log('chat.assistant-text', 'tail', { preview: `TAIL-SMALL-${i}` });
    };
    await prompt(cl!, sid, 'alpha', TAP);
    await settle();
    const frames = debugFrames(cl!);
    const markers = frames.filter((f) => f.env.payload.event === 'response-cap-reached');
    expect(markers).toHaveLength(1);
    // Nothing after the marker: it is the last frame, and no later small line slipped into leftover room.
    expect(frames.at(-1)!.env.payload.event).toBe('response-cap-reached');
    expect(JSON.stringify(cl!.updates)).not.toContain('TAIL-SMALL-');
    expect(frames.filter((f) => f.env.payload.event === 'fill')).not.toHaveLength(200);
    const marker = markers[0]!.env.payload.data as { capBytes: number; sentBytes: number };
    expect(marker.capBytes).toBe(262144);
    const total = frames.reduce((n, f) => n + f.bytes, 0);
    expect(total).toBe(marker.sentBytes + markers[0]!.bytes);
    expect(total).toBeLessThanOrEqual(262144); // 출처: #38497 H-1 provisional per-response cap, marker included
    const summary = records.find((r) => r.category === 'feedback.debug-bridge' && (r.data as { sessionId?: string }).sessionId === sid);
    expect((summary?.data as { overCap: number }).overCap).not.toBe(0);
  });
});

describe('H-1 audience is decided once, at the /v1/acp upgrade', () => {
  const GOOD = 'h1-synthetic-owner-token-0123456789';
  const BAD = 'h1-synthetic-wrong-token-9876543210';
  function upgrade(meta: Partial<MetaApiOpts>, headers: Record<string, string>) {
    let captured: AcpTransportConnection | null = null;
    let data: unknown;
    const bridge = createWsBridge({
      hostname: 'h', port: 1,
      wsAuthVerifier: createAuthVerifier([{ token: GOOD, issuedAt: 0, label: 'default' }]),
      acpAudienceForUpgrade: (req) => requestDebugAudience(req, meta as MetaApiOpts),
      acpOnConnection: (conn) => { captured = conn; },
    });
    const res = bridge.tryUpgrade(new Request(`http://10.9.8.7:1${WS_ACP_PATH}`, { headers: { upgrade: 'websocket', ...headers } }), {
      upgrade: (_req, o) => { data = o?.data; return true; },
    });
    if (res) return { status: res.status, audience: null as AcpAudience | null };
    const ws = { send() {}, close() {}, data } as unknown as WsLike;
    bridge.websocket.open?.(ws);
    return { status: 101, audience: (captured as AcpTransportConnection | null)?.audience ?? null };
  }

  test('owner bearer (header or subprotocol) → operator', () => {
    expect(upgrade({ bearerToken: GOOD }, { authorization: `Bearer ${GOOD}` })).toEqual({ status: 101, audience: 'operator' });
    expect(upgrade({ bearerToken: GOOD }, { 'sec-websocket-protocol': `bearer.${GOOD}` })).toEqual({ status: 101, audience: 'operator' });
  });

  test('verified member wins over a valid bearer → member', () => {
    const member = { bearerToken: GOOD, resolveVerifiedOwner: () => ({ id: 'm-synthetic-1' }) };
    expect(upgrade(member, { authorization: `Bearer ${GOOD}` })).toEqual({ status: 101, audience: 'member' });
  });

  test('noAuth daemon → unknown; wrong bearer still 401 (unchanged)', () => {
    expect(requestDebugAudience(new Request('http://x/v1/prompt/stream'), { noAuth: true } as MetaApiOpts)).toBe('unknown');
    expect(requestDebugAudience(new Request('http://x/v1/prompt/stream'), undefined)).toBe('unknown');
    expect(upgrade({ bearerToken: GOOD }, { authorization: `Bearer ${BAD}` }).status).toBe(401);
  });

  test('audience and request readers fail closed on prototype keys and inherited flags', () => {
    for (const raw of ['constructor', '__proto__', 'toString', 'Operator', '', 1, null]) expect(normalizeDebugAudience(raw)).toBe('unknown');
    expect(normalizeDebugAudience('operator')).toBe('operator');
    expect(readDebugTapRequest(Object.create({ elanous: { debugTap: true } }))).toBe(false);
    expect(readDebugTapRequest({ elanous: Object.create({ debugTap: true }) })).toBe(false);
    expect(readDebugTapRequest({ elanous: { debugTap: true } })).toBe(true);
  });
});
