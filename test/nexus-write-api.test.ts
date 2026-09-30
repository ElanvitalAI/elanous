// NEXUS · write API tests (Phase N-3 PR ι)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import { makeTestSpawnBackend } from '../src/nexus/supervisor/spawn.js';
import { createDefaultHealthProbeBackend } from '../src/nexus/supervisor/health.js';
import { createDaemonTabSpec } from '../src/nexus/kinds/daemon.js';
import type { PtyBackend } from '../src/nexus/webterm/pty.js';
import { getElanousConfigDir, setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

let tmpRoot: string;
let prevHome: string | undefined;
let prevNexus: string | undefined;
let prevTg: string | undefined;
let prevDc: string | undefined;
const bearerToken = 'nexus-write-api-test-token';
const sameOriginHeaders = { 'sec-fetch-site': 'same-origin' };
let handle: RunNexusHandle | undefined;
let baseUrl: string;
let webtermSpawns: Array<{ id: string; cwd?: string; killed: number }>;
let actualWebtermChildren = new Map<string, ChildProcess>();
let actualWebtermKills = new Map<string, number>();
let failWebtermSpawn = false;

function makeWebtermBackend(spawn: { id: string; cwd?: string; killed: number }): PtyBackend {
  return {
    onData: () => () => {},
    onExit: () => () => {},
    write: () => {},
    kill: () => { spawn.killed += 1; },
  };
}

function makeChildProcessBackend(id: string, child: ChildProcess): PtyBackend {
  return {
    onData: () => () => {},
    onExit: (cb) => {
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        cb({ exitCode, ...(signal ? { signal } : {}) });
      };
      child.once('exit', onExit);
      return () => child.removeListener('exit', onExit);
    },
    write: () => {},
    kill: (signal) => {
      actualWebtermKills.set(id, (actualWebtermKills.get(id) ?? 0) + 1);
      child.kill(signal);
    },
  };
}

async function waitForChildExit(child: ChildProcess, id: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`webterm child still alive after ${timeoutMs}ms: tab=${id} pid=${child.pid}`);
  }
}

beforeEach(async () => {
  webtermSpawns = [];
  actualWebtermChildren = new Map();
  actualWebtermKills = new Map();
  failWebtermSpawn = false;
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n3-write-'));
  prevHome = process.env.HOME;
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevTg = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  prevDc = process.env.ELANOUS_DISCORD_BOT_TOKEN;
  process.env.HOME = tmpRoot;
  mkdirSync(join(tmpRoot, '.elanous'), { recursive: true });
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  setElanousConfigDir(tmpRoot);
  writeFileSync(join(getElanousConfigDir(), 'acp-token'), bearerToken);
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
  handle = await runNexus({
    detachForTesting: true,
    skipRuntimeApi: false,
    toolCwd: process.cwd(),
    skipHttpServer: false,
    httpStartPort: 41000 + Math.floor(Math.random() * 2000),
    supervisorSpawnBackend: makeTestSpawnBackend(),
    supervisorProbes: createDefaultHealthProbeBackend(),
    webtermSpawn: ({ id, cwd }) => {
      if (failWebtermSpawn) throw new Error('webterm spawn failed');
      const child = actualWebtermChildren.get(id);
      if (child) return makeChildProcessBackend(id, child);
      const spawn = { id, ...(cwd ? { cwd } : {}), killed: 0 };
      webtermSpawns.push(spawn);
      return makeWebtermBackend(spawn);
    },
  });
  baseUrl = handle!.httpServer!.url;
});

