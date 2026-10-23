import { expect, test } from 'bun:test';
import { podSelfImplementSpawn, type SiWarmChildAttempt } from './self-implement-pod.js';
import { siWarmSha256, type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from './pod-si-warm-protocol.js';
import type { ChildPodReuseOperations } from './pod-child-reuse.js';
import { debug } from '../../debug/log.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const payload = bytes('{"feature":"a"}');
const credentialBundle = bytes('private fixture');
const returned: SiWarmReturnedBytes = { terminal: bytes('{"ok":true,"stage":"pr-opened","prNumber":123}'),
  ledger: bytes('{"event":"done"}\n'), log: bytes('child done\n'), artifacts: [] };
const command: SiWarmCommand = { protocol: 'si-v1', runId: 'run-1', attemptId: 'attempt-1',
  executionKey: 'a'.repeat(64), sourceSha: 'b'.repeat(40), leaseId: 'lease-1', generation: 1,
  workerId: 'worker-1', podUid: 'uid-1', key: { context: 'node-b', imageDigest: `sha256:${'c'.repeat(64)}`,
    lockHash: 'd'.repeat(64), architecture: 'amd64' }, envProfile: 'si-standard-v1', deadlineAt: 2000,
  payloadSha256: siWarmSha256(payload), credentialBundleSha256: siWarmSha256(credentialBundle) };
const reply: SiWarmReply = { protocol: 'si-v1', runId: command.runId, attemptId: command.attemptId,
  executionKey: command.executionKey, sourceSha: command.sourceSha, leaseId: command.leaseId,
  generation: command.generation, workerId: command.workerId, podUid: command.podUid,
  key: command.key, envProfile: command.envProfile, payloadSha256: command.payloadSha256,
  startedAt: 1000, finishedAt: 1500, exitCode: 0,
  terminalSha256: siWarmSha256(returned.terminal), ledgerSha256: siWarmSha256(returned.ledger),
  logSha256: siWarmSha256(returned.log), artifacts: [] };

function setup() {
  const events: string[] = [];
  const ledgerEvents: string[] = [];
  const receipt: { reply: SiWarmReply | null; bytes: SiWarmReturnedBytes | null;
    cleanup: 'clean' | 'failed' | 'unknown' } = { reply, bytes: returned, cleanup: 'clean' };
  const returnedLeases: Array<{ podUid: string; leaseId: string; generation: number; sourceSha: string }> = [];
  const cleanup: ChildPodReuseOperations = {
    stopChildProcesses: async () => { events.push('stop'); return { remaining: 0 }; },
    git: async (_lease, argv) => { events.push(argv[0]!); return { status: 0, stdout: '' }; },
    removeRunCredentials: async () => { events.push('revoke'); return { remaining: 0 }; },
    returnLease: async (lease) => {
      events.push('return');
      returnedLeases.push({ podUid: lease.podUid, leaseId: lease.leaseId,
        generation: lease.generation, sourceSha: lease.sourceSha });
    },
    quarantine: async () => { events.push('quarantine'); },
    observe: (event) => { events.push(event); },
  };
  const attempt: SiWarmChildAttempt = { leaseFenced: true,
    command, payload, credentialBundle, cleanup,
    transport: { pod: { context: command.key.context, namespace: 'default', name: 'warm-1',
      podUid: command.podUid, workerId: command.workerId, sourceSha: command.sourceSha,
      imageDigest: command.key.imageDigest, lockHash: command.key.lockHash,
      architecture: command.key.architecture }, now: () => 0,
      runner: { inspect: async () => attempt.transport.pod,
        execute: async () => ({ reply: receipt.reply, bytes: receipt.bytes, cleanup: receipt.cleanup }),
        quarantine: async () => true } },
    quarantineUnknown: async () => { events.push('quarantine-unknown'); },
    adopt: async () => { events.push('adopt'); } };
  const kubectl = () => { throw new Error('cold Job must not be created after si-v1 exec'); };
  return { events, ledgerEvents, returnedLeases, attempt, receipt, kubectl };
}

test('a warm provider no-entry uses the existing cold Job path', async () => {
  let acquisitions = 0;
  let coldCalls = 0;
  const job = podSelfImplementSpawn({
    kubectl: () => { coldCalls++; throw new Error('cold path reached'); },
    siWarmAttempt: async () => { acquisitions++; return null; },
    siWarmHostPostprocess: async result => result,
  })({ feature: 'a', spaceId: 'no-warm-lease' });
  try { await job.done; } catch { /* The injected cold transport intentionally fails. */ }
  expect(acquisitions).toBe(1);
  expect(coldCalls).toBeGreaterThan(0);
});

test('two si-v1 children on one Pod are validated, adopted, cleaned, and returned', async () => {
  const f = setup();
  let available = true;
  let generation = 0;
  const acquire = async (): Promise<SiWarmChildAttempt> => {
    if (!available) throw new Error('mock lease already held');
    available = false;
    generation++;
    const sourceSha = generation === 1 ? command.sourceSha : 'e'.repeat(40);
    const nextCommand: SiWarmCommand = { ...command, runId: `run-${generation}`,
      attemptId: `attempt-${generation}`, leaseId: `lease-${generation}`, generation, sourceSha };
    f.attempt.command = nextCommand;
    f.receipt.reply = { ...reply, runId: nextCommand.runId, attemptId: nextCommand.attemptId,
      leaseId: nextCommand.leaseId, generation, sourceSha };
    f.attempt.transport.pod = { ...f.attempt.transport.pod, sourceSha };
    f.events.push('acquire');
    return f.attempt;
  };
  f.attempt.cleanup.returnLease = async (lease) => {
    f.events.push('return');
    f.returnedLeases.push({ podUid: lease.podUid, leaseId: lease.leaseId,
      generation: lease.generation, sourceSha: lease.sourceSha });
    available = true;
  };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl, siWarmAttempt: acquire,
    siWarmHostPostprocess: async result => result,
    siWarmLedger: entry => { f.ledgerEvents.push(entry.event); } });
  for (const spaceId of ['first', 'second']) {
    const result = await spawn({ feature: 'a', spaceId }).done;
    expect(result.exitCode).toBe(0);
    expect(result.disposition).toMatchObject({ stage: 'pr-opened', prNumber: 123 });
  }
  expect(f.events.filter(event => event === 'acquire' || event === 'return')).toEqual([
    'acquire', 'return', 'acquire', 'return',
  ]);
  expect(available).toBe(true);
  expect(f.events.filter(event => event === 'adopt')).toHaveLength(2);
  expect(f.events.filter(event => event === 'return')).toHaveLength(2);
  expect(f.events.filter(event => event === 'quarantine')).toHaveLength(0);
  expect(f.ledgerEvents.filter(event => event === 'pod-reuse-return-decision')).toHaveLength(4);
  expect(f.returnedLeases).toEqual([
    { podUid: command.podUid, leaseId: 'lease-1', generation: 1, sourceSha: command.sourceSha },
    { podUid: command.podUid, leaseId: 'lease-2', generation: 2, sourceSha: 'e'.repeat(40) },
  ]);
});

