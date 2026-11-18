// ── POST /v1/llm/route/predict guard (P1-4 · 2026-05-14) ──
//
// Drives the mission router HTTP wire end-to-end:
//   • 503 when router not wired (DI seam absent)
//   • 400 on malformed bodies
//   • 200 + MissionPrediction on a valid request
//   • Source-level grep guard ensures the handler stays inside the
//     mutation block of http-server.ts (memory
//     `feedback_post_route_must_be_in_method_block`).
//
// Uses a fake MissionRouter — production wiring via
// `globalMissionRouter()` is covered by the unit suite in
// `test/llm-mission-router.test.ts`.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleLlmRoutePredict, parseRoutePredictBody } from '../src/nexus/api/llm-route-predict';
import type { MissionRouter, MissionPrediction } from '../src/llm/mission-router';

function fakeRouter(prediction: MissionPrediction): MissionRouter {
  return {
    async predict() {
      return prediction;
    },
  };
}

function makeRequest(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/v1/llm/route/predict', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('parseRoutePredictBody', () => {
  test('happy path with sessionId + attachments', () => {
    const out = parseRoutePredictBody({
      sessionId: 'sess-1',
      text: 'plan the next sprint',
      attachments: [{ kind: 'image' }, { kind: 'document' }],
    });
    if (!out.ok) throw new Error(`unexpected: ${out.error}`);
    expect(out.req.text).toBe('plan the next sprint');
    expect(out.req.sessionId).toBe('sess-1');
    expect(out.req.attachments).toHaveLength(2);
  });

  test('drops malformed attachment entries quietly', () => {
    const out = parseRoutePredictBody({
      text: 'review this',
      attachments: [{ kind: 'image' }, { kind: 'nonsense' }, 'string-entry', null],
    });
    if (!out.ok) throw new Error('unexpected');
    expect(out.req.attachments).toEqual([{ kind: 'image' }]);
  });

  test('reject when text missing', () => {
    const out = parseRoutePredictBody({ sessionId: 'x' });
    expect(out.ok).toBe(false);
  });

  test('reject when body is not an object', () => {
    expect(parseRoutePredictBody(null).ok).toBe(false);
    expect(parseRoutePredictBody('string').ok).toBe(false);
    expect(parseRoutePredictBody(42).ok).toBe(false);
  });
});

describe('handleLlmRoutePredict', () => {
  const fixture: MissionPrediction = {
    mission: 'plan',
    provider: 'claude',
    model: 'claude-opus-4-7',
    confidence: 0.78,
    tier: 1,
  };

  test('503 when router not wired', async () => {
    const r = makeRequest({ text: 'plan' });
    const res = await handleLlmRoutePredict(r, {});
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('router-not-configured');
  });

  test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const r = makeRequest(undefined, 'OPTIONS');
    const res = await handleLlmRoutePredict(r, { missionRouter: fakeRouter(fixture) });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('non-POST method returns 405 (handler-level · FU1 path-only gate)', async () => {
    // P1-FU1 (2026-05-14): http-server gate now matches path-only so
    // GET/PUT/DELETE reach the handler instead of catch-all 404 —
    // assert the handler's 405 fallback covers them.
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = new Request('http://localhost/v1/llm/route/predict', { method });
      const res = await handleLlmRoutePredict(r, { missionRouter: fakeRouter(fixture) });
      expect(res.status).toBe(405);
    }
  });

  test('400 on invalid JSON body', async () => {
    const r = new Request('http://localhost/v1/llm/route/predict', {
      method: 'POST',
      body: '{not json',
    });
    const res = await handleLlmRoutePredict(r, { missionRouter: fakeRouter(fixture) });
    expect(res.status).toBe(400);
  });

  test('400 when text missing', async () => {
    const r = makeRequest({ sessionId: 'x' });
    const res = await handleLlmRoutePredict(r, { missionRouter: fakeRouter(fixture) });
    expect(res.status).toBe(400);
  });

  test('200 with prediction body on valid POST', async () => {
    const r = makeRequest({ text: 'plan the auth migration', sessionId: 's' });
    const res = await handleLlmRoutePredict(r, { missionRouter: fakeRouter(fixture) });
    expect(res.status).toBe(200);
    const body = await res.json() as MissionPrediction;
    expect(body.mission).toBe('plan');
    expect(body.provider).toBe('claude');
    expect(body.tier).toBe(1);
  });
});

describe('http-server.ts wiring · source-level grep guard', () => {
  // Memory `feedback_post_route_must_be_in_method_block` + `feedback_source_level_grep_test_value`:
  // the POST route must live INSIDE the mutation block (method !== 'GET'),
  // otherwise the catch-all 405 silently swallows it and unit tests
  // (handler called directly) won't catch the regression.
  test('route is registered inside the mutation block in http-server.ts', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'nexus', 'api', 'http-server.ts'),
      'utf-8',
    );
    expect(src).toContain("handleLlmRoutePredict");
    // Memory `feedback_post_route_must_be_in_method_block` — confirm
    // the route handler call site appears AFTER the
    // `if (method !== 'GET') {` mutation block opens. We anchor on
    // `handleLlmRoutePredict(req,` (the wire call · unique) rather
    // than the path literal which also appears in the JSDoc above
    // the opts interface.
    // Quote-agnostic (#38766 reformatted http-server.ts to double quotes);
    // the brace anchor still pins the mutation BLOCK, not a one-line method-not-allowed guard.
    const muteIdx = src.search(/if \(method !== ['"]GET['"]\) \{/);
    const wireIdx = src.indexOf("handleLlmRoutePredict(req,");
    expect(muteIdx).toBeGreaterThan(0);
    expect(wireIdx).toBeGreaterThan(muteIdx);
  });

  test('boot wire in nexus/index.ts passes a configProvider thunk', () => {
    // P1-FU1 (2026-05-14): boot must pass a thunk so user-config edits
    // (`elanous config mission set …`) take effect without daemon restart.
    // The static `globalMissionRouter()` form would silently cache the
    // boot-time config and ignore later edits.
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'nexus', 'index.ts'),
      'utf-8',
    );
    expect(src).toContain('globalMissionRouter(');
    expect(src).toMatch(/missionRouter:\s*globalMissionRouter\(\s*\(\s*\)\s*=>/);
    expect(src).toContain('llm.missionRouting');
  });
});
