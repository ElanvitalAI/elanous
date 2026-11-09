import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { createAppSimulationStore } from './app-simulation-db.js';
import { createAppSimulationRoute } from './app-simulation-route.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('only an explicit authorized run writes app.sim events and a receipt to the sim store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-route-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const published: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const runSimulation = () => ({ runId: 'demo-run-1', events: [{ kind: 'app.sim.step' as const, appId: 'voice-notes', runId: 'demo-run-1', ts: 100,
    data: { step: 'transcription', message: '받아쓰기 확인', receiptId: 'demo-receipt' } }],
  receipts: [{ id: 'demo-receipt', appId: 'voice-notes', runId: 'demo-run-1', outcome: 'passed' as const, summary: '완료' }] });
  const route = createAppSimulationRoute({ store, authorize: request => request.headers.get('authorization') === 'Bearer owner',
    hasApp: slug => slug === 'voice-notes', publish: event => published.push(event), runSimulation });
  try {
    const path = 'http://nexus.invalid/v1/apps/voice-notes/simulations/run';
    expect((await route(new Request(path, { method: 'POST' })))?.status).toBe(401);
    expect(store.snapshot('voice-notes').status).toBe('not-created');
    const response = await route(new Request(path, { method: 'POST', headers: { authorization: 'Bearer owner' } }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, simulation: { status: 'passed',
      events: [{ kind: 'app.sim.step', appId: 'voice-notes' }], receipts: [{ id: 'demo-receipt', outcome: 'passed' }] } });
    expect(published).toHaveLength(1);
  } finally { store.close(); }
});
