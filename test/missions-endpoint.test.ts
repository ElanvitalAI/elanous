// M4-3 (2026-05-12) — GET /v1/missions + GET /v1/missions/:id e2e.
//
// Hermetic: every call uses ELANOUS_TASKS_DIR / ELANOUS_TASKS_DB env
// pointers at tmp dirs so the test never reads the dev's real TOX.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { TaskStore } from '../src/task-orchestrator/store.js';
import { createMission } from '../src/task-orchestrator/mission.js';
import { createTask } from '../src/task-orchestrator/types.js';

let tmpRoot: string;
let tmpTasks: string;
let prevNexus: string | undefined;
let prevTasksDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'm4-3-nexus-'));
  tmpTasks = mkdtempSync(join(tmpdir(), 'm4-3-tasks-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevTasksDir = process.env.ELANOUS_TASKS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.ELANOUS_TASKS_DIR = tmpTasks;
});

afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  if (prevTasksDir === undefined) delete process.env.ELANOUS_TASKS_DIR;
  else process.env.ELANOUS_TASKS_DIR = prevTasksDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpTasks, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedStore(): { missionId: string; taskIds: string[] } {
  const store = new TaskStore();
  try {
    const mission = createMission(
      {
        title: 'Diagram + video boost',
        description: 'Absorb diagram + video tooling',
        source: { kind: 'manual' },
      },
      { now: Date.now() },
    );
    store.saveMission(mission);
    const taskIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = createTask(
        {
          title: `Task ${i}`,
          description: `Task ${i} body`,
          surface: { kind: 'llm-direct', prompt: `Task ${i} prompt` },
          missionId: mission.id,
        },
        { now: Date.now() },
      );
      store.saveTask(t);
      taskIds.push(t.id);
    }
    return { missionId: mission.id, taskIds };
  } finally {
    store.close();
  }
}

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'M4-3' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 50000 + Math.floor(Math.random() * 2000);
}

function authorizedFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { authorization: 'Bearer test-token' } });
}

describe('M4-3 GET /v1/missions', () => {
  test('returns 401 when metaApi runtime is unwired, before reaching the route', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/missions`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('returns 401 without bearer even when metaApi runtime is wired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/missions`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('empty store → total=0 + empty array', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/missions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.missions).toEqual([]);
    } finally { srv.stop(); }
  });

  test('seeded mission → surfaced with task summary', async () => {
    const { missionId } = seedStore();
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/missions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      const card = body.missions[0];
      expect(card.id).toBe(missionId);
      expect(card.title).toBe('Diagram + video boost');
      expect(card.taskCount).toBe(3);
      expect(card.surfaceKindCounts['llm-direct']).toBe(3);
      // Default new tasks are 'backlog'.
      expect(card.taskStatusCounts['backlog']).toBe(3);
    } finally { srv.stop(); }
  });

  test('status filter narrows the result set', async () => {
    seedStore();
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      // Default new mission status = 'planning' (createMission).
      const planning = await authorizedFetch(`${srv.url}/v1/missions?status=planning`);
      const planningBody = await planning.json();
      expect(planningBody.total).toBe(1);
      const completed = await authorizedFetch(`${srv.url}/v1/missions?status=completed`);
      const completedBody = await completed.json();
      expect(completedBody.total).toBe(0);
    } finally { srv.stop(); }
  });
});

describe('M4-3 GET /v1/missions/:id', () => {
  test('404 when mission id unknown', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/missions/does-not-exist`);
      expect(res.status).toBe(404);
    } finally { srv.stop(); }
  });

  test('returns mission + attached tasks + surface roll-up', async () => {
    const { missionId, taskIds } = seedStore();
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/missions/${missionId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mission.id).toBe(missionId);
      expect(body.tasks.length).toBe(3);
      const returnedIds = body.tasks.map((t: { id: string }) => t.id);
      for (const id of taskIds) expect(returnedIds).toContain(id);
      expect(body.surfaceKindCounts['llm-direct']).toBe(3);
      // M4-3 detail follow-up — list endpoint always includes
      // taskStatusCounts; detail must match the same shape so PWA
      // mission lane can render without a list/detail divergence.
      expect(body.taskStatusCounts).toBeDefined();
      expect(body.taskStatusCounts['backlog']).toBe(3);
    } finally { srv.stop(); }
  });

  test('400 when path is missing the id segment', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await authorizedFetch(`${srv.url}/v1/missions/`);
      expect(res.status).toBe(400);
    } finally { srv.stop(); }
  });
});
