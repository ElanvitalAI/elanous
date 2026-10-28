import { describe, expect, test } from 'bun:test';
import { parsePodTermination, POD_TERMINATION_JOB_JSONPATH, readPodTermination } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import {
  POD_DEVICE_EVENTS,
  makeScriptedKubectlDevice,
  simPodTerminationSpawnIncident,
} from './task-orchestrator-surfaces-self-implement-pod-device.js';

const NOW = () => new Date('2026-10-22T14:00:00Z');
const event = (kind: (typeof POD_DEVICE_EVENTS)[number]['kind']) => POD_DEVICE_EVENTS.find((e) => e.kind === kind)!;

function capture(kind: (typeof POD_DEVICE_EVENTS)[number]['kind'], path: 'job-failed-condition' | 'result-marker' = 'job-failed-condition', withUid = true) {
  const device = makeScriptedKubectlDevice(POD_DEVICE_EVENTS);
  const fixture = event(kind);
  const record = readPodTermination({ kubectl: device.kubectl, namespace: 'elanous', job: fixture.jobName, path, now: NOW,
    jobUid: withUid ? fixture.jobUid : undefined });
  return { record, calls: device.calls };
}

describe('readPodTermination over the fake kubectl device (JOB-FAILURE-TERMINATION-CAPTURE)', () => {
  test('the simulated Job snapshot includes optional creation and completion timestamps', () => {
    const fixture = event('job-deadline-exceeded');
    const device = makeScriptedKubectlDevice([fixture]);
    const read = device.kubectl(['-n', 'elanous', 'get', 'job', fixture.jobName, '-o', `jsonpath=${POD_TERMINATION_JOB_JSONPATH}`]);
    expect(read.stdout).toBe('DeadlineExceeded\t3600\t33333333-3333-4333-8333-333333333333\t2026-10-22T12:55:10Z\t');
  });

  test('Job Failed condition (BackoffLimitExceeded): reason · exitCode · finishedAt observed, not OOM, not deadline', () => {
    const { record, calls } = capture('job-failed-backoff');
    expect(record).toEqual({
      job: 'si-task-backoff', path: 'job-failed-condition', observedAt: '2026-10-22T14:00:00.000Z',
      jobLookup: 'ok', jobUid: '11111111-1111-4111-8111-111111111111', jobConditionReason: 'BackoffLimitExceeded',
      activeDeadlineSeconds: 14400, deadlineExceeded: false,
      podLookup: 'terminated', containerReason: 'Error', exitCode: 1, finishedAt: '2026-10-22T05:07:41Z', oomKilled: false,
    });
    // One read each — and never a destructive or describe call.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.args.includes('delete') && !call.args.includes('describe'))).toBe(true);
  });

  test('OOMKilled comes from terminated.reason of this Job uid only — the stale same-name Pod of another uid is ignored', () => {
    const { record } = capture('child-oomkilled');
    expect(record).toMatchObject({ podLookup: 'terminated', containerReason: 'OOMKilled', exitCode: 137, oomKilled: true,
      finishedAt: '2026-10-22T12:56:03Z', deadlineExceeded: false });
  });

  test('DeadlineExceeded is the condition reason; activeDeadlineSeconds is the configured setting, recorded apart', () => {
    const { record } = capture('job-deadline-exceeded');
    expect(record).toMatchObject({ jobConditionReason: 'DeadlineExceeded', deadlineExceeded: true, activeDeadlineSeconds: 3600,
      containerReason: 'Error', exitCode: 143, oomKilled: false });
  });

  test('result marker early exit: the Pod is still running — container facts stay unknown, no condition yet', () => {
    const { record } = capture('result-marker-running', 'result-marker');
    expect(record).toMatchObject({ path: 'result-marker', jobLookup: 'ok', jobConditionReason: 'unknown', deadlineExceeded: 'unknown',
      activeDeadlineSeconds: 14400, podLookup: 'running', containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown' });
  });

  test('GC: Job NotFound → every field unobserved; Pods are absent with a known uid, unattributable without one', () => {
    const gone = capture('lookup-failure', 'job-failed-condition', false).record;
    expect(gone).toMatchObject({ jobLookup: 'unavailable', jobUid: 'unknown', jobConditionReason: 'unknown', activeDeadlineSeconds: 'unknown',
      deadlineExceeded: 'unknown', podLookup: 'unavailable', containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown' });
    const device = makeScriptedKubectlDevice(POD_DEVICE_EVENTS);
    const known = readPodTermination({ kubectl: device.kubectl, namespace: 'elanous', job: 'si-task-gone', path: 'job-failed-condition',
      jobUid: '55555555-5555-4555-8555-555555555555', now: NOW });
    expect(known).toMatchObject({ jobLookup: 'unavailable', podLookup: 'absent', oomKilled: 'unknown' });
  });

  test('a same-name Job of another uid is not this launch\'s: job facts unavailable, Pods filtered to this uid', () => {
    const device = makeScriptedKubectlDevice(POD_DEVICE_EVENTS);
    const record = readPodTermination({ kubectl: device.kubectl, namespace: 'elanous', job: 'si-task-oom', path: 'job-failed-condition',
      jobUid: '99999999-9999-4999-8999-999999999999', now: NOW });
    expect(record).toMatchObject({ jobLookup: 'unavailable', jobConditionReason: 'unknown', jobUid: '99999999-9999-4999-8999-999999999999',
      podLookup: 'terminated', containerReason: 'Completed', exitCode: 0, oomKilled: false });
  });

  test('without this launch\'s uid nothing is attributed — a readable same-name Job is not taken as this failure', () => {
    const { record } = capture('job-failed-backoff', 'job-failed-condition', false);
    expect(record).toMatchObject({ jobLookup: 'unavailable', jobUid: 'unknown', jobConditionReason: 'unknown', activeDeadlineSeconds: 'unknown',
      deadlineExceeded: 'unknown', podLookup: 'unavailable', containerReason: 'unknown', exitCode: 'unknown', oomKilled: 'unknown' });
  });

  test('a Job read that lacks a uid is not this launch\'s Job even with an expected uid', () => {
    const uid = '77777777-7777-4777-8777-777777777777';
    const kubectl = (args: readonly string[]) => args.includes('pods')
      ? { status: 0, stdout: '', stderr: '' }
      : { status: 0, stdout: 'DeadlineExceeded\t3600\t\t\t', stderr: '' };
    expect(readPodTermination({ kubectl, namespace: 'elanous', job: 'si-x', path: 'job-failed-condition', jobUid: uid, now: NOW }))
      .toMatchObject({ jobLookup: 'unavailable', jobConditionReason: 'unknown', deadlineExceeded: 'unknown', activeDeadlineSeconds: 'unknown', podLookup: 'absent' });
  });

  test('a Pod of this uid without a child terminated state takes its phase: Running · Pending · otherwise unknown', () => {
    const uid = '88888888-8888-4888-8888-888888888888';
    const at = (phase: string) => readPodTermination({ namespace: 'elanous', job: 'si-x', path: 'result-marker', jobUid: uid, now: NOW,
      kubectl: (args) => args.includes('pods')
        ? { status: 0, stdout: `2026-10-22T05:00:00Z\t\t\t\t|${phase}\t${uid}\n`, stderr: '' }
        : { status: 0, stdout: `\t14400\t${uid}`, stderr: '' } });
    expect(at('Running')).toMatchObject({ podLookup: 'running', containerReason: 'unknown', oomKilled: 'unknown' });
    expect(at('Pending')).toMatchObject({ podLookup: 'pending', containerReason: 'unknown', oomKilled: 'unknown' });
    expect(at('Failed')).toMatchObject({ podLookup: 'unknown', containerReason: 'unknown', oomKilled: 'unknown' });
    expect(at('')).toMatchObject({ podLookup: 'unknown' });
  });

  test('two Pods of this uid with the same creationTimestamp are ambiguous — neither is taken as this failure, in either order', () => {
    const uid = '12121212-1212-4121-8121-121212121212';
    const rowA = `2026-10-22T05:00:00Z\tOOMKilled\t137\t2026-10-22T05:10:00Z\t\t\t|Failed\t${uid}`;
    const rowB = `2026-10-22T05:00:00Z\tError\t1\t2026-10-22T05:20:00Z\t\t\t|Failed\t${uid}`;
    for (const rows of [[rowA, rowB], [rowB, rowA]]) {
      const record = readPodTermination({ namespace: 'elanous', job: 'si-x', path: 'job-failed-condition', jobUid: uid, now: NOW,
        kubectl: (args) => args.includes('pods')
          ? { status: 0, stdout: `${rows.join('\n')}\n`, stderr: '' }
          : { status: 0, stdout: `BackoffLimitExceeded\t14400\t${uid}`, stderr: '' } });
      expect(record).toMatchObject({ jobLookup: 'ok', podLookup: 'unknown', containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown' });
    }
  });

  test('parsePodTermination refuses a record that claims Job or Pod facts without a uid', () => {
    const { record } = capture('job-failed-backoff');
    expect(parsePodTermination({ ...record, jobUid: 'unknown' }, 'si-task-backoff')).toBeUndefined();
    expect(parsePodTermination({ ...record, jobUid: 'unknown', jobLookup: 'unavailable' }, 'si-task-backoff')).toBeUndefined();
    const gone = capture('lookup-failure', 'job-failed-condition', false).record;
    expect(parsePodTermination(gone, 'si-task-gone')).toEqual(gone);
  });

  test('a thrown kubectl is unavailable, never an exception', () => {
    const record = readPodTermination({ kubectl: () => { throw new Error('ETIMEDOUT'); }, namespace: 'elanous', job: 'si-x', path: 'result-marker',
      jobUid: '66666666-6666-4666-8666-666666666666', now: NOW });
    expect(record).toMatchObject({ jobLookup: 'unavailable', podLookup: 'unavailable', oomKilled: 'unknown', deadlineExceeded: 'unknown' });
  });

  test('E4: each of the five events runs the real podSelfImplementSpawn → its own ledger rows → recordClassifiedHarnessPodExit — one incident row each', async () => {
    const rows: Record<string, Record<string, unknown>> = {};
    for (const e of POD_DEVICE_EVENTS) {
      const observed = await simPodTerminationSpawnIncident(e.kind);
      expect(observed.incidentRows).toBe(1);
      // The spawn itself wrote the attempt start and the evidence row — the sim writes no ledger line.
      expect(observed.ledgerEvents).toContain('pod-child-run');
      expect(observed.ledgerEvents).toContain('pod-child-evidence');
      const line = JSON.parse(observed.incidentLine) as { podTermination?: Record<string, unknown> };
      expect(line.podTermination).toMatchObject({ job: observed.job });
      rows[e.kind] = line.podTermination!;
    }
    expect(rows['job-failed-backoff']).toMatchObject({ path: 'job-failed-condition', jobLookup: 'ok', jobConditionReason: 'BackoffLimitExceeded',
      activeDeadlineSeconds: 14400, deadlineExceeded: false, podLookup: 'terminated', containerReason: 'Error', exitCode: 1, finishedAt: '2026-10-22T05:07:41Z', oomKilled: false });
    expect(rows['child-oomkilled']).toMatchObject({ path: 'job-failed-condition', podLookup: 'terminated', containerReason: 'OOMKilled', exitCode: 137, oomKilled: true, deadlineExceeded: false });
    expect(rows['job-deadline-exceeded']).toMatchObject({ jobConditionReason: 'DeadlineExceeded', deadlineExceeded: true, activeDeadlineSeconds: 3600, exitCode: 143, oomKilled: false });
    expect(rows['result-marker-running']).toMatchObject({ path: 'result-marker', jobLookup: 'ok', jobConditionReason: 'unknown', podLookup: 'running',
      containerReason: 'unknown', exitCode: 'unknown', finishedAt: 'unknown', oomKilled: 'unknown', deadlineExceeded: 'unknown' });
    expect(rows['lookup-failure']).toMatchObject({ path: 'job-failed-condition', jobLookup: 'unavailable', jobUid: 'unknown', podLookup: 'unavailable',
      containerReason: 'unknown', exitCode: 'unknown', oomKilled: 'unknown', deadlineExceeded: 'unknown', activeDeadlineSeconds: 'unknown' });
  }, 120_000);

  test('parsePodTermination keeps only a well-formed record of the named Job', () => {
    const { record } = capture('child-oomkilled');
    expect(parsePodTermination(JSON.parse(JSON.stringify(record)), 'si-task-oom')).toEqual(record);
    expect(parsePodTermination(record, 'si-task-other')).toBeUndefined();
    expect(parsePodTermination({ ...record, env: [{ name: 'GH_TOKEN', value: 'x' }] }, 'si-task-oom')).toEqual(record);
    expect(parsePodTermination({ ...record, oomKilled: 'yes' }, 'si-task-oom')).toBeUndefined();
    expect(parsePodTermination({ ...record, containerReason: 'a b; rm -rf' }, 'si-task-oom')).toBeUndefined();
  });
});
