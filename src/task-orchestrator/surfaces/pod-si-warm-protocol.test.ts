import { expect, test } from 'bun:test';
import { assessSiWarmReply, decideSiWarmNextStep, parseSiWarmCommand, parseSiWarmReply,
  siWarmSha256, type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes } from './pod-si-warm-protocol.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const payload = bytes('{"feature":"change the code"}');
const credentialBundle = bytes('private credential fixture');
const returned: SiWarmReturnedBytes = {
  terminal: bytes('{"ok":true,"stage":"pr-opened","prNumber":123}'),
  ledger: bytes('{"event":"start"}\n'),
  log: bytes('child completed\n'),
  artifacts: [{ path: 'pod-logs/logs.jsonl', bytes: bytes('{"event":"done"}\n') }],
};
const command: SiWarmCommand = {
  protocol: 'si-v1', runId: 'run-1', attemptId: 'attempt-1', executionKey: 'a'.repeat(64),
  sourceSha: 'b'.repeat(40), leaseId: 'lease-1', generation: 3, workerId: 'worker-1',
  podUid: '0a1b2c3d-0000-4000-8000-aabbccddeeff',
  key: { context: 'node-b', imageDigest: `sha256:${'c'.repeat(64)}`,
    lockHash: 'd'.repeat(64), architecture: 'amd64' },
  envProfile: 'si-standard-v1', deadlineAt: 2000,
  payloadSha256: siWarmSha256(payload), credentialBundleSha256: siWarmSha256(credentialBundle),
};
const reply: SiWarmReply = {
  protocol: 'si-v1', runId: command.runId, attemptId: command.attemptId,
  executionKey: command.executionKey, sourceSha: command.sourceSha,
  leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
  podUid: command.podUid, key: command.key, envProfile: command.envProfile,
  payloadSha256: command.payloadSha256, startedAt: 1000, finishedAt: 1500, exitCode: 0,
  terminalSha256: siWarmSha256(returned.terminal), ledgerSha256: siWarmSha256(returned.ledger),
  logSha256: siWarmSha256(returned.log),
  artifacts: returned.artifacts.map(item => ({ path: item.path, sha256: siWarmSha256(item.bytes), bytes: item.bytes.byteLength })),
};
const assess = (candidate: unknown = reply, output: SiWarmReturnedBytes | null = returned,
  request: unknown = command, input = payload, secrets = credentialBundle) =>
  assessSiWarmReply(request, candidate, output, input, secrets);

test('si-v1 accepts exact source, lease, Pod, payload, terminal and artifact bytes', () => {
  expect(parseSiWarmCommand(command)).toEqual(command);
  expect(parseSiWarmReply(reply)).toEqual(reply);
  expect(assess()).toEqual({ reason: 'match', measured: true, quarantineWorker: false });
  expect(decideSiWarmNextStep({ boundary: 'exec-attempted', leaseFenced: false, validation: assess() }))
    .toEqual({ next: 'reconcile-only', quarantineWorker: true });
  expect(JSON.stringify(reply)).not.toContain('private credential fixture');
  expect(JSON.stringify(command)).not.toContain('private credential fixture');
  expect(Object.hasOwn(reply, 'credentialBundleSha256')).toBe(false);
});

test('a failed but complete child is measured and cannot trigger a duplicate Job', () => {
  const failed = { ...returned, terminal: bytes('{"ok":false,"stage":"review-blocked"}') };
  const failedReply = { ...reply, exitCode: 1, terminalSha256: siWarmSha256(failed.terminal) };
  const validation = assess(failedReply, failed);
  expect(validation).toEqual({ reason: 'match', measured: true, quarantineWorker: false });
  expect(decideSiWarmNextStep({ boundary: 'exec-attempted', leaseFenced: true, validation }))
    .toEqual({ next: 'adopt-warm', quarantineWorker: false });
});

