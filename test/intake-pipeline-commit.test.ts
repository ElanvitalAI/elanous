// FU-I7c — Phase 1 pipeline-commit HTTP endpoint smoke.
//
// Sibling of `test/intake-pipeline-preview.test.ts`. The commit
// endpoint writes to the *real* TaskStore (the bare `new TaskStore()`
// constructor) and persists workflow YAMLs to disk, so we point both
// at a temp `ELANOUS_NEXUS_DIR` + `HOME` to keep the test hermetic.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

let tmpRoot: string;
let tmpTasks: string;
let tmpWorkflows: string;
let prevEnvNexus: string | undefined;
let prevEnvTasksDir: string | undefined;
let prevEnvWorkflowsDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fu-i7c-pipeline-'));
  tmpTasks = mkdtempSync(join(tmpdir(), 'fu-i7c-tasks-'));
  tmpWorkflows = mkdtempSync(join(tmpdir(), 'fu-i7c-wf-'));
  prevEnvNexus = process.env.ELANOUS_NEXUS_DIR;
  prevEnvTasksDir = process.env.ELANOUS_TASKS_DIR;
  prevEnvWorkflowsDir = process.env.ELANOUS_WORKFLOWS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  // TaskStore reads ELANOUS_TASKS_DIR / ELANOUS_TASKS_DB; saveWorkflow
  // reads ELANOUS_WORKFLOWS_DIR. Point both at tmpdirs so the commit
  // never touches the dev's real TOX or workflow library.
  process.env.ELANOUS_TASKS_DIR = tmpTasks;
  process.env.ELANOUS_WORKFLOWS_DIR = tmpWorkflows;
});

afterEach(() => {
  const restore = (key: string, prev: string | undefined): void => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
  restore('ELANOUS_NEXUS_DIR', prevEnvNexus);
  restore('ELANOUS_TASKS_DIR', prevEnvTasksDir);
  restore('ELANOUS_WORKFLOWS_DIR', prevEnvWorkflowsDir);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpTasks, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpWorkflows, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'FU-I7c' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 46000 + Math.floor(Math.random() * 2000);
}

describe('FU-I7c /v1/intake/pipeline-commit', () => {
  test('returns 401 when metaApi runtime is unwired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawText: 'x' }),
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
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
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
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });

  test('writes to the real TaskStore + returns ids (skeleton fallback path)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'do thing X' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intakeId).toBeTruthy();
      expect(body.intakeId).toMatch(/^commit-/);
      expect(body.decomposition.fallback).toBe(true);
      expect(body.register).not.toBeNull();
      expect(body.register.missionIds.length).toBe(1);
      expect(body.register.taskIds.length).toBe(1);
      expect(body.register.errors).toEqual([]);
      // The TaskStore file should have been created under ELANOUS_TASKS_DIR.
      const dbPath = join(tmpTasks, 'tasks.db');
      expect(existsSync(dbPath)).toBe(true);
    } finally { srv.stop(); }
  });

  test('FU-I7d filter — includeTaskKeys whitelist honoured at commit time', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          rawText: 'do thing X',
          includeTaskKeys: ['m-99/t-99'], // no match → register nothing
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.register.taskIds.length).toBe(0);
      expect(body.register.missionIds.length).toBe(0);
      expect(body.register.skippedTaskKeys.length).toBeGreaterThan(0);
    } finally { srv.stop(); }
  });

  test('per-task data surface mirrors preview endpoint (mission.tasks array)', async () => {
    // The PWA reuses the same response shape for both endpoints, so
    // the per-task array must be present here too.
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'just a memo' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.decomposition.missions)).toBe(true);
      const mission = body.decomposition.missions[0];
      expect(Array.isArray(mission.tasks)).toBe(true);
      const task = mission.tasks[0];
      expect(task.taskKey).toContain(`${mission.id}/`);
      expect(['high', 'medium', 'low']).toContain(task.priority);
    } finally { srv.stop(); }
  });

  test('refinementHint + priorDecomposition body fields accepted (skeleton path)', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          rawText: 'try again',
          refinementHint: 'missions 더 작게',
          priorDecomposition: { missions: [] },
        }),
      });
      expect(res.status).toBe(200);
    } finally { srv.stop(); }
  });

  test('successive commits append independent Mission rows (no dedup)', async () => {
    // v1 contract: every commit creates a new Mission/Task. Idempotency
    // / dedup is a future arc — surface the shape via the test so the
    // PWA UX can decide whether to warn on repeat.
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const first = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'same memo' }),
      });
      const firstBody = await first.json();
      const second = await fetch(`${srv.url}/v1/intake/pipeline-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ rawText: 'same memo' }),
      });
      const secondBody = await second.json();
      expect(firstBody.register.missionIds.length).toBe(1);
      expect(secondBody.register.missionIds.length).toBe(1);
      // Mission ids must be different (separate rows).
      expect(firstBody.register.missionIds[0]).not.toBe(secondBody.register.missionIds[0]);
    } finally { srv.stop(); }
  });
});
