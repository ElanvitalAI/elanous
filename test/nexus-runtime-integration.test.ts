// NEXUS N-1.5 PR k — runtime wire-up smoke.
//
// Validates that booting NEXUS with the runtime opts wired (default
// production mode, modulo `detachForTesting=true`) flips every
// previously-503 endpoint to a real dispatch + every previously-404
// WS path to a successful upgrade. Companion to
// `nexus-meta-api-runtime-stubs.test.ts` which pins the no-runtime
// 503 contract.
//
// Each test boots a fresh NEXUS, hits the endpoint, asserts the
// response, then releases. supervisor + daemon tab autostart are
// disabled to keep the harness single-purpose (no child processes,
// no real ACP runtime spawn).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;
let prevVault: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-runtime-int-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  // Override HOME so the acp-token loader + intake archive default
  // never touch the developer's real ~/.elanous. Intake archive uses
  // os.homedir() at module-load; we additionally swap the singleton
  // so the test sees an isolated in-memory store.
  process.env.HOME = tmpRoot;
  // ⛔ 볼트도 임시로 «명시»한다 — Bun 의 os.homedir() 는 실행 중 HOME 변경을 따르지 않아(2026-09-26 실측),
  //   HOME 만 바꾸면 discoverObsidianVault 가 실제 볼트를 찾았다 → 이 시험이 실제 볼트에 Route-guard 노트 87개를 썼다.
  prevVault = process.env.ELANOUS_OBSIDIAN_VAULT;
  process.env.ELANOUS_OBSIDIAN_VAULT = join(tmpRoot, 'vault');
  mkdirSync(join(tmpRoot, 'vault'), { recursive: true });
  setIntakeStoreForTest(createIntakeStore({ archiveDir: null, replayOnInit: false }));
});

