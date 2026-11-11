import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../control-plane/ledger.js';
import { HostPoolLease } from '../pod-lease/host-lease.js';
import { PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { withSimClock } from '../ux-sim/fake-clock.js';
import { installCloudBurstAuto, type CloudBurstRuntimeConfig } from './cloud-burst-runtime.js';

test('a zero-demand update received during start is reconciled after the active burst call', async () => {
  await withSimClock(Date.parse('2026-11-10T00:00:00.000Z'), async clock => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-burst-runtime-pressure-'));
  let dispose: (() => void) | undefined;
  try {
    let started!: () => void;
    let continueStart!: () => void;
    const startEntered = new Promise<void>(resolve => { started = resolve; });
    const startGate = new Promise<void>(resolve => { continueStart = resolve; });
    let vmRunning = false;
    let stops = 0;
    let signalStopped!: () => void;
    const stopped = new Promise<void>(resolve => { signalStopped = resolve; });
    const cloudVm = {
      async start() { started(); await startGate; vmRunning = true; },
      async stop() { stops++; vmRunning = false; signalStopped(); },
      async status(host: 'aws2') { return { host, state: vmRunning ? 'running' : 'stopped' } as const; },
    };
    const pool = new PodPoolScheduler([
      { context: 'full', sshHost: 'aws3', capacity: 1, k3dCluster: 'full', federationRole: 'task' }, // Source: 내부 문서 `pod-federation-mapreduce` §2 — one saturated local member.
      { context: 'cloud', sshHost: 'aws2', capacity: 0, k3dCluster: 'cloud', federationRole: 'cloud' }, // Source: 내부 문서 `pod-federation-mapreduce` §2 — cloud begins reserved and unavailable.
    ], {
      hostLease: new HostPoolLease('cloud-burst-pressure', { dir: root }),
      occupancy: () => ({ full: { occupied: 1 }, cloud: { occupied: 0 } }),
    });
    const config: CloudBurstRuntimeConfig = {
      host: 'aws2', context: 'cloud', capacity: 1, threshold: 1, // Source: 내부 문서 `CONDUCTOR` §6c — the smallest enabled fixture.
      hourlyCostKrw: 10_000, ttlHours: 2, imageDigest: `sha256:${'a'.repeat(64)}`, // Source: 내부 문서 `CONDUCTOR` §6c.
      owner: 'NT-3', purpose: 'execution',
    };
    dispose = installCloudBurstAuto({
      pool, config, cloudVm, join: async () => {}, isWarm: async () => false,
      ledger: new ResourceLedger(root), now: () => clock.now(), reconcileIntervalMs: 10,
    });
    const controller = new AbortController();
    const waiting = pool.tryAcquire(undefined, undefined, { waiterId: 'cancel-while-starting', signal: controller.signal });
    await startEntered;
    controller.abort(new Error('work was cancelled while cloud VM started'));
    continueStart();
    await waiting;
    await clock.tickAndFlushMicrotasks(10);
    await stopped;
    dispose();
    dispose = undefined;
    expect(stops).toBe(1);
    expect(pool.members.find(member => member.context === 'cloud')?.capacity).toBe(0);
  } finally { dispose?.(); rmSync(root, { recursive: true, force: true }); }
  });
});
