// R3 — server-side `/v1/notification-action` endpoint contract.
//
// SW (apps/pwa/public/sw.js) POSTs here when the user taps an
// inline action button on a turn-end push notification. We record
// as an intent-prediction feedback tap so the recency boost
// surfaces in the next ranking the user sees.
//
// Cross-ref:
//   src/nexus/api/notification-action.ts (handler)
//   src/web-push/notify-turn-end.ts (TURN_END_ACTIONS)
//   apps/pwa/public/sw.js notificationclick

import { describe, expect, test } from 'bun:test';

import {
  handleNotificationAction,
  resolveNotificationActionLabel,
} from '../src/nexus/api/notification-action.js';
import {
  createIntentPredictionService,
  createFeedbackStore,
  INTENT_BUTTON_LABELS,
} from '../src/intent-prediction/index.js';
import { expectMalformedJson400 } from './helpers/http-error-contract';

function makeService() {
  return createIntentPredictionService({
    contextProvider: () => ({
      sessionId: 's',
      lastTurnSummary: '',
      lastErr: null,
      progressPct: 0,
      fileEditCount: 0,
      idleMs: 0,
    }),
    feedbackStore: createFeedbackStore({}),
    // Use a long interval — tests don't await ticks; they just
    // verify recordFeedback was called by inspecting diagnostics.
    intervalMs: 60_000,
  });
}

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/v1/notification-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('resolveNotificationActionLabel', () => {
  test('intent-0 → first canonical label', () => {
    expect(resolveNotificationActionLabel('intent-0')).toBe(INTENT_BUTTON_LABELS[0]!);
  });

  test('intent-5 → last canonical label (when 6 labels exist)', () => {
    expect(resolveNotificationActionLabel(`intent-${INTENT_BUTTON_LABELS.length - 1}`))
      .toBe(INTENT_BUTTON_LABELS[INTENT_BUTTON_LABELS.length - 1]!);
  });

  test('out-of-bounds index → null', () => {
    expect(resolveNotificationActionLabel('intent-99')).toBeNull();
  });

  test('non-numeric suffix → null', () => {
    expect(resolveNotificationActionLabel('intent-abc')).toBeNull();
  });

  test('wrong prefix → null', () => {
    expect(resolveNotificationActionLabel('foo-0')).toBeNull();
    expect(resolveNotificationActionLabel('action-0')).toBeNull();
  });

  test('empty string → null', () => {
    expect(resolveNotificationActionLabel('')).toBeNull();
  });
});

describe('handleNotificationAction', () => {
  test('happy path · recordFeedback called · feedbackCount surfaces', async () => {
    const service = makeService();
    try {
      const before = service.diagnostics().feedbackCount;
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'sess-1', action: 'intent-0' }),
        { service },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        label: string;
        sessionId: string;
        feedbackCount: number;
      };
      expect(body.ok).toBe(true);
      expect(body.label).toBe(INTENT_BUTTON_LABELS[0]!);
      expect(body.sessionId).toBe('sess-1');
      expect(body.feedbackCount).toBe(before + 1);
    } finally {
      service.dispose();
    }
  });

  test('no sessionId → folds to wildcard sentinel + still records', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: null, action: 'intent-2' }),
        { service },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { sessionId: string };
      expect(body.sessionId).toBe('__notification_action__');
    } finally {
      service.dispose();
    }
  });

  test('empty string sessionId → also wildcard', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: '', action: 'intent-1' }),
        { service },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { sessionId: string };
      expect(body.sessionId).toBe('__notification_action__');
    } finally {
      service.dispose();
    }
  });

  test('missing action → 400', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'x' }),
        { service },
      );
      expect(res.status).toBe(400);
    } finally {
      service.dispose();
    }
  });

  test('unknown action prefix → 400', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'x', action: 'foo-0' }),
        { service },
      );
      expect(res.status).toBe(400);
    } finally {
      service.dispose();
    }
  });

  test('out-of-bounds intent index → 400', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'x', action: 'intent-99' }),
        { service },
      );
      expect(res.status).toBe(400);
    } finally {
      service.dispose();
    }
  });

  test('invalid JSON body → 400', async () => {
    const service = makeService();
    try {
      const req = new Request('http://localhost/v1/notification-action', {
        method: 'POST',
        body: 'not json{',
      });
      const res = await handleNotificationAction(req, { service });
      await expectMalformedJson400(res);
    } finally {
      service.dispose();
    }
  });

  test('non-POST → 405', async () => {
    const service = makeService();
    try {
      const req = new Request('http://localhost/v1/notification-action', {
        method: 'GET',
      });
      const res = await handleNotificationAction(req, { service });
      expect(res.status).toBe(405);
    } finally {
      service.dispose();
    }
  });

  test('checkAuth=false → 401', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'x', action: 'intent-0' }),
        { service, checkAuth: () => false },
      );
      expect(res.status).toBe(401);
    } finally {
      service.dispose();
    }
  });
});

// R3 v2 (2026-05-09) — fire-and-forget loopback wiring.
describe('handleNotificationAction · R3 v2 loopback', () => {
  test('loopback wired + concrete sessionId → run() called once with the resolved label', async () => {
    const service = makeService();
    const calls: Array<{ sessionId: string; promptText: string }> = [];
    const loopback = {
      run: async (input: { sessionId: string; promptText: string }) => {
        calls.push(input);
      },
    };
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'sess-abc', action: 'intent-0' }),
        { service, loopback },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; loopbackQueued: boolean };
      expect(body.ok).toBe(true);
      expect(body.loopbackQueued).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.sessionId).toBe('sess-abc');
      expect(calls[0]!.promptText).toBe(INTENT_BUTTON_LABELS[0]!);
    } finally {
      service.dispose();
    }
  });

  test('loopback wired + missing sessionId → loopbackQueued=false (no run)', async () => {
    const service = makeService();
    const calls: Array<{ sessionId: string; promptText: string }> = [];
    const loopback = {
      run: async (input: { sessionId: string; promptText: string }) => {
        calls.push(input);
      },
    };
    try {
      const res = await handleNotificationAction(
        makePostRequest({ action: 'intent-1' }),
        { service, loopback },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; loopbackQueued: boolean };
      expect(body.loopbackQueued).toBe(false);
      expect(calls.length).toBe(0);
    } finally {
      service.dispose();
    }
  });

  test('loopback omitted → loopbackQueued=false · feedback still recorded', async () => {
    const service = makeService();
    try {
      const res = await handleNotificationAction(
        makePostRequest({ sessionId: 'sess-xyz', action: 'intent-2' }),
        { service },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; loopbackQueued: boolean; feedbackCount: number };
      expect(body.loopbackQueued).toBe(false);
      expect(body.feedbackCount).toBe(1);
    } finally {
      service.dispose();
    }
  });
});
