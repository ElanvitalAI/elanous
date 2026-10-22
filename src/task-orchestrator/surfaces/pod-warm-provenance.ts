import { spawnSync } from 'node:child_process';
import type { Kubectl } from './self-implement-pod.js';
import { podProvenanceMetadata } from './pod-provenance.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import type { WarmPodSpec } from './pod-warm-worker-pod.js';

const PREFIX = 'elanous.ai/';
const STATIC = new Set(['pool', 'image-digest', 'launch-host']);
const workKey = (key: string) => key.startsWith(PREFIX) && !STATIC.has(key.slice(PREFIX.length));

export function warmLeaseMetadata(command: WarmWorkerCommand) {
  return podProvenanceMetadata({ actorKind: 'loop', actor: 'release-gate', character: 'gate-warm-worker',
    entrance: 'release-gate-warm', kind: 'warm', run: command.runId, phase: 'release-gate',
    requestedAt: command.requestedAt || 'unknown', reason: 'gate shadow replay', commit: command.cutSha,
    shard: command.attemptId, warmReused: true });
}

export function warmExecEnv(command: WarmWorkerCommand): string[] {
  return [...warmLeaseMetadata(command).env,
    { name: 'ELANOUS_POD_LEASE', value: command.leaseId },
    { name: 'ELANOUS_POD_WORKER', value: command.workerId },
  ].map(({ name, value }) => `${name}=${value}`);
}

/** One UID/resourceVersion-guarded metadata mutation. A failed patch never admits a lease. */
export function patchWarmLeaseMetadata(spec: WarmPodSpec, command: WarmWorkerCommand,
  next: 'leased' | 'idle' | 'quarantined', injected?: Kubectl): { ok: boolean; reason: string } {
  const fail = (reason: string) => ({ ok: false, reason });
  if (!command.podUid || !command.requestedAt) return fail('lease-identity-missing');
  const kubectl: Kubectl = injected ?? ((args, input) => {
    const env = { ...process.env };
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
    const result = spawnSync('kubectl', [...args], { encoding: 'utf8', input, env,
      timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const prefix = ['--context', spec.kubectlContext, '-n', spec.namespace];
  const observed = kubectl([...prefix, 'get', 'pod', spec.name, '-o', 'json']);
  if (observed.status !== 0) return fail('pod-read-failed');
  let pod: any;
  try { pod = JSON.parse(observed.stdout); } catch { return fail('pod-read-invalid'); }
  const metadata = pod?.metadata;
  if (metadata?.name !== spec.name || metadata?.namespace !== spec.namespace
    || metadata?.uid !== command.podUid || typeof metadata?.resourceVersion !== 'string'
    || !metadata.resourceVersion
    || metadata.annotations?.['elanous.dev/warm-worker-id'] !== spec.workerId
    || metadata.annotations?.['elanous.dev/warm-cut-sha'] !== spec.cutSha) return fail('pod-identity-drift');
  const labels = { ...(metadata.labels ?? {}) } as Record<string, string>;
  const annotations = { ...(metadata.annotations ?? {}) } as Record<string, string>;
  if (next === 'leased' && labels[`${PREFIX}state`] !== undefined
    && labels[`${PREFIX}state`] !== 'idle') return fail('lease-state-not-idle');
  if (next === 'leased' && labels[`${PREFIX}state`] === undefined
    && [...Object.keys(labels), ...Object.keys(annotations)].some(workKey)) return fail('stale-work-metadata');
  if (next === 'idle' && (labels[`${PREFIX}state`] !== 'leased'
    || labels[`${PREFIX}lease`] !== command.leaseId)) return fail('lease-state-mismatch');
  if (next === 'quarantined' && labels[`${PREFIX}state`] === 'leased'
    && labels[`${PREFIX}lease`] !== command.leaseId) return fail('lease-state-mismatch');
  for (const key of Object.keys(labels)) if (workKey(key)) delete labels[key];
  for (const key of Object.keys(annotations)) if (workKey(key)) delete annotations[key];
  if (next === 'leased') {
    const work = warmLeaseMetadata(command);
    Object.assign(labels, work.labels, { [`${PREFIX}state`]: 'leased', [`${PREFIX}lease`]: command.leaseId });
    Object.assign(annotations, work.annotations, { [`${PREFIX}lease`]: command.leaseId });
  } else labels[`${PREFIX}state`] = next;
  const patch = [
    { op: 'test', path: '/metadata/uid', value: command.podUid },
    { op: 'test', path: '/metadata/resourceVersion', value: metadata.resourceVersion },
    { op: 'add', path: '/metadata/labels', value: labels },
    { op: 'add', path: '/metadata/annotations', value: annotations },
  ];
  const updated = kubectl([...prefix, 'patch', 'pod', spec.name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']);
  if (updated.status !== 0) return fail('conditional-patch-failed');
  try {
    const after = JSON.parse(updated.stdout);
    const matched = after?.metadata?.uid === command.podUid
      && after?.metadata?.labels?.[`${PREFIX}state`] === next
      && (next !== 'leased' ? after.metadata.labels[`${PREFIX}lease`] === undefined
        : after.metadata.labels[`${PREFIX}lease`] === command.leaseId);
    return matched ? { ok: true, reason: 'applied' } : fail('patch-result-mismatch');
  } catch { return fail('patch-result-invalid'); }
}
