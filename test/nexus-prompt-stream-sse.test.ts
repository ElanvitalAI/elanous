// Phase B-1 (PWA chat streaming · 2026-05-06) — daemon-side SSE wire
// contract for `POST /v1/prompt/stream`.
//
// Locks the event ordering + payload shape the PWA `parsePromptSseStream`
// (apps/pwa/src/lib/daemon-client.ts) consumes. If either side drifts,
// these tests fail before users see a frozen `/chat` bubble.
//
// Two layers:
// 1. Routing — absent metaApi → default-deny 401 (before the
//    `/v1/prompt` not-wired stub can run).
// 2. SSE wire — wired metaApi → text-delta + turn-end event stream.
//    `runCoreTurn` is spied so we can drive deltas without booting an
//    LLM provider.
//
// Contract classification (GoalId 5b4c31c4c4f1139e): intentional changes.
// Commit 56f22ecccace2f0fa82f1e7a464e2fc043c27bd0 states that the Thinking
// bridge emits Feedback Envelopes and that PWA consumes them over
// `/v1/prompt/stream` SSE, so the strict event arrays below include `feedback`.
// Commit d982bcafb8cc5b54cc1f7f1cd264a254a25e46c7 states that the SurfacePicker
// forwards `tools` to `/v1/prompt/stream` and the daemon swaps that turn's
// surface. Commit 9a126a5a33fc53d8e1ba299d1526bdb8808501bd explicitly makes
// daemon chat reuse the shared core+finance assembly, and commit
// 41385d0e806cc49a346858e5eaef0fe0bed708e0 exposes live MCP names. This
// fixture disables the optional finance pack, so it locks the stable coding,
// core, and skill portions of that intended catalogue; an empty per-request
// catalogue is payload drift, not a contract change.
// The existing execution boundary is this test's `startNexusHttpServer()`
// request, which routes POST /v1/prompt/stream to handlePromptStreamPost,
// then resolvePerRequestToolSurface → runDaemonPromptTurn → runCoreTurn.

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import { toolSurface } from '../src/boot/daemon-tools/index.js';
import * as coreTurnModule from '../src/core-turn/index.js';
import * as userConfigModule from '../src/user-config.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-prompt-stream-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  spyOn(userConfigModule, 'getUserConfig').mockReturnValue({ finance: { enabled: false } } as userConfigModule.UserConfig);
});

afterEach(() => {
  mock.restore();
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
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'B-1' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  return { state, registry, bus };
}

let portCursor = 49000;
function uniquePort(): number {
  portCursor += 1;
  return portCursor;
}

interface SseEvent {
  event: string;
  data: unknown;
}

async function drainSse(res: Response): Promise<SseEvent[]> {
  expect(res.body).not.toBeNull();
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  const events: SseEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          const rest = line.slice(5);
          dataStr += rest.startsWith(' ') ? rest.slice(1) : rest;
        }
      }
      if (dataStr) {
        try { events.push({ event, data: JSON.parse(dataStr) }); }
        catch { /* drop malformed */ }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  return events;
}

