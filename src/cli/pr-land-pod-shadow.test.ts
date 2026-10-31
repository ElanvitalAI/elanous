import { expect, test } from 'bun:test';
import { runHeavyOnPodShadow } from './pr-land-pod-shadow.js';

const local = { ok: true as const, mode: 'rebased' as const, baseTip: 'abc', reviewResult: 'r.json' };
const pod = { ok: true as const, mode: 'rebased' as const, baseTip: 'abc', reviewResult: 'r.json' };

function harness(runPod: () => unknown | Promise<unknown>) {
  const calls: unknown[][] = [];
  const logs: unknown[][] = [];
  const warns: string[] = [];
  return {
    runPod: () => {
      calls.push([]);
      return runPod();
    },
    log: (category: string, event: string, data: Record<string, unknown>) => {
      logs.push([category, event, data]);
    },
    warn: (message: string) => {
      warns.push(message);
    },
    calls,
    logs,
    warns,
  };
}

test('disabled calls pod 0 times', async () => {
  const h = harness(() => pod);
  const result = await runHeavyOnPodShadow({
    enabled: false,
    pr: 7,
    head: 'deadbeef',
    local,
    runPod: h.runPod,
    log: h.log,
    warn: h.warn,
  });
  expect(h.calls).toHaveLength(0);
  expect(h.logs).toHaveLength(0);
  expect(h.warns).toHaveLength(0);
  expect(result).toBe(local);
});

test('enabled calls pod once and logs heavy-on-pod-shadow', async () => {
  const h = harness(() => pod);
  const result = await runHeavyOnPodShadow({
    enabled: true,
    pr: 7,
    head: 'deadbeef',
    local,
    runPod: h.runPod,
    log: h.log,
    warn: h.warn,
  });
  expect(h.calls).toHaveLength(1);
  expect(h.warns).toHaveLength(0);
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0]![0]).toBe('pr.land');
  expect(h.logs[0]![1]).toBe('heavy-on-pod-shadow');
  const data = h.logs[0]![2] as Record<string, unknown>;
  expect(data).toMatchObject({ pr: 7, head: 'deadbeef', local, pod, agree: true });
  expect(typeof data.podMs).toBe('number');
  expect(typeof data.localMs).toBe('number');
  expect(result).toBe(local);
});

test('enabled logs disagreeing Pod verdict without changing local verdict', async () => {
  const differentPod = { ...pod, baseTip: 'different' };
  const h = harness(() => differentPod);
  const result = await runHeavyOnPodShadow({
    enabled: true,
    pr: 7,
    head: 'deadbeef',
    local,
    runPod: h.runPod,
    log: h.log,
    warn: h.warn,
  });

  expect(h.calls).toHaveLength(1);
  expect(h.logs).toHaveLength(1);
  expect((h.logs[0]![2] as Record<string, unknown>).agree).toBe(false);
  expect(h.warns).toHaveLength(0);
  expect(result).toBe(local);
});

test('shadow evidence callback records agreement but cannot change the landing verdict', async () => {
  const h = harness(() => pod);
  let observation: { pod: unknown; agree: boolean } | undefined;
  const result = await runHeavyOnPodShadow({
    enabled: true, pr: 7, head: 'deadbeef', local, runPod: h.runPod, log: h.log, warn: h.warn,
    onShadow: (value) => { observation = value; throw new Error('journal unavailable'); },
  });
  expect(observation).toEqual({ pod, agree: true });
  expect(h.warns).toEqual(['shadow evidence write failed: journal unavailable']);
  expect(result).toBe(local);
});

test('pod throw only warns and keeps local verdict', async () => {
  const h = harness(() => {
    throw new Error('pod-down');
  });
  const result = await runHeavyOnPodShadow({
    enabled: true,
    pr: 7,
    head: 'deadbeef',
    local,
    runPod: h.runPod,
    log: h.log,
    warn: h.warn,
  });
  expect(h.calls).toHaveLength(1);
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0]![1]).toBe('heavy-on-pod-shadow');
  expect((h.logs[0]![2] as { pod: { measured: boolean; ok: boolean; reason: string }; agree: boolean }).pod)
    .toEqual({ measured: false, ok: false, reason: 'pod-exception:Error' });
  expect((h.logs[0]![2] as { agree: boolean }).agree).toBe(false);
  expect(h.warns).toEqual(['pod-down']);
  expect(result).toBe(local);
});
