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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
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