afterEach(async () => {
  if (activeHandle) {
    try { activeHandle.release(); } catch { /* swallow */ }
    activeHandle = undefined;
  }
  if (prevNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexusDir;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevVault === undefined) delete process.env.ELANOUS_OBSIDIAN_VAULT;
  else process.env.ELANOUS_OBSIDIAN_VAULT = prevVault;
  setIntakeStoreForTest(null);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

function uniquePort(): number {
  return 49000 + Math.floor(Math.random() * 2000);
}

async function bootNexus(extra: Parameters<typeof runNexus>[0] = {}): Promise<RunNexusHandle> {
  const handle = await runNexus({
    detachForTesting: true,
    skipHttpServer: false,
    skipRuntimeApi: false,
    skipSupervisor: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    httpStartPort: uniquePort(),
    voiceAdapter: createStubPwaVoiceAdapter(),
    toolCwd: tmpRoot,
    ...extra,
  });
  if (!handle) throw new Error('runNexus returned undefined');
  activeHandle = handle;
  return handle;
}

describe('NEXUS runtime wire-up integration (PR k)', () => {
  test('GET /v1/health returns ok (baseline sanity)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/health`);
    expect(res.status).toBe(200);
  });

  test('GET /v1/sessions returns sessions list (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test('POST /v1/sessions/external registers session (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/sessions/external`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-pr-k-1', origin: 'pwa' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('test-pr-k-1');
    expect(h.history!.has('test-pr-k-1')).toBe(true);
  });

  test('GET /v1/intake returns empty list (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/intake`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test('POST /v1/intake creates intake session (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'remember to ship pr-k', mode: 'review' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { intakeId: string; state: string };
    expect(typeof body.intakeId).toBe('string');
    expect(body.intakeId.length).toBeGreaterThan(0);
  });

  test('GET /v1/control-signals returns observer snapshot (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/control-signals?limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; items: unknown[] };
    expect(typeof body.total).toBe('number');
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('GET /v1/simulations returns scenarios catalog (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/simulations`);
    expect(res.status).toBe(200);
    const body = await res.json() as { scenarios: unknown[] };
    expect(Array.isArray(body.scenarios)).toBe(true);
  });

  test('GET /v1/tools returns active tool surface (was 503)', async () => {
    const h = await bootNexus({ tools: 'readonly' });
    const res = await fetch(`${h.httpServer!.url}/v1/tools`);
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; specs: { name: string }[] };
    expect(body.kind).toBe('readonly');
    const names = body.specs.map((s) => s.name);
    expect(names).toContain('Read');
    expect(names).toContain('Grep');
    expect(names).toContain('WebSearch');
  });

  test('GET /v1/voice/cost returns monthly summary (PR d · runtime gates removed)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/voice/cost`);
    expect(res.status).toBe(200);
    const body = await res.json() as { totalUsd: number };
    expect(typeof body.totalUsd).toBe('number');
  });

  test('GET /v1/push/vapid-public-key returns key (PR d · runtime gates removed)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/push/vapid-public-key`);
    expect(res.status).toBe(200);
    const body = await res.json() as { publicKey: string };
    expect(typeof body.publicKey).toBe('string');
    expect(body.publicKey.length).toBeGreaterThan(0);
  });

  // R3 v1 regression guard (2026-05-09 dogfood) — the original
  // PR #2121 placed this route in the wrong block of http-server.ts,
  // so POST hit the catch-all 405 instead of the handler. The
  // notification-action.test.ts unit test called the handler
  // directly and missed the routing bug. This e2e test fetches
  // through the live http-server so a routing regression fails loud.
  test('POST /v1/notification-action records intent feedback (route guard)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/notification-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-r3', action: 'intent-0' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; label: string; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.label.length).toBeGreaterThan(0);
    expect(body.sessionId).toBe('sess-r3');
  });

  // 2026-05-09 dogfood follow-up — POST
  // /v1/intent-prediction/:sessionId/feedback had the same routing
  // bug as the R3 regression above (sat in the GET-only region of
  // http-server). PR #2047 's unit test called the handler directly
  // and the runNexus integration test runs with skipHttpServer=true,
  // so the POST route was never end-to-end tested. Pin it here so
  // the next reorg can't silently re-break it.
  test('POST /v1/intent-prediction/:sessionId/feedback round-trip (route guard)', async () => {
    const h = await bootNexus();
    const sessId = 'sess-feedback-guard';
    const res = await fetch(
      `${h.httpServer!.url}/v1/intent-prediction/${sessId}/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chosen: '오토파일럿',
          context: {
            sessionId: sessId,
            lastTurnSummary: '',
            lastErr: null,
            progressPct: 0.4,
            fileEditCount: 2,
            idleMs: 30_000,
            recentTaps: [],
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; feedbackCount: number };
    expect(body.ok).toBe(true);
    expect(body.feedbackCount).toBeGreaterThan(0);
  });

  // R-OCR.1.5 (2026-05-09) — POST /v1/notes/from-image route guard.
  // Same lesson as the R3 + intent-feedback guards above: a POST route
  // placed outside the `method !== 'GET'` block silently 405s. The
  // unit test in `notes-from-image.test.ts` calls the handler directly
  // and bypasses http-server routing entirely, so the wire only
  // shows up in this integration. Asserting "not 405" pins the
  // route into the right block; the actual 503 vs 200 outcome
  // depends on whether UPSTAGE_API_KEY is set in the test env (we
  // accept both — the contract under test is *routing*, not OCR).
  test('POST /v1/notes/from-image is wired (route guard · not 405)', async () => {
    const h = await bootNexus();
    const form = new FormData();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    form.append('image', new Blob([png], { type: 'image/png' }), 'guard.png');
    const res = await fetch(`${h.httpServer!.url}/v1/notes/from-image`, {
      method: 'POST',
      body: form,
    });
    // 405 = route fell through to the catch-all → REGRESSION.
    // 200 = OCR happy path (UPSTAGE_API_KEY set + reachable). OK.
    // 503 = no provider available (UPSTAGE_API_KEY missing). OK.
    // 502 = OCR upstream / provider failed. OK (still wired).
    expect(res.status).not.toBe(405);
  });

  // R-OCR.3 (2026-05-09) — POST /v1/notes/save route guard.
  // Same lesson as the route guards above: handler is unit-tested
  // direct, so only e2e fetches surface a wiring regression. The
  // happy path lands the file in the discovered (test HOME-rooted)
  // vault — verified in `notes-save.test.ts` against an injected
  // vault. Here we just ensure the route is reachable + writes
  // succeed end-to-end through the live http-server.
  test('POST /v1/notes/save is wired (route guard · happy path 201)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/notes/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Route guard\n\nintegration body',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      ok: boolean;
      knowledgeId: string;
      vaultLabel: string;
    };
    expect(body.ok).toBe(true);
    expect(body.knowledgeId).toMatch(/^notes\/\d{4}-\d{2}-\d{2}\//);
  });

  // R5.0 (2026-05-09) — `/v1/sessions/active` route guard. Same
  // shape as the other PWA-facing endpoints — we just verify the
  // wire is alive end-to-end (200 + sessions array). Status pill
  // derivation is exercised in `sessions-active.test.ts`.
  test('GET /v1/sessions/active returns 200 with sessions array (route guard)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/sessions/active`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      sessions: unknown[];
      total: number;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  // R5.4 — `/v1/sessions/:id/decision` route guard.
  test('POST /v1/sessions/:id/decision returns 200 + echo (route guard)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/sessions/sess-r5/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      sessionId: string;
      decision: string;
    };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('sess-r5');
    expect(body.decision).toBe('approve');
  });

  test('OPTIONS /v1/sessions/:id/decision returns 204 (preflight)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/sessions/sess-r5/decision`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  // R6.2 — `/v1/reflection/today` route guard.
  test('GET /v1/reflection/today returns 200 + snapshot (route guard)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/reflection/today`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      snapshot: { date: string; notesSaved: number; sessionsToday: number };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.snapshot.date).toBe('string');
    expect(typeof body.snapshot.notesSaved).toBe('number');
    expect(typeof body.snapshot.sessionsToday).toBe('number');
  });

  test('GET /v1/reflection/2026-05-08 (specific date) returns 200', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/reflection/2026-05-08`);
    expect(res.status).toBe(200);
  });

  test('GET /v1/reflection/garbage → 404 (route does not match)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/reflection/yesterday`);
    expect(res.status).toBe(404);
  });

  test('OPTIONS /v1/notes/save returns 204 with CORS headers (preflight)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/notes/save`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  // R-OCR.4 (2026-05-09) — metric snapshot + event endpoint guards.
  // The handlers are unit-tested direct so only the live http-server
  // wire surfaces a routing regression. After a save round-trip we
  // verify the snapshot reflects the count — pins the runNexus
  // wiring of `notesSave.metrics` + `notesMetrics` to the same
  // collector instance.
  test('GET /v1/metrics/notes-from-image reflects save activity (route + collector wire)', async () => {
    const h = await bootNexus();
    // Trigger a save to advance the counter.
    const saveRes = await fetch(`${h.httpServer!.url}/v1/notes/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# metric round-trip\n\nbody' }),
    });
    expect(saveRes.status).toBe(201);
    const snapRes = await fetch(`${h.httpServer!.url}/v1/metrics/notes-from-image`);
    expect(snapRes.status).toBe(200);
    const body = await snapRes.json() as {
      ok: boolean;
      wired: boolean;
      snapshot: { save: { total: number } };
    };
    expect(body.wired).toBe(true);
    expect(body.snapshot.save.total).toBeGreaterThanOrEqual(1);
  });

  test('POST /v1/metrics/notes-event records a client cancel event', async () => {
    const h = await bootNexus();
    const ev = await fetch(`${h.httpServer!.url}/v1/metrics/notes-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', polishMode: 'minimal' }),
    });
    expect(ev.status).toBe(200);
    const snap = await fetch(`${h.httpServer!.url}/v1/metrics/notes-from-image`);
    const body = await snap.json() as {
      snapshot: { client: { cancel: number } };
    };
    expect(body.snapshot.client.cancel).toBeGreaterThanOrEqual(1);
  });

  test('OPTIONS /v1/metrics/notes-event returns 204 with CORS headers', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/metrics/notes-event`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('OPTIONS /v1/notes/from-image returns 204 with CORS headers (preflight)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/notes/from-image`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('POST /v1/hitl/callback/:id returns 404 for unknown id (was 503)', async () => {
    const h = await bootNexus();
    const res = await fetch(`${h.httpServer!.url}/v1/hitl/callback/req-no-such-thing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: true }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('no_pending_request');
  });

  test('POST /v1/hitl/callback/:id resolves a pending awaiter end-to-end', async () => {
    const h = await bootNexus();
    const requestId = 'req-pr-k-end-to-end';
    const awaitPromise = h.hitlPending!.awaitCallback(requestId, 5_000);
    // Give the scheduler one tick so the listener is registered before
    // the POST hits NEXUS — defensive against a race on slower CI.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await fetch(`${h.httpServer!.url}/v1/hitl/callback/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: false }),
    });
    expect(res.status).toBe(200);
    const answer = await awaitPromise;
    expect(answer).toBe(false);
  });

  test('WS /v1/voice/ws upgrade succeeds with stub adapter (was 404)', async () => {
    const h = await bootNexus();
    const wsUrl = h.httpServer!.url.replace(/^http/, 'ws') + '/v1/voice/ws';
    const ws = new WebSocket(wsUrl);
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
      // Small timeout so a stuck CI doesn't hang the suite.
    });
    try {
      // ⚠️ Close in `finally`. If the assertion fails, an early return leaves
      // the socket open, and one live handle keeps `bun test` from exiting —
      // a failure that then reads as "the suite hangs" instead of "this
      // assertion failed".
      expect(connected).toBe(true);
    } finally {
      ws.close();
    }
  });

  test('WS /v1/acp upgrade succeeds (was 404)', async () => {
    const h = await bootNexus();
    const wsUrl = h.httpServer!.url.replace(/^http/, 'ws') + '/v1/acp';
    const ws = new WebSocket(wsUrl);
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
    });
    try {
      // ⚠️ Close in `finally`. If the assertion fails, an early return leaves
      // the socket open, and one live handle keeps `bun test` from exiting —
      // a failure that then reads as "the suite hangs" instead of "this
      // assertion failed".
      expect(connected).toBe(true);
    } finally {
      ws.close();
    }
  });

  test('runtime opt-out (skipRuntimeApi=true) refuses an unauthenticated request before the stub', async () => {
    // 보안 강화(09-26) 뒤 인증 검사가 스텁보다 앞선다 — 런타임을 안 이은 경로도 무인증이면 401 이다(503 스텁은 인증 뒤의 일).
    const h = await bootNexus({ skipRuntimeApi: true });
    const res = await fetch(`${h.httpServer!.url}/v1/sessions`);
    expect(res.status).toBe(401);
  });
});
