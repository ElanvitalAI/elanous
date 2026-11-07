import { expect, test } from 'bun:test';
import { createHostMirrorMountAdapter, createPodReuseSharedFakeBoundary } from './pod-reuse-shared-fake-boundary.js';
import { runWarmSiReuseSimulation } from './warm-si-reuse-sim.js';

test('POD-REUSE-SHARED-FAKE-K8S uses one control and Kubernetes boundary through SI reuse and return', async () => {
  const boundary = await createPodReuseSharedFakeBoundary();
  try {
    const evidence = await runWarmSiReuseSimulation({ runId: 'shared-k8s-return', boundary });
    const pod = boundary.kubernetes.get('pool-host-a-context')!.getPod('warm-pool-host-a-si-1');
    expect(evidence.leaseGenerations).toEqual([1, 2]);
    expect(evidence.podUids).toEqual(['si-warm-pod-uid-1', 'si-warm-pod-uid-1']);
    expect(evidence.cleanupOutcomes).toEqual(['returned', 'returned']);
    expect(pod?.metadata.uid).toBe('si-warm-pod-uid-1');
    expect(pod?.metadata.labels['elanous.ai/state']).toBe('idle');
    expect(boundary.primary.requests.filter(row => row.path.includes('/leases/pod-worker/'))).toHaveLength(4);
  } finally { boundary.stop(); }
});

test('POD-REUSE-SHARED-FAKE-K8S quarantines the shared Pod when cleanup finds residue', async () => {
  const boundary = await createPodReuseSharedFakeBoundary();
  try {
    const evidence = await runWarmSiReuseSimulation({ runId: 'shared-k8s-orphan', processResidue: 1, boundary });
    const pod = boundary.kubernetes.get('pool-host-a-context')!.getPod('warm-pool-host-a-si-1');
    expect(evidence.cleanupOutcomes).toEqual(['quarantined']);
    expect(evidence.retryAcquire).toBe('no-entry:busy');
    expect(pod?.metadata.labels['elanous.ai/state']).toBe('quarantined');
    expect(boundary.primary.requests.some(row => row.path.endsWith('/quarantine') && row.status === 200)).toBe(true);
  } finally { boundary.stop(); }
});

test('POD-REUSE-SHARED-FAKE-K8S host-mirror adapter counts reads and rejects writes from production mount flags', () => {
  const adapter = createHostMirrorMountAdapter({ path: '/srv/mirror/elanous.git', seed: new Uint8Array(4096) });
  expect(adapter.readOnly).toBe(true);
  expect(adapter.read()).toHaveLength(4096);
  expect(adapter.bytesRead).toBe(4096);
  expect(adapter.bytesWritten).toBe(0);
  expect(() => adapter.write(new Uint8Array([1]))).toThrow('host-mirror mount is read-only');
  expect(adapter.bytesWritten).toBe(0);
});
