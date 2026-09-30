// FU3 — Phase 1 pipeline-preview HTTP endpoint smoke.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fu3-pipeline-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'FU3' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 44000 + Math.floor(Math.random() * 2000);
}

describe('FU3 /v1/intake/pipeline-preview', () => {
  test('returns 401 when metaApi runtime is unwired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawText: 'hello' }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('unauthorized');
    } finally { srv.stop(); }
  });

  test('wired metaApi without bearer denies before body validation', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('rejects request without rawText (400)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('returns structured pipeline preview for a memo (skeleton fallback)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: '==== Group ====\n- do thing X' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intakeId).toBeTruthy();
      // Decompose falls back to skeleton (1 mission + 1 task).
      expect(body.decomposition.fallback).toBe(true);
      expect(body.decomposition.missionCount).toBe(1);
      expect(body.decomposition.taskCount).toBe(1);
      // I7 (2026-05-12) — per-task data so PWA cards UI can render
      // a card per task without a second fetch.
      expect(body.decomposition.missions).toHaveLength(1);
      const mission = body.decomposition.missions[0];
      expect(Array.isArray(mission.tasks)).toBe(true);
      expect(mission.tasks).toHaveLength(1);
      const task = mission.tasks[0];
      expect(task.id).toBeTruthy();
      expect(task.taskKey).toContain(`${mission.id}/`);
      expect(typeof task.title).toBe('string');
      expect(typeof task.intent).toBe('string');
      expect(['high', 'medium', 'low']).toContain(task.priority);
      // Skeleton fallback → categorize all-cognitive → workflow-ineligible.
      expect(task.workflowEligible).toBe(false);
      // No enrichments wired → diagnosticOnly count is also 0 for the
      // skeleton path (no urls/keywords on the synthetic task).
      expect(body.enrichmentCounts.diagnosticOnly).toBe(0);
      // Categorize falls back to all-cognitive (workflowEligible = 0).
      expect(body.categorize.fallback).toBe(true);
      expect(body.categorize.counts.workflowEligible).toBe(0);
      // Align: heuristic baseline for the single low-priority task.
      expect(body.align.dependencyCount).toBe(0);
      // Synth: nothing eligible → all counts zero (synth skipped).
      expect(body.synth.counts.skipped).toBeGreaterThanOrEqual(0);
      // Register not requested → null.
      expect(body.register).toBeNull();
    } finally { srv.stop(); }
  });

  test('register=true writes to an in-memory store + returns ids', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'do thing X', register: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.register).not.toBeNull();
      expect(body.register.missionIds.length).toBe(1);
      expect(body.register.taskIds.length).toBe(1);
      expect(body.register.errors).toEqual([]);
      // FU-I7d — skip surfaces always present (empty when no filter).
      expect(body.register.skippedTaskKeys).toEqual([]);
      expect(body.register.skippedMissionKeys).toEqual([]);
    } finally { srv.stop(); }
  });

  test('FU-I7b — useRealEnrich:true body is accepted (skeleton decompose path leaves no urls)', async () => {
    // Skeleton fallback only emits a single task with no urls/keywords,
    // so the plugin bundle has nothing to walk — but the endpoint
    // still must accept the body and finish 200. Once FU-I7a real
    // LLM produces tasks with URLs, the plugins fan out for real.
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'plain memo', useRealEnrich: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intakeId).toBeTruthy();
    } finally { srv.stop(); }
  });

  test('FU-I7a — useRealLlm:false (default) still hits the skeleton fallback', async () => {
    // Pre-FU-I7a contract: when useRealLlm is omitted (or false), the
    // endpoint must continue using the SHARED_THROW skeleton. This is
    // what every existing e2e test depends on + the only safe default
    // when no LLM key is configured.
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          rawText: 'plain memo',
          useRealLlm: false,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decomposition.fallback).toBe(true);
      expect(body.categorize.fallback).toBe(true);
    } finally { srv.stop(); }
  });

  test('FU-I7e — refinementHint body is accepted (skeleton path silently ignores)', async () => {
    // The skeleton fallback path doesn't reach the LLM prompt, so the
    // hint can't change the output. The endpoint still must accept the
    // body shape (no 400) and finish successfully — once FU-I7a wires
    // a real LLM the prompt builder will actually consume the hint.
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          rawText: 'redo this please',
          refinementHint: 'missions 더 작게',
          priorDecomposition: {
            missions: [
              { id: 'm-1', title: 'Old', tasks: [{ id: 't-1', title: 'Old t', intent: 'old' }] },
            ],
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intakeId).toBeTruthy();
      // Skeleton fallback still active — refine wiring is in place
      // but real refinement awaits FU-I7a real LLM.
      expect(body.decomposition.fallback).toBe(true);
    } finally { srv.stop(); }
  });

  test('FU-I7d — includeTaskKeys whitelist honours the per-card verdict', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      // Skeleton fallback produces exactly one task at m-1/t-1, so a
      // whitelist that omits it must skip the entire mission and the
      // task. The skip surface is the user's signal.
      const res = await fetch(`${srv.url}/v1/intake/pipeline-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          rawText: 'do thing X',
          register: true,
          includeTaskKeys: ['m-99/t-99'],   // nothing matches
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.register).not.toBeNull();
      expect(body.register.taskIds.length).toBe(0);
      expect(body.register.missionIds.length).toBe(0);
      expect(body.register.skippedTaskKeys.length).toBeGreaterThan(0);
      expect(body.register.skippedMissionKeys.length).toBeGreaterThan(0);
    } finally { srv.stop(); }
  });
});
