// `/v1` default-deny — the gate in routeRequest runs before any handler.
//
// Random paths are invented here. They are not collected by grepping
// http-server.ts: a gate in front of routing must 401 even when no route exists.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { debug } from '../src/debug/log.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { PUBLIC_ROUTES, isPublicRoute } from '../src/nexus/api/public-routes.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

const BEARER = 'default-deny-test-token';

const RANDOM_OUTSIDE_PATHS = [
  '/v1/config/secrets',
  '/v1/llm/rotation',
  '/v1/hitl/audit/recent',
  '/v1/terminals/view',
  '/v1/worktrees',
  '/v1/vault/notes/today',
  '/v1/sessions/store/abc/fork',
  '/v1/workflows/runs/pending',
  '/v1/intake/pipeline-preview',
  '/v1/tools/runtime',
  '/v1/zz-alpha/one',
  '/v1/zz-beta',
  '/v1/missions/m-1/tasks',
  '/v1/scheduler/nightly',
  '/v1/hitl/callback/req-9',
  '/v1/workflows/webhooks/inbound',
  '/v1/setup/llm-providers',
  '/v1/push/subscriptions',
  '/v1/diag/auth-trace',
  '/v1/no/such/prefix/leaf',
] as const;

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return {
    state,
    eventBus,
    registry: new TabRegistry(state),
    metaApi: { bearerToken: BEARER, noAuth: false },
    connectInfo: {
      nexusVersion: 'test',
      acpTokenOverride: 'unused-acp-token',
    },
    startPort: 59000 + Math.floor(Math.random() * 1000),
  };
}

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
});

function start() {
  const server = startNexusHttpServer(serverFixture());
  servers.push(server);
  return server;
}

async function statusOf(
  server: { url: string },
  path: string,
  init?: RequestInit,
): Promise<number> {
  const headers = new Headers(init?.headers);
  if (!headers.has('sec-fetch-site')) headers.set('sec-fetch-site', 'cross-site');
  const res = await fetch(`${server.url}${path}`, { ...init, headers });
  await res.arrayBuffer();
  return res.status;
}

describe('nexus /v1 default-deny', () => {
  test('named probes: unauth config 401, health 200, sessions prefix 401, bearer config 200, connect-info 200, missing route 401', async () => {
    const server = start();
    const missing = `/v1/zz-no-such-route-${Math.random().toString(36).slice(2, 10)}`;

    expect(await statusOf(server, '/v1/config')).toBe(401);
    expect(await statusOf(server, '/v1/health')).toBe(200);
    expect(await statusOf(server, '/v1/sessions/x')).toBe(401);
    expect(await statusOf(server, '/v1/config', {
      headers: { authorization: `Bearer ${BEARER}` },
    })).toBe(200);
    expect(await statusOf(server, '/v1/nexus/connect-info')).toBe(200);
    expect(await statusOf(server, missing)).toBe(401);
  });

  test('every PUBLIC_ROUTES entry has a non-empty why, and always-public entries are not 401 unauthenticated', async () => {
    const server = start();
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(0);
    for (const route of PUBLIC_ROUTES) {
      expect(route.why.trim().length).toBeGreaterThan(0);
      expect(route.why.includes('\n')).toBe(false);
      // This server has no setup-mode flag (P24b), so routeRequest passes
      // setupMode:false. The /v1/setup prefix is public only when that flag
      // is true — unauthenticated calls stay denied, which is the contract.
      if (route.path.startsWith('/v1/setup/')) {
        expect(isPublicRoute(route.method, `${route.path}probe`, { setupMode: false })).toBe(false);
        expect(isPublicRoute(route.method, `${route.path}probe`, { setupMode: true })).toBe(true);
        expect(await statusOf(server, `${route.path}probe`, { method: route.method })).toBe(401);
        continue;
      }
      if (route.selfVerified) {
        // The handler answers 401 itself without its own token — so the status
        // cannot tell gate from handler. The gate's own observation must stay silent.
        const logSpy = spyOn(debug, 'log');
        try {
          await statusOf(server, route.path, { method: route.method });
          const denied = logSpy.mock.calls.some(([cat, event, data]) =>
            cat === 'nexus.auth' && event === 'default-deny' && (data as { pathname?: string } | undefined)?.pathname === route.path);
          expect(denied).toBe(false);
        } finally {
          logSpy.mockRestore();
        }
        continue;
      }
      const code = await statusOf(server, route.path, { method: route.method });
      expect(code).not.toBe(401);
    }
  });

  test('the Pod grok relay POST passes the gate (the handler checks its own token)', async () => {
    expect(isPublicRoute('POST', '/v1/pod/credential/grok', { setupMode: false })).toBe(true);
    const server = start();
    const logSpy = spyOn(debug, 'log');
    try {
      await statusOf(server, '/v1/pod/credential/grok', { method: 'POST' });
      const denied = logSpy.mock.calls.some(([cat, event, data]) =>
        cat === 'nexus.auth' && event === 'default-deny' && (data as { pathname?: string } | undefined)?.pathname === '/v1/pod/credential/grok');
      expect(denied).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('the Pod GitHub relay POST passes default-deny to its own token gate, not other methods', async () => {
    expect(isPublicRoute('POST', '/v1/pod/credential/github', { setupMode: false })).toBe(true);
    expect(isPublicRoute('GET', '/v1/pod/credential/github', { setupMode: false })).toBe(false);
    const server = start();
    const logSpy = spyOn(debug, 'log');
    try {
      expect(await statusOf(server, '/v1/pod/credential/github', { method: 'POST' })).toBe(401);
      expect(logSpy.mock.calls.some(([cat, event, data]) =>
        cat === 'nexus.auth' && event === 'default-deny' && (data as { pathname?: string } | undefined)?.pathname === '/v1/pod/credential/github')).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('20 random /v1 paths outside the allowlist are all 401', async () => {
    expect(RANDOM_OUTSIDE_PATHS).toHaveLength(20);
    const server = start();
    for (const path of RANDOM_OUTSIDE_PATHS) {
      expect(isPublicRoute('GET', path, { setupMode: false })).toBe(false);
      expect(await statusOf(server, path)).toBe(401);
    }
  });

  test('a denied /v1 request logs nexus.auth default-deny with method and pathname only', async () => {
    const seen: Array<{ method?: string; pathname?: string; keys: string[] }> = [];
    const original = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      if (category === 'nexus.auth' && event === 'default-deny') {
        const detail = (data ?? {}) as Record<string, unknown>;
        seen.push({
          method: detail.method as string | undefined,
          pathname: detail.pathname as string | undefined,
          keys: Object.keys(detail),
        });
      }
      original(category, event, data as never);
    }) as typeof debug.log;
    try {
      const server = start();
      expect(await statusOf(server, '/v1/config')).toBe(401);
      expect(await statusOf(server, '/v1/health')).toBe(200);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(seen).toEqual([{ method: 'GET', pathname: '/v1/config', keys: ['method', 'pathname'] }]);
  });

  test('setup prefix is public only when setupMode is true', () => {
    expect(isPublicRoute('GET', '/v1/setup/llm-providers', { setupMode: false })).toBe(false);
    expect(isPublicRoute('GET', '/v1/setup/llm-providers', { setupMode: true })).toBe(true);
    expect(isPublicRoute('GET', '/v1/health', { setupMode: false })).toBe(true);
    expect(isPublicRoute('POST', '/v1/health', { setupMode: false })).toBe(false);
    expect(isPublicRoute('GET', '/app/', { setupMode: true })).toBe(false);
    expect(isPublicRoute('GET', '/', { setupMode: true })).toBe(false);
  });
});
