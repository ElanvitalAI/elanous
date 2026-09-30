// NEXUS · /v1/intent-prediction/* REST + SSE handlers (Phase 0.5).
//
// Covers `src/nexus/api/intent-prediction.ts` + the runNexus
// integration that wires `runtimeIntentPrediction` through the
// http-server opts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import {
  createIntentPredictionService,
  type IntentContext,
  type IntentRanking,
} from '../src/intent-prediction/index.js';
import {
  dispatchIntentPredictionRoute,
  handleIntentPredictionFeedback,
  handleIntentPredictionSnapshot,
} from '../src/nexus/api/intent-prediction.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

const baseCtx: Omit<IntentContext, 'recentTaps'> = {
  sessionId: 'sess-1',
  lastTurnSummary: '',
  lastErr: null,
  progressPct: 0,
  fileEditCount: 0,
  idleMs: 0,
};

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-intent-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.HOME = tmpRoot;
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
  setIntakeStoreForTest(null);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

function uniquePort(): number {
  return 60000 + Math.floor(Math.random() * 2000);
}

async function bootNexus(extra: Parameters<typeof runNexus>[0] = {}): Promise<RunNexusHandle> {
  const handle = await runNexus({
    detachForTesting: true,
    skipHttpServer: true,
    skipRuntimeApi: false,
    skipSupervisor: true,
    skipPushcutChannel: true,
    skipPwaChannel: true,
    skipTelegramChannel: true,
    skipDiscordChannel: true,
    skipTerminalChannel: true,
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

// ─── REST snapshot ────────────────────────────────────────────────

describe('handleIntentPredictionSnapshot', () => {
  test('subscribes lazily + returns IntentRanking JSON', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = handleIntentPredictionSnapshot(
      new Request('http://x/v1/intent-prediction/sess-1'),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as IntentRanking;
    expect(body.sessionId).toBe('sess-1');
    expect(body.candidates).toHaveLength(6);
    svc.dispose();
  });

  test('400 when sessionId is empty', () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = handleIntentPredictionSnapshot(
      new Request('http://x/v1/intent-prediction/'),
      '',
      { service: svc },
    );
    expect(res.status).toBe(400);
    svc.dispose();
  });

  test('404 when contextProvider returns null', () => {
    const svc = createIntentPredictionService({ contextProvider: () => null });
    const res = handleIntentPredictionSnapshot(
      new Request('http://x/v1/intent-prediction/unknown'),
      'unknown',
      { service: svc },
    );
    expect(res.status).toBe(404);
    svc.dispose();
  });

  test('checkAuth=false → 401', () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = handleIntentPredictionSnapshot(
      new Request('http://x/v1/intent-prediction/sess-1'),
      'sess-1',
      { service: svc, checkAuth: () => false },
    );
    expect(res.status).toBe(401);
    svc.dispose();
  });
});

// ─── Feedback POST ────────────────────────────────────────────────

describe('handleIntentPredictionFeedback', () => {
  test('happy path → 200 + feedbackCount returned', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await handleIntentPredictionFeedback(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          chosen: '승인',
          context: { ...baseCtx, sessionId: 'sess-1' },
        }),
      }),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; feedbackCount: number };
    expect(body.ok).toBe(true);
    expect(body.feedbackCount).toBe(1);
    svc.dispose();
  });

  test('400 when chosen is not a canonical IntentButtonLabel', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await handleIntentPredictionFeedback(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          chosen: 'NOT_A_REAL_LABEL',
          context: { ...baseCtx, sessionId: 'sess-1' },
        }),
      }),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(400);
    svc.dispose();
  });

  test('400 when context.sessionId mismatches URL :sessionId', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await handleIntentPredictionFeedback(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          chosen: '승인',
          context: { ...baseCtx, sessionId: 'OTHER' },
        }),
      }),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(400);
    svc.dispose();
  });

  test('400 when JSON body is malformed', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await handleIntentPredictionFeedback(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: '{not-json',
      }),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(400);
    svc.dispose();
  });

  test('400 when context required fields missing', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await handleIntentPredictionFeedback(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: JSON.stringify({ chosen: '승인', context: { sessionId: 'sess-1' } }),
      }),
      'sess-1',
      { service: svc },
    );
    expect(res.status).toBe(400);
    svc.dispose();
  });
});

