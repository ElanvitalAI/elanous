// D8 (2026-05-12) — GET /v1/dispatch/runs e2e.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import {
  recordDispatchOutcome,
  type DispatchRunRecord,
} from '../src/dispatch/dispatch-metrics.js';

const SAMPLE: DispatchRunRecord = {
  at: '2026-05-12T10:00:00.000Z',
  taskId: 'task:abc',
  outcome: 'launched',
  reason: 'ok',
  axes: {
    inSleepWindow: true,
    idle: true,
    resourceOk: true,
    priorityBoosted: false,
  },
};

let tmpRoot: string;
let tmpDispatch: string;
let prevNexus: string | undefined;
let prevDispatch: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'd8-runs-nexus-'));
  tmpDispatch = mkdtempSync(join(tmpdir(), 'd8-runs-dispatch-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevDispatch = process.env.ELANOUS_DISPATCH_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.ELANOUS_DISPATCH_DIR = tmpDispatch;
});

afterEach(() => {
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  if (prevDispatch === undefined) delete process.env.ELANOUS_DISPATCH_DIR;
  else process.env.ELANOUS_DISPATCH_DIR = prevDispatch;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpDispatch, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: '0.4.0', phase: 'D8' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  return { state, registry, bus };
}

async function uniquePort(): Promise<number> {
  return 52000 + Math.floor(Math.random() * 2000);
}

describe('D8 GET /v1/dispatch/runs', () => {
  test('returns 401 when metaApi runtime is unwired', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
    });
    try {
      const res = await fetch(`${srv.url}/v1/dispatch/runs`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
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
      const res = await fetch(`${srv.url}/v1/dispatch/runs`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { srv.stop(); }
  });

  test('empty log → 0 total + empty rows', async () => {
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/dispatch/runs`, { headers: { authorization: 'Bearer test-token' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.rows).toEqual([]);
    } finally { srv.stop(); }
  });

  test('seeded rows → aggregates + most-recent-first', async () => {
    recordDispatchOutcome(SAMPLE);
    recordDispatchOutcome({ ...SAMPLE, taskId: 'task:b', outcome: 'rejected', reason: 'resource-budget:gpu' });
    recordDispatchOutcome({ ...SAMPLE, taskId: 'task:c', outcome: 'rejected', reason: 'resource-budget:gpu' });
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/dispatch/runs`, { headers: { authorization: 'Bearer test-token' } });
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.rows[0].taskId).toBe('task:c');
      expect(body.aggregates.byOutcome.launched).toBe(1);
      expect(body.aggregates.byOutcome.rejected).toBe(2);
      expect(body.aggregates.topRejectReasons[0].reason).toBe('resource-budget:gpu');
      expect(body.aggregates.topRejectReasons[0].count).toBe(2);
    } finally { srv.stop(); }
  });

  test('?limit=N caps surfaced rows (aggregates still see full file)', async () => {
    for (let i = 0; i < 5; i += 1) {
      recordDispatchOutcome({ ...SAMPLE, taskId: `r-${i}` });
    }
    const fix = makeFixture();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: await uniquePort(),
      metaApi: { bearerToken: 'test-token', noAuth: false },
    });
    try {
      const res = await fetch(`${srv.url}/v1/dispatch/runs?limit=2`, { headers: { authorization: 'Bearer test-token' } });
      const body = await res.json();
      expect(body.total).toBe(5);
      expect(body.rows.length).toBe(2);
      expect(body.aggregates.total).toBe(5);
    } finally { srv.stop(); }
  });
});
