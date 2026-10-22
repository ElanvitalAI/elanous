import { expect, test } from 'bun:test';
import type { Kubectl } from './self-implement-pod.js';
import { warmWorkerPodManifest, type WarmPodSpec } from './pod-warm-worker-pod.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import { patchWarmLeaseMetadata, warmExecEnv } from './pod-warm-provenance.js';

const cutSha = 'a'.repeat(40);
const key = { context: 'pool-node-b', imageDigest: `sha256:${'b'.repeat(64)}`,
  lockHash: 'c'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-worker-1', namespace: 'elanous-test', kubectlContext: 'node-b',
  workerId: 'worker-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha, key,
  hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/' };
const command = (runId: string, leaseId: string): WarmWorkerCommand => ({ protocol: 1,
  runId, attemptId: `${runId}-attempt`, cutSha, leaseId, generation: 1, workerId: spec.workerId, key,
  podUid: 'pod-uid-1', requestedAt: '2026-10-20T11:12:00.000Z', deadlineAt: Date.now() + 60_000,
  files: ['src/example/worker.test.ts'], envProfile: 'gate-v1' });

const fixture = () => {
  const template = warmWorkerPodManifest(spec);
  const pod = { metadata: { ...(template.metadata as { labels: Record<string, string>;
    annotations: Record<string, string> }), uid: 'pod-uid-1', resourceVersion: '1' } };
  const calls: string[] = [];
  const kubectl: Kubectl = args => {
    calls.push(args[4]!);
    if (args[4] === 'get') return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    if (args[4] === 'patch') {
      const ops = JSON.parse(args[args.indexOf('-p') + 1]!) as Array<{ value: any }>;
      if (ops[0]?.value !== pod.metadata.uid || ops[1]?.value !== pod.metadata.resourceVersion)
        return { status: 1, stdout: '', stderr: 'UID/resourceVersion conflict' };
      pod.metadata.labels = ops[2]!.value;
      pod.metadata.annotations = ops[3]!.value;
      pod.metadata.resourceVersion = String(Number(pod.metadata.resourceVersion) + 1);
      return { status: 0, stdout: JSON.stringify(pod), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected kubectl' };
  };
  return { pod, kubectl, calls };
};

test('two warm leases rotate current work labels and clear them before idle reuse', () => {
  const { pod, kubectl } = fixture();
  const first = command('run-1', 'lease-1');
  const second = command('run-2', 'lease-2');
  expect(patchWarmLeaseMetadata(spec, first, 'leased', kubectl)).toEqual({ ok: true, reason: 'applied' });
  expect(pod.metadata.labels['elanous.ai/run']).toBe('run-1');
  expect(pod.metadata.annotations['elanous.ai/lease']).toBe('lease-1');
  expect(warmExecEnv(first)).toContain('ELANOUS_POD_LEASE=lease-1');
  expect(warmExecEnv(first)).toContain('ELANOUS_POD_REASON=gate shadow replay');
  expect(patchWarmLeaseMetadata(spec, first, 'idle', kubectl)).toEqual({ ok: true, reason: 'applied' });
  expect(pod.metadata.labels['elanous.ai/state']).toBe('idle');
  expect(pod.metadata.labels['elanous.ai/run']).toBeUndefined();
  expect(pod.metadata.annotations['elanous.ai/lease']).toBeUndefined();
  expect(patchWarmLeaseMetadata(spec, second, 'leased', kubectl)).toEqual({ ok: true, reason: 'applied' });
  expect(pod.metadata.labels['elanous.ai/run']).toBe('run-2');
  expect(pod.metadata.annotations['elanous.ai/lease']).toBe('lease-2');
  expect(JSON.stringify(pod)).not.toContain('lease-1');
});

test('warm exec env carries the full per-lease provenance key set', () => {
  const keys = warmExecEnv(command('run-1', 'lease-1')).map(entry => entry.slice(0, entry.indexOf('=')));
  expect(keys).toEqual(['ELANOUS_POD_ACTOR_KIND', 'ELANOUS_POD_ACTOR', 'ELANOUS_POD_KIND', 'ELANOUS_POD_RUN',
    'ELANOUS_POD_PHASE', 'ELANOUS_POD_REQUESTED_AT', 'ELANOUS_POD_CHARACTER', 'ELANOUS_POD_ENTRANCE',
    'ELANOUS_POD_COMMIT', 'ELANOUS_POD_SHARD', 'ELANOUS_POD_REASON', 'ELANOUS_POD_WARM_REUSED',
    'ELANOUS_POD_LEASE', 'ELANOUS_POD_WORKER']);
});

test('UID drift and an unreturned lease refuse a second admission before patch', () => {
  const { pod, kubectl, calls } = fixture();
  const first = command('run-1', 'lease-1');
  expect(patchWarmLeaseMetadata(spec, { ...first, podUid: 'replaced' }, 'leased', kubectl))
    .toEqual({ ok: false, reason: 'pod-identity-drift' });
  expect(calls).toEqual(['get']);
  expect(patchWarmLeaseMetadata(spec, first, 'leased', kubectl).ok).toBe(true);
  expect(patchWarmLeaseMetadata(spec, command('run-2', 'lease-2'), 'leased', kubectl))
    .toEqual({ ok: false, reason: 'lease-state-not-idle' });
  expect(pod.metadata.labels['elanous.ai/lease']).toBe('lease-1');
});

test('resourceVersion conflict leaves a lease unadmitted', () => {
  const { kubectl } = fixture();
  const conflict: Kubectl = args => args[4] === 'patch'
    ? { status: 1, stdout: '', stderr: 'the object has been modified' } : kubectl(args);
  expect(patchWarmLeaseMetadata(spec, command('run-1', 'lease-1'), 'leased', conflict))
    .toEqual({ ok: false, reason: 'conditional-patch-failed' });
});

test('quarantine clears active work labels and does not advertise idle', () => {
  const { pod, kubectl } = fixture();
  const active = command('run-1', 'lease-1');
  expect(patchWarmLeaseMetadata(spec, active, 'leased', kubectl).ok).toBe(true);
  expect(patchWarmLeaseMetadata(spec, active, 'quarantined', kubectl).ok).toBe(true);
  expect(pod.metadata.labels['elanous.ai/state']).toBe('quarantined');
  expect(pod.metadata.labels['elanous.ai/run']).toBeUndefined();
  expect(pod.metadata.annotations['elanous.ai/lease']).toBeUndefined();
  expect(patchWarmLeaseMetadata(spec, command('run-2', 'lease-2'), 'leased', kubectl))
    .toEqual({ ok: false, reason: 'lease-state-not-idle' });
});