test('an uncertain response after exec is reconciled and quarantined without a duplicate Job', async () => {
  const f = setup();
  f.receipt.bytes = null;
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async result => result,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'uncertain' }).done;
  expect(result.error?.code).toBe('si-warm-reconcile-only');
  expect(f.events).toContain('stop');
  expect(f.events).toContain('revoke');
  expect(f.events).toContain('quarantine');
  expect(f.events).not.toContain('adopt');
  expect(f.events).not.toContain('return');
});

test('uncertain response with a failed retireLease quarantine records pod-reuse-quarantine-failed', async () => {
  const f = setup();
  f.receipt.bytes = null;
  f.attempt.cleanup.quarantine = async () => { throw new Error('quarantine unavailable'); };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'uncertain-quarantine-failed' }).done;
  expect(result.error).toMatchObject({ code: 'si-warm-worker-state-unknown' });
  const entry = f.ledgerEvents.find(item => item.startsWith('pod-reuse-quarantine-failed:'));
  expect(entry).toBeDefined();
  expect(entry).toContain('invalid-reply');
  expect(entry).toContain('quarantine:quarantine unavailable');
});

test('adopt failure with a failed retireLease quarantine records both causes in the ledger', async () => {
  const f = setup();
  f.attempt.adopt = async () => { throw new Error('collector unreachable'); };
  f.attempt.cleanup.quarantine = async () => { throw new Error('pool unreachable'); };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'adopt-quarantine-failed' }).done;
  expect(result.error).toMatchObject({ code: 'si-warm-worker-state-unknown', message: 'pool unreachable' });
  const entry = f.ledgerEvents.find(item => item.startsWith('pod-reuse-quarantine-failed:'));
  expect(entry).toBeDefined();
  expect(entry).toContain('adopt-failed');
  expect(entry).toContain('quarantine:pool unreachable');
});

