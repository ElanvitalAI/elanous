import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import {
  createFeedbackEmitter,
  DEFAULT_NEXUS_HTTP_PORT,
  NEXUS_HTTP_PORT_RANGE,
  probeNexusHttpPort,
  startNexusHttpServer,
} from './http-server.js';
import { NexusEventBus } from './event-bus.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import type { ContextNowDeps } from '../../context-bus/context-now.js';
import { checkBrand } from '../../../scripts/brand/check.js';
import { resetUserConfig } from '../../user-config.js';
import { useBackend } from '../config/secrets/index.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const envelope: FeedbackEnvelope = {
  envelopeVersion: 1,
  kind: 'media.image',
  blockId: 'image-1',
  phase: 'end',
  sessionId: 'session-1',
  emittedAt: 1,
  seq: 1,
  asciiFallback: [],
  payload: { src: 'https://example.test/image.png', mediaType: 'image/png' },
};

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return { state, eventBus, registry: new TabRegistry(state) };
}

test('channel-bot GET and authenticated POST reach HTTP handlers without leaking the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-bot-http-'));
  setElanousConfigDir(dir);
  useBackend('file');
  resetUserConfig();
  const server = startNexusHttpServer({
    ...serverFixture(), startPort: uniquePort(), metaApi: { bearerToken: 'auth', noAuth: false },
  });
  try {
    const headers = { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' };
    const get = await fetch(`${server.url}/v1/setup/channel-bots`, { headers });
    expect(get.status).toBe(200);
    expect((await get.json() as { platforms: unknown[] }).platforms).toHaveLength(2);
    const unauthorized = await fetch(`${server.url}/v1/setup/channel-bot`, {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}',
    });
    expect(unauthorized.status).toBe(401);
    const post = await fetch(`${server.url}/v1/setup/channel-bot`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', allowedUsers: ['123'] }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, restartNeeded: true });
  } finally {
    server.stop();
    resetUserConfig();
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /v1/grid is bearer-gated, combines HQ and pool data without writes, and leaves existing routes intact', async () => {
  let hqReads = 0, poolReads = 0;
  const fixture = serverFixture();
  const server = startNexusHttpServer({ ...fixture, startPort: uniquePort(),
    metaApi: { bearerToken: 'auth', noAuth: false },
    grid: { readHq: () => { hqReads++; return { record: { holder: 'mbp', generation: 2, acquiredAt: 1, renewedAt: 2, ttlSeconds: 1500 }, ageSeconds: 3, expired: false }; },
      poolSpec: () => 'node-b:4', measure: () => { poolReads++; return { members: [{ context: 'node-b', capacity: 4, running: 1, pending: 1, reason: null }] as ReturnType<typeof import('../../task-orchestrator/surfaces/pod-lease.js').measurePoolLease>['members'] }; } },
  });
  try {
    const untrusted = { 'sec-fetch-site': 'cross-site' };
    for (const headers of [untrusted, { ...untrusted, authorization: 'Bearer wrong' }]) {
      const denied = await fetch(`${server.url}/v1/grid`, { headers });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: 'unauthorized' });
    }
    expect([hqReads, poolReads]).toEqual([0, 0]);
    const headers = { ...untrusted, authorization: 'Bearer auth' };
    const grid = await fetch(`${server.url}/v1/grid`, { headers });
    expect(grid.status).toBe(200);
    expect(grid.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await grid.json()).toEqual({ hq: { record: { holder: 'mbp', generation: 2, acquiredAt: 1, renewedAt: 2, ttlSeconds: 1500 }, ageSeconds: 3, expired: false, reason: null },
      members: [{ context: 'node-b', capacity: 4, running: 1, pending: 1, occupied: 2, reason: null }], poolReason: null });
    expect([hqReads, poolReads]).toEqual([1, 1]);
    const write = await fetch(`${server.url}/v1/grid`, { method: 'POST', headers });
    expect(write.status).toBe(405);
    expect(await write.json()).toEqual({ error: 'method-not-allowed', method: 'POST' });
    expect([hqReads, poolReads]).toEqual([1, 1]);
    const health = await fetch(`${server.url}/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json() as { ok: boolean }).ok).toBe(true);
    const nexus = await fetch(`${server.url}/v1/nexus`, { headers });
    expect(nexus.status).toBe(200);
    expect((await nexus.json() as { nexusVersion: string }).nexusVersion).toBe('test');
  } finally { server.stop(); }
});

function uniquePort(): number {
  return 43000 + Math.floor(Math.random() * 2000);
}

async function waitForOccupantReady(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 3000,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === 'number') {
    throw new Error('occupant stdout is not a stream');
  }
  const reader = stdout.getReader();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => null),
    ]);
    if (!result || result.done) break;
    buf += decoder.decode(result.value);
    if (buf.includes('ready')) return;
  }
  throw new Error(`occupant was not ready: ${JSON.stringify(buf)}`);
}

function spawnPortOccupant(opts: {
  port: number;
  hostname?: string;
  hang?: boolean;
  redirectTo?: string;
}): ReturnType<typeof Bun.spawn> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const fetchBody = opts.hang
    ? 'return new Promise(() => {});'
    : opts.redirectTo
      ? `return new Response(null, { status: 302, headers: { Location: ${JSON.stringify(opts.redirectTo)} } });`
      : "return new Response('ok', { status: 200 });";
  return Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `Bun.serve({ port: ${opts.port}, hostname: ${JSON.stringify(hostname)}, fetch() { ${fetchBody} } }); console.log('ready'); await Bun.sleep(60_000);`,
    ],
    stdout: 'pipe',
    stderr: 'ignore',
  });
}

function capturePortSkipLogs(): { records: Array<{ port: number; reason: string }>; restore: () => void } {
  const records: Array<{ port: number; reason: string }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    if (category === 'nexus.http' && event === 'port-occupied-skip') {
      const detail = (data ?? {}) as { port?: number; reason?: string };
      records.push({ port: Number(detail.port), reason: String(detail.reason ?? '') });
    }
    originalLog(category, event, data as never);
  }) as typeof debug.log;
  return {
    records,
    restore() {
      (debug as { log: typeof debug.log }).log = originalLog;
    },
  };
}

describe('GET /v1/context/now audience boundary', () => {
  const at = '2026-10-04T04:00:00.000Z';
  const deps: ContextNowDeps = {
    now: () => new Date(at), version: () => '0.2.0',
    checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0'
      ? [{ id: 'K6', title: '공개 기능', status: 'red', owner: 'TC', updatedAt: at, updatedBy: 'TC' },
        { id: 'K7', title: 'fully autonomous', status: 'yellow', owner: 'OP', updatedAt: at, updatedBy: 'OP' }] : [] }),
    decisions: () => [],
    seatEntries: () => [{ entry: { seat: 'MK', at, status: 'shadow', item: { id: 'K6', title: '공개 기능', text: '', source: 'checklist' } }, source: 'elanous://seat-loop/MK/2026-10-04#1' }],
    events: () => [{ id: 'event-1', at, text: '', kind: 'report', summary: 'PR #1234 on run-abcdef12 at /home/alice/plan',
      refs: { seat: 'UX', recipients: [], all: false, kind: 'report', slot: null, deadline: null, url: 'https://github.com/org/repo/pull/1234' } }],
  };

  test('accepts all three query audiences, defaults to operator, and rejects unknown values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-now-http-'));
    setElanousConfigDir(dir);
    resetUserConfig();
    const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(),
      metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: deps });
    const headers = { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' };
    try {
      expect((await fetch(`${server.url}/v1/context/now?audience=public-demo`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })).status).toBe(401);
      for (const [query, audience] of [['', 'operator'], ['?audience=operator', 'operator'],
        ['?audience=user', 'user'], ['?audience=public-demo', 'public-demo']] as const) {
        const res = await fetch(`${server.url}/v1/context/now${query}`, { headers });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.audience).toBe(audience);
        expect(body.hiddenCount).toBe(audience === 'public-demo' ? 1 : 0);
        expect(JSON.stringify(body)).toContain('공개 기능');
        if (audience === 'public-demo') {
          const text = JSON.stringify(body);
          for (const sensitive of [/\b(?:OP|TC|MK|UX)\b/, /\bPR\s*#?\d+\b|#\d+\b/i,
            /\brun[-_][a-z0-9-]{8,}\b/i, /\/(?:home|Users|root)\//]) {
            expect(text).not.toMatch(sensitive);
          }
        } else {
          expect(JSON.stringify(body)).toContain('PR #1234');
        }
      }
      const bad = await fetch(`${server.url}/v1/context/now?audience=other`, { headers });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'invalid_audience' });
      const repeated = await fetch(`${server.url}/v1/context/now?audience=public-demo&audience=operator`, { headers });
      expect(repeated.status).toBe(400);
    } finally {
      server.stop();
      resetUserConfig();
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('installed public-demo without brand rules returns 200 and collapses all fact titles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-now-missing-http-'));
    setElanousConfigDir(dir);
    resetUserConfig();
    const missingRules: typeof checkBrand = (scope, paths) => checkBrand(scope, paths, join(dir, 'absent-brand-rules.yaml'));
    const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(),
      metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: { ...deps, brandCheck: missingRules } });
    try {
      const operator = await fetch(`${server.url}/v1/context/now?audience=operator`, {
        headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' },
      });
      expect(operator.status).toBe(200);
      expect((await operator.json() as { hiddenCount: number }).hiddenCount).toBe(0);
      const res = await fetch(`${server.url}/v1/context/now?audience=public-demo`, {
        headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { hiddenCount: number; facts: Array<{ kind: string; title?: string }> };
      expect(body.hiddenCount).toBe(3);
      expect(body.facts.filter(fact => fact.title).map(fact => fact.title)).toEqual(['내부 항목 1개', '내부 항목 2개']);
      expect(text).not.toMatch(/\/Users\/|\/home\/|\bstack\b/i);
    } finally {
      server.stop();
      resetUserConfig();
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handler exceptions always return a single JSON line without error details, regardless of NODE_ENV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-now-failed-http-'));
    setElanousConfigDir(dir);
    resetUserConfig();
    const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(),
      metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: {
        ...deps, checklist: () => { throw new Error('private /Users/alice /home/alice stack'); },
      } });
    const previousEnv = process.env.NODE_ENV;
    try {
      for (const env of ['development', 'production']) {
        process.env.NODE_ENV = env;
        const res = await fetch(`${server.url}/v1/context/now?audience=public-demo`, {
          headers: { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' },
        });
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('application/json');
        const text = await res.text();
        expect(text).toBe('{"error":"context-now-failed"}');
        expect(text).not.toMatch(/\/Users\/|\/home\/|\bstack\b|<html/i);
      }
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
      server.stop();
      resetUserConfig();
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nexus.demoMode forces public-demo for absent and operator/user queries, including voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-now-demo-http-'));
    setElanousConfigDir(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ nexus: { demoMode: true } }));
    resetUserConfig();
    const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(),
      metaApi: { bearerToken: 'auth', noAuth: false }, contextNowDeps: deps });
    const headers = { authorization: 'Bearer auth', 'sec-fetch-site': 'cross-site' };
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    const served: unknown[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      if (category === 'context.now' && event === 'served') served.push(data);
      originalLog(category, event, data as never);
    }) as typeof debug.log;
    try {
      for (const query of ['', '?audience=operator', '?audience=user', '?audience=operator&format=voice']) {
        const res = await fetch(`${server.url}/v1/context/now${query}`, { headers });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.audience).toBe('public-demo');
        expect(body.hiddenCount).toBe(1);
        const text = JSON.stringify(body);
        for (const sensitive of [/\b(?:OP|TC|MK|UX)\b/, /\bPR\s*#?\d+\b|#\d+\b/i,
          /\brun[-_][a-z0-9-]{8,}\b/i, /\/(?:home|Users|root)\//]) {
          expect(text).not.toMatch(sensitive);
        }
      }
      expect(served).toEqual(Array.from({ length: 4 }, () => ({ audience: 'public-demo', hidden: 1, forced: true })));
      const bad = await fetch(`${server.url}/v1/context/now?audience=unknown`, { headers });
      expect(bad.status).toBe(400);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      server.stop();
      resetUserConfig();
      resetElanousConfigDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createFeedbackEmitter', () => {
  test('publishes the original envelope to the media SSE bus without ACP', () => {
    const bus = new NexusEventBus();
    const received: unknown[] = [];
    bus.subscribe((event) => received.push(event), ['media.']);

    createFeedbackEmitter(bus, 'session-1', undefined)(envelope);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'media.feedback' });
    expect((received[0] as { detail: FeedbackEnvelope }).detail).toBe(envelope);
  });

  test('keeps ACP delivery while publishing the original envelope to the SSE bus', () => {
    const bus = new NexusEventBus();
    const received: unknown[] = [];
    const acp: Array<[string, FeedbackEnvelope]> = [];
    bus.subscribe((event) => received.push(event), ['media.']);

    createFeedbackEmitter(bus, 'session-1', (sessionId, env) => { acp.push([sessionId, env]); })(envelope);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'media.feedback' });
    expect((received[0] as { detail: FeedbackEnvelope }).detail).toBe(envelope);
    expect(acp).toEqual([['session-1', envelope]]);
  });
});

describe('probeNexusHttpPort', () => {
  test('reports occupied when a localhost HTTP response arrives', async () => {
    const port = uniquePort();
    const occupant = spawnPortOccupant({ port });
    try {
      await waitForOccupantReady(occupant);
      expect(probeNexusHttpPort(port)).toBe('occupied');
    } finally {
      occupant.kill();
      await occupant.exited;
    }
  });

  test('reports occupied when the first response is a 302 to an unreachable destination', async () => {
    const port = uniquePort();
    const occupant = spawnPortOccupant({ port, redirectTo: 'http://127.0.0.1:1/' });
    try {
      await waitForOccupantReady(occupant);
      expect(probeNexusHttpPort(port)).toBe('occupied');
    } finally {
      occupant.kill();
      await occupant.exited;
    }
  });

  test('fails open as available on connection errors', () => {
    expect(probeNexusHttpPort(1)).toBe('available');
  });

  test('fails open as available when the request times out', async () => {
    const port = uniquePort();
    const hang = spawnPortOccupant({ port, hang: true });
    try {
      await waitForOccupantReady(hang);
      expect(probeNexusHttpPort(port, 80)).toBe('available');
    } finally {
      hang.kill();
      await hang.exited;
    }
  });
});

describe('startNexusHttpServer port occupancy probe', () => {
  test('preserves default startPort, portRange, hostname, and return shape', () => {
    expect(DEFAULT_NEXUS_HTTP_PORT).toBe(31415);
    expect(NEXUS_HTTP_PORT_RANGE).toBe(16);
    const startPort = uniquePort();
    const server = startNexusHttpServer({
      ...serverFixture(),
      startPort,
      portRange: 1,
      portProbe: () => 'available',
    });
    try {
      expect(server.port).toBe(startPort);
      expect(server.hostname).toBe('127.0.0.1');
      expect(server.url).toBe(`http://127.0.0.1:${startPort}`);
      expect(typeof server.stop).toBe('function');
    } finally {
      server.stop();
    }
  });

  test('skips a candidate that already answers and binds the next port', () => {
    const startPort = uniquePort();
    const probed: number[] = [];
    const capture = capturePortSkipLogs();
    const server = startNexusHttpServer({
      ...serverFixture(),
      startPort,
      portRange: 3,
      portProbe: (port) => {
        probed.push(port);
        return port === startPort ? 'occupied' : 'available';
      },
    });
    try {
      expect(server.port).toBe(startPort + 1);
      expect(probed[0]).toBe(startPort);
      expect(capture.records).toEqual([{ port: startPort, reason: 'already answering' }]);
    } finally {
      capture.restore();
      server.stop();
    }
  });

  test('treats a throwing probe as available and still binds the first candidate', () => {
    const startPort = uniquePort();
    const server = startNexusHttpServer({
      ...serverFixture(),
      startPort,
      portRange: 2,
      portProbe: () => {
        throw new Error('probe exploded');
      },
    });
    try {
      expect(server.port).toBe(startPort);
    } finally {
      server.stop();
    }
  });

  test('default probe times out as available and still attempts the first candidate', async () => {
    const startPort = uniquePort();
    const hang = spawnPortOccupant({ port: startPort, hostname: '0.0.0.0', hang: true });
    const capture = capturePortSkipLogs();
    const probed: Array<{ port: number; verdict: string }> = [];
    let server: ReturnType<typeof startNexusHttpServer> | undefined;
    try {
      await waitForOccupantReady(hang);
      expect(probeNexusHttpPort(startPort, 80)).toBe('available');
      server = startNexusHttpServer({
        ...serverFixture(),
        startPort,
        portRange: 2,
        hostname: '127.0.0.1',
        portProbe: (port) => {
          const verdict = probeNexusHttpPort(port, 80);
          probed.push({ port, verdict });
          return verdict;
        },
      });
      // Fail-open permits the bind attempt; exclusive-bind hosts may still
      // reject the first candidate and land on the next one.
      expect(probed[0]).toEqual({ port: startPort, verdict: 'available' });
      expect(capture.records).toEqual([]);
      expect([startPort, startPort + 1]).toContain(server.port);
      expect(server.hostname).toBe('127.0.0.1');
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      expect(typeof server.stop).toBe('function');
    } finally {
      capture.restore();
      server?.stop();
      hang.kill();
      await hang.exited;
    }
  });

  test('fail-open bind collision moves to the next candidate', async () => {
    const startPort = uniquePort();
    const occupant = spawnPortOccupant({ port: startPort, hostname: '127.0.0.1' });
    const capture = capturePortSkipLogs();
    const probed: number[] = [];
    let server: ReturnType<typeof startNexusHttpServer> | undefined;
    try {
      await waitForOccupantReady(occupant);
      server = startNexusHttpServer({
        ...serverFixture(),
        startPort,
        portRange: 2,
        hostname: '127.0.0.1',
        portProbe: (port) => {
          probed.push(port);
          return 'available';
        },
      });
      expect(probed[0]).toBe(startPort);
      expect(server.port).toBe(startPort + 1);
      expect(server.hostname).toBe('127.0.0.1');
      expect(server.url).toBe(`http://127.0.0.1:${startPort + 1}`);
      expect(typeof server.stop).toBe('function');
      expect(capture.records).toEqual([]);
    } finally {
      capture.restore();
      server?.stop();
      occupant.kill();
      await occupant.exited;
    }
  });

  test('throws the existing no-free-port error when every candidate is occupied', () => {
    const startPort = uniquePort();
    const range = 3;
    expect(() => startNexusHttpServer({
      ...serverFixture(),
      startPort,
      portRange: range,
      portProbe: () => 'occupied',
    })).toThrow(`nexus http: no free port in range ${startPort}..${startPort + range - 1}`);
  });

  test('default probe fail-open binds the first candidate when nothing answers', () => {
    const startPort = uniquePort();
    const server = startNexusHttpServer({
      ...serverFixture(),
      startPort,
      portRange: 1,
    });
    try {
      expect(server.port).toBe(startPort);
    } finally {
      server.stop();
    }
  });

  test('default probe skips a candidate that answers with a 302 to an unreachable destination', async () => {
    const startPort = uniquePort();
    const occupant = spawnPortOccupant({
      port: startPort,
      hostname: '0.0.0.0',
      redirectTo: 'http://127.0.0.1:1/',
    });
    const capture = capturePortSkipLogs();
    let server: ReturnType<typeof startNexusHttpServer> | undefined;
    try {
      await waitForOccupantReady(occupant);
      expect(probeNexusHttpPort(startPort)).toBe('occupied');
      server = startNexusHttpServer({
        ...serverFixture(),
        startPort,
        portRange: 2,
        hostname: '127.0.0.1',
      });
      expect(server.port).toBe(startPort + 1);
      expect(capture.records).toEqual([{ port: startPort, reason: 'already answering' }]);
    } finally {
      capture.restore();
      server?.stop();
      occupant.kill();
      await occupant.exited;
    }
  });

  test('default probe skips a wildcard occupant that still answers on loopback', async () => {
    const startPort = uniquePort();
    const occupant = spawnPortOccupant({ port: startPort, hostname: '0.0.0.0' });
    const capture = capturePortSkipLogs();
    let server: ReturnType<typeof startNexusHttpServer> | undefined;
    try {
      await waitForOccupantReady(occupant);
      expect(probeNexusHttpPort(startPort)).toBe('occupied');
      server = startNexusHttpServer({
        ...serverFixture(),
        startPort,
        portRange: 2,
        hostname: '127.0.0.1',
      });
      expect(server.port).toBe(startPort + 1);
      expect(capture.records).toEqual([{ port: startPort, reason: 'already answering' }]);
    } finally {
      capture.restore();
      server?.stop();
      occupant.kill();
      await occupant.exited;
    }
  });
});

