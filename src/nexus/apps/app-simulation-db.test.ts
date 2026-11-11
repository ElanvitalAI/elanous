import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { createAppSimulationStore } from './app-simulation-db.js';
import { createAppLifecycleStore } from './app-db.js';
import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';
import { resolveConceptProofForFingerprint } from './app-simulation.js';
import type { SimReceipt } from '../../ux-sim/sim-receipt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('concept proof resolver skips earlier failures and proofs for other app fingerprints', () => {
  const proof = (appFingerprint: string, verdict: SimReceipt['verdict'], id: string): SimReceipt => ({
    schema: 'elanous.sim-receipt.v1', appSimulationReceiptId: id, appSimulationRunId: `run-${id}`, appId: 'voice-notes',
    appFingerprint, deviceCatalogVersion: 1, requiredScenarios: [{ id: 'happy-path', outcome: verdict === 'passed' ? 'passed' : 'failed' }],
    sandboxEstablished: true, externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0,
    eventLedgerPath: `app-simulation.sqlite#${id}`, createdAt: '2026-11-10T08:00:00.000Z', verdict, reasons: [],
    receiptFingerprint: id.padEnd(64, '0'),
  });
  const currentFingerprint = 'a'.repeat(64);
  const latestFailure = proof(currentFingerprint, 'failed', 'latest-failure');
  const otherFingerprintPass = proof('b'.repeat(64), 'passed', 'other-fingerprint-pass');
  const currentPass = proof(currentFingerprint, 'passed', 'current-pass');
  const receipts = [latestFailure, otherFingerprintPass, currentPass].map(conceptProof => ({ conceptProof }));

  expect(resolveConceptProofForFingerprint(receipts, currentFingerprint)).toBe(currentPass);
  expect(resolveConceptProofForFingerprint(receipts.slice(0, 2), currentFingerprint)).toBe(latestFailure);
});

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
    expect(Number.isFinite(Date.parse(store.snapshot('voice-notes').receipts[0]!.createdAt))).toBe(true);
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

test('app sim proof creation failure rolls back the simulation receipt and events', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-proof-rollback-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  try {
    const result = { runId: 'run-proof-rollback', events: [{ kind: 'app.sim.step' as const, appId: 'voice-notes', runId: 'run-proof-rollback', ts: 1,
      data: { step: 'simulation-step', message: 'ok', receiptId: 'receipt-proof-rollback' } }],
    receipts: [{ id: 'receipt-proof-rollback', appId: 'voice-notes', runId: 'run-proof-rollback', outcome: 'passed' as const, summary: 'completed' }] };
    expect(() => store.recordWithConceptProof(result, 'receipt-proof-rollback', () => { throw new Error('proof generation failed'); }))
      .toThrow('proof generation failed');
    expect(store.snapshot('voice-notes')).toEqual({ status: 'not-created', events: [], receipts: [] });
  } finally { store.close(); }
});