test('ledger write failure during pod-reuse-quarantine-failed is fail-soft', async () => {
  const f = setup();
  f.receipt.bytes = null;
  f.attempt.cleanup.quarantine = async () => { throw new Error('quarantine unavailable'); };
  const observed: Array<{ event: string; data?: unknown }> = [];
  const originalLog = debug.log.bind(debug);
  debug.log = (_category: string, event: string, data?: unknown) => { observed.push({ event, data }); };
  try {
    const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
      siWarmLedger: entry => {
        f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`);
        if (entry.event === 'pod-reuse-quarantine-failed') { throw new Error('ledger unavailable'); }
      },
      siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
    const result = await spawn({ feature: 'a', spaceId: 'ledger-fail-soft' }).done;
    expect(result.error).toMatchObject({ code: 'si-warm-worker-state-unknown' });
    expect(observed.some(entry => entry.event === 'ledger-unavailable')).toBe(true);
  } finally { debug.log = originalLog; }
});

test('quarantine receipt carries observed process residue after an uncertain exec', async () => {
  const f = setup();
  f.receipt.bytes = null;
  f.attempt.cleanup.stopChildProcesses = async () => ({ remaining: 2 });
  let receipt: { observedResidue: number | null } | undefined;
  f.attempt.cleanup.quarantine = async (_lease, value) => { receipt = value; };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async done => done,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'residue' }).done;
  expect(result.error?.code).toBe('si-warm-reconcile-only');
  expect(receipt?.observedResidue).toBe(2);
});

test('transport quarantine failure surfaces worker-state-unknown with its cause', async () => {
  const f = setup();
  f.receipt.bytes = null;
  f.attempt.transport.runner.quarantine = async () => { throw new Error('fence store unavailable'); };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async done => done,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'transport-quarantine' }).done;
  expect(result.error?.code).toBe('si-warm-worker-state-unknown');
  expect(result.error?.message).toContain('fence store unavailable');
});

test('verified PR disposition survives uncertain in-Pod cleanup for reconciliation', async () => {
  const f = setup();
  f.receipt.cleanup = 'failed';
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async done => done,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'cleanup-failed' }).done;
  expect(result.error?.code).toBe('si-warm-reconcile-only');
  expect(result.disposition).toMatchObject({ stage: 'pr-opened', prNumber: 123 });
  expect(f.events).not.toContain('adopt');
  expect(f.events).not.toContain('return');
});

test('an unreadable self disposition quarantines before artifact adoption or return', async () => {
  const f = setup();
  const malformed = bytes('{"kind":"self","ok":true,"stage":"pr-opened","result":null}');
  f.receipt.bytes = { ...returned, terminal: malformed };
  f.receipt.reply = { ...reply, terminalSha256: siWarmSha256(malformed) };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async result => result,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'bad-terminal' }).done;
  expect(result.error?.code).toBe('si-warm-terminal-unreadable');
  expect(f.events).toContain('quarantine');
  expect(f.events).not.toContain('adopt');
  expect(f.events).not.toContain('return');
});

test('cleanAndReturnChildPod throw followed by a successful explicit quarantine settles as quarantined', async () => {
  const f = setup();
  f.attempt.cleanup.git = async () => ({ status: 1, stdout: '' });
  f.attempt.cleanup.quarantine = async () => { throw new Error('pool unreachable'); };
  f.attempt.quarantineUnknown = async reason => { f.events.push(`quarantine-unknown:${reason}`); };
  const observed: Array<{ event: string; data?: unknown }> = [];
  const originalLog = debug.log.bind(debug);
  debug.log = (_category: string, event: string, data?: unknown) => { observed.push({ event, data }); };
  try {
    const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
      siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`); },
      siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
    const result = await spawn({ feature: 'a', spaceId: 'return-threw-quarantined' }).done;
    expect(result.error?.code).not.toBe('si-warm-worker-state-unknown');
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.disposition).toMatchObject({ stage: 'pr-opened', prNumber: 123 });
    expect(f.events.some(event => event.startsWith('quarantine-unknown:return-quarantine-unavailable:'))).toBe(true);
    expect(f.ledgerEvents.some(entry => entry.startsWith('pod-reuse-quarantined:'))).toBe(true);
    const childResult = observed.find(entry => entry.event === 'child-result');
    expect((childResult?.data as { returnOutcome?: string } | undefined)?.returnOutcome).toBe('quarantined');
    // The settled quarantine must not re-enter the not-entered cold fallback.
    expect(f.events.filter(event => event === 'cold-kubectl' || event === 'return')).toHaveLength(0);
  } finally { debug.log = originalLog; }
});

