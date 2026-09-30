// NEXUS N-1.5 PR c — /v1/acp + /v1/voice/ws WS bridge tests.
//
// Boots a NEXUS HTTP server with the WS bridge wired and verifies:
//  · `/v1/acp` upgrade returns 404 when no handler provided
//  · `/v1/voice/ws` upgrade returns 404 when adapter unavailable
//  · `/v1/acp` upgrade succeeds when acpOnConnection is supplied
//  · `/v1/voice/ws` upgrade succeeds when adapter is available
//  · Non-WS routes still work unchanged when bridge is wired

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import type { AcpConnectionHandler } from '../src/acp/transport/types.js';
import type { PwaVoiceAdapter, PwaVoiceSession } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-ws-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture(): {
  state: ReturnType<typeof createNexusState>;
  registry: TabRegistry;
  bus: NexusEventBus;
} {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'N-1.5 PR c' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  return { state, registry, bus };
}

function uniquePort(): number {
  return 43000 + Math.floor(Math.random() * 2000);
}

function makeAcpHandler(): { handler: AcpConnectionHandler; called: { count: number } } {
  const called = { count: 0 };
  const handler: AcpConnectionHandler = async () => {
    called.count += 1;
  };
  return { handler, called };
}

function makeVoiceAdapter(available: boolean): PwaVoiceAdapter {
  const session: PwaVoiceSession = {
    pushUpstream: () => { /* noop */ },
    finalize: async () => { /* noop */ },
    close: async () => { /* noop */ },
    onDownstream: () => () => { /* noop */ },
    onStateChange: () => () => { /* noop */ },
  } as unknown as PwaVoiceSession;
  return {
    available,
    openSession: async () => session,
  } as unknown as PwaVoiceAdapter;
}

describe('NEXUS WS bridge — /v1/acp + /v1/voice/ws (PR c)', () => {
  test('without wsBridge or metaApi, /v1/acp returns 401 before HTTP fallback', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/acp`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('without wsBridge or metaApi, /v1/voice/ws returns 401 before HTTP fallback', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/voice/ws`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('without wsBridge, authenticated /v1/acp returns 404', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      const res = await fetch(`${srv.url}/v1/acp`, { headers: { authorization: 'Bearer test-token' } });
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('without wsBridge, authenticated /v1/voice/ws returns 404', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      const res = await fetch(`${srv.url}/v1/voice/ws`, { headers: { authorization: 'Bearer test-token' } });
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('with wsBridge but no acpOnConnection, /v1/acp returns 404', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
      wsBridge: { trace: () => { /* silent */ } },
    });
    try {
      const res = await fetch(`${srv.url}/v1/acp`, { headers: { authorization: 'Bearer test-token' } });
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('with wsBridge but adapter unavailable, /v1/voice/ws returns 404', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
      wsBridge: {
        voiceAdapter: makeVoiceAdapter(/* available */ false),
        trace: () => { /* silent */ },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/voice/ws`);
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('with acpOnConnection, /v1/acp accepts WebSocket upgrade', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const { handler, called } = makeAcpHandler();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
      wsBridge: { acpOnConnection: handler, trace: () => { /* silent */ } },
    });
    try {
      const ws = new WebSocket(`ws://${srv.hostname}:${srv.port}/v1/acp`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('ws open failed')));
      });
      // Give the bridge a tick to invoke acpOnConnection (no-auth path).
      const deadline = Date.now() + 1500;
      while (called.count === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(called.count).toBe(1);
      ws.close();
    } finally { srv.stop(); }
  });

  test('with available voiceAdapter, /v1/voice/ws accepts WebSocket upgrade', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const adapter = makeVoiceAdapter(/* available */ true);
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
      wsBridge: { voiceAdapter: adapter, trace: () => { /* silent */ } },
    });
    try {
      const ws = new WebSocket(`ws://${srv.hostname}:${srv.port}/v1/voice/ws`);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener('open', () => resolve(true));
        ws.addEventListener('error', () => resolve(false));
      });
      expect(opened).toBe(true);
      ws.close();
    } finally { srv.stop(); }
  });

  test('non-WS routes (e.g. /v1/health) work even when bridge is wired', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const { handler } = makeAcpHandler();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
      wsBridge: {
        acpOnConnection: handler,
        voiceAdapter: makeVoiceAdapter(true),
        trace: () => { /* silent */ },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    } finally { srv.stop(); }
  });
});
