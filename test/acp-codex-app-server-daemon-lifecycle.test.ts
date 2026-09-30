// M6 (2026-04-28) — codex-app-server daemon idle hibernate.
//
// Verifies:
//   - Client side: lastUsedAt + getIdleAgeMs bump on outbound write
//     and inbound message; getLastUsedAt reflects activity.
//   - Agent side: configured idleTimeoutMs hibernates the daemon after
//     the threshold elapses, preserving session→thread maps. The next
//     prompt() lazy-restarts via the spawn factory and issues a
//     thread/resume against the fresh daemon before turn/start.
//   - Race safety: concurrent prompts during a lazy restart share the
//     same startInFlight promise (no double spawn).
//   - Disabled path: idleTimeoutMs=0 leaves the timer dormant.

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CodexAppServerAgent,
} from '../src/acp/codex-app-server-agent.js';
import { CodexAppServerClient } from '../src/acp/codex-app-server-client.js';
import type {
  CasThreadIndex,
  CasThreadIndexEntry,
} from '../src/acp/codex-app-server-thread-index.js';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../src/acp/codex-app-server-proto.js';
import type {
  SpawnCodexAppServerOpts,
  SpawnedCodexAppServer,
} from '../src/acp/codex-app-server-client.js';

// ─── Test harness ─────────────────────────────────────────────────────

function makeMemThreadIndex(): CasThreadIndex {
  const map = new Map<string, CasThreadIndexEntry>();
  return {
    get path() { return '/mem'; },
    get(id) { return map.get(id) ?? null; },
    put(id, input) {
      const ts = Date.now();
      const entry: CasThreadIndexEntry = {
        synthId: id,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: input.createdAt ?? ts,
        lastTurnAt: input.lastTurnAt ?? ts,
      };
      map.set(id, entry);
      return entry;
    },
    touch(id) {
      const e = map.get(id);
      if (!e) return null;
      const updated = { ...e, lastTurnAt: Date.now() };
      map.set(id, updated);
      return updated;
    },
    setMcpPolicy(id, policy) {
      const e = map.get(id);
      if (!e) return null;
      const updated = policy === null ? { ...e } : { ...e, mcpPolicy: policy };
      if (policy === null) delete (updated as { mcpPolicy?: unknown }).mcpPolicy;
      map.set(id, updated);
      return updated;
    },
    remove(id) { return map.delete(id); },
    list() { return [...map.values()]; },
  };
}

interface TransportSlot {
  client: CodexAppServerClient;
  child: { kill: (sig: NodeJS.Signals) => boolean; killed: boolean; pid: number };
  stdin: PassThrough;
  stdout: PassThrough;
  sent: JsonRpcRequest[];
  reply(id: string | number, result: unknown): void;
  notify(method: string, params: unknown): void;
}

function buildTransport(): TransportSlot {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent: JsonRpcRequest[] = [];
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && 'method' in obj) {
          sent.push(obj as JsonRpcRequest);
        }
      } catch {
        /* swallow */
      }
    }
  });
  const client = new CodexAppServerClient({
    stdin,
    stdout,
    requestTimeoutMs: null,
  });
  // Simulated child — captures kill calls for hibernate assertions.
  const fakeChild = Object.assign(new EventEmitter(), {
    killed: false,
    pid: 4242,
    kill(_sig: NodeJS.Signals = 'SIGTERM'): boolean {
      fakeChild.killed = true;
      return true;
    },
  }) as unknown as TransportSlot['child'];
  return {
    client,
    child: fakeChild,
    stdin,
    stdout,
    sent,
    reply(id, result) {
      const resp: JsonRpcResponse = { jsonrpc: '2.0', id, result };
      stdout.write(JSON.stringify(resp) + '\n');
    },
    notify(method, params) {
      const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      stdout.write(JSON.stringify(notif) + '\n');
    },
  };
}

interface FactoryHarness {
  agent: CodexAppServerAgent;
  transports: TransportSlot[];
  /** Most recently spawned transport. */
  latest(): TransportSlot;
}

interface FactoryOpts {
  idleTimeoutMs?: number;
  idleCheckMs?: number;
}