test('quarantine failure after an uncertain exec is reported as unknown worker state', async () => {
  const f = setup();
  f.receipt.bytes = null;
  f.attempt.cleanup.quarantine = async () => { throw new Error('quarantine unavailable'); };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async result => result,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'unknown-worker' }).done;
  expect(result.error?.code).toBe('si-warm-worker-state-unknown');
  expect(result.error?.message).toContain('quarantine unavailable');
  expect(f.events).not.toContain('return');
});

test('an adopt failure keeps the measured PR disposition for reconciliation', async () => {
  const f = setup();
  f.attempt.adopt = async () => { throw new Error('collector unavailable'); };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmHostPostprocess: async result => result,
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'adopt-failed' }).done;
  expect(result.error?.code).toBe('si-warm-reconcile-only');
  expect(result.disposition).toMatchObject({ stage: 'pr-opened', prNumber: 123 });
  expect(f.events).toContain('quarantine');
  expect(f.events).not.toContain('return');
});

test('warm execution refuses to start without cold-path host postprocess parity', () => {
  const f = setup();
  expect(() => podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmAttempt: async () => f.attempt })({ feature: 'a', spaceId: 'no-postprocess' }))
    .toThrow('cold-path host postprocess parity');
  expect(f.events).toEqual([]);
});

test('warm disposition removes Pod-only worktreePath before host postprocess', async () => {
  const f = setup();
  const terminal = bytes('{"ok":true,"stage":"pr-opened","prNumber":123,"worktreePath":"/workspace/repo/child"}');
  f.receipt.bytes = { ...returned, terminal };
  f.receipt.reply = { ...reply, terminalSha256: siWarmSha256(terminal) };
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmAttempt: async () => f.attempt,
    siWarmHostPostprocess: async done => {
      expect(done.disposition?.worktreePath).toBeUndefined();
      return done;
    } })({ feature: 'a', spaceId: 'pod-path' }).done;
  expect(result.disposition?.worktreePath).toBeUndefined();
});

test('host postprocess failure keeps the measured PR for reconciliation', async () => {
  const f = setup();
  const result = await podSelfImplementSpawn({ kubectl: f.kubectl, siWarmLedger: () => {},
    siWarmAttempt: async () => f.attempt,
    siWarmHostPostprocess: async () => { throw new Error('host regate unavailable'); } })
    ({ feature: 'a', spaceId: 'host-postprocess-failed' }).done;
  expect(result.error).toMatchObject({ code: 'si-warm-host-postprocess-failed' });
  expect(result.disposition).toMatchObject({ stage: 'pr-opened', prNumber: 123 });
});

