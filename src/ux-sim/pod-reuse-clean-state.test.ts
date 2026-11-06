import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { cleanAndReturnChildPod, type ChildPodLease, type ChildPodReuseOperations } from '../task-orchestrator/surfaces/pod-child-reuse.js';
import { createPodReuseResidueFaultFixture } from './fault-pod-reuse-residue.js';

const workerLease: ChildPodLease = {
  workerId: 'worker-1', podUid: 'pod-uid-1', leaseId: 'lease-round-1', generation: 1,
  key: { context: 'simulation', imageDigest: `sha256:${'b'.repeat(64)}`,
    lockHash: 'c'.repeat(64), architecture: 'amd64' }, sourceSha: '0'.repeat(40),
};

test('one simulated warm worker clears real Git, child-process and credential residue before two lease returns', async () => {
  const fixture = createPodReuseResidueFaultFixture();
  const sourceSha = fixture.remote.git(fixture.remote.checkout, ['rev-parse', 'HEAD']);
  const children = new Map<string, ChildProcess>();
  const returned: Array<{ generation: number; observedResidue: ReturnType<typeof fixture.residue> }> = [];
  const quarantined: string[] = [];
  const liveChildPids = () => [...children.values()]
    .filter((child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null)
    .map((child) => child.pid!);
  const stopChild = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    child.kill('SIGTERM');
    await exited;
  };
  const operations: ChildPodReuseOperations = {
    stopChildProcesses: async () => {
      for (const process of fixture.processes.list('worker-1')) {
        const child = children.get(process.id);
        if (child) await stopChild(child);
        fixture.processes.kill(process.id, 'worker-1');
      }
      return { remaining: fixture.processes.list('worker-1').length + liveChildPids().length };
    },
    git: async (_lease, args) => {
      try {
        const stdout = fixture.remote.git(fixture.remote.checkout, args);
        return { status: 0, stdout };
      } catch {
        return { status: 1 };
      }
    },
    removeRunCredentials: async () => {
      rmSync(fixture.runCredentialPath, { force: true });
      return { remaining: existsSync(fixture.runCredentialPath) ? 1 : 0 };
    },
    returnLease: async (lease, receipt) => {
      expect(receipt).toEqual({ clean: true, reason: 'clean', observedResidue: 0 });
      const observedResidue = fixture.residue();
      expect(observedResidue).toEqual({ gitStatus: '', credentials: [], processes: [] });
      expect(liveChildPids()).toEqual([]);
      expect(fixture.remote.git(fixture.remote.checkout, ['rev-parse', 'HEAD'])).toBe(sourceSha);
      returned.push({ generation: lease.generation, observedResidue });
    },
    quarantine: async (_lease, receipt) => { quarantined.push(receipt.reason); },
    observe: () => {},
  };

  try {
    for (const generation of [1, 2]) {
      const runId = `round-${generation}`;
      const seeded = fixture.inject(runId);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      children.set(seeded.processId, child);
      const injected = fixture.residue();
      expect(injected.gitStatus).not.toBe('');
      expect(injected.credentials).toEqual([fixture.runCredentialPath]);
      expect(injected.processes).toEqual([seeded.processId]);
      expect(liveChildPids()).toHaveLength(1);

      expect(await cleanAndReturnChildPod({ ...workerLease, leaseId: `lease-${generation}`, generation,
        sourceSha }, operations)).toEqual({ outcome: 'returned', reason: 'clean' });
      expect(fixture.residue()).toEqual({ gitStatus: '', credentials: [], processes: [] });
      expect(liveChildPids()).toEqual([]);
    }

    expect(returned.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(returned.every(({ observedResidue }) => observedResidue.gitStatus === ''
      && observedResidue.credentials.length === 0 && observedResidue.processes.length === 0)).toBe(true);
    expect(quarantined).toEqual([]);
  } finally {
    for (const child of children.values()) await stopChild(child);
    fixture.cleanup();
  }
}, 30_000);
