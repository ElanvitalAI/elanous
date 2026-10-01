// NEXUS N-1.5 PR e — runtime-not-wired meta-API endpoint stubs.
//
// PR e exposes the v6 cutover surface for intake / sessions /
// control-signals / simulations / tools / screenshot / recordings.
// With no metaApi, a valid local bearer reaches the runtime-not-wired 503;
// unauthenticated requests remain default-denied.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import { ensureAuthToken } from '../src/auth/acp-token.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-runtime-stubs-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
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
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'N-1.5 PR e' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  return { state, registry, bus };
}

function uniquePort(): number {
  return 47000 + Math.floor(Math.random() * 2000);
}

describe('NEXUS meta-API protected routes without runtime (PR e)', () => {
  test('authenticated PATCH /v1/nexus/tabs/chat:1 reaches the runtime-not-wired stub', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: uniquePort() });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs/chat%3A1`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${ensureAuthToken().token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'renamed' }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'meta-api-runtime-not-wired' });
    } finally { srv.stop(); }
  });

  async function expectRuntimeNotWired(method: 'GET' | 'POST', path: string, body?: object): Promise<void> {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: uniquePort() });
    try {
      const res = await fetch(`${srv.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${ensureAuthToken().token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'meta-api-runtime-not-wired' });
    } finally { srv.stop(); }
  }

  test('GET /v1/simulations returns 503 not-wired', async () => {
    await expectRuntimeNotWired('GET', '/v1/simulations');
  });

  test('GET /v1/tools returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/tools');
  });

  test('POST /v1/intake returns 503', async () => {
    await expectRuntimeNotWired('POST', '/v1/intake', { text: 'test' });
  });

  test('GET /v1/intake list returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/intake');
  });

  test('POST /v1/sessions/external returns 503', async () => {
    await expectRuntimeNotWired('POST', '/v1/sessions/external');
  });

  test('GET /v1/sessions returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/sessions');
  });

  test('GET /v1/control-signals returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/control-signals');
  });

  test('POST /v1/control-signals returns 503', async () => {
    await expectRuntimeNotWired('POST', '/v1/control-signals');
  });

  test('GET /v1/turns/last/screenshot returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/turns/last/screenshot');
  });

  test('GET /v1/recordings/foo.mp4 returns 503', async () => {
    await expectRuntimeNotWired('GET', '/v1/recordings/foo.mp4');
  });

  test('PR f · POST /v1/prompt returns 503 not-wired', async () => {
    await expectRuntimeNotWired('POST', '/v1/prompt', { userText: 'hi' });
  });

  test('PR h · POST /v1/hitl/callback/:id returns 503 not-wired', async () => {
    await expectRuntimeNotWired('POST', '/v1/hitl/callback/req-abc123', { answer: true });
  });

  test('private routes without a bearer or without a runtime stub remain default-denied', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: uniquePort() });
    try {
      const withoutBearer = await fetch(`${srv.url}/v1/simulations`);
      expect(withoutBearer.status).toBe(401);
      expect(await withoutBearer.json()).toEqual({ error: 'unauthorized' });
      const unrelated = await fetch(`${srv.url}/v1/not-a-runtime-stub`, {
        headers: { authorization: `Bearer ${ensureAuthToken().token}` },
      });
      expect(unrelated.status).toBe(401);
      expect(await unrelated.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });
});
