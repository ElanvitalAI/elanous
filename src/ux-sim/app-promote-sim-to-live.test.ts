import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppLifecycleEvent } from '../nexus/apps/app-lifecycle-ledger.js';
import { createAppLifecycleStore } from '../nexus/apps/app-db.js';
import { promoteAppToLive } from '../nexus/apps/app-promote.js';
import { fingerprintAppSourceDirectory } from '../nexus/apps/app-source-snapshot.js';
import type { AppSimulationSnapshot } from '../nexus/apps/app-simulation.js';
import { createFakeAppSourceWorld } from './fake-app-source-world.js';
import { createFakeAppHost } from './fake-app-host.js';

test('app promotion requires a fresh passing receipt bound to the current source snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-promote-sim-'));
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'index.html'), '<main>ready</main>\n');
  const source = createFakeAppSourceWorld(join(root, 'source-world'));
  const lifecycle = createAppLifecycleStore(join(root, 'lifecycle.sqlite'));
  const host = createFakeAppHost([{ slug: 'demo-app', current: 'v1', versions: [{ id: 'v1', files: { 'index.html': '<main>ready</main>\n' } }] }]);
  const now = new Date('2026-11-10T01:00:00.000Z');
  const fingerprint = source.snapshot({ appSlug: 'demo-app', deploymentId: 'simulation-1', sourceRoot }).fingerprint;
  expect(fingerprintAppSourceDirectory(sourceRoot)).toBe(fingerprint);
  lifecycle.ensureCreated(createAppLifecycleEvent({ appId: 'demo-app', action: 'created', environment: 'simulation', actor: 'system' }));
  const receipt = { id: 'sim-receipt-1', appId: 'demo-app', runId: 'sim-run-1', createdAt: now.toISOString(),
    outcome: 'passed' as const, summary: 'fake app host simulation passed', appFingerprint: fingerprint };
  let snapshot: AppSimulationSnapshot = { status: 'passed', runId: receipt.runId,
    events: [{ id: 'sim-event-1', kind: 'app.sim.step', appId: receipt.appId, runId: receipt.runId, ts: now.getTime(),
      data: { step: 'host-check', message: 'fake app host returned expected source', receiptId: receipt.id } }], receipts: [receipt] };
  const matchingEvents = snapshot.events;
  const deps = { simulations: { snapshot: () => snapshot }, lifecycle, currentFingerprint: () => fingerprint,
    withSourceLock: async <T>(_appId: string, run: (assertHeld: () => void) => T | Promise<T>): Promise<T> => await run(() => undefined),
    config: { appPromoteReceiptTtlMs: 60_000 }, now: () => now };
  const input = { appId: 'demo-app', fingerprint, receiptId: receipt.id };
  try {
    expect(await promoteAppToLive({ ...input, fingerprint: '0'.repeat(64) }, deps)).toEqual({ outcome: 'rejected', reason: 'app-invalid' });
    expect(await promoteAppToLive({ ...input, receiptId: 'missing' }, deps)).toEqual({ outcome: 'rejected', reason: 'receipt-missing' });
    const legacyReceipt = { id: receipt.id, appId: receipt.appId, runId: receipt.runId, createdAt: receipt.createdAt,
      outcome: receipt.outcome, summary: receipt.summary };
    snapshot = { ...snapshot, receipts: [legacyReceipt] };
    expect(await promoteAppToLive(input, deps)).toEqual({ outcome: 'rejected', reason: 'receipt-stale' });
    snapshot = { ...snapshot, receipts: [{ ...receipt, appFingerprint: '0'.repeat(64) }] };
    expect(await promoteAppToLive(input, deps)).toEqual({ outcome: 'rejected', reason: 'receipt-stale' });
    expect(await promoteAppToLive(input, { ...deps, currentFingerprint: () => '0'.repeat(64) })).toEqual({ outcome: 'rejected', reason: 'app-invalid' });
    snapshot = { ...snapshot, receipts: [{ ...receipt, outcome: 'failed' }] };
    expect(await promoteAppToLive(input, deps)).toEqual({ outcome: 'rejected', reason: 'simulation-failed' });
    snapshot = { ...snapshot, receipts: [receipt], events: [] };
    expect(await promoteAppToLive(input, deps)).toEqual({ outcome: 'rejected', reason: 'receipt-stale' });
    snapshot = { ...snapshot, receipts: [{ ...receipt, createdAt: new Date(now.getTime() - 60_000).toISOString() }], events: matchingEvents };
    expect(await promoteAppToLive(input, deps)).toEqual({ outcome: 'rejected', reason: 'receipt-stale' });
    expect(lifecycle.snapshot('demo-app')?.status).toBe('draft');

    snapshot = { ...snapshot, receipts: [receipt], events: matchingEvents };
    const promoted = await promoteAppToLive(input, deps);
    expect(promoted).toEqual({ outcome: 'promoted', appId: 'demo-app', fingerprint, receiptId: receipt.id, runId: receipt.runId });
    expect(lifecycle.snapshot('demo-app')?.status).toBe('live');
    host.deploy('demo-app', 'v1');
    expect(host.fetch('demo-app.app.sim.invalid', '/').status).toBe(200);
  } finally {
    lifecycle.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
