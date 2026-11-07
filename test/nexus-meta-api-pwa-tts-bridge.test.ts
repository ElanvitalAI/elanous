// Phase 5b (PWA voice 일원화 server-side TTS · 2026-05-07) — chat REST
// `/v1/prompt/stream` ↔ `voice-pwa-tts-bridge` wire contract.
//
// PR 1876 cascade Phase 5 가 client-side Web Speech API (F2-lite) 로
// 진입한 이유는 server bridge 가 voice-dispatch path 전용이라 chat
// REST 가 PCM emit 못 했기 때문. 본 wire 가 그 gap 을 메꿈.
//
// 두 단언:
// 1. `metaApiOpts.pwaTtsBridge` 가 wired 면 onTextDelta 마다
//    `bridge.pushChunk(sessionId, delta)` 호출.
// 2. turn-end 시 `bridge.flush(sessionId)` 1번 await.
// 3. bridge undefined (옵트인 안 됨) 시 호출 0 — 회귀 영향 없음.

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import * as coreTurnModule from '../src/core-turn/run-core-turn.js';
import type { PwaTtsBridge } from '../src/voice/voice-pwa-tts-bridge.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-tts-bridge-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface BridgeCall {
  kind: 'pushChunk' | 'flush' | 'attach' | 'detach';
  sessionId: string;
  chunk?: string;
}

function makeMockBridge(): { bridge: PwaTtsBridge; calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
  const bridge: PwaTtsBridge = {
    pushChunk(sessionId, chunk) {
      calls.push({ kind: 'pushChunk', sessionId, chunk });
    },
    async flush(sessionId) {
      calls.push({ kind: 'flush', sessionId });
    },
    attach(sessionId) {
      calls.push({ kind: 'attach', sessionId });
    },
    detach(sessionId) {
      calls.push({ kind: 'detach', sessionId });
    },
    __peekBuffer() { return ''; },
  };
  return { bridge, calls };
}

function makeFixture(): {
  state: ReturnType<typeof createNexusState>;
  registry: TabRegistry;
  bus: NexusEventBus;
} {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: '5b' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:1' }));
  return { state, registry, bus };
}

let portCursor = 49500;
function uniquePort(): number {
  portCursor += 1;
  return portCursor;
}

async function drainStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
  }
  return buffer;
}

describe('Phase 5b · /v1/prompt/stream → pwaTtsBridge wire', () => {
  test('pushChunk(sessionId, delta) on each text-delta + flush(sessionId) on turn-end', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onText?.('Hel', 'Hel');
      ctx.callbacks?.onText?.('lo', 'Hello');
      ctx.callbacks?.onText?.(', wor', 'Hello, wor');
      ctx.callbacks?.onText?.('ld!', 'Hello, world!');
      return { stopReason: 'end_turn', finalText: 'Hello, world!' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const { bridge, calls } = makeMockBridge();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history, pwaTtsBridge: bridge },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-tts-1', userText: 'hi' }),
      });
      expect(res.status).toBe(200);
      await drainStream(res);

      // Each onText callback should map 1:1 to a pushChunk call with
      // the delta (not the cumulative `full`). Order preserved.
      const pushes = calls.filter((c) => c.kind === 'pushChunk');
      expect(pushes).toHaveLength(4);
      expect(pushes.map((c) => c.chunk)).toEqual(['Hel', 'lo', ', wor', 'ld!']);
      for (const p of pushes) expect(p.sessionId).toBe('sess-tts-1');

      // Exactly one flush at turn-end with the same sessionId.
      const flushes = calls.filter((c) => c.kind === 'flush');
      expect(flushes).toHaveLength(1);
      expect(flushes[0]!.sessionId).toBe('sess-tts-1');

      // Order: all pushes precede the flush (sentence-streaming
      // contract — server-side bridge sees the whole turn in arrival
      // order before the final drain).
      const lastPushIdx = calls.lastIndexOf(pushes[pushes.length - 1]!);
      const flushIdx = calls.indexOf(flushes[0]!);
      expect(lastPushIdx).toBeLessThan(flushIdx);
    } finally { srv.stop(); }
  });

  test('bridge undefined (default · opt-out) — pushChunk/flush call 0 (회귀 영향 없음)', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onText?.('hi', 'hi');
      return { stopReason: 'end_turn', finalText: 'hi' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      // No pwaTtsBridge — Phase 5 Web Speech client fallback path.
      metaApi: { noAuth: true, history },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-no-bridge', userText: 'x' }),
      });
      expect(res.status).toBe(200);
      const body = await drainStream(res);
      // SSE stream still works — text-delta + turn-end events present.
      expect(body).toContain('event: text-delta');
      expect(body).toContain('event: turn-end');
    } finally { srv.stop(); }
    // No assertion on bridge — just verifying no crash + SSE intact.
  });

  test('bridge throws on pushChunk/flush — handler still completes the turn (errors are swallowed)', async () => {
    spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
      ctx.callbacks?.onText?.('throwing', 'throwing');
      return { stopReason: 'end_turn', finalText: 'throwing' };
    });

    const fix = makeFixture();
    const history = new DaemonSessionHistory();
    const erroringBridge: PwaTtsBridge = {
      pushChunk() { throw new Error('synthetic push fail'); },
      async flush() { throw new Error('synthetic flush fail'); },
      attach() { /* unused */ },
      detach() { /* unused */ },
      __peekBuffer() { return ''; },
    };
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history, pwaTtsBridge: erroringBridge },
    });
    try {
      const res = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-throw', userText: 'go' }),
      });
      expect(res.status).toBe(200);
      const body = await drainStream(res);
      // Turn completes — bridge faults are telemetric only, never break
      // the chat REST stream contract for the user.
      expect(body).toContain('event: turn-end');
      expect(body).not.toContain('event: error');
    } finally { srv.stop(); }
  });
});
