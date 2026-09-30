// I10 (2026-05-12) — GET /v1/intake/runs e2e + emit-on-preview integration.
//
// Verifies that:
//   1. The endpoint returns 401 when metaApi is unwired.
//   2. An empty file → empty result (no error).
//   3. A preview call emits a row that the read endpoint surfaces.
//   4. Aggregates roll up across multiple preview calls.
//   5. ?limit=N caps the rows in the response.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

let tmpRoot: string;
let tmpIntake: string;
let prevNexus: string | undefined;
let prevIntake: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'i10-runs-nexus-'));
  tmpIntake = mkdtempSync(join(tmpdir(), 'i10-runs-intake-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevIntake = process.env.ELANOUS_INTAKE_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  // Point the metrics writer at a tmpdir so the test never appends to
  // the dev's real ~/.elanous/intake/pipeline-runs.jsonl.
  process.env.ELANOUS_INTAKE_DIR = tmpIntake;
});

afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  if (prevIntake === undefined) delete process.env.ELANOUS_INTAKE_DIR;
  else process.env.ELANOUS_INTAKE_DIR = prevIntake;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpIntake, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'I10' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 48000 + Math.floor(Math.random() * 2000);
}

describe('I10 GET /v1/intake/runs', () => {
  test('returns 401 when metaApi runtime is unwired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/runs`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('unauthorized');
    } finally { srv.stop(); }
  });

  test('wired metaApi without bearer denies before the runs handler', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/runs`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('empty log → total=0 + empty rows + empty aggregates', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/runs`, { headers: { authorization: 'Bearer test-token' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.rows).toEqual([]);
      expect(body.aggregates.total).toBe(0);
      expect(body.aggregates.avgDurationMs).toBe(0);
    } finally { srv.stop(); }
  });

  test('preview call emits a row that runs endpoint surfaces', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const preview = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'memo for I10' }),
      });
      expect(preview.status).toBe(200);
      const runs = await fetch(`${srv.url}/v1/intake/runs`, { headers: { authorization: 'Bearer test-token' } });
      const body = await runs.json();
      expect(body.total).toBe(1);
      expect(body.rows.length).toBe(1);
      expect(body.rows[0].kind).toBe('preview');
      expect(body.rows[0].intakeId).toMatch(/^preview-/);
      expect(body.rows[0].decomposition.fallback).toBe(true);
      expect(body.rows[0].useRealLlm).toBe(false);
      expect(body.rows[0].useRealEnrich).toBe(false);
      // Aggregates roll up the single preview row.
      expect(body.aggregates.total).toBe(1);
      expect(body.aggregates.byKind.preview).toBe(1);
      expect(body.aggregates.fallbackRate.decompose).toBe(1);
    } finally { srv.stop(); }
  });

  test('aggregates fold across multiple preview calls', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
          body: JSON.stringify({ rawText: `memo ${i}` }),
        });
      }
      const runs = await fetch(`${srv.url}/v1/intake/runs`, { headers: { authorization: 'Bearer test-token' } });
      const body = await runs.json();
      expect(body.total).toBe(3);
      expect(body.aggregates.byKind.preview).toBe(3);
      expect(body.aggregates.avgDurationMs).toBeGreaterThanOrEqual(0);
    } finally { srv.stop(); }
  });

  test('?limit=N caps the response rows (aggregates still see full file)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      for (let i = 0; i < 5; i += 1) {
        await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
          body: JSON.stringify({ rawText: `memo ${i}` }),
        });
      }
      const runs = await fetch(`${srv.url}/v1/intake/runs?limit=2`, { headers: { authorization: 'Bearer test-token' } });
      const body = await runs.json();
      expect(body.total).toBe(5);            // all 5 in the file
      expect(body.rows.length).toBe(2);      // but only 2 surfaced
      expect(body.aggregates.total).toBe(5); // aggregates over full file
    } finally { srv.stop(); }
  });
});