test('not-entered cold fallback verifies pinned-source git cleanup before returning the lease clean', async () => {
  const f = setup();
  const kubectl = () => { f.events.push('cold-kubectl'); throw new Error('cold spawn ends the probe'); };
  // A stale Pod identity (not a source mismatch) keeps the request not-entered.
  f.attempt.transport.pod = { ...f.attempt.transport.pod, podUid: 'stale-pod-uid' };
  const gitArgv: Record<string, string[]> = {};
  f.attempt.cleanup.git = async (_lease, argv) => {
    f.events.push(argv[0]!);
    gitArgv[argv[0]!] = [...argv];
    return { status: 0, stdout: '' };
  };
  let receipt: { clean: boolean; reason: string; observedResidue: number | null } | undefined;
  f.attempt.cleanup.returnLease = async (_lease, value) => { receipt = value; f.events.push('return'); };
  const spawn = podSelfImplementSpawn({ kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { action?: string }).action ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  await spawn({ feature: 'a', spaceId: 'cold-fallback' }).done.catch(() => null);
  expect(f.events).toContain('stop');
  expect(f.events).toContain('revoke');
  // reset -> clean -> status at the pinned sourceSha precede the clean return.
  expect(f.events.indexOf('reset')).toBeGreaterThanOrEqual(0);
  expect(f.events.indexOf('clean')).toBeGreaterThan(f.events.indexOf('reset'));
  expect(f.events.indexOf('status')).toBeGreaterThan(f.events.indexOf('clean'));
  expect(f.events.indexOf('return')).toBeGreaterThan(f.events.indexOf('status'));
  expect(gitArgv.reset).toContain(command.sourceSha);
  expect(f.events.indexOf('return')).toBeLessThan(f.events.indexOf('cold-kubectl'));
  expect(receipt).toMatchObject({ clean: true, reason: 'clean', observedResidue: 0 });
  expect(f.ledgerEvents).toContain('pod-reuse-cold-fallback-dispose:returned');
  expect(f.events).not.toContain('quarantine');
});

test('not-entered cold fallback quarantines a dirty pinned-source worktree instead of returning it clean', async () => {
  const f = setup();
  const kubectl = () => { f.events.push('cold-kubectl'); throw new Error('cold spawn ends the probe'); };
  f.attempt.transport.pod = { ...f.attempt.transport.pod, podUid: 'stale-pod-uid' };
  f.attempt.cleanup.git = async (_lease, argv) => {
    f.events.push(argv[0]!);
    return argv[0] === 'status' ? { status: 0, stdout: 'M  src/lib.ts\0' } : { status: 0, stdout: '' };
  };
  const quarantines: Array<{ clean: boolean; reason: string; observedResidue: number | null }> = [];
  f.attempt.cleanup.quarantine = async (_lease, value) => { f.events.push('quarantine'); quarantines.push(value); };
  const spawn = podSelfImplementSpawn({ kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { action?: string }).action ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  await spawn({ feature: 'a', spaceId: 'cold-dirty' }).done.catch(() => null);
  expect(f.events).not.toContain('return');
  expect(f.returnedLeases).toHaveLength(0);
  expect(quarantines).toHaveLength(1);
  expect(quarantines[0]).toMatchObject({ clean: false, reason: 'worktree-not-clean' });
  expect(f.events.indexOf('status')).toBeGreaterThan(f.events.indexOf('reset'));
  expect(f.events.indexOf('quarantine')).toBeGreaterThan(f.events.indexOf('status'));
  // The cold Job may start only after the disposal itself succeeded.
  expect(f.events.indexOf('cold-kubectl')).toBeGreaterThan(f.events.indexOf('quarantine'));
  expect(f.ledgerEvents).toContain('pod-reuse-cold-fallback-dispose:quarantined');
  expect(f.ledgerEvents).not.toContain('pod-reuse-cold-fallback-dispose:returned');
});

test('not-entered cold fallback treats an unmeasurable process count as unknown, not zero', async () => {
  const f = setup();
  const kubectl = () => { f.events.push('cold-kubectl'); throw new Error('cold spawn ends the probe'); };
  f.attempt.transport.pod = { ...f.attempt.transport.pod, podUid: 'stale-pod-uid' };
  f.attempt.cleanup.stopChildProcesses = async () => { f.events.push('stop'); return { remaining: Number.NaN }; };
  const quarantines: Array<{ clean: boolean; reason: string; observedResidue: number | null }> = [];
  f.attempt.cleanup.quarantine = async (_lease, value) => { f.events.push('quarantine'); quarantines.push(value); };
  const spawn = podSelfImplementSpawn({ kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { action?: string }).action ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  await spawn({ feature: 'a', spaceId: 'cold-unmeasured' }).done.catch(() => null);
  expect(f.events).not.toContain('return');
  expect(f.returnedLeases).toHaveLength(0);
  expect(quarantines).toHaveLength(1);
  expect(quarantines[0]).toMatchObject({ clean: false, reason: 'child-processes-remain' });
  expect(f.ledgerEvents).toContain('pod-reuse-cold-fallback-dispose:quarantined');
  expect(f.ledgerEvents).not.toContain('pod-reuse-cold-fallback-dispose:returned');
  expect(f.events.indexOf('cold-kubectl')).toBeGreaterThan(f.events.indexOf('quarantine'));
});

test('cold fallback disposal failure refuses to start the cold Job and preserves both errors', async () => {
  const f = setup();
  const kubectl = () => { f.events.push('cold-kubectl'); throw new Error('cold job must not start'); };
  f.attempt.transport.pod = { ...f.attempt.transport.pod, sourceSha: 'f'.repeat(40) };
  f.attempt.cleanup.stopChildProcesses = async () => { throw new Error('pod exec unavailable'); };
  f.attempt.cleanup.quarantine = async () => { throw new Error('pool unreachable'); };
  const spawn = podSelfImplementSpawn({ kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { action?: string }).action ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'cold-dispose-failed' }).done;
  expect(result.error?.code).toBe('si-warm-worker-state-unknown');
  expect(result.error?.message).toContain('disposal:pool unreachable');
  expect(result.error?.message).toContain('quarantine:pool unreachable');
  expect(f.events).not.toContain('cold-kubectl');
  expect(f.ledgerEvents).toContain('pod-reuse-cold-fallback-dispose-failed:quarantine-failed');
});

test('cleanAndReturnChildPod throw quarantines explicitly and preserves both errors with ledger judgement', async () => {
  const f = setup();
  f.attempt.cleanup.git = async () => ({ status: 1, stdout: '' });
  f.attempt.cleanup.quarantine = async () => { throw new Error('pool unreachable'); };
  f.attempt.quarantineUnknown = async reason => {
    f.events.push(`quarantine-unknown:${reason}`);
    throw new Error('fence store down');
  };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'return-threw' }).done;
  expect(result.error?.code).toBe('si-warm-worker-state-unknown');
  expect(result.error?.message).toContain('return:pool unreachable');
  expect(result.error?.message).toContain('quarantine:fence store down');
  expect(f.events.some(event => event.startsWith('quarantine-unknown:return-quarantine-unavailable:'))).toBe(true);
  expect(f.ledgerEvents.some(entry => entry.startsWith('pod-reuse-quarantine-failed:')
    && entry.includes('return:pool unreachable') && entry.includes('quarantine:fence store down'))).toBe(true);
});