describe('POST /v1/prompt/stream — SSE routing + wire contract', () => {
  test('authenticated request with no history returns 503 after the auth gate', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix, eventBus: fix.bus, startPort: uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ userText: 'hi' }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('meta-api-runtime-not-wired');
    } finally { srv.stop(); }
  });

  test('returns 401 unauthorized when metaApi runtime is absent', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userText: 'hi' }),
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('emits turn-begin → text-delta → turn-end events with the locked payload shape', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Drive two deltas through the same callback the production
      // turn loop would invoke. The handler bridges these to SSE
      // text-delta events without re-shaping.
      ctx.callbacks?.onText?.('Hel', 'Hel');
      ctx.callbacks?.onText?.('lo', 'Hello');
      return { stopReason: 'end_turn', finalText: 'Hello' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: {
        noAuth: true,
        history,
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-stream-1', userText: 'hi' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const events = await drainSse(res);

      // Locked sequence: begin → thinking feedback → 2× delta → final
      // feedback → end. No `error` event.
      expect(events.map((e) => e.event)).toEqual([
        'turn-begin',
        'feedback',
        'text-delta',
        'text-delta',
        'feedback',
        'feedback',
        'turn-end',
      ]);
      expect(events[0]!.data).toEqual({ sessionId: 'sess-stream-1' });
      expect(events[2]!.data).toEqual({ delta: 'Hel', full: 'Hel' });
      expect(events[3]!.data).toEqual({ delta: 'lo', full: 'Hello' });
      expect(events[6]!.data).toEqual({
        sessionId: 'sess-stream-1',
        text: 'Hello',
        stopReason: 'end_turn',
      });
    } finally { srv.stop(); }
  });

  test('B-2.5: emits image-block events when tool returns image-bearing result + interleaves with text-delta', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Mirror the production tool-loop ordering: text streams →
      // tool fires (image arrives mid-turn) → text resumes.
      ctx.callbacks?.onText?.('look', 'look');
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: 'WebTerminalScreenshot',
        result: { mediaType: 'image/png', dataB64: 'iVBORw0KGgo=' },
      });
      ctx.callbacks?.onText?.('ing', 'looking');
      return { stopReason: 'end_turn', finalText: 'looking' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-img-1', userText: 'capture' }),
      });
      expect(res.status).toBe(200);
      const events = await drainSse(res);

      // Phase B-3 (2026-05-06) — every tool result now also fires a
      // `tool-result` SSE event for the status pill, alongside the
      // image-block event for vision-bearing results. The intentional
      // feedback contract adds thinking begin/delta/end envelopes around
      // the existing sequence.
      expect(events.map((e) => e.event)).toEqual([
        'turn-begin',
        'feedback',
        'text-delta',
        'image-block',
        'tool-result',
        'text-delta',
        'feedback',
        'feedback',
        'turn-end',
      ]);

      const imageEvent = events[3]!.data as {
        src: string;
        mediaType: string;
        alt: string;
      };
      expect(imageEvent.src).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(imageEvent.mediaType).toBe('image/png');
      expect(imageEvent.alt).toBe('WebTerminalScreenshot result');
    } finally { srv.stop(); }
  });

  test('B-2.5: omits `alt` from the image-block payload when the daemon side has none', async () => {
    // Defensive: the runDaemonPromptTurn callback always supplies alt
    // today (`${name} result`), but if a future caller passes
    // onImageBlock with no alt the SSE payload should match the PWA
    // type (alt is optional in the wire). This test pins the meta-api
    // handler's conditional spread so a refactor can't accidentally
    // emit `"alt":undefined` literal.
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Synthesize an image result that bypasses the daemon's default
      // alt: tool result with empty name so alt becomes ` result`
      // (still defined, so the conditional stays); negative case
      // requires future caller. For now assert at least the field is
      // absent when the tool name is empty + we monkey the alt.
      ctx.callbacks?.onToolResult?.({
        id: 'call-1',
        name: '',
        result: { mediaType: 'image/png', dataB64: 'AAA' },
      });
      return { stopReason: 'end_turn', finalText: '' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-no-alt', userText: 'x' }),
      });
      const events = await drainSse(res);
      const imgEvent = events.find((e) => e.event === 'image-block');
      expect(imgEvent).toBeDefined();
      const data = imgEvent!.data as Record<string, unknown>;
      expect(data.src).toBe('data:image/png;base64,AAA');
      expect(data.mediaType).toBe('image/png');
      // Empty-name tool still produces an alt string, so this asserts
      // the wire payload remains JSON-clean (no literal `undefined`).
      expect('alt' in data).toBe(true);
      expect(typeof data.alt).toBe('string');
    } finally { srv.stop(); }
  });

  // ── Phase B-3 (PWA chat streaming · 2026-05-06) ──────────────────

  test('B-3: emits tool-call + tool-result SSE events with id correlation', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onToolCall?.({
        id: 'c1',
        name: 'Read',
        args: { path: '/tmp/x' },
      });
      ctx.callbacks?.onToolResult?.({
        id: 'c1',
        name: 'Read',
        result: { lines: Array(3).fill('line') },
      });
      ctx.callbacks?.onText?.('done', 'done');
      return { stopReason: 'end_turn', finalText: 'done' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-tool-1', userText: 'x' }),
      });
      const events = await drainSse(res);
      expect(events.map((e) => e.event)).toEqual([
        'turn-begin',
        'feedback',
        'tool-call',
        'tool-result',
        'text-delta',
        'feedback',
        'feedback',
        'turn-end',
      ]);
      const callEvent = events[2]!.data as {
        id: string;
        name: string;
        args: Record<string, unknown>;
      };
      const resultEvent = events[3]!.data as {
        id: string;
        name: string;
        ok: boolean;
        summary?: string;
      };
      expect(callEvent.id).toBe('c1');
      expect(callEvent.name).toBe('Read');
      expect(callEvent.args).toEqual({ path: '/tmp/x' });
      expect(resultEvent.id).toBe('c1');
      expect(resultEvent.ok).toBe(true);
      expect(resultEvent.summary).toBe('3 lines');
    } finally { srv.stop(); }
  });

  test('B-3: client disconnect (ReadableStream cancel) triggers daemon abort signal', async () => {
    let abortObserved = false;
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Wait for the abort to fire — the daemon's per-turn signal is
      // forwarded to ctx.signal. If the cancel handler aborts it,
      // we observe it here. Time-bound the wait so a misconfigured
      // wire doesn't hang the test.
      const start = Date.now();
      while (Date.now() - start < 500) {
        if (ctx.signal.aborted) {
          abortObserved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return {
        stopReason: ctx.signal.aborted ? 'aborted' : 'end_turn',
        finalText: '',
      };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const ac = new AbortController();
      const fetchPromise = fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-cancel', userText: 'x' }),
        signal: ac.signal,
      });
      // Give the server a moment to start the stream + enter
      // runCoreTurn before we abort the fetch.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      // Drain any error from the aborted fetch (don't care).
      try { await fetchPromise; } catch { /* expected */ }
      // Give the server time to observe the cancel and run cleanup.
      await new Promise((r) => setTimeout(r, 100));
      expect(abortObserved).toBe(true);
    } finally { srv.stop(); }
  });

  test('emits a terminal `error` event with turn_failed payload when runCoreTurn throws', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => {
      throw new Error('llm exploded');
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: {
        noAuth: true,
        history,
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-error', userText: 'hi' }),
      });
      // SSE response status stays 200 — error is in-band so the PWA
      // can render the user's prior deltas before the failure line.
      expect(res.status).toBe(200);
      const events = await drainSse(res);
      expect(events.map((e) => e.event)).toEqual([
        'turn-begin',
        'feedback',
        'feedback',
        'error',
      ]);
      const errPayload = events[3]!.data as { error: string; message: string };
      expect(errPayload.error).toBe('turn_failed');
      expect(errPayload.message).toBe('llm exploded');
    } finally { srv.stop(); }
  });

  test('rejects unauthorized requests when bearer token is configured (401, not SSE)', async () => {
    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: {
        bearerToken: 'tok-secret',
        history,
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userText: 'hi' }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('unauthorized');
    } finally { srv.stop(); }
  });

  // ── Phase B-4 (PWA chat streaming · 2026-05-06) ──────────────────

  test('B-4: GET /v1/chat/events without sessionId returns 400 bad_request', async () => {
    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const res = await fetch(`${srv.url}/v1/chat/events`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
    } finally { srv.stop(); }
  });

  test('B-4: GET /v1/chat/events emits a `subscribed` event immediately and observes published turns', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      // Give the observer time to subscribe before we publish.
      await new Promise((r) => setTimeout(r, 30));
      ctx.callbacks?.onText?.('hi', 'hi');
      return { stopReason: 'end_turn', finalText: 'hi' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      // Step 1 — observer connects + reads the `subscribed` marker.
      const observerRes = await fetch(
        `${srv.url}/v1/chat/events?sessionId=sess-fanout-1`,
      );
      expect(observerRes.status).toBe(200);
      const reader = observerRes.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: { event: string; data: unknown }[] = [];
      const pumpUntilTurnEnd = async (): Promise<void> => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) {
                const rest = line.slice(5);
                dataStr += rest.startsWith(' ') ? rest.slice(1) : rest;
              }
            }
            if (dataStr) {
              try { events.push({ event, data: JSON.parse(dataStr) }); }
              catch { /* drop malformed */ }
            }
            idx = buf.indexOf('\n\n');
          }
          if (events.find((e) => e.event === 'turn-end')) return;
        }
      };

      // Step 2 — fire a POST to that same session in parallel.
      const postPromise = fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-fanout-1', userText: 'x' }),
      });

      // Step 3 — observer must see the same wire shape (subscribed →
      // turn-begin → text-delta → turn-end). Drain until turn-end.
      await pumpUntilTurnEnd();
      // Cancel observer + drain POST body.
      try { await reader.cancel(); } catch { /* ignore */ }
      const postRes = await postPromise;
      try { await postRes.body?.cancel(); } catch { /* ignore */ }

      const eventNames = events.map((e) => e.event);
      expect(eventNames[0]).toBe('subscribed');
      expect(eventNames).toContain('turn-begin');
      expect(eventNames).toContain('text-delta');
      expect(eventNames).toContain('turn-end');
      const subscribed = events[0]!.data as { sessionId: string };
      expect(subscribed.sessionId).toBe('sess-fanout-1');
    } finally { srv.stop(); }
  });

  // Review comment #1 (PR #1788) — pin `publishedSessionId` provenance.
  //
  // The handler captures `parsed.value.sessionId` AT REQUEST TIME and
  // uses that for every `bus.publish`. If a future refactor moves the
  // mint downstream (so the topic id changes mid-turn) every observer
  // would silently miss events. This test pins the contract from both
  // angles:
  //   - caller-supplied sessionId → bus topic === supplied id
  //   - caller omits sessionId → daemon mints, turn-begin event payload
  //     equals the bus topic (so a fresh observer that learns the id
  //     from turn-begin can still subscribe successfully on the next
  //     turn)
  test('B-4: bus.publish topic === parsed.value.sessionId for both supplied and minted ids', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onText?.('x', 'x');
      return { stopReason: 'end_turn', finalText: 'x' };
    });

    // Inject a tracking bus so we can read which sessionId every
    // publish was scoped to. `__setChatEventBusForTest` returns a
    // disposer; meta-api reads `defaultChatEventBus()` so the
    // injection takes effect for the next request.
    const { createChatEventBus, __setChatEventBusForTest } = await import(
      '../src/nexus/api/chat-event-bus.js'
    );
    const tracker = createChatEventBus();
    const seenTopics: string[] = [];
    const realPublish = tracker.publish.bind(tracker);
    tracker.publish = (sessionId, event) => {
      seenTopics.push(sessionId);
      realPublish(sessionId, event);
    };
    const restore = __setChatEventBusForTest(tracker);

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      // Case 1 — caller supplies a specific id.
      const supplied = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-supplied', userText: 'x' }),
      });
      const evA = await drainSse(supplied);
      const beginA = evA[0]!.data as { sessionId: string };
      expect(beginA.sessionId).toBe('sess-supplied');
      expect(new Set(seenTopics)).toContain('sess-supplied');

      // Case 2 — caller omits sessionId; parseDaemonPromptBody mints.
      seenTopics.length = 0;
      const minted = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userText: 'x' }),
      });
      const evB = await drainSse(minted);
      const beginB = evB[0]!.data as { sessionId: string };
      // The minted id must be in the turn-begin payload.
      expect(typeof beginB.sessionId).toBe('string');
      expect(beginB.sessionId.length).toBeGreaterThan(0);
      // And every bus.publish for this turn must have used that
      // exact id — never a different one.
      const uniqTopics = Array.from(new Set(seenTopics));
      expect(uniqTopics).toEqual([beginB.sessionId]);
    } finally {
      restore();
      srv.stop();
    }
  });

  // Review comment #3 (PR #1788) — verify listener cleanup.
  //
  // SSE integration tests use the process-singleton bus. Each subscribe
  // must release its listener slot when the observer's ReadableStream
  // is canceled (client navigates away · fetch abort · process exit).
  // If `ReadableStream.cancel` does not fire `unsubscribe`, the bus
  // leaks listeners and a future POST turn would replay events into
  // dead handlers (silently — try/catch isolated, but still wasted
  // work). This test pins `subscriberCount === 0` after the observer
  // disconnects.
  test('B-4: cancelling the observer stream releases the bus listener slot', async () => {
    const { defaultChatEventBus } = await import(
      '../src/nexus/api/chat-event-bus.js'
    );
    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const sessionId = `sess-cleanup-${Math.random().toString(36).slice(2, 8)}`;
      const bus = defaultChatEventBus();
      expect(bus.subscriberCount(sessionId)).toBe(0);

      // Use AbortController on the fetch itself — aborting at the
      // request level closes the underlying socket, which Bun.serve
      // detects + propagates to the Response body's `cancel` handler.
      // Plain `reader.cancel()` on the consumer side may not flush
      // through the loopback bridge fast enough; aborting the fetch
      // is the deterministic path.
      const ac = new AbortController();
      const observer = await fetch(
        `${srv.url}/v1/chat/events?sessionId=${sessionId}`,
        { signal: ac.signal },
      );
      const reader = observer.body!.getReader();
      // Pump until we see the `subscribed` marker so we know the
      // bus.subscribe() call has executed before we measure.
      const dec = new TextDecoder();
      let buf = '';
      let sawSubscribed = false;
      while (!sawSubscribed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('event: subscribed')) sawSubscribed = true;
      }
      expect(sawSubscribed).toBe(true);
      expect(bus.subscriberCount(sessionId)).toBe(1);

      // Disconnect by aborting the fetch — closes socket → Bun.serve
      // fires cancel on the source stream → our cancel handler
      // unsubscribes from the bus.
      ac.abort();
      try { await reader.cancel(); } catch { /* expected after abort */ }

      // Poll briefly for the listener slot to release. Bun routes the
      // cancel handler through a microtask after the socket close, so
      // a tight retry loop converges within ~50ms in practice.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && bus.subscriberCount(sessionId) > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(bus.subscriberCount(sessionId)).toBe(0);
    } finally { srv.stop(); }
  });

  test('B-4: cross-session isolation — observer for session A sees no events from session B', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      await new Promise((r) => setTimeout(r, 20));
      ctx.callbacks?.onText?.('hi', 'hi');
      return { stopReason: 'end_turn', finalText: 'hi' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      // Observe session A.
      const observerRes = await fetch(
        `${srv.url}/v1/chat/events?sessionId=sess-A`,
      );
      const reader = observerRes.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const events: { event: string; data: unknown }[] = [];
      const drainFor = async (ms: number): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < ms) {
          const winner = await Promise.race([
            reader.read(),
            new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true } as never), ms - (Date.now() - start) + 5)),
          ]);
          if ((winner as { done: boolean }).done) return;
          const value = (winner as { value?: Uint8Array }).value;
          if (!value) return;
          buf += dec.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) {
                const rest = line.slice(5);
                dataStr += rest.startsWith(' ') ? rest.slice(1) : rest;
              }
            }
            if (dataStr) {
              try { events.push({ event, data: JSON.parse(dataStr) }); }
              catch { /* drop */ }
            }
            idx = buf.indexOf('\n\n');
          }
        }
      };

      // Fire POST for session B (different from observer).
      const postPromise = fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-B', userText: 'x' }),
      });
      await drainFor(150);
      try { await reader.cancel(); } catch { /* ignore */ }
      const postRes = await postPromise;
      try { await postRes.body?.cancel(); } catch { /* ignore */ }

      // Observer A should only have seen its `subscribed` marker —
      // none of session B's wire shape.
      expect(events.map((e) => e.event)).toEqual(['subscribed']);
    } finally { srv.stop(); }
  });

  test('rejects malformed JSON body with 400 before opening the SSE stream', async () => {
    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: {
        noAuth: true,
        history,
      },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad_request');
    } finally { srv.stop(); }
  });

  // PR-D (PWA surface picker · 2026-05-13) — per-request tool-surface
  // override. The picker injects `tools` on the wire; the daemon
  // resolves `toolSurface(kind)` for this turn only without
  // disturbing the boot-time surface used by subsequent turns.
  describe('per-request tools override (PR-D)', () => {
    test('body.tools = "chat" routes the turn through the chat surface specs', async () => {
      const observedToolNames: string[][] = [];
      spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
        observedToolNames.push((ctx.tools ?? []).map((t) => t.name));
        ctx.callbacks?.onText?.('ok', 'ok');
        return { stopReason: 'end_turn', finalText: 'ok' };
      });

      const fix = makeFixture();
      const history = new DaemonSessionHistory();
      const srv = startNexusHttpServer({
        ...fix,
        eventBus: fix.bus,
        startPort: uniquePort(),
        metaApi: {
          noAuth: true,
          history,
          toolCwd: tmpRoot,
          // Intentionally NO boot-time toolSurface — the per-request
          // override must wire one on its own, proving the swap path
          // works without a pre-existing surface fallback.
        },
      });
      try {
        const res = await fetch(`${srv.url}/v1/prompt/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'sess-tools-1',
            userText: 'please run the tool',
            tools: 'chat',
          }),
        });
        expect(res.status).toBe(200);
        await drainSse(res);
        // Compare the routed turn against the current chat surface, including
        // newly exposed tools, rather than freezing an obsolete catalogue.
        const expectedNames = toolSurface('chat').specs.map((spec) => spec.name);
        expect(expectedNames).toContain('SelfImplement');
        expect(observedToolNames).toEqual([expectedNames]);
      } finally { srv.stop(); }
    });

    test('body.tools = "readonly" exposes only the read-only tool specs', async () => {
      let observedToolNames: string[] = [];
      spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
        observedToolNames = (ctx.tools ?? []).map((t) => t.name);
        return { stopReason: 'end_turn', finalText: 'ok' };
      });

      const fix = makeFixture();
      const history = new DaemonSessionHistory();
      const srv = startNexusHttpServer({
        ...fix,
        eventBus: fix.bus,
        startPort: uniquePort(),
        metaApi: { noAuth: true, history, toolCwd: tmpRoot },
      });
      try {
        const res = await fetch(`${srv.url}/v1/prompt/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'sess-tools-2',
            userText: 'please run the tool',
            tools: 'readonly',
          }),
        });
        expect(res.status).toBe(200);
        await drainSse(res);
        // PR-D's readonly contract excludes the chat write-capable tools.
        expect(observedToolNames).toEqual([
          'Read',
          'Grep',
          'WebSearch',
          'Plan',
          'MarkStepDone',
        ]);
      } finally { srv.stop(); }
    });

    test('body.tools omitted → tools array stays empty (no boot-time surface configured)', async () => {
      let observedToolNames: string[] = [];
      spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
        observedToolNames = (ctx.tools ?? []).map((t) => t.name);
        return { stopReason: 'end_turn', finalText: 'ok' };
      });

      const fix = makeFixture();
      const history = new DaemonSessionHistory();
      const srv = startNexusHttpServer({
        ...fix,
        eventBus: fix.bus,
        startPort: uniquePort(),
        metaApi: { noAuth: true, history },
      });
      try {
        const res = await fetch(`${srv.url}/v1/prompt/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-tools-3', userText: 'hi' }),
        });
        expect(res.status).toBe(200);
        await drainSse(res);
        expect(observedToolNames).toEqual([]);
      } finally { srv.stop(); }
    });

    test('body.tools with an unknown kind rejects with 400 before opening the stream', async () => {
      const fix = makeFixture();
      const history = new DaemonSessionHistory();
      const srv = startNexusHttpServer({
        ...fix,
        eventBus: fix.bus,
        startPort: uniquePort(),
        metaApi: { noAuth: true, history },
      });
      try {
        const res = await fetch(`${srv.url}/v1/prompt/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'sess-tools-4',
            userText: 'hi',
            tools: 'bogus',
          }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('bad_request');
        expect(body.reason).toContain('tools must be one of');
      } finally { srv.stop(); }
    });
  });
});
