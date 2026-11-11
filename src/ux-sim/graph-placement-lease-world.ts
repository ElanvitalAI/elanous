import { join } from 'node:path';
import { admitGuardianHostLease, readResourceLedger, requestGuardianHostLease } from '../resource-ledger/resource-ledger.js';
import type { GraphRunState } from '../graph-runner/runner.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { createGraphTriggerHookDevice } from './graph-trigger-hook-device.js';

export interface GraphPlacementLeaseCase {
  readonly id: string;
  readonly placement: 'local' | 'pod' | 'remote:aws1' | 'user-cloud';
  readonly host: 'mshq' | 'pod-a' | 'aws1' | 'user-cloud';
  readonly runId: string;
  readonly consumer: string;
  readonly leaseId: string;
  readonly podGeneration: string;
  readonly expectedGeneration: string;
  readonly cpu: number;
  readonly profileMaxCpu: number;
  readonly hostOnline: boolean;
  readonly at: string;
  readonly seedLease: 'valid' | 'missing' | 'expired' | 'wrong-run' | 'wrong-consumer';
}

const base = {
  runId: 'placement-run', consumer: 'graph-runner', podGeneration: 'gen-2', expectedGeneration: 'gen-2',
  cpu: 1, profileMaxCpu: 2, hostOnline: true, at: '2026-11-10T07:00:00.000Z', seedLease: 'valid',
} as const;

/** Each case is independent: a real Guardian lease is seeded in the world's isolated ledger. */
export const graphPlacementLeaseCases: readonly GraphPlacementLeaseCase[] = [
  { ...base, id: 'valid-local', placement: 'local', host: 'mshq', runId: 'placement-local', leaseId: 'guardian:valid-local' },
  { ...base, id: 'valid-pod', placement: 'pod', host: 'pod-a', runId: 'placement-pod', leaseId: 'guardian:valid-pod' },
  { ...base, id: 'valid-remote', placement: 'remote:aws1', host: 'aws1', runId: 'placement-remote', leaseId: 'guardian:valid-remote' },
  { ...base, id: 'valid-user-cloud', placement: 'user-cloud', host: 'user-cloud', runId: 'placement-user', leaseId: 'guardian:valid-user-cloud' },
  { ...base, id: 'missing-lease', placement: 'pod', host: 'pod-a', runId: 'placement-missing', leaseId: 'guardian:missing-lease', seedLease: 'missing' },
  { ...base, id: 'expired-lease', placement: 'pod', host: 'pod-a', runId: 'placement-expired', leaseId: 'guardian:expired-lease', seedLease: 'expired' },
  { ...base, id: 'wrong-run', placement: 'pod', host: 'pod-a', runId: 'placement-wrong-run', leaseId: 'guardian:wrong-run', seedLease: 'wrong-run' },
  { ...base, id: 'wrong-consumer', placement: 'pod', host: 'pod-a', runId: 'placement-wrong-consumer', leaseId: 'guardian:wrong-consumer', seedLease: 'wrong-consumer' },
  { ...base, id: 'stale-generation', placement: 'pod', host: 'pod-a', runId: 'placement-stale', leaseId: 'guardian:stale-generation', podGeneration: 'gen-1' },
  { ...base, id: 'over-profile', placement: 'pod', host: 'pod-a', runId: 'placement-over', leaseId: 'guardian:over-profile', cpu: 3 },
  { ...base, id: 'offline-host', placement: 'remote:aws1', host: 'aws1', runId: 'placement-offline', leaseId: 'guardian:offline-host', hostOnline: false },
];

export type GraphPlacementLeaseAdapter = (input: {
  readonly request: GraphPlacementLeaseCase;
  readonly hostOnline: boolean;
  readonly admitHostLease: () => boolean;
  readonly enterNode: () => Promise<GraphRunState>;
}) => Promise<{ readonly decision: string; readonly reason?: string; readonly runId?: string }>;

/** Reuses Guardian's real lease ledger, the fake fleet, and the real graph runner; admission policy remains adapter-owned. */
export function createGraphPlacementLeaseWorld(source: string) {
  const hook = createGraphTriggerHookDevice(source);
  const ledgerPath = join(hook.root, 'guardian-resource-ledger.jsonl');
  const fleet = createFakeFleetDevice({ clusters: [
    { host: 'mshq', context: 'local', nodes: ['local-node'] },
    { host: 'pod-a', context: 'pod', nodes: ['pod-node'] },
    { host: 'aws1', context: 'remote', nodes: ['remote-node'] },
    { host: 'user-cloud', context: 'user-cloud', nodes: ['user-node'] },
  ] });
  const observations: Array<{ request: GraphPlacementLeaseCase; decision: string; reason?: string; runId?: string; admissions: boolean[]; enters: string[] }> = [];
  const seeded = new Set<string>();
  return {
    ledgerPath, fleet, observations, calls: hook.calls, events: hook.events,
    ledgerEvents: () => readResourceLedger(ledgerPath),
    seed(request: GraphPlacementLeaseCase) {
      if (seeded.has(request.id) || request.seedLease === 'missing') return;
      seeded.add(request.id);
      const at = new Date('2026-11-10T06:00:00.000Z');
      const record = requestGuardianHostLease({
        requestId: request.id,
        runId: request.seedLease === 'wrong-run' ? 'different-run' : request.runId,
        requestedBy: 'guardian',
        consumer: request.seedLease === 'wrong-consumer' ? 'different-consumer' : request.consumer,
        purpose: 'graph-node-placement', host: request.host, priority: 'normal',
        expiresAt: request.seedLease === 'expired' ? '2026-11-10T06:05:00.000Z' : '2026-11-10T08:00:00.000Z',
      }, at, ledgerPath);
      if (record.leaseId !== request.leaseId || record.state !== 'active') throw new Error(`fixture lease not active: ${request.id}`);
    },
    async deliver(request: GraphPlacementLeaseCase, adapter: GraphPlacementLeaseAdapter) {
      this.seed(request);
      hook.advanceTo(request.at);
      fleet.setHostOnline(request.host, request.hostOnline);
      const admissions: boolean[] = [];
      const enters: string[] = [];
      const result = await adapter({
        request, hostOnline: fleet.hostOnline(request.host),
        admitHostLease: () => {
          const admitted = admitGuardianHostLease({ leaseId: request.leaseId, host: request.host,
            runId: request.runId, consumer: request.consumer }, new Date(request.at), ledgerPath);
          admissions.push(admitted);
          return admitted;
        },
        enterNode: async () => {
          enters.push(request.runId);
          return hook.fire('manual', { placement: request.placement, leaseId: request.leaseId,
            podGeneration: request.podGeneration }, request.runId);
        },
      });
      const observation = { request, admissions, enters, ...result };
      observations.push(observation);
      return observation;
    },
    async play(adapter: GraphPlacementLeaseAdapter) {
      for (const request of graphPlacementLeaseCases) await this.deliver(request, adapter);
      return observations;
    },
    close: () => hook.close(),
  };
}