test('a transport exception followed by quarantineUnknown failure preserves both errors and records the judgement', async () => {
  const f = setup();
  f.attempt.transport.runner.execute = async () => { throw new Error('exec stream severed'); };
  f.attempt.quarantineUnknown = async () => { f.events.push('quarantine-unknown'); throw new Error('fence store down'); };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
    siWarmLedger: entry => { f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`); },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'double-failure' }).done;
  expect(result.error?.code).toBe('si-warm-worker-state-unknown');
  expect(result.error?.message).toContain('exec stream severed');
  expect(result.error?.message).toContain('fence store down');
  expect(f.events).toContain('quarantine-unknown');
  expect(f.events).not.toContain('return');
  expect(f.ledgerEvents.some(entry => entry.startsWith('pod-reuse-quarantine-failed:')
    && entry.includes('transport:exec stream severed') && entry.includes('quarantine:fence store down'))).toBe(true);
  expect(f.ledgerEvents).not.toContain('pod-reuse-quarantined:transport-exception');
});

test('a transport exception with a confirmed quarantineUnknown records pod-reuse-quarantined once, in order, without a cold Job', async () => {
  const f = setup();
  f.attempt.transport.runner.execute = async () => { throw new Error('exec stream severed'); };
  const order: string[] = [];
  f.attempt.quarantineUnknown = async () => { f.events.push('quarantine-unknown'); order.push('quarantine-unknown'); };
  const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
    siWarmLedger: entry => {
      f.ledgerEvents.push(`${entry.event}:${String((entry.data as { reason?: string }).reason ?? '')}`);
      if (entry.event === 'pod-reuse-quarantined') {
        order.push('ledger-quarantined');
        expect(entry.data).toMatchObject({ spaceId: 'transport-quarantined', workerId: command.workerId,
          leaseId: command.leaseId, reason: 'transport-exception' });
      }
    },
    siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
  const result = await spawn({ feature: 'a', spaceId: 'transport-quarantined' }).done;
  expect(result.error?.code).toBe('si-warm-reconcile-only');
  expect(result.error?.message).toContain('exec stream severed');
  // Exactly one confirmed quarantine and exactly one durable ledger row, confirmed first.
  expect(f.events.filter(event => event === 'quarantine-unknown')).toHaveLength(1);
  expect(f.ledgerEvents.filter(event => event === 'pod-reuse-quarantined:transport-exception')).toHaveLength(1);
  expect(order).toEqual(['quarantine-unknown', 'ledger-quarantined']);
  expect(f.events).not.toContain('return');
  expect(f.events).not.toContain('cold-kubectl');
});

test('a ledger write throw after a confirmed transport-exception quarantine keeps reconcile-only (fail-soft)', async () => {
  const f = setup();
  f.attempt.transport.runner.execute = async () => { throw new Error('exec stream severed'); };
  f.attempt.quarantineUnknown = async () => { f.events.push('quarantine-unknown'); };
  const observed: Array<{ event: string; data?: unknown }> = [];
  const originalLog = debug.log.bind(debug);
  debug.log = (_category: string, event: string, data?: unknown) => { observed.push({ event, data }); };
  try {
    const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
      siWarmLedger: entry => {
        if (entry.event === 'pod-reuse-quarantined') throw new Error('warm ledger store unavailable');
        f.ledgerEvents.push(entry.event);
      },
      siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
    const result = await spawn({ feature: 'a', spaceId: 'transport-ledger-threw' }).done;
    expect(result.error?.code).toBe('si-warm-reconcile-only');
    expect(result.error?.message).toContain('exec stream severed');
    expect(f.events.filter(event => event === 'quarantine-unknown')).toHaveLength(1);
    expect(f.ledgerEvents).not.toContain('pod-reuse-quarantined');
    expect(observed.some(entry => entry.event === 'ledger-unavailable'
      && (entry.data as { event?: string }).event === 'pod-reuse-quarantined')).toBe(true);
    expect(f.events).not.toContain('return');
    expect(f.events).not.toContain('cold-kubectl');
  } finally { debug.log = originalLog; }
});

test('siWarmLedger write failure after a successful returnLease preserves the returned disposition and logs ledger-unavailable', async () => {
  const f = setup();
  const observed: Array<{ event: string; data?: unknown }> = [];
  const originalLog = debug.log.bind(debug);
  debug.log = (_category: string, event: string, data?: unknown) => { observed.push({ event, data }); };
  try {
    const spawn = podSelfImplementSpawn({ kubectl: f.kubectl,
      siWarmLedger: entry => {
        f.ledgerEvents.push(entry.event);
        if (entry.event === 'pod-reuse-return-decision'
          && (entry.data as { outcome?: string }).outcome === 'returned') throw new Error('warm ledger store unavailable');
      },
      siWarmHostPostprocess: async result => result, siWarmAttempt: async () => f.attempt });
    const result = await spawn({ feature: 'a', spaceId: 'ledger-after-return' }).done;
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(f.events.filter(event => event === 'return')).toHaveLength(1);
    expect(f.returnedLeases).toHaveLength(1);
    expect(f.events.filter(event => event === 'quarantine-unknown')).toHaveLength(0);
    expect(f.events.filter(event => event === 'quarantine')).toHaveLength(0);
    const childResult = observed.find(entry => entry.event === 'child-result');
    expect((childResult?.data as { returnOutcome?: string } | undefined)?.returnOutcome).toBe('returned');
    const unavailable = observed.filter(entry => entry.event === 'ledger-unavailable');
    expect(unavailable).toHaveLength(1);
    expect((unavailable[0]?.data as { runId?: string; event?: string })).toMatchObject({ runId: 'run-1', event: 'pod-reuse-return-decision' });
  } finally { debug.log = originalLog; }
});
