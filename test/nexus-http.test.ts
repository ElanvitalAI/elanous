// NEXUS · HTTP API + SSE tests (Phase N-1 PR δ)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNexus } from '../src/nexus/index.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState, pushEvent } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import { createWebtermTabSpec } from '../src/nexus/kinds/webterm.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-http-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture(): { state: ReturnType<typeof createNexusState>; registry: TabRegistry; bus: NexusEventBus } {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'N-1 PR δ' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  registry.register(createWebtermTabSpec({ id: 'webterm:1' }));
  return { state, registry, bus };
}

const AUTH = { authorization: 'Bearer test-token' };
const META_API = { bearerToken: 'test-token', noAuth: false };

async function uniquePort(): Promise<number> {
  // Pick a port unlikely to collide with parallel tests.
  return 41000 + Math.floor(Math.random() * 2000);
}

describe('NexusEventBus', () => {
  test('subscribe/publish: all topics when no prefix', () => {
    const bus = new NexusEventBus();
    const got: string[] = [];
    bus.subscribe((ev) => got.push(ev.kind));
    bus.publish({ ts: 1, kind: 'nexus.boot' });
    bus.publish({ ts: 2, kind: 'tab.created', tabId: 'chat:1' });
    expect(got).toEqual(['nexus.boot', 'tab.created']);
  });

  test('prefix filter: only matching events delivered', () => {
    const bus = new NexusEventBus();
    const got: string[] = [];
    bus.subscribe((ev) => got.push(ev.kind), ['tab.']);
    bus.publish({ ts: 1, kind: 'nexus.boot' });
    bus.publish({ ts: 2, kind: 'tab.up', tabId: 'chat:1' });
    bus.publish({ ts: 3, kind: 'tab.down', tabId: 'chat:1' });
    expect(got).toEqual(['tab.up', 'tab.down']);
  });

  test('unsubscribe stops delivery', () => {
    const bus = new NexusEventBus();
    const got: string[] = [];
    const off = bus.subscribe((ev) => got.push(ev.kind));
    bus.publish({ ts: 1, kind: 'nexus.boot' });
    off();
    bus.publish({ ts: 2, kind: 'nexus.boot' });
    expect(got).toEqual(['nexus.boot']);
    expect(bus.size()).toBe(0);
  });

  test('throwing listener does not break others', () => {
    const bus = new NexusEventBus();
    bus.subscribe(() => { throw new Error('boom'); });
    let received = false;
    bus.subscribe(() => { received = true; });
    bus.publish({ ts: 1, kind: 'nexus.boot' });
    expect(received).toBe(true);
  });

  test('pushEvent fans out via state.bus', () => {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: '0.4.0', phase: 'N-1' });
    state.bus = bus;
    const got: string[] = [];
    bus.subscribe((ev) => got.push(ev.kind));
    pushEvent(state, { kind: 'nexus.boot' });
    expect(got).toEqual(['nexus.boot']);
  });
});