afterEach(() => {
  handle?.release();
  handle = undefined;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  resetElanousConfigDir();
  if (prevTg === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = prevTg;
  if (prevDc === undefined) delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
  else process.env.ELANOUS_DISCORD_BOT_TOKEN = prevDc;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function responseBody(res: Response): Promise<{ status: number; body: any }> {
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: body as any };
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(sameOriginHeaders);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return responseBody(await fetch(`${baseUrl}${path}`, { ...init, headers }));
}

async function unauthenticatedCall(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  return responseBody(await fetch(`${baseUrl}${path}`, init));
}

describe('POST /v1/nexus/tabs · create', () => {
  test('chat tab — auto id chat:N+1 · view-only · started=false', async () => {
    const before = handle!.registry.list().filter((t) => t.spec.kind === 'chat').length;
    const res = await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.tab.spec.kind).toBe('chat');
    expect(res.body.tab.spec.id).toBe(`chat:${before + 1}`);
    expect(res.body.started).toBe(false); // view-only
  });

  test('runtime webterm creates one injected PTY with cwd, ignores duplicate and non-webterm events, and destroys on delete', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'webterm', id: 'webterm:runtime', kindOpts: { cwd: tmpRoot } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.started).toBe(false);
    expect(webtermSpawns).toEqual([{ id: 'webterm:runtime', cwd: tmpRoot, killed: 0 }]);
    expect(handle!.webtermSessions!.has('webterm:runtime')).toBe(true);

    handle!.eventBus.publish({ ts: Date.now(), kind: 'tab.created', tabId: 'webterm:runtime' });
    handle!.eventBus.publish({ ts: Date.now(), kind: 'tab.created', tabId: 'chat:ignored' });
    expect(webtermSpawns).toHaveLength(1);

    // A view-only tab can emit tab.down without being unregistered. Its
    // daemon-owned PTY must survive and remain reusable by a later start.
    handle!.eventBus.publish({ ts: Date.now(), kind: 'tab.down', tabId: 'webterm:runtime', detail: { reason: 'stop' } });
    expect(handle!.webtermSessions!.has('webterm:runtime')).toBe(true);
    expect(webtermSpawns[0]!.killed).toBe(0);
    handle!.eventBus.publish({ ts: Date.now(), kind: 'tab.created', tabId: 'webterm:runtime' });
    expect(webtermSpawns).toHaveLength(1);

    const deleted = await call('/v1/nexus/tabs/webterm:runtime', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(handle!.webtermSessions!.has('webterm:runtime')).toBe(false);
    expect(webtermSpawns[0]!.killed).toBe(1);
  });

  test('DELETE destroys a runtime webterm child while stop preserves it and release cleans the remainder', async () => {
    const children = ['webterm:actual-delete-1', 'webterm:actual-delete-2', 'webterm:actual-release'].map((id) => {
      const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done']);
      actualWebtermChildren.set(id, child);
      return { id, child };
    });
    try {
      for (const { id } of children) {
        const created = await call('/v1/nexus/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'webterm', id, kindOpts: { cwd: tmpRoot } }),
        });
        expect(created.status).toBe(201);
        expect(handle!.webtermSessions!.has(id)).toBe(true);
      }

      const stopped = await call(`/v1/nexus/tabs/${children[0]!.id}/stop`, { method: 'POST' });
      expect(stopped.status).toBe(200);
      expect(actualWebtermKills.get(children[0]!.id) ?? 0).toBe(0);
      expect(handle!.webtermSessions!.has(children[0]!.id)).toBe(true);

      for (const { id, child } of children.slice(0, 2)) {
        const deleted = await call(`/v1/nexus/tabs/${id}`, { method: 'DELETE' });
        expect(deleted).toEqual({ status: 200, body: { deleted: true, id } });
        expect(actualWebtermKills.get(id) ?? 0).toBe(1);
        await waitForChildExit(child, id);
        expect(handle!.webtermSessions!.has(id)).toBe(false);
      }

      handle!.release();
      handle = undefined;
      expect(actualWebtermKills.get(children[2]!.id) ?? 0).toBe(1);
      await waitForChildExit(children[2]!.child, children[2]!.id);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });

  test('DELETE escalates a TERM-ignoring runtime webterm child and observes its exit', async () => {
    const id = 'webterm:term-ignoring-child';
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; printf ready; while :; do sleep 1; done"]);
    actualWebtermChildren.set(id, child);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout?.once('data', () => resolve());
      });
      const created = await call('/v1/nexus/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'webterm', id, kindOpts: { cwd: tmpRoot } }),
      });
      expect(created.status).toBe(201);

      const deleted = await call(`/v1/nexus/tabs/${id}`, { method: 'DELETE' });
      expect(deleted).toEqual({ status: 200, body: { deleted: true, id } });
      await waitForChildExit(child, id, 2_500);
      expect(actualWebtermKills.get(id)).toBe(2);
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('release escalates a TERM-ignoring runtime webterm child and observes its exit', async () => {
    const id = 'webterm:term-ignoring-release';
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; printf ready; while :; do sleep 1; done"]);
    actualWebtermChildren.set(id, child);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout?.once('data', () => resolve());
      });
      const created = await call('/v1/nexus/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'webterm', id, kindOpts: { cwd: tmpRoot } }),
      });
      expect(created.status).toBe(201);
      handle!.release();
      handle = undefined;
      await waitForChildExit(child, id, 2_500);
      expect(actualWebtermKills.get(id)).toBe(2);
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('repeated DELETE calls leave no TERM-ignoring runtime webterm children alive', async () => {
    const children: Array<{ id: string; child: ChildProcess }> = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const id = `webterm:term-ignoring-repeat-${index}`;
        const child = spawn('/bin/sh', ['-c', "trap '' TERM; printf ready; while :; do sleep 1; done"]);
        children.push({ id, child });
        actualWebtermChildren.set(id, child);
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.stdout?.once('data', () => resolve());
        });
        const created = await call('/v1/nexus/tabs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'webterm', id, kindOpts: { cwd: tmpRoot } }),
        });
        expect(created.status).toBe(201);
        const deleted = await call(`/v1/nexus/tabs/${id}`, { method: 'DELETE' });
        expect(deleted.status).toBe(200);
        await waitForChildExit(child, id, 2_500);
        expect(actualWebtermKills.get(id)).toBe(2);
        expect(child.signalCode).toBe('SIGKILL');
      }
      expect(children.filter(({ child }) => child.exitCode === null && child.signalCode === null)).toEqual([]);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });

  test('runtime webterm spawn failure leaves no session and does not block subsequent tab events', async () => {
    failWebtermSpawn = true;
    const failed = await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'webterm', id: 'webterm:failed' }),
    });
    expect(failed.status).toBe(201);
    expect(handle!.webtermSessions!.has('webterm:failed')).toBe(false);
    expect(webtermSpawns).toHaveLength(0);

    failWebtermSpawn = false;
    const succeeding = await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'webterm', id: 'webterm:after-failure' }),
    });
    expect(succeeding.status).toBe(201);
    expect(handle!.webtermSessions!.has('webterm:after-failure')).toBe(true);
    expect(webtermSpawns).toHaveLength(1);
  });

  test('id explicit override is honored', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:custom' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.tab.spec.id).toBe('chat:custom');
  });

  test('conflict id → 409', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'dup:1' }),
    });
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'dup:1' }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tab-id-conflict');
  });

  test('daemon spawn-able tab → started=true via TestSpawnBackend', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:write-test' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.tab.spec.kind).toBe('daemon');
    expect(res.body.started).toBe(true);
    expect(res.body.tab.pid).toBeGreaterThan(0);
  });

  test('start=false suppresses auto-spawn', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:nostart', start: false }),
    });
    expect(res.status).toBe(201);
    expect(res.body.started).toBe(false);
    expect(res.body.tab.pid).toBeUndefined();
  });

  test('channel-bot requires platform', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'channel-bot', id: 'bot:bad' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('channel-bot-platform-required');
  });

  test('channel-bot with valid platform registers', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'channel-bot', id: 'tg:write-test', kindOpts: { platform: 'telegram' } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.tab.spec.kind).toBe('channel-bot');
  });

  // Surface-unification v2.2 V2.2-8 (2026-05-11) retired the 'scheduler' tab
  // kind — it is no longer in VALID_KINDS, so a create POST rejects it as an
  // unknown kind. (Was: "scheduler kind creates + spawns (PR λ wiring)".)
  test('scheduler kind retired → 400 unknown-kind', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'scheduler', id: 's:write-test' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown-kind');
    expect(res.body.kind).toBe('scheduler');
  });

  test('unknown kind → 400', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mystery' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown-kind');
  });

  test('missing kind → 400 kind-required', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('kind-required');
  });

  test('invalid JSON body → 400', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-json');
  });
});

