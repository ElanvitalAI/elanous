import { describe, expect, test } from 'bun:test';
import { siWarmSha256, type SiWarmCommand } from './pod-si-warm-protocol.js';
import { encodeSiWarmPrivateStdin, executeSiWarmTransport,
  type SiWarmFixedRunner, type SiWarmPodIdentity } from './pod-si-warm-transport.js';

const payload = new TextEncoder().encode('{"goal":"private"}');
const credentials = new TextEncoder().encode('secret-token');
const terminal = new TextEncoder().encode('{"ok":true,"stage":"complete"}');
const ledger = new TextEncoder().encode('{"event":"complete"}\n');
const log = new TextEncoder().encode('done\n');
const command: SiWarmCommand = {
  protocol: 'si-v1', runId: 'run-1', attemptId: 'attempt-1', executionKey: 'a'.repeat(64),
  sourceSha: 'b'.repeat(40), leaseId: 'lease-1', generation: 3, workerId: 'worker-1',
  podUid: 'pod-uid-1', key: { context: 'pool-1', imageDigest: `sha256:${'c'.repeat(64)}`,
    lockHash: 'd'.repeat(64), architecture: 'amd64' }, envProfile: 'si-standard-v1',
  deadlineAt: 20_000, payloadSha256: siWarmSha256(payload),
  credentialBundleSha256: siWarmSha256(credentials),
};
const pod: SiWarmPodIdentity = { context: command.key.context, namespace: 'default', name: 'warm-1',
  podUid: command.podUid, workerId: command.workerId, sourceSha: command.sourceSha,
  imageDigest: command.key.imageDigest, lockHash: command.key.lockHash,
  architecture: command.key.architecture };
const reply = { protocol: 'si-v1', runId: command.runId, attemptId: command.attemptId,
  executionKey: command.executionKey, sourceSha: command.sourceSha, leaseId: command.leaseId,
  generation: command.generation, workerId: command.workerId, podUid: command.podUid,
  key: command.key, envProfile: command.envProfile, payloadSha256: command.payloadSha256,
  startedAt: 1000, finishedAt: 2000, exitCode: 0,
  terminalSha256: siWarmSha256(terminal), ledgerSha256: siWarmSha256(ledger),
  logSha256: siWarmSha256(log), artifacts: [] };
const bytes = { terminal, ledger, log, artifacts: [] };
const input = { command, pod, leaseFenced: true, payload, credentialBundle: credentials,
  now: () => 0 };

describe('si-v1 warm transport boundary', () => {
  test('the current image fails before entry without a fixed si-task runner', async () => {
    const result = await executeSiWarmTransport(input);
    expect(result).toMatchObject({ boundary: 'not-entered', reason: 'runner-unavailable',
      measured: false, quarantineWorker: false });
  });

  test('rejects stale lease, Pod identity and secret digest before calling exec', async () => {
    let calls = 0;
    const runner: SiWarmFixedRunner = { inspect: async () => pod,
      execute: async () => { calls++; throw new Error(); },
      quarantine: async () => true };
    const unfenced = await executeSiWarmTransport({ ...input, runner, leaseFenced: false });
    expect(unfenced).toMatchObject({ boundary: 'not-entered', reason: 'lease-unfenced',
      measured: false, quarantineWorker: true, quarantineRecorded: false });
    expect((await executeSiWarmTransport({ ...input, runner,
      pod: { ...pod, imageDigest: `sha256:${'e'.repeat(64)}` } })).reason).toBe('pod-identity');
    expect((await executeSiWarmTransport({ ...input, runner,
      credentialBundle: new TextEncoder().encode('wrong') })).reason).toBe('invalid-command');
    expect((await executeSiWarmTransport({ ...input, runner: { ...runner,
      inspect: async () => ({ ...pod, podUid: 'replaced' }) } })).reason).toBe('pod-identity');
    expect(calls).toBe(0);
  });

  test('passes private bytes on stdin with fixed argv and adopts verified bytes', async () => {
    const runner: SiWarmFixedRunner = {
      inspect: async () => pod,
      execute: async (argv, stdin, budget) => {
        expect(argv.slice(-3)).toEqual(['--', 'bun',
          '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts']);
        expect(argv.join(' ')).not.toContain('secret-token');
        expect(argv.join(' ')).not.toContain('private');
        expect(stdin).toEqual(encodeSiWarmPrivateStdin(command, payload, credentials));
        expect(budget).toBe(20_000);
        return { reply, bytes, cleanup: 'clean' };
      }, quarantine: async () => { throw new Error('should not quarantine'); },
    };
    const result = await executeSiWarmTransport({ ...input, runner });
    expect(result).toMatchObject({ boundary: 'exec-attempted', reason: 'match', measured: true,
      quarantineWorker: false, reply });
    expect(result.bytes).toBe(bytes);
  });

  test('exec keeps the admitted child deadline beyond thirty minutes', async () => {
    const longer = { ...command, deadlineAt: 7_200_000 };
    let budget = 0;
    const runner: SiWarmFixedRunner = { inspect: async () => pod,
      execute: async (_argv, _stdin, ms) => { budget = ms; return { reply, bytes, cleanup: 'clean' }; },
      quarantine: async () => true };
    const result = await executeSiWarmTransport({ ...input, command: longer, runner });
    expect(budget).toBe(7_200_000);
    expect(result.reason).toBe('match');
  });

  test('lost response, wrong artifact hash and uncertain cleanup require quarantine', async () => {
    for (const receipt of [
      { reply: null, bytes: null, cleanup: 'unknown' as const },
      { reply, bytes: { ...bytes, log: new TextEncoder().encode('tampered') }, cleanup: 'clean' as const },
      { reply, bytes, cleanup: 'failed' as const },
    ]) {
      let quarantineCalls = 0;
      const runner: SiWarmFixedRunner = { inspect: async () => pod, execute: async () => receipt,
        quarantine: async () => { quarantineCalls++; return true; } };
      const result = await executeSiWarmTransport({ ...input, runner });
      expect(result).toMatchObject({ boundary: 'exec-attempted', measured: false,
        quarantineWorker: true, quarantineRecorded: true, reply: null, bytes: null });
      expect(quarantineCalls).toBe(1);
    }
  });
});