function makeFactoryHarness(opts: FactoryOpts = {}): FactoryHarness {
  const transports: TransportSlot[] = [];
  const factory = (_spawnOpts: SpawnCodexAppServerOpts): SpawnedCodexAppServer => {
    const slot = buildTransport();
    transports.push(slot);
    return {
      client: slot.client,
      child: slot.child as unknown as SpawnedCodexAppServer['child'],
    };
  };
  const agent = new CodexAppServerAgent({
    backendId: 'codex-app-server',
    cwd: '/tmp',
    idleTimeoutMs: opts.idleTimeoutMs,
    idleCheckMs: opts.idleCheckMs,
    _spawnFactory: factory,
    _threadIndexForTesting: makeMemThreadIndex(),
  });
  return {
    agent,
    transports,
    latest() {
      return transports[transports.length - 1]!;
    },
  };
}

async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

function findRequest(sent: JsonRpcRequest[], method: string): JsonRpcRequest | undefined {
  return sent.find((m) => m.method === method);
}

async function bringUp(h: FactoryHarness): Promise<{ sessionId: string; threadId: string }> {
  const startP = h.agent.newSession();
  await tick();
  const initReq = findRequest(h.latest().sent, 'initialize');
  h.latest().reply(initReq!.id, { serverInfo: { name: 'codex', version: '0' } });
  await tick();
  const startReq = findRequest(h.latest().sent, 'thread/start');
  const threadId = 'th-1';
  h.latest().reply(startReq!.id, { thread: { id: threadId }, model: 'gpt-5' });
  const sessionId = await startP;
  return { sessionId: sessionId as unknown as string, threadId };
}

// ─── client.ts side: getIdleAgeMs ─────────────────────────────────────

describe('CodexAppServerClient · M6 · idle observability', () => {
  test('getIdleAgeMs returns 0 just after construction', () => {
    const slot = buildTransport();
    expect(slot.client.getIdleAgeMs()).toBeLessThan(10);
  });

  test('getIdleAgeMs increases over wall-clock time without activity', async () => {
    const slot = buildTransport();
    await new Promise((r) => setTimeout(r, 25));
    expect(slot.client.getIdleAgeMs()).toBeGreaterThanOrEqual(20);
  });

  test('outbound notify bumps lastUsedAt', async () => {
    const slot = buildTransport();
    await new Promise((r) => setTimeout(r, 25));
    const before = slot.client.getIdleAgeMs();
    slot.client.notify('keepalive', {});
    await tick();
    expect(slot.client.getIdleAgeMs()).toBeLessThan(before);
  });

  test('inbound notification bumps lastUsedAt', async () => {
    const slot = buildTransport();
    await new Promise((r) => setTimeout(r, 25));
    const before = slot.client.getIdleAgeMs();
    slot.notify('item/started', { threadId: 'x', item: { id: 'a' } });
    await tick();
    expect(slot.client.getIdleAgeMs()).toBeLessThan(before);
  });

  test('getLastUsedAt returns the same timestamp scale as Date.now', () => {
    const slot = buildTransport();
    const now = Date.now();
    const lu = slot.client.getLastUsedAt();
    expect(lu).toBeGreaterThanOrEqual(now - 50);
    expect(lu).toBeLessThanOrEqual(now + 50);
  });
});

// ─── agent.ts side: hibernate config + lifecycle ──────────────────────