describe('/v1/health bind identity', () => {
  test('loopback GET without a token reports the hostname selected for Bun.listen', async () => {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'health' });
    const registry = new TabRegistry(state);
    const srv = startNexusHttpServer({
      state,
      registry,
      eventBus: bus,
      startPort: 41000 + Math.floor(Math.random() * 2000),
      hostname: '127.0.0.1',
    });
    try {
      const res = await fetch(`${srv.url}/v1/health`);
      const body = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.bindHost).toBe('127.0.0.1');
      expect(srv.hostname).toBe('127.0.0.1');
    } finally {
      srv.stop();
    }
  });
});

test('GET /v1/drafts/metrics is bearer-gated and answers from the cached source on every load', async () => {
  let reads = 0;
  const snapshot = { state: 'measuring' as const, metrics: null, measuredAt: null, refreshing: true, reason: null };
  const server = startNexusHttpServer({ ...serverFixture(), startPort: uniquePort(),
    metaApi: { bearerToken: 'auth', noAuth: false },
    draftMetrics: { read: () => { reads++; return snapshot; } },
  });
  try {
    const denied = await fetch(`${server.url}/v1/drafts/metrics`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(denied.status).toBe(401);
    expect(reads).toBe(0);
    const headers = { 'sec-fetch-site': 'cross-site', authorization: 'Bearer auth' };
    const ok = await fetch(`${server.url}/v1/drafts/metrics`, { headers });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(snapshot);
    const write = await fetch(`${server.url}/v1/drafts/metrics`, { method: 'POST', headers });
    expect(write.status).toBe(405);
    expect(reads).toBe(1);
  } finally { server.stop(); }
});
