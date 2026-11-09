import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { podSelfImplementSpawn } from '../task-orchestrator/surfaces/self-implement-pod.js';
import type { SiWarmChildAttempt } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { siWarmSha256, type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from '../task-orchestrator/surfaces/pod-si-warm-protocol.js';
import { postprocessSiWarmChild } from '../task-orchestrator/surfaces/pod-si-warm-host.js';
import { classifyPodTerminal } from '../self-dev/draft-residue.js';
import type { Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runWarmSiReuseSimulation } from './warm-si-reuse-sim.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { assertWarmPoolReuseSchedule, assertWorldLedgerMatchesDeclarations, createWorld, destroyWorld,
  runWarmPoolReuseWorldScenario, runWarmPoolUncertainExecution } from './world.js';

test('POD-REUSE-SIM-WORLD matches declared production rows one-to-one independent of order', () => {
  const declarations = [
    { expectedAt: 1_798_531_210_000, event: 'pod.reuse.return-decision', data: { outcome: 'returned' } },
    { expectedAt: 1_798_531_210_000, event: 'pod.reuse.return-decision', data: { outcome: 'returned', host: 'pool-a' } },
  ];
  const actual = [
    { runId: 'ledger-run', event: 'pod.reuse.return-decision', timestamp: new Date(1_798_531_210_000).toISOString(), data: { outcome: 'returned', host: 'pool-a' } },
    { runId: 'ledger-run', event: 'pod.reuse.return-decision', timestamp: new Date(1_798_531_210_000).toISOString(), data: { outcome: 'returned', host: 'pool-b' } },
  ];
  expect(() => assertWorldLedgerMatchesDeclarations(declarations, actual, 'ledger')).not.toThrow();
  expect(() => assertWorldLedgerMatchesDeclarations([...declarations, declarations[0]!], actual, 'ledger')).toThrow(/missing or ambiguous/);
  expect(() => assertWorldLedgerMatchesDeclarations(declarations, [...actual, { ...actual[0]!, timestamp: new Date(1_798_531_211_000).toISOString() }], 'ledger'))
    .toThrow(/undeclared production ledger row.*pod\.reuse\.return-decision@2026-12-29T08:00:11\.000Z/);
  const hostDeclarations = declarations.map((declaration, index) => ({ ...declaration, data: { host: index === 0 ? 'pool-a' : 'pool-b' } }));
  expect(() => assertWorldLedgerMatchesDeclarations(hostDeclarations, [actual[0]!, actual[0]!], 'ledger')).toThrow(/missing or ambiguous/);
});

test('POD-REUSE-SIM-WORLD rejects residue injection before scheduled recovery', () => {
  expect(() => assertWarmPoolReuseSchedule(10_000, 60_000, 90_000, 90_000, 120_000)).not.toThrow();
  expect(() => assertWarmPoolReuseSchedule(10_000, 60_000, 90_000, 90_000, 80_000)).toThrow(/inject residue after recovery/);
});

test('POD-REUSE-SIM-SI-CHAIN proves two fenced SI leases reuse one cleaned Pod UID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'si-chain-clean-'));
  try {
    const evidence = await runWarmSiReuseSimulation({ runId: 'si-chain-clean', stateRoot: root });
    expect(evidence.leaseGenerations).toEqual([1, 2]);
    expect(evidence.podUids).toEqual(['si-warm-pod-uid-1', 'si-warm-pod-uid-1']);
    expect(evidence.cleanupOutcomes).toEqual(['returned', 'returned']);
    expect(evidence.returnedChildProofs).toHaveLength(2);
    expect(evidence.ledgerRows.filter(row => row.event === 'pod.reuse.return-decision' && row.data.outcome === 'returned'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: 'si-chain-clean', data: expect.objectContaining({ childRunId: 'si-chain-clean-1', childAttemptId: 'attempt-1' }) }),
        expect.objectContaining({ runId: 'si-chain-clean', data: expect.objectContaining({ childRunId: 'si-chain-clean-2', childAttemptId: 'attempt-2' }) }),
      ]));
    expect(evidence.finalPodState).toBe('idle');
    expect(evidence.controlTransitions.filter(path => path.includes('/release:200'))).toHaveLength(2);
    expect(evidence.controlTransitions.filter(path => path.includes('/sanitize:200'))).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POD-REUSE-SIM-SI-CHAIN quarantines process residue before a second lease', async () => {
  const evidence = await runWarmSiReuseSimulation({ runId: 'si-chain-residue', processResidue: 1 });
  expect(evidence.leaseGenerations).toEqual([1]);
  expect(evidence.cleanupOutcomes).toEqual(['quarantined']);
  expect(evidence.retryAcquire).toBe('no-entry:busy');
  expect(evidence.finalPodState).toBe('quarantined');
  expect(evidence.controlTransitions.some(path => path.includes('/quarantine:200'))).toBe(true);
  expect(evidence.controlTransitions.some(path => path.includes('/sanitize:200'))).toBe(false);
});

