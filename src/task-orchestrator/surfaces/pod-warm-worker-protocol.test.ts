import { expect, test } from 'bun:test';
import { assessWarmWorkerShadow, type WarmWorkerCommand, type WarmWorkerFileResult, type WarmWorkerReply } from './pod-warm-worker-protocol.js';

const first = 'test/a.test.ts';
const second = 'test/b.test.ts';
const command: WarmWorkerCommand = {
  protocol: 1, runId: 'release-1', attemptId: 'attempt-1', cutSha: 'a'.repeat(40),
  leaseId: 'lease-1', generation: 3, workerId: 'worker-1',
  key: { context: 'node-b', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' },
  deadlineAt: 2000, files: [first, second], envProfile: 'gate-v1',
};
const job: WarmWorkerFileResult[] = [
  { file: first, rc: 1, failureIds: [`${first} > fails`], errorIds: [], junitComplete: true },
  { file: second, rc: 0, failureIds: [], errorIds: [], junitComplete: true },
];
const reply: WarmWorkerReply = {
  protocol: 1, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
  leaseId: command.leaseId, generation: command.generation, workerId: command.workerId,
  key: command.key, envProfile: command.envProfile,
  startedAt: 1000, finishedAt: 1500, files: job,
};

test('shadow match preserves the one-shot Job as the only adopted verdict', () => {
  expect(assessWarmWorkerShadow(command, job, { ...reply, files: [...job].reverse() }))
    .toEqual({ reason: 'match', adopt: 'job', quarantineWorker: false });
});

test('a stale lease generation or wrong cut cannot enter the gate verdict', () => {
  expect(assessWarmWorkerShadow(command, job, { ...reply, generation: 2 }).reason).toBe('identity');
  expect(assessWarmWorkerShadow(command, job, { ...reply, cutSha: 'd'.repeat(40) }).reason).toBe('identity');
  expect(assessWarmWorkerShadow(command, job, { ...reply, key: { ...reply.key, lockHash: 'different' } }).reason).toBe('identity');
  expect(assessWarmWorkerShadow(command, job, { ...reply, finishedAt: 2001 }).reason).toBe('identity');
});

test('worker missing JUnit or file quarantines; reference missing stays unmeasured', () => {
  const missingJunit = { ...job[0]!, junitComplete: false };
  expect(assessWarmWorkerShadow(command, job, { ...reply, files: [missingJunit, job[1]!] }))
    .toEqual({ reason: 'missing-artifact', adopt: 'job', quarantineWorker: true });
  expect(assessWarmWorkerShadow(command, job, { ...reply, files: [job[0]!] }).reason).toBe('file-set');
  expect(assessWarmWorkerShadow(command, job, { ...reply, files: [{ ...job[0]!, rc: '0' }, job[1]!] }).reason)
    .toBe('invalid-reply');
  expect(assessWarmWorkerShadow(command, [{ ...job[0]!, junitComplete: false }, job[1]!], reply))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  expect(assessWarmWorkerShadow(command, [job[0]!, { ...job[1]!, junitComplete: false }],
    { ...reply, files: [{ ...job[0]!, rc: 0 }, job[1]!] }))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  expect(assessWarmWorkerShadow(command, [job[0]!, { ...job[1]!, junitComplete: false }], null))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  expect(assessWarmWorkerShadow(command, [job[0]!, { ...job[1]!, junitComplete: false }],
    { ...reply, files: [job[0]!] }))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  expect(assessWarmWorkerShadow(command, [{ ...job[0]!, failureIds: [job[0]!.failureIds[0]!, job[0]!.failureIds[0]!] }, job[1]!], reply))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  const overlapping = { ...job[0]!, errorIds: [job[0]!.failureIds[0]!] };
  expect(assessWarmWorkerShadow(command, [overlapping, job[1]!], { ...reply, files: [overlapping, job[1]!] }))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  const unnamed = { ...job[0]!, failureIds: [`${first} > `] };
  expect(assessWarmWorkerShadow(command, [unnamed, job[1]!], { ...reply, files: [unnamed, job[1]!] }))
    .toEqual({ reason: 'reference-unmeasured', adopt: 'job', quarantineWorker: false });
  expect(assessWarmWorkerShadow(command, [{ ...job[0]!, rc: 0 }, job[1]!], reply).reason).toBe('reference-unmeasured');
});

test('different rc or failure identities quarantine even when failure counts match', () => {
  expect(assessWarmWorkerShadow(command, job, { ...reply, files: [{ ...job[0]!, rc: 2 }, job[1]!] }).reason).toBe('result');
  expect(assessWarmWorkerShadow(command, job, { ...reply,
    files: [{ ...job[0]!, failureIds: [`${first} > other failure`] }, job[1]!] }).reason).toBe('result');
  expect(assessWarmWorkerShadow(command, job, { ...reply,
    files: [{ ...job[0]!, errorIds: [`${first} > [error] TypeError: extra`] }, job[1]!] }).reason).toBe('result');
  const errorOnly = { ...job[0]!, failureIds: [], errorIds: [`${first} > [error]`] };
  expect(assessWarmWorkerShadow(command, [errorOnly, job[1]!], { ...reply,
    files: [errorOnly, job[1]!] }).reason).toBe('reference-unmeasured');
  const contentError = { ...errorOnly, errorIds: [`${first} > [error] TypeError: alpha`] };
  expect(assessWarmWorkerShadow(command, [contentError, job[1]!], { ...reply,
    files: [{ ...contentError, errorIds: [`${first} > [error] TypeError: beta`] }, job[1]!] }).reason).toBe('result');
});

test('missing reply stays unmeasured; an empty error identity cannot match itself', () => {
  expect(assessWarmWorkerShadow(command, job, null))
    .toEqual({ reason: 'reply-unmeasured', adopt: 'job', quarantineWorker: false });
  const bare = { ...job[0]!, failureIds: [], errorIds: [`${first} > [error] `] };
  expect(assessWarmWorkerShadow(command, [bare, job[1]!], { ...reply, files: [bare, job[1]!] }).reason)
    .toBe('reference-unmeasured');
});

test('an empty file request cannot prove a warm worker match', () => {
  expect(assessWarmWorkerShadow({ ...command, files: [] }, [], { ...reply, files: [] }))
    .toEqual({ reason: 'no-sample', adopt: 'job', quarantineWorker: false });
});
