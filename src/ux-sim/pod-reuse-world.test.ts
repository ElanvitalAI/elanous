import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { debug } from '../debug/log.js';
import { runPodReuseWorld } from './pod-reuse-world.js';
import { runWarmSiReuseSimulation } from './warm-si-reuse-sim.js';

test('POD-REUSE-SIM-METHOD: lifecycle world shares SI lease state and measures warm-worker/source boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-reuse-world-test-'));
  const previous = getTestStateRoot();
  const previousDebugFile = debug.isFileEnabled();
  setTestStateRoot(root);
  debug.setFileEnabled(false);
  try {
    const result = await runPodReuseWorld(`pod-reuse-world-${Date.now()}`);

    expect(result.workerProviderHit.selection).toMatchObject({ selected: true, transport: 'observed', reason: 'complete' });
    expect(result.workerProviderMismatch).toMatchObject({ selection: null,
      reconcile: { target: 1, ready: 0, failed: [expect.any(String)] } });
    expect(result.sourceIo.sourceBytes).toBeGreaterThan(0);
    expect(result.sourceIo.sourceManifestReadOnly).toBe(true);
    expect(result.sourceIo.sourceMountPath).toBe('/host-mirror');
    expect(result.sourceIo.sourceHostPath).toContain('/mirror.git');
    expect(result.sourceIo.hostMirrorAdapter).toEqual({ readOnly: true,
      bytesRead: result.sourceIo.sourceBytes, bytesWritten: 0, writeRejected: true });
    expect(result.sourceIo.reference).toMatchObject({ via: 'production-pod-source-script/shared-mirror' });
    expect(result.sourceIo.reference.sharedObjectAlternate).toBe(true);
    expect(result.sourceIo.reference.objectStoreBytes).toBe(0);
    expect(result.sourceIo.copy).toMatchObject({ via: 'git-clone-no-hardlinks' });
    expect(result.sourceIo.copy.objectStoreBytes).toBeGreaterThan(0);
    expect(result.sourceIo.reference.readBytes).toBeGreaterThan(0);
    expect(result.sourceIo.copy.readBytes).toBe(result.sourceIo.reference.readBytes);
    expect(result.sourceIo.copy.objectStoreBytes).toBeGreaterThan(0);
    expect(result.sourceIo.reference.digest).toBe(result.sourceIo.copy.digest);
    expect(result.sourceIo.reference.setupMs).toBeGreaterThanOrEqual(0);
    expect(result.sourceIo.copy.setupMs).toBeGreaterThanOrEqual(0);
    expect(result.scenario.pass).toBe(true);
    expect(result.scenario.cleanReuse.leaseGenerations).toEqual([1, 2, 1]);
    expect(result.scenario.cleanReuse.podUids[0]).toBe(result.scenario.cleanReuse.podUids[1]);
    expect(result.scenario.cleanReuse.leaseHosts).toEqual(['pool-host-a', 'pool-host-a', 'pool-host-b']);
    expect(result.scenario.cleanReuse.cleanupOutcomes).toEqual(['returned', 'quarantined', 'returned']);
    expect(result.scenario.residueReuse.cleanupOutcomes).toEqual(['quarantined']);
    expect(result.scenario.residueReuse.leaseGenerations).toEqual([1]);
    expect(result.scenario.recovery.observations[0]?.recoveryVerdict).toContain('surviving host pool-b');
    expect(result.scenario.residueBeforeCleanup.credentials).toHaveLength(1);
    expect(result.scenario.residueAfterCleanup.credentials).toEqual([]);
    expect(result.admission.recommended).toBeGreaterThan(0);
    expect((result.job as { spec?: unknown }).spec).toBeDefined();
  } finally {
    setTestStateRoot(previous ?? null);
    debug.setFileEnabled(previousDebugFile);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('POD-REUSE-ALLOC-RETURN admits a warm lease at cold-slot exhaustion and quarantines before alternate-host recovery', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'pod-reuse-alloc-return-'));
  try {
    const reused = await runWarmSiReuseSimulation({ runId: 'alloc-return-clean', stateRoot, exhaustColdJobSlots: true });
    expect(reused).toMatchObject({ coldAdmission: { recommended: 0, capacitySlots: 0, placeableSlots: 0, running: 1 },
      leaseGenerations: [1, 2], podUids: ['si-warm-pod-uid-1', 'si-warm-pod-uid-1'],
      cleanupOutcomes: ['returned', 'returned'], finalPodState: 'idle' });
    expect(reused.controlTransitions.filter(path => path.includes('/release:200'))).toHaveLength(2);
    expect(reused.controlTransitions.filter(path => path.includes('/sanitize:200'))).toHaveLength(2);

    const orphaned = await runWarmSiReuseSimulation({ runId: 'alloc-return-orphan', stateRoot, exhaustColdJobSlots: true, processResidue: 1,
      includeAlternateHost: true, recoverOnAlternateHost: true });
    expect(orphaned).toMatchObject({ coldAdmission: { recommended: 0, capacitySlots: 0, placeableSlots: 0, running: 1 },
      leaseHosts: ['pool-host-a', 'pool-host-b'],
      cleanupOutcomes: ['quarantined', 'returned'], retryAcquire: 'acquired:pool-host-b',
      recoveryHost: 'pool-host-b', finalPodState: 'idle' });
    const transitions = orphaned.controlTransitions;
    const quarantine = transitions.indexOf('/v1/leases/pod-worker/warm-pool-host-a-si-1-generation-1/quarantine:200');
    const retryRejected = transitions.indexOf('/v1/leases/pod-worker:409');
    const retryAcquired = transitions.indexOf('/v1/leases/pod-worker:200', retryRejected + 1);
    const alternateRelease = transitions.indexOf('/v1/leases/pod-worker/warm-pool-host-b-si-1-generation-1/release:200');
    const alternateSanitize = transitions.indexOf('/v1/leases/pod-worker/warm-pool-host-b-si-1-generation-1/sanitize:200');
    expect(quarantine).toBeGreaterThanOrEqual(0);
    expect(retryRejected).toBeGreaterThan(quarantine);
    expect(retryAcquired).toBeGreaterThan(retryRejected);
    expect(alternateRelease).toBeGreaterThan(retryAcquired);
    expect(alternateSanitize).toBeGreaterThan(alternateRelease);
    expect(transitions.some(path => path.includes('warm-pool-host-a-si-1-generation-1/release'))).toBe(false);
    expect(transitions.some(path => path.includes('warm-pool-host-a-si-1-generation-1/sanitize'))).toBe(false);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
