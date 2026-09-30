// M4-6 (2026-05-12) — workflow lifecycle endpoint e2e.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let tmpHome: string;
let prevNexus: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'm4-6-nexus-'));
  tmpHome = mkdtempSync(join(tmpdir(), 'm4-6-home-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  // getGlobalWorkflowDir() resolves via homedir() / setElanousConfigDir.
  // Point both at tmp dirs so the lifecycle file lands in a sandbox.
  process.env.HOME = tmpHome;
  setElanousConfigDir(join(tmpHome, '.elanous'));
});

afterEach(() => {
  const restore = (key: string, prev: string | undefined): void => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
  restore('ELANOUS_NEXUS_DIR', prevNexus);
  restore('HOME', prevHome);
  resetElanousConfigDir();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'M4-6' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 54000 + Math.floor(Math.random() * 2000);
}

function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: 'Bearer test-token' },
  });
}

describe('M4-6 workflow lifecycle endpoint', () => {
  test('GET returns 401 when metaApi unwired, before reaching the route', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('GET returns 401 without bearer even when metaApi is wired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('GET returns "active" by default when no lifecycle file exists', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBe('quick-summary');
      expect(body.status).toBe('active');
    } finally { srv.stop(); }
  });

  test('PUT sets status + subsequent GET reflects it', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const put = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json();
      expect(putBody.ok).toBe(true);
      expect(putBody.status).toBe('draft');
      const get = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`);
      const getBody = await get.json();
      expect(getBody.status).toBe('draft');
    } finally { srv.stop(); }
  });

  test('PUT 400 on unknown status', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('PUT 400 on invalid JSON body', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('PUT 404 on unknown workflow name (no dangling side-file entry)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/workflows/does-not-exist/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('workflow_not_found');
      expect(body.workflow).toBe('does-not-exist');
    } finally { srv.stop(); }
  });

  test('PUT then PUT again surfaces previous status', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      });
      const res = await authorizedFetch(`${srv.url}/v1/workflows/quick-summary/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      const body = await res.json();
      expect(body.previous).toBe('draft');
      expect(body.status).toBe('active');
    } finally { srv.stop(); }
  });
});