describe('CodexAppServerAgent · M6 · idle config', () => {
  test('default idleTimeoutMs is 300_000', () => {
    const prev = process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
    delete process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
    try {
      const h = makeFactoryHarness();
      expect(h.agent.getIdleTimeoutMs()).toBe(300_000);
    } finally {
      if (prev !== undefined) process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS = prev;
    }
  });

  test('opts.idleTimeoutMs wins over env', () => {
    const prev = process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
    process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS = '60000';
    try {
      const h = makeFactoryHarness({ idleTimeoutMs: 12345 });
      expect(h.agent.getIdleTimeoutMs()).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
      else process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS = prev;
    }
  });

  test('env override applies when opts unset', () => {
    const prev = process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
    process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS = '12345';
    try {
      const h = makeFactoryHarness();
      expect(h.agent.getIdleTimeoutMs()).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS;
      else process.env.ELANOUS_CODEX_APP_SERVER_IDLE_MS = prev;
    }
  });

  test('idleTimeoutMs=0 disables hibernation (no kill on long idle)', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0, idleCheckMs: 5 });
    const { sessionId } = await bringUp(h);
    expect(sessionId).toBeDefined();
    const t0 = h.latest();
    expect(t0.child.killed).toBe(false);
    // Force any pending timers to evaluate even though they shouldn't be
    // armed at all.
    await new Promise((r) => setTimeout(r, 30));
    expect(t0.child.killed).toBe(false);
    await h.agent.stop();
  });
});

