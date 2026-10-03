import { expect, test } from 'bun:test';
import { podPredecessorFor, podSelfImplementSpawn } from './self-implement-pod.js';
import { PodPoolScheduler, parsePodPool } from './pod-pool.js';

test('a Pod launch with an after predecessor cannot create a Job without pool admission', async () => {
  const calls: string[] = [];
  const spawn = podSelfImplementSpawn({
    env: {},
    kubectl: (args) => { calls.push(args.join(' ')); return { status: 0, stdout: 'test-context', stderr: '' }; },
  });
  const result = await spawn({ feature: 'dependent goal', spaceId: 'no-pool-dependency', after: '#123' }).done;
  expect(result.error?.code).toBe('pod-lease');
  expect(calls).toEqual([]);
});

test('a Pod launch whose predecessor closed without merging ends blocked, not as a silent abort, and applies no Job', async () => {
  const calls: string[] = [];
  const pool = new PodPoolScheduler(parsePodPool('fake:2'), {
    status: () => ({ recommended: 2, accountSlots: 0, limitedBy: 'capacity', reason: null,
      capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
    dependencyMerged: () => 'blocked',
    pollMs: 2,
  });
  const spawn = podSelfImplementSpawn({ pool, env: {}, pollMs: 2,
    kubectl: (args) => { calls.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; } });
  const result = await spawn({ feature: 'dependent goal', spaceId: 'blocked-dependency', after: 123 }).done;
  expect(result.error).toEqual({ code: 'pod-predecessor-blocked', message: 'pod lease predecessor blocked: 123 was closed without merging' });
  expect(calls.filter((call) => call.includes('apply'))).toEqual([]);
});

test('a goal line `선행: #N`, a goal ID line, or the --after option become the Pod queue predecessor', () => {
  expect(podPredecessorFor('Fix X\n선행: #123\n', {})).toBe(123);
  expect(podPredecessorFor('Fix X\nafter: 0123456789abcdef', {})).toBe('0123456789abcdef');
  expect(podPredecessorFor('Fix X', { ELANOUS_POD_AFTER: '#77' }, '선행: #123')).toBe(77);
  expect(podPredecessorFor('Fix X', {}, 'parent\n선행: #123')).toBe(123);
  // Only an exact own line counts — prose mentioning 선행 or a shared file is not a predecessor.
  expect(podPredecessorFor('선행 리뷰 must-fix 반영 · src/a.ts 도 고친다', {})).toBeUndefined();
  expect(podPredecessorFor('선행: 나중에', {})).toBeUndefined();
});

test('a `선행: #N` goal line holds the Pod Job until the PR merges', async () => {
  let state: 'waiting' | 'merged' = 'waiting';
  const checked: Array<string | number> = [];
  const applied: string[] = [];
  const pool = new PodPoolScheduler(parsePodPool('fake:2'), {
    status: () => ({ recommended: 2, accountSlots: 0, limitedBy: 'capacity', reason: null,
      capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
    dependencyMerged: (after) => { checked.push(after); return state; },
    pollMs: 2,
  });
  const spawn = podSelfImplementSpawn({ pool, env: {}, pollMs: 2, repoUrl: 'not-a-github-repository',
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }),
    kubectl: (args, input) => {
      if (args.includes('apply') && input && (JSON.parse(input) as { kind: string }).kind === 'Job') applied.push('job');
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    } });
  const controller = new AbortController();
  const job = spawn({ feature: 'dependent goal\n선행: #123', spaceId: 'goal-line-dependency', signal: controller.signal });
  try {
    await Bun.sleep(20);
    expect(checked).toContain(123);
    expect(applied).toEqual([]);
    expect(pool.admissionSnapshot()).toMatchObject({ queued: 1, waiting: [{ after: 123, reason: 'predecessor-unmerged:123' }] });
    state = 'merged';
    expect((await job.done).exitCode).toBe(0);
    expect(applied).toHaveLength(1);
  } finally { controller.abort(); await job.done; }
});
