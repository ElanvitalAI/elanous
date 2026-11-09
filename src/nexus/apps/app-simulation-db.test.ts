import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { createAppSimulationStore } from './app-simulation-db.js';
import { createAppLifecycleStore } from './app-db.js';
import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('app sim rows are app-scoped, repeatable by run and kept outside the live lifecycle ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-store-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const lifecycle = createAppLifecycleStore(join(root, 'app-lifecycle.sqlite'));
  try {
    lifecycle.ensureCreated(createAppLifecycleEvent({ appId: 'voice-notes', action: 'created', environment: 'simulation', actor: 'system' }, { id: () => 'created-voice' }));
    const lifecycleBefore = lifecycle.snapshot('voice-notes');
    store.record({ runId: 'app-demo-run-1', events: [
      { kind: 'app.sim.step', appId: 'voice-notes', runId: 'app-demo-run-1', ts: 100,
        data: { step: 'transcription', message: '받아쓰기 확인', receiptId: 'receipt-voice' } },
      { kind: 'app.sim.step', appId: 'shop-studio', runId: 'app-demo-run-1', ts: 200,
        data: { step: 'upload', message: '사진 저장 확인', receiptId: 'receipt-shop' } },
    ], receipts: [
      { id: 'receipt-voice', appId: 'voice-notes', runId: 'app-demo-run-1', outcome: 'passed', summary: '완료' },
      { id: 'receipt-shop', appId: 'shop-studio', runId: 'app-demo-run-1', outcome: 'passed', summary: '완료' },
    ] });
    expect(store.snapshot('voice-notes')).toMatchObject({ status: 'passed', runId: 'app-demo-run-1',
      events: [{ kind: 'app.sim.step', appId: 'voice-notes', data: { step: 'transcription' } }],
      receipts: [{ id: 'receipt-voice', appId: 'voice-notes', outcome: 'passed' }] });
    expect(store.snapshot('shop-studio').events).toHaveLength(1);
    expect(store.snapshot('missing-app')).toEqual({ status: 'not-created', events: [], receipts: [] });
    expect(lifecycle.snapshot('voice-notes')).toEqual(lifecycleBefore);
  } finally { store.close(); lifecycle.close(); }
});

test('app sim storage rejects events attached to another app receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-invalid-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  try {
    expect(() => store.record({ runId: 'run-2', events: [{ kind: 'app.sim.step', appId: 'voice-notes', runId: 'run-2', ts: 100,
      data: { step: 'transcription', message: 'ok', receiptId: 'receipt-shop' } }],
    receipts: [{ id: 'receipt-shop', appId: 'shop-studio', runId: 'run-2', outcome: 'passed', summary: '완료' }] })).toThrow('app simulation event must reference its app receipt');
  } finally { store.close(); }
});