describe('HTTP routes (read-only)', () => {
  test('without metaApi, private route returns 401 before tab lookup', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: await uniquePort() });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs/nope`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('GET /v1/health returns aggregate counts', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/health`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.tabs.total).toBe(2);
      expect(body.tabs.byStatus.idle).toBe(2);
      expect(body.nexusVersion).toBe('0.4.0');
    } finally { srv.stop(); }
  });

  test('GET /v1/nexus returns snapshot with tabs + recentEvents', async () => {
    const fix = makeFixture();
    pushEvent(fix.state, { kind: 'nexus.boot' });
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/nexus`, { headers: AUTH });
      const body = await res.json();
      expect(body.tabs).toHaveLength(2);
      expect(body.recentEvents.length).toBeGreaterThan(0);
      expect(body.recentEvents.find((e: { kind: string }) => e.kind === 'nexus.boot')).toBeDefined();
    } finally { srv.stop(); }
  });

  test('GET /v1/nexus/tabs?kind=chat filters by kind', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs?kind=chat`, { headers: AUTH });
      const body = await res.json();
      expect(body.tabs).toHaveLength(1);
      expect(body.tabs[0].spec.id).toBe('chat:1');
    } finally { srv.stop(); }
  });

  test('GET /v1/nexus/tabs?kind=bogus returns 400', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs?kind=bogus`, { headers: AUTH });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('GET /v1/nexus/tabs/:id returns tab + recentEvents', async () => {
    const fix = makeFixture();
    pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });
    pushEvent(fix.state, { kind: 'tab.up', tabId: 'webterm:1' });
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs/chat:1`, { headers: AUTH });
      const body = await res.json();
      expect(body.tab.spec.id).toBe('chat:1');
      // Filtered to this tab id only.
      expect(body.recentEvents.every((e: { tabId?: string }) => e.tabId === 'chat:1')).toBe(true);
    } finally { srv.stop(); }
  });

  test('GET /v1/nexus/tabs/:id 404s unknown id', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/nexus/tabs/nope`, { headers: AUTH });
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('unknown route returns 404 json', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/somewhere/else`, { headers: AUTH });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('not-found');
    } finally { srv.stop(); }
  });

  test('non-GET method returns 405', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const res = await fetch(`${srv.url}/v1/health`, { method: 'POST', headers: AUTH });
      expect(res.status).toBe(405);
    } finally { srv.stop(); }
  });

  test('port auto-pick advances when first port is busy', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const blocker = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const next = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
      try {
        expect(next.port).toBeGreaterThan(port);
        expect(next.port).toBeLessThanOrEqual(port + 16);
      } finally { next.stop(); }
    } finally { blocker.stop(); }
  });
});