// ─── Route dispatcher ─────────────────────────────────────────────

describe('dispatchIntentPredictionRoute', () => {
  test('matches /v1/intent-prediction/:id → snapshot', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await dispatchIntentPredictionRoute(
      new Request('http://x/v1/intent-prediction/sess-1'),
      new URL('http://x/v1/intent-prediction/sess-1'),
      { service: svc },
    );
    expect(res?.status).toBe(200);
    svc.dispose();
  });

  test('matches /v1/intent-prediction/:id/feedback → POST', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await dispatchIntentPredictionRoute(
      new Request('http://x/v1/intent-prediction/sess-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          chosen: '승인',
          context: { ...baseCtx, sessionId: 'sess-1' },
        }),
      }),
      new URL('http://x/v1/intent-prediction/sess-1/feedback'),
      { service: svc },
    );
    expect(res?.status).toBe(200);
    svc.dispose();
  });

  test('non-matching path → null', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await dispatchIntentPredictionRoute(
      new Request('http://x/v1/something-else'),
      new URL('http://x/v1/something-else'),
      { service: svc },
    );
    expect(res).toBeNull();
    svc.dispose();
  });

  test('wrong method on snapshot path → 405', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await dispatchIntentPredictionRoute(
      new Request('http://x/v1/intent-prediction/sess-1', { method: 'POST' }),
      new URL('http://x/v1/intent-prediction/sess-1'),
      { service: svc },
    );
    expect(res?.status).toBe(405);
    svc.dispose();
  });

  test('GET on /feedback → 405', async () => {
    const svc = createIntentPredictionService({
      contextProvider: (id) => ({ ...baseCtx, sessionId: id }),
    });
    const res = await dispatchIntentPredictionRoute(
      new Request('http://x/v1/intent-prediction/sess-1/feedback'),
      new URL('http://x/v1/intent-prediction/sess-1/feedback'),
      { service: svc },
    );
    expect(res?.status).toBe(405);
    svc.dispose();
  });
});

// ─── runNexus integration ─────────────────────────────────────────

describe('runNexus intent-prediction wire', () => {
  test('default boot exposes intentPrediction handle', async () => {
    const h = await bootNexus();
    expect(h.intentPrediction).toBeDefined();
    expect(typeof h.intentPrediction!.subscribe).toBe('function');
    expect(typeof h.intentPrediction!.recordFeedback).toBe('function');
  });

  test('skipIntentPrediction:true → handle undefined', async () => {
    const h = await bootNexus({ skipIntentPrediction: true });
    expect(h.intentPrediction).toBeUndefined();
  });

  test('skipRuntimeApi:true short-circuits the intent-prediction wire too', async () => {
    const h = await bootNexus({ skipRuntimeApi: true });
    expect(h.intentPrediction).toBeUndefined();
  });

  test('release() disposes the service (idempotent)', async () => {
    const h = await bootNexus();
    expect(h.intentPrediction).toBeDefined();
    h.release();
    activeHandle = undefined;
    expect(() => h.release()).not.toThrow();
  });

  test('intentContextProvider override is used by the service', async () => {
    let callsToProvider = 0;
    const h = await bootNexus({
      intentContextProvider: (id) => {
        callsToProvider += 1;
        return { ...baseCtx, sessionId: id, lastErr: 'forced' };
      },
    });
    h.intentPrediction!.subscribe('sess-x');
    expect(callsToProvider).toBeGreaterThan(0);
    const r = h.intentPrediction!.latest('sess-x');
    // The forced error context should bias '잠시 멈춤' to the top.
    const top = [...r!.candidates].sort((a, b) => b.confidence - a.confidence)[0]!;
    expect(top.label).toBe('잠시 멈춤');
  });
});