test('stale source, lease, generation, Pod UID, image or payload cannot be adopted', () => {
  for (const candidate of [
    { ...reply, sourceSha: 'e'.repeat(40) },
    { ...reply, leaseId: 'lease-old' },
    { ...reply, generation: 2 },
    { ...reply, podUid: 'different-pod' },
    { ...reply, key: { ...reply.key, imageDigest: `sha256:${'f'.repeat(64)}` } },
    { ...reply, payloadSha256: 'f'.repeat(64) },
  ]) expect(assess(candidate)).toEqual({ reason: 'identity', measured: false, quarantineWorker: true });
  expect(assess(reply, returned, command, bytes('changed payload')).reason).toBe('invalid-command');
  expect(assess(reply, returned, command, payload, bytes('different credentials')).reason).toBe('invalid-command');
  expect(assess(reply, returned, { ...command, sourceSha: 'not-a-sha' }).reason).toBe('invalid-command');
});

test('unknown wire fields, especially credential text, fail closed', () => {
  expect(parseSiWarmReply({ ...reply, credential: 'private credential fixture' })).toBeNull();
  expect(parseSiWarmCommand({ ...command, credential: 'private credential fixture' })).toBeNull();
  expect(parseSiWarmReply({ ...reply, artifacts: [{ ...reply.artifacts[0], raw: 'secret' }] })).toBeNull();
  expect(parseSiWarmReply({ ...reply, artifacts: [{ ...reply.artifacts[0], path: '../escape' }] })).toBeNull();
  expect(parseSiWarmReply({ ...reply, artifacts: [{ ...reply.artifacts[0], path: '..' }] })).toBeNull();
});

test('missing or changed terminal, ledger, log and artifacts never become success', () => {
  expect(assess(reply, null).reason).toBe('missing-output');
  expect(assess(reply, { ...returned, terminal: bytes('{"ok":true,"stage":"merged"}') }).reason).toBe('output-hash');
  expect(assess(reply, { ...returned, ledger: bytes('') }).reason).toBe('missing-output');
  expect(assess(reply, { ...returned, log: bytes('changed') }).reason).toBe('output-hash');
  expect(assess(reply, { ...returned, artifacts: [] }).reason).toBe('missing-output');
  expect(assess(reply, { ...returned, artifacts: [{ ...returned.artifacts[0]!, bytes: bytes('changed') }] }).reason)
    .toBe('output-hash');
  expect(assess({ ...reply, artifacts: [reply.artifacts[0]!, reply.artifacts[0]!] },
    { ...returned, artifacts: [returned.artifacts[0]!, returned.artifacts[0]!] }).reason).toBe('invalid-reply');
});

test('a hashed but malformed terminal is still rejected', () => {
  const output = { ...returned, terminal: bytes('{"ok":"true","stage":"merged"}') };
  expect(assess({ ...reply, terminalSha256: siWarmSha256(output.terminal) }, output).reason).toBe('terminal');
});

test('deadline and missing reply are unknown after exec and require reconciliation', () => {
  expect(assess({ ...reply, finishedAt: command.deadlineAt }).reason).toBe('expired');
  const missing = assess(null);
  expect(missing.reason).toBe('invalid-reply');
  expect(decideSiWarmNextStep({ boundary: 'exec-attempted', leaseFenced: true, validation: missing }))
    .toEqual({ next: 'reconcile-only', quarantineWorker: true });
  expect(decideSiWarmNextStep({ boundary: 'exec-attempted', leaseFenced: false }))
    .toEqual({ next: 'reconcile-only', quarantineWorker: true });
});

test('a command whose deadline is not a usable future instant fails closed at the wire', () => {
  expect(parseSiWarmCommand({ ...command, deadlineAt: 0 })).toBeNull();
  expect(parseSiWarmCommand({ ...command, deadlineAt: -1 })).toBeNull();
  expect(parseSiWarmCommand({ ...command, deadlineAt: Number.NaN })).toBeNull();
  expect(parseSiWarmCommand({ ...command, deadlineAt: Number.POSITIVE_INFINITY })).toBeNull();
  expect(parseSiWarmCommand(command)).toEqual(command);
});

test('only a fenced lease that never entered Pod exec may use a cold Job', () => {
  expect(decideSiWarmNextStep({ boundary: 'not-entered', leaseFenced: true }))
    .toEqual({ next: 'cold-job', quarantineWorker: false });
  expect(decideSiWarmNextStep({ boundary: 'not-entered', leaseFenced: false }))
    .toEqual({ next: 'reconcile-only', quarantineWorker: true });
});
