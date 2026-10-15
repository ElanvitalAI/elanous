import { afterAll, afterEach, expect, test } from 'bun:test';
import { kubectlTransientReason, retryKubectlTransient, type KubectlCallResult } from './kubectl-transient-retry.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { debug } from '../../debug/log.js';

const LOCKED: KubectlCallResult = { status: 1, stdout: '', stderr: 'Error from server: error when creating "STDIN": rpc error: code = Unknown desc = database is locked\n' };
const OK: KubectlCallResult = { status: 0, stdout: 'secret/x-creds created\n', stderr: '' };
const FORBIDDEN: KubectlCallResult = { status: 1, stdout: '', stderr: 'Error from server (Forbidden): secrets is forbidden\n' };

const events: Array<{ event: string; data: Record<string, unknown> }> = [];
const off = debug.registerSink({ name: 'kubectl-transient-retry-test', emit: (record) => {
  if (record.category === 'pod.secret') events.push({ event: record.event, data: record.data as Record<string, unknown> });
} });
afterEach(() => { events.length = 0; });
afterAll(off);

test('classifies only the measured k3s sqlite lock as transient', () => {
  expect(kubectlTransientReason(LOCKED)).toBe('database is locked');
  expect(kubectlTransientReason(OK)).toBeNull();
  expect(kubectlTransientReason(FORBIDDEN)).toBeNull();
  expect(kubectlTransientReason({ ...LOCKED, status: 0 })).toBeNull();
  // stderr 가 다른 오류면 stdout 에 같은 문구가 있어도 일시 오류가 아니다.
  expect(kubectlTransientReason({ ...FORBIDDEN, stdout: 'database is locked\n' })).toBeNull();
});

test('two locked retries then success returns the success with exponential backoff', async () => {
  const waits: number[] = [];
  const results = [LOCKED, OK];
  let calls = 0;
  const out = await retryKubectlTransient(() => { calls++; return results.shift()!; }, LOCKED, { sleep: async (ms) => { waits.push(ms); }, category: 'pod.secret', data: { job: 'j' } });
  expect(out).toEqual(OK);
  expect(calls).toBe(2);
  expect(waits).toEqual([500, 1_000]);
  expect(events.map((e) => e.event)).toEqual(['retry', 'retry', 'retry-recovered']);
  expect(events[0]!.data).toMatchObject({ job: 'j', attempt: 1, reason: 'database is locked' });
});

test('still locked after every backoff returns the last failure once exhausted', async () => {
  const waits: number[] = [];
  let calls = 0;
  const out = await retryKubectlTransient(() => { calls++; return LOCKED; }, LOCKED, { sleep: async (ms) => { waits.push(ms); }, category: 'pod.secret' });
  expect(out.status).toBe(1);
  expect(out.stderr).toContain('database is locked');
  // 상수와 독립된 literal — 상한·대기를 줄이면 이 시험이 문다.
  expect(calls).toBe(4);
  expect(waits).toEqual([500, 1_000, 2_000, 4_000]);
  expect(events.filter((e) => e.event === 'retry-exhausted')).toHaveLength(1);
});

test('a non-transient error stops retrying immediately', async () => {
  let calls = 0;
  const forbiddenFirst = await retryKubectlTransient(() => { calls++; return OK; }, FORBIDDEN, { sleep: async () => {}, category: 'pod.secret' });
  expect(forbiddenFirst).toEqual(FORBIDDEN);
  expect(calls).toBe(0);
  const out = await retryKubectlTransient(() => { calls++; return FORBIDDEN; }, LOCKED, { sleep: async () => {}, category: 'pod.secret' });
  expect(out).toEqual(FORBIDDEN);
  expect(calls).toBe(1);
  const mixed = { ...FORBIDDEN, stdout: 'database is locked\n' };
  expect(await retryKubectlTransient(() => { calls++; return OK; }, mixed, { sleep: async () => {}, category: 'pod.secret' })).toEqual(mixed);
  expect(calls).toBe(1);
  expect(events.some((e) => e.event === 'retry-exhausted')).toBe(false);
});

const secretKubectl = (secretResults: KubectlCallResult[], applied: string[]): Kubectl => (args, input) => {
  if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
  if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
  if (args.includes('apply') && input) {
    const kind = (JSON.parse(input) as { kind: string }).kind;
    applied.push(kind);
    if (kind === 'Secret') return secretResults.shift() ?? OK;
  }
  if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

test('Pod spawn retries a locked Secret apply and goes on to create the Job', async () => {
  const applied: string[] = [];
  const waits: number[] = [];
  const result = await podSelfImplementSpawn({ kubectl: secretKubectl([LOCKED, LOCKED, OK], applied), credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }), env: {}, githubInstallation: () => null, sleep: async (ms) => { waits.push(ms); } })({ feature: 'x', spaceId: 'secret-db-locked-recovers' }).done;
  expect(result.error?.code).not.toBe('pod-secret');
  expect(applied.filter((k) => k === 'Secret')).toHaveLength(3);
  expect(applied).toContain('Job');
  expect(waits.slice(0, 2)).toEqual([500, 1_000]);
  expect(events.map((e) => e.event)).toEqual(['retry', 'retry', 'retry-recovered']);
  expect(events[0]!.data).toMatchObject({ job: expect.any(String), namespace: expect.any(String), context: 'test-context' });
});

test('Pod spawn fails with pod-secret only after the lock retries are exhausted', async () => {
  const applied: string[] = [];
  const waits: number[] = [];
  const result = await podSelfImplementSpawn({ kubectl: secretKubectl(Array.from({ length: 10 }, () => LOCKED), applied), credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }), env: {}, githubInstallation: () => null, sleep: async (ms) => { waits.push(ms); } })({ feature: 'x', spaceId: 'secret-db-locked-exhausted' }).done;
  expect(result.error?.code).toBe('pod-secret');
  expect(result.error?.message).toContain('database is locked');
  expect(applied.filter((k) => k === 'Secret')).toHaveLength(5);
  expect(waits.slice(0, 4)).toEqual([500, 1_000, 2_000, 4_000]);
  expect(applied).not.toContain('Job');
});