test('POD-REUSE-ARTIFACT-CAP SI-CHAIN device rejects oversized runner artifact before host decoding', async () => {
  const evidence = await runWarmSiReuseSimulation({ runId: 'si-chain-artifact-cap', injectOversizedArtifact: true });
  expect(evidence.artifactCapRejected).toBe(true);
  expect(evidence.artifactDecodeCalls).toBe(0);
  expect(evidence.leaseGenerations).toEqual([1]);
  expect(evidence.cleanupOutcomes).toEqual(['quarantined']);
  expect(evidence.finalPodState).toBe('quarantined');
});

test('POD-REUSE-DEADLINE-PARITY production spawn reconciles a late warm terminal like a cold Job', async () => {
  // Mock only the SI worker/clock boundary. The production podSelfImplementSpawn → transport validation →
  // reconcile-only handling → host postprocess path classifies the returned terminal and quarantines the lease.
  const root = mkdtempSync(join(tmpdir(), 'warm-deadline-parity-'));
  const encoder = new TextEncoder();
  const payload = encoder.encode('{"feature":"deadline"}');
  const credentialBundle = encoder.encode('private fixture');
  let clock = 1_000;
  const now = () => clock;
  const command: SiWarmCommand = { protocol: 'si-v1', runId: 'run-warm-deadline', attemptId: 'attempt-warm-deadline',
    executionKey: 'a'.repeat(64), sourceSha: 'b'.repeat(40), leaseId: 'lease-deadline', generation: 1,
    workerId: 'worker-deadline', podUid: 'pod-deadline',
    key: { context: 'test-context', imageDigest: `sha256:${'c'.repeat(64)}`, lockHash: 'd'.repeat(64), architecture: 'amd64' },
    envProfile: 'si-standard-v1', deadlineAt: 2_000,
    payloadSha256: siWarmSha256(payload), credentialBundleSha256: siWarmSha256(credentialBundle) };
  const pod = { context: command.key.context, namespace: 'elanous-test', name: 'warm-deadline',
    podUid: command.podUid, workerId: command.workerId, sourceSha: command.sourceSha,
    imageDigest: command.key.imageDigest, lockHash: command.key.lockHash, architecture: command.key.architecture };
  let quarantineCount = 0;
  let adoptCount = 0;
  const classified: string[] = [];
  const attempt: SiWarmChildAttempt = { leaseFenced: true, command, payload, credentialBundle,
    transport: { pod, now, runner: { inspect: async () => pod,
      execute: async () => {
        const startedAt = now();
        clock = 2_001; // fake runner finishes after the production deadline boundary
        const bytes: SiWarmReturnedBytes = { terminal: encoder.encode('{"ok":false,"stage":"error"}'),
          ledger: encoder.encode('{"event":"deadline"}\\n'), log: encoder.encode(''), artifacts: [] };
        const reply: SiWarmReply = { protocol: 'si-v1', runId: command.runId, attemptId: command.attemptId,
          executionKey: command.executionKey, sourceSha: command.sourceSha, leaseId: command.leaseId,
          generation: command.generation, workerId: command.workerId, podUid: command.podUid, key: command.key,
          envProfile: command.envProfile, payloadSha256: command.payloadSha256,
          startedAt, finishedAt: now(), exitCode: 124,
          terminalSha256: siWarmSha256(bytes.terminal), ledgerSha256: siWarmSha256(bytes.ledger),
          logSha256: siWarmSha256(bytes.log), artifacts: [] };
        return { reply, bytes, cleanup: 'failed' as const };
      }, quarantine: async () => { quarantineCount++; return true; } } },
    cleanup: { stopChildProcesses: async () => ({ remaining: 0 }), git: async () => ({ status: 0, stdout: '' }),
      removeRunCredentials: async () => ({ remaining: 0 }), returnLease: async () => {},
      quarantine: async () => { quarantineCount++; }, observe: () => {} },
    quarantineUnknown: async () => { quarantineCount++; }, adopt: async () => { adoptCount++; } };
  const coldTerminal = classifyPodTerminal({ childRunId: 'cold-deadline-run', state: 'failed',
    disposition: { stage: 'deadline', ok: false }, at: new Date(2_001).toISOString() });
  try {
    const result = await podSelfImplementSpawn({
      kubectl: (() => ({ status: 1, stdout: '', stderr: 'unused by warm path' })) as unknown as Kubectl,
      credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_test' }),
      env: { ELANOUS_STATE_DIR: root }, pollMs: 1, sleep: async () => {},
      siWarmAttempt: async () => attempt,
      siWarmHostPostprocess: async (warmResult, warmAttempt, input) => postprocessSiWarmChild(
        input, warmResult, warmAttempt, {}, async terminal => { classified.push(terminal.terminalClass); }),
    })({ feature: 'fix it', spaceId: 'warm-deadline-parity' }).done;
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'si-warm-reconcile-only' },
      disposition: { ok: false, stage: 'error' } });
    expect(classified).toEqual([coldTerminal.terminalClass]);
    expect(coldTerminal.terminalClass).toBe('failed-no-pr');
    expect(adoptCount).toBe(0);
    expect(quarantineCount).toBeGreaterThanOrEqual(1);
    expect(clock).toBeGreaterThan(command.deadlineAt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POD-REUSE-SIM-WORLD runs clean reuse, scheduled residue quarantine, and gorilla recovery in one world', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-reuse-world-test-'));
  const previous = getTestStateRoot();
  const previousDebugFile = debug.isFileEnabled();
  setTestStateRoot(root);
  debug.setFileEnabled(false);
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(join(import.meta.dir, '../../scenarios/ux-sim/warm-pool-reuse-world.yaml'));
    const result = await runWarmPoolReuseWorldScenario(world);
    expect(result.pass).toBe(true);
    const worldRuntime = loadMockScenarioCatalog().devices.find(({ id }) => id === 'world-runtime');
    expect(worldRuntime?.logsRecorded).toBe('yes');
    expect(worldRuntime?.eventNames).toContain('pod.reuse/uncertain-exec-injected');
    expect(result.cleanReuse).toMatchObject({ leaseGenerations: [1, 2, 1], cleanupOutcomes: ['returned', 'quarantined', 'returned'],
      leaseHosts: ['pool-host-a', 'pool-host-a', 'pool-host-b'], recoveryHost: 'pool-host-b',
      leaseArchitectures: ['arm64', 'arm64', 'arm64'],
      podUids: ['si-warm-pod-uid-1', 'si-warm-pod-uid-1', 'si-warm-pod-uid-2'], finalPodState: 'idle' });
    expect(result.residueBeforeCleanup).toMatchObject({ credentials: [expect.any(String)], processes: ['child-pod-reuse-core-residue'] });
    expect(result.residueBeforeCleanup.gitStatus).toContain('README.md');
    expect(result.residueAfterCleanup).toMatchObject({ credentials: [], processes: ['child-pod-reuse-core-residue'] });
    expect(result.residueAfterCleanup.gitStatus).toBe(result.residueBeforeCleanup.gitStatus);
    expect(result.residueReuse).toMatchObject({ cleanupOutcomes: ['quarantined'], retryAcquire: 'no-entry:busy', finalPodState: 'quarantined' });
    expect(result.productionLedgerRows.map(({ event }) => event)).toContain('pod.reuse.clean-failed');
    expect(result.productionLedgerRows.some((row) => row.event === 'pod.reuse.return-decision' && row.data.outcome === 'quarantined')).toBe(true);
    expect(result.productionLedgerRows.some((row) => row.event === 'pod.reuse.return-decision'
      && row.data.outcome === 'returned' && row.timestamp === '2026-11-05T00:00:10.000Z')).toBe(true);
    expect(result.uncertainExecutions.map(({ fault, resultCode, coldJobStarts, providerQuarantines,
      cleanupQuarantines, adoptions, leaseReturns }) => [fault, resultCode, coldJobStarts,
      providerQuarantines, cleanupQuarantines, adoptions, leaseReturns])).toEqual([
      ['timeout', 'si-warm-reconcile-only', 0, 1, 0, 0, 0],
      ['connection-lost', 'si-warm-reconcile-only', 0, 1, 0, 0, 0],
      ['result-missing', 'si-warm-reconcile-only', 0, 0, 1, 0, 0],
      ['cleanup-unknown', 'si-warm-reconcile-only', 0, 0, 1, 0, 0],
    ]);
    expect(result.uncertainExecutions.find(({ fault }) => fault === 'cleanup-unknown')?.disposition)
      .toEqual({ stage: 'pr-opened', prNumber: 123 });
    expect(result.uncertainExecutions.every(({ ledgerEvents }) => ledgerEvents.includes('pod-reuse-quarantined'))).toBe(true);
    expect(result.uncertainEventMonkeyRows.map(({ event, data }) => [event, data.fault, data.injected, data.level]))
      .toEqual(['timeout', 'connection-lost', 'result-missing', 'cleanup-unknown'].map((fault) =>
        ['uncertain-exec-injected', fault, true, 'L0']));
    const timeoutRow = result.uncertainEventMonkeyRows.find(({ data }) => data.fault === 'timeout')!;
    const changedFaultExecution = await runWarmPoolUncertainExecution({ ...timeoutRow,
      data: { ...timeoutRow.data, fault: 'connection-lost' } }, `${timeoutRow.data.runId}-changed-fault`, world.root,
    () => Date.parse('2026-11-05T00:03:00.000Z'));
    expect(result.uncertainExecutions.find(({ fault }) => fault === 'timeout')?.resultMessage)
      .toBe('simulated SI exec timed out after dispatch');
    expect(changedFaultExecution).toMatchObject({ fault: 'connection-lost',
      resultCode: 'si-warm-reconcile-only', resultMessage: 'simulated SI exec connection lost after dispatch',
      coldJobStarts: 0, providerQuarantines: 1 });
    expect(result.recovery).toMatchObject({ evaluation: { pass: true, failures: [] }, injections: [
      { injectionId: 'inj-pod-reuse-core-1', ledgerRows: 0 }, { injectionId: 'inj-pod-reuse-core-2', ledgerRows: 0 },
      { injectionId: 'inj-pod-reuse-core-3', ledgerRows: 0 }, { injectionId: 'inj-pod-reuse-core-4', ledgerRows: 0 },
    ] });
    expect(result.recovery.timeline.map(({ kind, atMs }) => [kind, atMs])).toEqual([
      ['injection', 10_000], ['fault-start', 60_000], ['fault-recovery', 90_000], ['injection', 90_000], ['injection', 120_000],
      ['injection', 180_000],
    ]);
    expect(result.recovery.observations[0]?.recoveryVerdict).toContain('surviving host pool-b');
    expect(result.recovery.observations[0]?.recoveryVerdict).toContain('cloud leases lost=1');
    expect(result.cloudEvents.some((event) => event.type === 'vm-disappeared' && event.id === 'pod-reuse-core-pool-a-vm' && event.lostLeases === 1)).toBe(true);
    expect(result.cloudEvents.some((event) => event.type === 'create-from-image' && event.id === 'pod-reuse-core-pool-a-vm-replacement')).toBe(false);
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previous ?? null);
    debug.setFileEnabled(previousDebugFile);
    rmSync(root, { recursive: true, force: true });
  }
});
