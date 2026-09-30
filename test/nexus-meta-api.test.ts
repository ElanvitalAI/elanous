// NEXUS N-1.5 PR d — voice / push / attachments meta-API routing tests.
//
// Verifies the route table on NEXUS HTTP server:
//  · without `metaApi` opts → protected paths return 401; public VAPID key stays 503
//  · with authenticated `metaApi` opts but missing dependencies → graceful 503
//  · auth gating respects bearerToken / noAuth

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-meta-api-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  // Ensure web-push subscriptions store + attachment store don't pollute
  // the user's $HOME during the test run.
  setElanousConfigDir(tmpRoot);
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  resetElanousConfigDir();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture(): {
  state: ReturnType<typeof createNexusState>;
  registry: TabRegistry;
  bus: NexusEventBus;
} {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'N-1.5 PR d' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  return { state, registry, bus };
}

function uniquePort(): number {
  return 45000 + Math.floor(Math.random() * 2000);
}

describe('NEXUS meta-API — voice / push / attachments (PR d)', () => {
  test('without metaApi opts, public /v1/push/vapid-public-key returns 503', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/push/vapid-public-key`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('meta-api-not-wired');
    } finally { srv.stop(); }
  });

  test('without metaApi opts, /v1/push/subscribe POST returns 401', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/push/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('without metaApi opts, /v1/voice/cost returns 401', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/voice/cost`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('without metaApi opts, /v1/attachments POST returns 401', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port });
    try {
      const res = await fetch(`${srv.url}/v1/attachments`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('authenticated /v1/push/subscribe reaches body validation', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix, eventBus: fix.bus, startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/push/subscribe`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('authenticated /v1/attachments reaches upload validation', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix, eventBus: fix.bus, startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/attachments`, {
        method: 'POST', headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('authenticated /v1/voice/cost with no voiceRest returns 503', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/voice/cost`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('voice-rest-disabled');
    } finally { srv.stop(); }
  });

  test('with metaApi but no auth token, mutations return 401', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'tok', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/push/test`, { method: 'POST' });
      expect(res.status).toBe(401);
    } finally { srv.stop(); }
  });

  test('authenticated voice transcribe falls through to 503 (no voiceRest)', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/voice/transcribe`, {
        method: 'POST', headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('voice-rest-disabled');
    } finally { srv.stop(); }
  });

  // VAPID public key happy path is not covered here — the
  // `web-push` npm package is not installed in this repo's bun test
  // environment (same reason `daemon-public-server.test.ts` skips it
  // on main HEAD). We verify the public route's *not-wired* path (503)
  // above; the wired path is covered by integration testing post-T3.

  test('non-meta-api routes (e.g., /v1/health) work alongside metaApi opts', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/health`);
      expect(res.status).toBe(200);
    } finally { srv.stop(); }
  });

  test('attachment GET with invalid id format returns 400', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/attachments/not-a-valid-id`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  // Same-origin auth bypass — PWA served by NEXUS at /app/* hits /v1/*
  // on the same host. Browser-set Sec-Fetch-Site is forbidden-header
  // (cannot be spoofed by JS), so cross-origin callers without a bearer
  // still get 401.
  test('same-origin browser request to /v1/tools bypasses bearer (Sec-Fetch-Site)', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: {
        bearerToken: 'tok',
        noAuth: false,
        toolSurface: { kind: 'webterm', specs: [], dispatch: async () => undefined },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/tools`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe('webterm');
    } finally { srv.stop(); }
  });

  test('cross-site request to /v1/tools without bearer still returns 401', async () => {
    const fix = makeFixture();
    const port = uniquePort();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: port,
      metaApi: {
        bearerToken: 'tok',
        noAuth: false,
        toolSurface: { kind: 'webterm', specs: [], dispatch: async () => undefined },
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/tools`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(401);
    } finally { srv.stop(); }
  });
});