describe('DELETE /v1/nexus/tabs/:id', () => {
  test('removes a tab + 200', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:to-delete' }),
    });
    expect(handle!.registry.has('chat:to-delete')).toBe(true);
    const res = await call('/v1/nexus/tabs/chat:to-delete', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(handle!.registry.has('chat:to-delete')).toBe(false);
  });

  test('missing tab → 404', async () => {
    const res = await call('/v1/nexus/tabs/never-existed', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tab-not-found');
  });
});

describe('PATCH /v1/nexus/tabs/:id', () => {
  test('label patch persists', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:patch', label: 'old' }),
    });
    const res = await call('/v1/nexus/tabs/chat:patch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'new label' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.tab.spec.label).toBe('new label');
    expect(handle!.registry.get('chat:patch')!.spec.label).toBe('new label');
  });

  test('missing tab → 404', async () => {
    const res = await call('/v1/nexus/tabs/missing', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/nexus/tabs/:id/start', () => {
  test('view-only kind → 409', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:start-vo' }),
    });
    const res = await call('/v1/nexus/tabs/chat:start-vo/start', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('view-only-kind');
  });

  test('daemon idle → start success', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:explicit-start', start: false }),
    });
    expect(handle!.registry.get('d:explicit-start')!.pid).toBeUndefined();
    const res = await call('/v1/nexus/tabs/d:explicit-start/start', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    expect(res.body.tab.pid).toBeGreaterThan(0);
  });

  test('missing tab → 404', async () => {
    const res = await call('/v1/nexus/tabs/missing/start', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/nexus/tabs/:id/stop', () => {
  test('stops a running daemon · pid cleared', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:stop-me' }),
    });
    expect(handle!.registry.get('d:stop-me')!.pid).toBeGreaterThan(0);
    const res = await call('/v1/nexus/tabs/d:stop-me/stop?graceMs=0', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    expect(handle!.registry.get('d:stop-me')!.pid).toBeUndefined();
    expect(handle!.registry.get('d:stop-me')!.status).toBe('stopped');
  });
});