describe('CodexAppServerAgent · M6 · hibernate', () => {
  test('idle timer fires hibernate after threshold (kills child + nulls client)', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 25, idleCheckMs: 5 });
    const { sessionId } = await bringUp(h);
    const t0 = h.latest();
    // Wait past the idle threshold + a couple of poll ticks.
    await new Promise((r) => setTimeout(r, 60));
    expect(t0.child.killed).toBe(true);
    expect(h.agent.getCapabilities()).toBeNull();
    // Session→thread map preserved.
    expect((h.agent as unknown as { sessionToThread: Map<unknown, unknown> }).sessionToThread.get(
      sessionId as unknown,
    )).toBeDefined();
    await h.agent.stop();
  });

  test('_testForceIdleHibernate convenience kills child + clears currentDaemonSessions', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0 });
    const { sessionId } = await bringUp(h);
    const t0 = h.latest();
    h.agent._testForceIdleHibernate();
    expect(t0.child.killed).toBe(true);
    expect(
      (h.agent as unknown as { currentDaemonSessions: Set<unknown> }).currentDaemonSessions.size,
    ).toBe(0);
    expect(
      (h.agent as unknown as { sessionToThread: Map<unknown, unknown> }).sessionToThread.has(
        sessionId as unknown,
      ),
    ).toBe(true);
    await h.agent.stop();
  });

  test('hibernate rejects pending turn promises', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0 });
    const { sessionId } = await bringUp(h);
    const t0 = h.latest();
    const p = h.agent.prompt(
      sessionId as unknown as Parameters<typeof h.agent.prompt>[0],
      [{ type: 'text', text: 'stay' }],
      () => undefined,
    );
    await tick();
    const turn = findRequest(t0.sent, 'turn/start');
    expect(turn).toBeDefined();
    h.agent._testForceIdleHibernate();
    const result = await p.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    expect(result).toContain('hibernated');
    await h.agent.stop();
  });

  test('prompt after hibernate lazy-restarts + thread/resume + turn/start', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0 });
    const { sessionId, threadId } = await bringUp(h);
    h.agent._testForceIdleHibernate();
    expect(h.transports.length).toBe(1);

    const onUpdate = () => undefined;
    const p = h.agent.prompt(
      sessionId as unknown as Parameters<typeof h.agent.prompt>[0],
      [{ type: 'text', text: 'after-hibernate' }],
      onUpdate,
    );
    await tick();
    // Second daemon spawned for the lazy restart.
    expect(h.transports.length).toBe(2);
    const t1 = h.latest();
    const initReq = findRequest(t1.sent, 'initialize');
    expect(initReq).toBeDefined();
    t1.reply(initReq!.id, { serverInfo: { name: 'codex', version: '0' } });
    await tick();
    // thread/resume comes BEFORE turn/start.
    const resumeReq = findRequest(t1.sent, 'thread/resume');
    expect(resumeReq).toBeDefined();
    expect((resumeReq!.params as { threadId: string }).threadId).toBe(threadId);
    t1.reply(resumeReq!.id, { thread: { id: threadId }, model: 'gpt-5' });
    await tick();
    const turnReq = findRequest(t1.sent, 'turn/start');
    expect(turnReq).toBeDefined();
    t1.reply(turnReq!.id, { turnId: 'after-hib-turn' });
    // Reject is fine — we only assert lifecycle reached turn/start.
    p.catch(() => undefined);
    await h.agent.stop();
  });

  test('subsequent prompts on same session skip the resume RPC', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0 });
    const { sessionId, threadId } = await bringUp(h);
    h.agent._testForceIdleHibernate();

    const p1 = h.agent.prompt(
      sessionId as unknown as Parameters<typeof h.agent.prompt>[0],
      [{ type: 'text', text: 'first' }],
      () => undefined,
    );
    await tick();
    const t1 = h.latest();
    t1.reply(findRequest(t1.sent, 'initialize')!.id, {});
    await tick();
    t1.reply(findRequest(t1.sent, 'thread/resume')!.id, { thread: { id: threadId } });
    await tick();
    t1.reply(findRequest(t1.sent, 'turn/start')!.id, { turnId: 't1' });
    p1.catch(() => undefined);
    // simulate completion to allow another prompt
    t1.notify('turn/completed', { threadId, turn: { status: 'completed' } });
    await tick();

    const sentSnapshot = t1.sent.length;
    const p2 = h.agent.prompt(
      sessionId as unknown as Parameters<typeof h.agent.prompt>[0],
      [{ type: 'text', text: 'second' }],
      () => undefined,
    );
    await tick();
    // Only turn/start — no second resume.
    const newRequests = t1.sent.slice(sentSnapshot);
    expect(newRequests.some((r) => r.method === 'thread/resume')).toBe(false);
    expect(newRequests.some((r) => r.method === 'turn/start')).toBe(true);
    p2.catch(() => undefined);
    await h.agent.stop();
  });

  test('concurrent prompts during a lazy restart share startInFlight (no double spawn)', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 0 });
    const { sessionId, threadId } = await bringUp(h);
    h.agent._testForceIdleHibernate();

    const p1 = h.agent.prompt(
      sessionId as unknown as Parameters<typeof h.agent.prompt>[0],
      [{ type: 'text', text: 'a' }],
      () => undefined,
    );
    // Same tick — second prompt arrives before initialize round-trip.
    const p2 = h.agent.newSession();
    await tick();
    expect(h.transports.length).toBe(2); // exactly one new spawn

    const t1 = h.latest();
    t1.reply(findRequest(t1.sent, 'initialize')!.id, {});
    await tick();
    // p1 needs thread/resume + turn/start; p2 needs thread/start.
    const resumeReq = findRequest(t1.sent, 'thread/resume');
    expect(resumeReq).toBeDefined();
    t1.reply(resumeReq!.id, { thread: { id: threadId } });
    await tick();
    const ts = findRequest(t1.sent, 'thread/start');
    expect(ts).toBeDefined();
    t1.reply(ts!.id, { thread: { id: 'th-2' }, model: 'm' });
    await tick();
    const turnReq = findRequest(t1.sent, 'turn/start');
    if (turnReq) t1.reply(turnReq.id, { turnId: 't1-after' });
    await tick();
    p1.catch(() => undefined);
    await p2;
    await h.agent.stop();
  });

  test('stop() clears the idle timer', async () => {
    const h = makeFactoryHarness({ idleTimeoutMs: 1_000, idleCheckMs: 5 });
    const agentWithIdleCheck = h.agent as unknown as { checkIdle: () => void; idleTimerHandle: unknown };
    const checkIdle = agentWithIdleCheck.checkIdle.bind(h.agent);
    let idleChecks = 0;
    agentWithIdleCheck.checkIdle = () => {
      idleChecks++;
      checkIdle();
    };
    await bringUp(h);
    await new Promise((r) => setTimeout(r, 25));
    expect(idleChecks).toBeGreaterThan(0);
    await h.agent.stop();
    const checksAtStop = idleChecks;
    // A lingering interval would still call checkIdle even though stop nulled the client and handle.
    await new Promise((r) => setTimeout(r, 60));
    expect(idleChecks - checksAtStop).toBe(0);
    expect(h.transports).toHaveLength(1);
    expect(agentWithIdleCheck.idleTimerHandle).toBeNull();
  });
});