describe('SSE /v1/events', () => {
  test('streams events filtered by topic prefix', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${srv.url}/v1/events?topics=tab.`, { signal: ctrl.signal, headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // Push two events: one matches the prefix, one does not.
      // (Stream `start` fires synchronously when subscribe runs, so we
      // can publish immediately after the handshake.)
      pushEvent(fix.state, { kind: 'nexus.boot' });
      pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });

      // Read until we have the matching frame.
      const deadline = Date.now() + 2000;
      while (!buf.includes('"kind":"tab.up"') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(buf).toContain('"kind":"tab.up"');
      expect(buf).not.toContain('"kind":"nexus.boot"');
      ctrl.abort();
    } finally { srv.stop(); }
  });

  // NEXUS N-1.5 PR b — /v1/events as SSoT (control-server SSE freeze
  // deprecated under decision #13/#15/#18). Tighten coverage so a
  // future PWA SSE consumer can rely on the contract.

  test('PR b · empty topics param = receive all events (wildcard)', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${srv.url}/v1/events`, { signal: ctrl.signal, headers: AUTH });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      pushEvent(fix.state, { kind: 'nexus.boot' });
      pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });
      const deadline = Date.now() + 2000;
      while (
        !(buf.includes('"kind":"nexus.boot"') && buf.includes('"kind":"tab.up"')) &&
        Date.now() < deadline
      ) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(buf).toContain('"kind":"nexus.boot"');
      expect(buf).toContain('"kind":"tab.up"');
      ctrl.abort();
    } finally { srv.stop(); }
  });

  test('PR b · multiple prefixes match by union', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${srv.url}/v1/events?topics=tab.,nexus.`, { signal: ctrl.signal, headers: AUTH });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      pushEvent(fix.state, { kind: 'nexus.boot' });
      pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });
      pushEvent(fix.state, { kind: 'config.changed' });
      const deadline = Date.now() + 2000;
      while (
        !(buf.includes('"kind":"nexus.boot"') && buf.includes('"kind":"tab.up"')) &&
        Date.now() < deadline
      ) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(buf).toContain('"kind":"nexus.boot"');
      expect(buf).toContain('"kind":"tab.up"');
      expect(buf).not.toContain('"kind":"config.changed"');
      ctrl.abort();
    } finally { srv.stop(); }
  });

  test('PR b · multiple subscribers each receive matching frames', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();
      const [res1, res2] = await Promise.all([
        fetch(`${srv.url}/v1/events?topics=tab.`, { signal: ctrl1.signal, headers: AUTH }),
        fetch(`${srv.url}/v1/events?topics=tab.`, { signal: ctrl2.signal, headers: AUTH }),
      ]);
      const r1 = res1.body!.getReader();
      const r2 = res2.body!.getReader();
      const dec = new TextDecoder();
      let b1 = '';
      let b2 = '';
      pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });
      const deadline = Date.now() + 2000;
      while (
        !(b1.includes('"kind":"tab.up"') && b2.includes('"kind":"tab.up"')) &&
        Date.now() < deadline
      ) {
        const a = await r1.read();
        if (!a.done) b1 += dec.decode(a.value, { stream: true });
        const b = await r2.read();
        if (!b.done) b2 += dec.decode(b.value, { stream: true });
      }
      expect(b1).toContain('"kind":"tab.up"');
      expect(b2).toContain('"kind":"tab.up"');
      ctrl1.abort();
      ctrl2.abort();
    } finally { srv.stop(); }
  });

  test('PR b · frame format follows SSE spec (event: + data: pair)', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${srv.url}/v1/events?topics=tab.`, { signal: ctrl.signal, headers: AUTH });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      pushEvent(fix.state, { kind: 'tab.up', tabId: 'chat:1' });
      const deadline = Date.now() + 2000;
      while (!buf.includes('"kind":"tab.up"') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      // Per SSE spec the frame must include `event: <kind>` followed by
      // `data: <payload>` separated by a blank line (\n\n).
      expect(buf).toContain('event: tab.up\n');
      expect(buf).toMatch(/data: \{[^\n]*"kind":"tab\.up"[^\n]*\}\n\n/);
      ctrl.abort();
    } finally { srv.stop(); }
  });

  test('PR b · subscriber count returns to baseline after client abort', async () => {
    const fix = makeFixture();
    const port = await uniquePort();
    const srv = startNexusHttpServer({ ...fix, eventBus: fix.bus, startPort: port, metaApi: META_API });
    try {
      const baseline = fix.bus.size();
      const ctrl = new AbortController();
      const res = await fetch(`${srv.url}/v1/events?topics=tab.`, { signal: ctrl.signal, headers: AUTH });
      // Drain initial comment frame so the subscriber is registered.
      const reader = res.body!.getReader();
      await reader.read();
      expect(fix.bus.size()).toBe(baseline + 1);
      ctrl.abort();
      // The bus subscription is torn down via the cancel callback. Bun
      // schedules the cancel callback asynchronously, so wait briefly.
      const deadline = Date.now() + 1500;
      while (fix.bus.size() !== baseline && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fix.bus.size()).toBe(baseline);
    } finally { srv.stop(); }
  });
});

describe('runNexus integration with HTTP server', () => {
  test('detachForTesting skips HTTP server (no port bind)', async () => {
    const handle = await runNexus({ detachForTesting: true });
    try {
      expect(handle!.httpServer).toBeUndefined();
      expect(handle!.eventBus).toBeDefined();
    } finally { handle!.release(); }
  });

  test('skipHttpServer=false starts the server even with detachForTesting', async () => {
    const port = 42000 + Math.floor(Math.random() * 1000);
    const handle = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      httpStartPort: port,
    });
    try {
      expect(handle!.httpServer).toBeDefined();
      expect(handle!.runtime.httpPort).toBe(handle!.httpServer!.port);
      const res = await fetch(`${handle!.httpServer!.url}/v1/health`);
      expect(res.status).toBe(200);
    } finally { handle!.release(); }
  });
});