describe('POST /v1/nexus/tabs/:id/restart', () => {
  test('restart kicks new pid', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:cycle' }),
    });
    const pid1 = handle!.registry.get('d:cycle')!.pid;
    expect(pid1).toBeGreaterThan(0);
    const res = await call('/v1/nexus/tabs/d:cycle/restart?graceMs=0', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.restarted).toBe(true);
    expect(res.body.started).toBe(true);
    const pid2 = handle!.registry.get('d:cycle')!.pid;
    expect(pid2).toBeGreaterThan(0);
    expect(pid2).not.toBe(pid1);
  });

  test('view-only kind → 409', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:restart-vo' }),
    });
    const res = await call('/v1/nexus/tabs/chat:restart-vo/restart', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  test('missing tab → 404', async () => {
    const res = await call('/v1/nexus/tabs/missing/restart', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('tab mutation authentication', () => {
  test('rejects every headerless mutation, preserves tabs, and traces the denial', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'daemon', id: 'd:auth-guard', start: false }),
    });
    const before = handle!.registry.get('d:auth-guard');
    expect(before).toBeDefined();
    expect(before!.spec.label).toBe('d:auth-guard');
    expect(before!.status).toBe('idle');

    const requests: Array<[string, RequestInit]> = [
      ['/v1/nexus/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'chat', id: 'chat:unauthorized-create' }),
      }],
      ['/v1/nexus/tabs/d:auth-guard', { method: 'DELETE' }],
      ['/v1/nexus/tabs/d:auth-guard', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'unauthorized patch' }),
      }],
      ['/v1/nexus/tabs/d:auth-guard/start', { method: 'POST' }],
      ['/v1/nexus/tabs/d:auth-guard/stop', { method: 'POST' }],
      ['/v1/nexus/tabs/d:auth-guard/restart', { method: 'POST' }],
    ];
    for (const [path, init] of requests) {
      const res = await unauthenticatedCall(path, init);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    }

    expect(handle!.registry.has('chat:unauthorized-create')).toBe(false);
    const after = handle!.registry.get('d:auth-guard');
    expect(after!.spec.label).toBe('d:auth-guard');
    expect(after!.status).toBe('idle');

    const trace = await call('/v1/diag/auth-trace', {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    expect(trace.status).toBe(200);
    const denied = trace.body.entries.filter((entry: { path: string; ok: boolean; reason: string }) => (
      entry.path.startsWith('/v1/nexus/tabs') && !entry.ok
    ));
    expect(denied).toHaveLength(requests.length);
    expect(denied.every((entry: { reason: string }) => entry.reason === 'missing-auth-header')).toBe(true);
  });

  test('accepts a bearer mutation', async () => {
    const res = await unauthenticatedCall('/v1/nexus/tabs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'chat', id: 'chat:bearer-success' }),
    });
    expect(res.status).toBe(201);
    expect(handle!.registry.has('chat:bearer-success')).toBe(true);
  });

  test('rejects headerless mutations when the API runtime is unavailable', async () => {
    handle?.release();
    handle = await runNexus({
      detachForTesting: true,
      skipRuntimeApi: true,
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      supervisorSpawnBackend: makeTestSpawnBackend(),
      supervisorProbes: createDefaultHealthProbeBackend(),
    });
    baseUrl = handle!.httpServer!.url;
    handle!.registry.register(createDaemonTabSpec({ id: 'd:auth-runtime-unavailable' }));

    const requests: Array<[string, RequestInit]> = [
      ['/v1/nexus/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'chat', id: 'chat:runtime-unavailable' }),
      }],
      ['/v1/nexus/tabs/d:auth-runtime-unavailable', { method: 'DELETE' }],
      ['/v1/nexus/tabs/d:auth-runtime-unavailable', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'blocked patch' }),
      }],
      ['/v1/nexus/tabs/d:auth-runtime-unavailable/start', { method: 'POST' }],
      ['/v1/nexus/tabs/d:auth-runtime-unavailable/stop', { method: 'POST' }],
      ['/v1/nexus/tabs/d:auth-runtime-unavailable/restart', { method: 'POST' }],
    ];

    for (const [path, init] of requests) {
      const res = await unauthenticatedCall(path, init);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    }

    const authenticated = await unauthenticatedCall('/v1/nexus/tabs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'chat', id: 'chat:runtime-unavailable' }),
    });
    expect(authenticated.status).toBe(503);
    expect(authenticated.body.error).toBe('meta-api-runtime-not-wired');

    expect(handle!.registry.has('chat:runtime-unavailable')).toBe(false);
    const protectedTab = handle!.registry.get('d:auth-runtime-unavailable');
    expect(protectedTab).toBeDefined();
    expect(protectedTab!.spec.label).toBe('d:auth-runtime-unavailable');
    expect(protectedTab!.status).toBe('idle');
  });
});

describe('routing edge cases', () => {
  test('unknown action → 404 unknown-action', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:edge' }),
    });
    const res = await call('/v1/nexus/tabs/chat:edge/unknown', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown-action');
  });

  test('non-POST on /:id/action → 405', async () => {
    await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', id: 'chat:wrong-method' }),
    });
    const res = await call('/v1/nexus/tabs/chat:wrong-method/start', { method: 'PATCH' });
    expect(res.status).toBe(405);
  });

  test('PUT on /v1/nexus/tabs root → 405', async () => {
    const res = await call('/v1/nexus/tabs', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat' }),
    });
    expect(res.status).toBe(405);
  });
});

describe('skipSupervisor mode → 503 on mutations', () => {
  test('POST returns 503 when supervisor unavailable', async () => {
    handle?.release();
    handle = await runNexus({
      detachForTesting: true,
      skipRuntimeApi: false,
      toolCwd: process.cwd(),
      skipHttpServer: false,
      httpStartPort: 41000 + Math.floor(Math.random() * 2000),
      skipSupervisor: true,
    });
    baseUrl = handle!.httpServer!.url;
    const res = await call('/v1/nexus/tabs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chat' }),
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('supervisor-unavailable');
  });
});
