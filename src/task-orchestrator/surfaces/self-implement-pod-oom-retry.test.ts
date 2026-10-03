import { describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const keyFor = (spaceId: string, feature: string) => createHash('sha256').update(JSON.stringify({ spaceId, feature })).digest('hex');
import { debug } from '../../debug/log.js';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { podJobName, podMemoryLimitFor, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { HostPoolLease } from '../../pod-lease/host-lease.js';
import { PodPoolScheduler, parsePodPool } from './pod-pool.js';
import { POD_HOST_LEASE_ANNOTATION } from './pod-lease.js';

const creds = () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' });

function simulation(reasons: string[], tier?: 'high' | 'standard') {
  const jobs: any[] = [];
  const secrets: any[] = [];
  const calls: string[] = [];
  let leases = 0;
  let releases = 0;
  const kubectl: Kubectl = (args, input) => {
    const command = args.join(' ');
    calls.push(command);
    if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
    // POD8b DNS probe (pool lease): coredns Ready and the disposable lookup Pod resolves.
    if (command.includes('deployment coredns')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
    if (command.includes('pod/elanous-dns-') && args.includes('logs')) return { status: 0, stdout: 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1\n', stderr: '' };
    if (command.includes('pod/elanous-dns-') && args.includes('-o')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Succeeded' } }), stderr: '' };
    if (command.includes('elanous-dns-') || (args.includes('create') && input?.includes('elanous-dns-'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('nodes') && args.includes('-o')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '16' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
    if (args.includes('jobs') && args.includes('-o')) return { status: 0, stdout: '{"items":[]}', stderr: '' };
    if (args.includes('pods') && args.includes('--all-namespaces')) return { status: 0, stdout: '{"items":[]}', stderr: '' };
    if (command.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (command.endsWith('apply -f -')) {
      const manifest = JSON.parse(input!);
      if (manifest.kind === 'Job') jobs.push(manifest);
      else secrets.push(manifest);
    }
    const reason = reasons[jobs.length - 1] ?? 'Error';
    if (args.includes('pods')) return { status: 0, stdout: `2026-10-03T00:00:00Z\t${reason}\t${reason === 'OOMKilled' ? 137 : 1}\n`, stderr: '' };
    if (args.includes('get') && args.includes('job') && command.includes('status.conditions[*].type')) return { status: 0, stdout: reason === 'Complete' ? 'Complete' : 'Failed', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: reason === 'Complete' ? '{"stage":"pr-opened","ok":true}\n' : '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const pool = {
    tryAcquire: () => { leases++; return { context: 'ctx', imageRef: 'image', capacity: 2 }; },
    release: () => { releases++; }, snapshot: () => ({}),
  };
  const root = mkdtempSync(join(tmpdir(), 'pod-oom-retry-'));
  const env = { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'run-parent-1', ...(tier ? { ELANOUS_POD_MEMORY_TIER: tier } : {}) };
  return { kubectl, jobs, secrets, calls, pool, root, env, get leases() { return leases; }, get releases() { return releases; } };
}

describe('Pod OOM retry', () => {
  test('only a standalone memory line selects high, never an inline phrase', () => {
    expect(podMemoryLimitFor('Pod 메모리: high\ngoal', {}).tier).toBe('high');
    expect(podMemoryLimitFor('이번 Pod 메모리: high 로 실행', {}).tier).toBe('standard');
  });
  test('standard OOMKilled/137 launches same goal at high once with attempt 2 and a fresh lease', async () => {
    const s = simulation(['OOMKilled', 'Complete']);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'oom-retry-success', emit: (r) => {
      if (r.category === 'self-implement.pod' && r.event === 'oom-retry') events.push({ event: r.event, data: r.data as Record<string, unknown> });
    } });
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'oom-first' }).done;
      expect(result.exitCode).toBe(0);
      expect(s.jobs).toHaveLength(2);
      expect(s.secrets.map((secret) => secret.stringData.feature)).toEqual(['same goal', 'same goal']);
      expect(s.jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['16Gi', '32Gi']);
      expect(s.jobs[0].spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value)
        .not.toBe(s.jobs[1].spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value);
      expect(s.leases).toBe(2);
      expect(s.releases).toBe(2);
      expect(s.calls.filter((c) => c.includes('delete job') && c.includes('--wait=true'))).toHaveLength(1);
      expect(events).toEqual([{ event: 'oom-retry', data: expect.objectContaining({ from: '16Gi', to: '32Gi', job: podJobName('oom-first') }) }]);
      const ledger = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(ledger.filter((entry) => entry.event === 'pod-child-run').map((entry) => entry.data.attempt)).toEqual([1, 2]);
      expect(ledger.find((entry) => entry.event === 'pod-oom-retry').data).toMatchObject({ attempt: 2, from: '16Gi', to: '32Gi' });
      expect(ledger.some((entry) => entry.event === 'pod-oom-retry-finished')).toBe(true);
      expect(ledger.findIndex((entry) => entry.event === 'pod-oom-retry-intent')).toBeLessThan(ledger.findIndex((entry) => entry.event === 'pod-child-run' && entry.data.attempt === 2));
    } finally { off(); rmSync(s.root, { recursive: true, force: true }); }
  });

  test('OOM retry reacquires the host lease and waits behind another lease when N=1', async () => {
    const s = simulation(['OOMKilled', 'Complete']);
    const processStart = (pid: number) => pid === 4321 ? 'foreign-process' : 'same-process';
    const lease = new HostPoolLease('oom-retry-cap', { dir: s.root, processStart });
    const foreign = new HostPoolLease('oom-retry-cap', { dir: s.root, pid: 4321, processStart });
    let foreignRelease: (() => void) | null = null;
    const pool = new PodPoolScheduler(parsePodPool('ctx:2'), {
      hostLease: lease, pollMs: 2,
      status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
    });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') {
        expect(lease.live()).toHaveLength(1);
        expect(JSON.parse(input).metadata.annotations[POD_HOST_LEASE_ANNOTATION]).toBe('true');
      }
      if (args.includes('delete') && args.includes('job') && args.includes('--wait=true')) {
        expect(s.jobs).toHaveLength(1);
        // First Job was applied; occupy the only free host slot before retry admission.
        foreignRelease = foreign.tryReserve(() => true);
        expect(foreignRelease).not.toBeNull();
      }
      return s.kubectl(args, input);
    };
    const controller = new AbortController();
    try {
      const done = podSelfImplementSpawn({ kubectl, pool, env: s.env, credentials: creds, pollMs: 2 })({ feature: 'same goal', spaceId: 'oom-host-admission', signal: controller.signal }).done;
      for (let n = 0; n < 100 && !foreignRelease; n++) await Bun.sleep(2);
      expect(foreignRelease).not.toBeNull();
      for (let n = 0; n < 100 && pool.admissionSnapshot().queued !== 1; n++) await Bun.sleep(2);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      expect(s.jobs).toHaveLength(1);
      foreignRelease!(); foreignRelease = null;
      expect((await done).exitCode).toBe(0);
      expect(s.jobs).toHaveLength(2);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 0 });
      expect(lease.live()).toHaveLength(0);
    } finally { controller.abort(); if (foreignRelease) (foreignRelease as () => void)(); rmSync(s.root, { recursive: true, force: true }); }
  });

  test('aborting a queued OOM retry never applies a second Job or leaves a host lease', async () => {
    const s = simulation(['OOMKilled']);
    const processStart = (pid: number) => pid === 4321 ? 'foreign-process' : 'same-process';
    const lease = new HostPoolLease('oom-abort-cap', { dir: s.root, processStart });
    const foreign = new HostPoolLease('oom-abort-cap', { dir: s.root, pid: 4321, processStart });
    const pool = new PodPoolScheduler(parsePodPool('ctx:2'), {
      hostLease: lease, pollMs: 2,
      status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
    });
    let foreignRelease: (() => void) | null = null;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('delete') && args.includes('job') && args.includes('--wait=true')) {
        expect(s.jobs).toHaveLength(1);
        foreignRelease = foreign.tryReserve(() => true);
        expect(foreignRelease).not.toBeNull();
      }
      return s.kubectl(args, input);
    };
    const controller = new AbortController();
    try {
      const done = podSelfImplementSpawn({ kubectl, pool, env: s.env, credentials: creds, pollMs: 2 })({ feature: 'same goal', spaceId: 'oom-abort-admission', signal: controller.signal }).done;
      for (let n = 0; n < 100 && !foreignRelease; n++) await Bun.sleep(2);
      expect(foreignRelease).not.toBeNull();
      for (let n = 0; n < 100 && pool.admissionSnapshot().queued !== 1; n++) await Bun.sleep(2);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      controller.abort();
      expect((await done).error?.code).toBe('aborted');
      expect(s.jobs).toHaveLength(1);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 0 });
      foreignRelease!(); foreignRelease = null;
      expect(lease.live()).toHaveLength(0);
    } finally { controller.abort(); if (foreignRelease) (foreignRelease as () => void)(); rmSync(s.root, { recursive: true, force: true }); }
  });

  test('retry intent is durable before deleting the OOM Job', async () => {
    const s = simulation(['OOMKilled', 'Complete']);
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('delete') && args.includes('job') && args.includes('--wait=true')) {
        const ledger = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
        expect(ledger.find((entry) => entry.event === 'pod-oom-retry-intent').data).toMatchObject({ job: podJobName('intent-before-delete'), attempt: 2, from: '16Gi', to: '32Gi' });
      }
      return s.kubectl(args, input);
    };
    try {
      expect((await podSelfImplementSpawn({ kubectl, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'intent-before-delete' }).done).exitCode).toBe(0);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('high lease without a 32Gi placement refuses the second Job', async () => {
    const s = simulation(['OOMKilled']);
    const kubectl: Kubectl = (args, input) => {
      const response = s.kubectl(args, input);
      return args.includes('nodes') && args.includes('-o') ? { ...response, stdout: response.stdout.replace('128Gi', '24Gi') } : response;
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'oom-no-lease' }).done;
      expect(result.error?.code).toBe('pod-lease');
      expect(result.error?.message).toContain('마지막 샘플: 샘플 없음');
      expect(s.jobs).toHaveLength(1);
      expect(s.leases).toBe(2);
      expect(s.releases).toBe(2);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('a read error during high lease measurement fails closed', async () => {
    const s = simulation(['OOMKilled']);
    const kubectl: Kubectl = (args, input) => {
      const response = s.kubectl(args, input);
      return args.includes('nodes') && args.includes('-o') ? { status: 1, stdout: '', stderr: 'unavailable' } : response;
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'oom-lease-unavailable' }).done;
      expect(result.error?.code).toBe('pod-lease');
      expect(s.jobs).toHaveLength(1);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('high OOM fails without retry, including explicit high', async () => {
    for (const tier of [undefined, 'high'] as const) {
      const s = simulation(['OOMKilled'], tier);
      try {
        const feature = tier ? 'goal' : 'Pod 메모리: high\ngoal';
        const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature, spaceId: 'oom-high' }).done;
        expect(result.error?.code).toBe('pod-oom-killed');
        expect(result.error?.message).toContain('OOM · high 에서도');
        expect(s.jobs).toHaveLength(1);
        expect(s.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('32Gi');
        expect(s.leases).toBe(1);
      } finally { rmSync(s.root, { recursive: true, force: true }); }
    }
  });

  test('second OOM at high returns a named failure without a third launch', async () => {
    const s = simulation(['OOMKilled', 'OOMKilled']);
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'oom-twice' }).done;
      expect(result.error?.code).toBe('pod-oom-killed');
      expect(result.error?.message).toContain('OOM · high 에서도');
      expect(s.jobs).toHaveLength(2);
      expect(s.leases).toBe(2);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('reattached high Job after host restart does not launch a third time', async () => {
    const s = simulation(['OOMKilled']);
    const existingId = 'run-reattached-high-1';
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Complete', stderr: '' };
      if (args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor('reattach-high', 'same goal'), 'elanous.dev/attempt': '2' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '32Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: existingId }] }] } } } }), stderr: '' };
      if (cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('pods')) return { status: 0, stdout: '2026-10-03T00:00:00Z\tOOMKilled\t137\n', stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'reattach-high' }).done;
      expect(result.error?.code).toBe('pod-oom-killed');
      expect(result.error?.message).toContain('OOM · high 에서도');
      expect(s.jobs).toHaveLength(0);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('restart after OOM deletion failure still resumes high attempt instead of standard', async () => {
    const s = simulation(['OOMKilled']);
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('delete') && args.includes('job') && args.includes('--wait=true')) return { status: 1, stdout: '', stderr: 'transient deletion failure' };
      return s.kubectl(args, input);
    };
    const spaceId = 'restart-after-failed-delete';
    try {
      expect((await podSelfImplementSpawn({ kubectl, env: s.env, credentials: creds })({ feature: 'same goal', spaceId }).done).error?.code).toBe('pod-error');
      const intent = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8');
      expect(intent).toContain('pod-oom-retry-intent');
      const resumed = simulation(['Complete']);
      try {
        const result = await podSelfImplementSpawn({ kubectl: resumed.kubectl, env: { ...resumed.env, ELANOUS_STATE_DIR: s.root }, credentials: creds })({ feature: 'same goal', spaceId }).done;
        expect(result.exitCode).toBe(0);
        expect(resumed.jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['32Gi']);
      } finally { rmSync(resumed.root, { recursive: true, force: true }); }
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('restart after deleting the first OOM Job resumes durable attempt 2 at high without standard launch', async () => {
    const s = simulation(['Complete']);
    const name = podJobName('restart-after-delete');
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job: name, executionKey: keyFor('restart-after-delete', 'same goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' } }, runLedgerDir(s.root));
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'restart-after-delete' }).done;
      expect(result.exitCode).toBe(0);
      expect(s.jobs).toHaveLength(1);
      expect(s.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('32Gi');
      expect(s.secrets[0].stringData.feature).toBe('same goal');
      expect(s.leases).toBe(1);
      expect(s.calls.some((call) => call.includes('get nodes'))).toBe(true);
      const ledger = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(ledger.filter((entry) => entry.event === 'pod-child-run').map((entry) => entry.data.attempt)).toEqual([2]);
      expect(ledger.find((entry) => entry.event === 'pod-oom-retry').data).toMatchObject({ attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' });
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('restart with no high capacity keeps intent and does not launch standard', async () => {
    const s = simulation(['Complete']);
    const name = podJobName('restart-no-capacity');
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job: name, executionKey: keyFor('restart-no-capacity', 'same goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' } }, runLedgerDir(s.root));
    const kubectl: Kubectl = (args, input) => {
      const result = s.kubectl(args, input);
      return args.includes('nodes') && args.includes('-o') ? { ...result, stdout: result.stdout.replace('128Gi', '24Gi') } : result;
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'restart-no-capacity' }).done;
      expect(result.error?.code).toBe('pod-lease');
      expect(s.jobs).toHaveLength(0);
      expect(readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8')).toContain('pod-oom-retry-intent');
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('reattached actual 16Gi OOM retries even when current request is high', async () => {
    const s = simulation(['Complete'], 'high');
    const name = podJobName('reattach-standard-high-request');
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (!s.jobs.length && cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Running', stderr: '' };
      if (!s.jobs.length && args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor('reattach-standard-high-request', 'same goal'), 'elanous.dev/attempt': '1' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '16Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-old-standard' }] }] } } } }), stderr: '' };
      if (!s.jobs.length && cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (!s.jobs.length && args.includes('pods') && !args.includes('--all-namespaces')) return { status: 0, stdout: '2026-10-03T00:00:00Z\tOOMKilled\t137\n', stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'reattach-standard-high-request' }).done;
      expect(result).toMatchObject({ exitCode: 0 });
      expect(s.jobs).toHaveLength(1);
      expect(s.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('32Gi');
      const ledger = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(ledger.find((entry) => entry.event === 'pod-oom-retry-intent').data).toMatchObject({ job: name, from: '16Gi', to: '32Gi' });
      expect(ledger.find((entry) => entry.event === 'pod-oom-retry').data.from).toBe('16Gi');
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('reattached actual high OOM does not retry when request is standard', async () => {
    const s = simulation(['OOMKilled']);
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Running', stderr: '' };
      if (args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor('reattach-high-standard-request', 'same goal'), 'elanous.dev/attempt': '2' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '32Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-old-high' }] }] } } } }), stderr: '' };
      if (cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('pods') && !args.includes('--all-namespaces')) return { status: 0, stdout: '2026-10-03T00:00:00Z\tOOMKilled\t137\n', stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'reattach-high-standard-request' }).done;
      expect(result.error?.code).toBe('pod-oom-killed');
      expect(result.error?.message).toContain('OOM · high 에서도');
      expect(s.jobs).toHaveLength(0);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('restart attaches existing high retry Job instead of deleting or launching again', async () => {
    const s = simulation(['Complete']);
    const name = podJobName('restart-high-existing');
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job: name, executionKey: keyFor('restart-high-existing', 'same goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' } }, runLedgerDir(s.root));
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Complete', stderr: '' };
      if (args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor('restart-high-existing', 'same goal'), 'elanous.dev/attempt': '2' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '32Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-high-existing' }] }] } } } }), stderr: '' };
      if (cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'restart-high-existing' }).done;
      expect(result).toMatchObject({ exitCode: 0 });
      expect(s.jobs).toHaveLength(0);
      expect(s.calls.some((call) => call.includes('delete job'))).toBe(false);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('host restart sees an already Failed 16Gi Job before deleting it, and retries at 32Gi', async () => {
    const s = simulation(['Complete']);
    let oldJob = true;
    const oldId = 'run-old-oom-child';
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (oldJob && cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (oldJob && args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor('failed-before-host-restart', 'same goal'), 'elanous.dev/attempt': '1' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '16Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: oldId }] }] } } } }), stderr: '' };
      if (oldJob && cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (oldJob && args.includes('pods') && !args.includes('--all-namespaces')) return { status: 0, stdout: '2026-10-03T00:00:00Z\tOOMKilled\t137\n', stderr: '' };
      if (oldJob && args.includes('delete') && args.includes('job')) {
        const ledger = readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8');
        expect(ledger).toContain('pod-oom-retry-intent');
        oldJob = false;
      }
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'failed-before-host-restart' }).done;
      expect(result.exitCode).toBe(0);
      expect(s.jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['32Gi']);
      expect(s.leases).toBe(2);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('host restart consumes a failed high attempt without launching a third Job', async () => {
    const s = simulation(['Complete']);
    const spaceId = 'failed-high-after-restart';
    const job = podJobName(spaceId);
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job, executionKey: keyFor(spaceId, 'same goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' } }, runLedgerDir(s.root));
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor(spaceId, 'same goal'), 'elanous.dev/attempt': '2' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '32Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-second' }] }] } } } }), stderr: '' };
      if (cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('pods') && !args.includes('--all-namespaces')) return { status: 0, stdout: '2026-10-03T00:00:00Z\tOOMKilled\t137\n', stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, env: s.env, credentials: creds })({ feature: 'same goal', spaceId }).done;
      expect(result.error?.code).toBe('pod-oom-killed');
      expect(result.error?.message).toContain('OOM · high 에서도');
      expect(s.jobs).toHaveLength(0);
      expect(s.calls.some((call) => call.includes('delete job'))).toBe(false);
      expect(readFileSync(runLedgerPath('run-parent-1', runLedgerDir(s.root)), 'utf8')).toContain('pod-oom-retry-finished');
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('old or finished retry intents cannot be mistaken for this invocation', async () => {
    const s = simulation(['Complete']);
    const spaceId = 'intent-scope';
    const job = podJobName(spaceId);
    const key = keyFor(spaceId, 'current goal');
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job, executionKey: keyFor(spaceId, 'previous goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'old' } }, runLedgerDir(s.root));
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job, executionKey: key, attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'finished' } }, runLedgerDir(s.root));
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-finished', data: { job, executionKey: key, fromChildRunId: 'finished' } }, runLedgerDir(s.root));
    try {
      expect((await podSelfImplementSpawn({ kubectl: s.kubectl, env: s.env, credentials: creds })({ feature: 'current goal', spaceId }).done).exitCode).toBe(0);
      expect(s.jobs.map((item) => item.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['16Gi']);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('without ELANOUS_RUN_ID a standard OOM still records and launches high once', async () => {
    const s = simulation(['OOMKilled', 'Complete']);
    delete (s.env as { ELANOUS_RUN_ID?: string }).ELANOUS_RUN_ID;
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, env: s.env, credentials: creds })({ feature: 'standalone goal', spaceId: 'standalone-oom' }).done;
      expect(result.exitCode).toBe(0);
      expect(s.jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['16Gi', '32Gi']);
      expect(s.calls.some((call) => call.includes('get nodes'))).toBe(true);
      const key = keyFor('standalone-oom', 'standalone goal');
      const id = `run-${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
      const ledger = readFileSync(runLedgerPath(id, runLedgerDir(s.root)), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(ledger.filter((entry) => entry.event === 'pod-child-run').map((entry) => entry.data.attempt)).toEqual([1, 2]);
      expect(ledger.some((entry) => entry.event === 'pod-oom-retry-finished')).toBe(true);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('POD9 must-fix: resuming an OOM retry refuses a same-name high Job from another goal execution', async () => {
    const s = simulation(['Complete']);
    const spaceId = 'foreign-high-job';
    const job = podJobName(spaceId);
    appendRunLedgerEntry({ runId: 'run-parent-1', event: 'pod-oom-retry-intent', data: { job, executionKey: keyFor(spaceId, 'same goal'), attempt: 2, from: '16Gi', to: '32Gi', fromChildRunId: 'run-first' } }, runLedgerDir(s.root));
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Running', stderr: '' };
      if (args.includes('job') && args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: { 'elanous.dev/execution-key': keyFor(spaceId, 'another goal'), 'elanous.dev/attempt': '2' } }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '32Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-other' }] }] } } } }), stderr: '' };
      return s.kubectl(args, input);
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, env: s.env, credentials: creds })({ feature: 'same goal', spaceId }).done;
      expect(result.error?.code).toBe('pod-oom-retry-mismatch');
      expect(s.jobs).toHaveLength(0);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('POD9 must-fix: a failed attempt-2 ledger write never ends as success', async () => {
    const s = simulation(['OOMKilled', 'Complete']);
    const ledgerMod = await import('../../self-implement/run-ledger.js');
    const real = ledgerMod.appendRunLedgerEntry;
    const spy = spyOn(ledgerMod, 'appendRunLedgerEntry').mockImplementation(((entry: { event: string }, dir?: string) => {
      if (entry.event === 'pod-oom-retry') throw new Error('disk full');
      return (real as (...a: unknown[]) => unknown)(entry, dir);
    }) as never);
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'same goal', spaceId: 'ledger-write-fails' }).done;
      expect(result.exitCode).not.toBe(0);
      expect(result.error?.code).toBe('pod-oom-retry-ledger');
    } finally { spy.mockRestore(); rmSync(s.root, { recursive: true, force: true }); }
  });

  test('non-OOM termination never retries', async () => {
    const s = simulation(['Error']);
    try {
      const result = await podSelfImplementSpawn({ kubectl: s.kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'not-oom' }).done;
      expect(result.error?.code).toBe('pod-job-failed');
      expect(s.jobs).toHaveLength(1);
      expect(s.leases).toBe(1);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('OOM reason without container exit 137 is a non-OOM failure', async () => {
    const s = simulation(['OOMKilled']);
    const kubectl: Kubectl = (args, input) => {
      const response = s.kubectl(args, input);
      return args.includes('pods') ? { ...response, stdout: response.stdout.replace('137', '1') } : response;
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, pool: s.pool as never, env: s.env, credentials: creds })({ feature: 'goal', spaceId: 'oom-wrong-exit' }).done;
      expect(result.error?.code).toBe('pod-job-failed');
      expect(result.error?.message).toContain('container=OOMKilled/1');
      expect(s.jobs).toHaveLength(1);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });

  test('parent goal memory phrase warns even when shard explicitly selects high', async () => {
    const s = simulation(['Complete']);
    const previous = process.cwd();
    const warnings: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: string) => { warnings.push(message); });
    try {
      execFileSync('git', ['init', '-q', s.root]);
      writeFileSync(join(s.root, 'goal.md'), '본문의 Pod 메모리 high 요청');
      process.chdir(s.root);
      await podSelfImplementSpawn({ kubectl: s.kubectl, env: { ...s.env, ELANOUS_POD_GOAL_DOC: 'goal.md' }, credentials: creds })({ feature: 'Pod 메모리: high\nshard', spaceId: 'parent-warning' }).done;
      expect(s.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('32Gi');
      expect(warnings).toEqual([expect.stringContaining('(parent-goal)')]);
    } finally { process.chdir(previous); warn.mockRestore(); rmSync(s.root, { recursive: true, force: true }); }
  });

  test('malformed Pod 메모리 in goal is ignored with warning and observation', async () => {
    const s = simulation(['Complete']);
    const warnings: string[] = [];
    const events: Record<string, unknown>[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: string) => { warnings.push(message); });
    const off = debug.registerSink({ name: 'oom-memory-warning', emit: (r) => {
      if (r.category === 'self-implement.pod' && r.event === 'memory-directive-ignored') events.push(r.data as Record<string, unknown>);
    } });
    try {
      await podSelfImplementSpawn({ kubectl: s.kubectl, env: s.env, credentials: creds })({ feature: '이번 Pod 메모리 high 로 부탁', spaceId: 'bad-memory-rule' }).done;
      expect(s.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('16Gi');
      expect(warnings).toEqual([expect.stringContaining('Pod 메모리 지시 무시됨 · 이유:')]);
      expect(events).toEqual([expect.objectContaining({ where: 'feature', reason: expect.stringContaining('한 줄 단독') })]);
      const mixed = simulation(['Complete']);
      try {
        await podSelfImplementSpawn({ kubectl: mixed.kubectl, env: mixed.env, credentials: creds })({ feature: 'Pod 메모리: high\n또 Pod 메모리 high 로 부탁', spaceId: 'mixed-memory-rule' }).done;
        expect(mixed.jobs[0].spec.template.spec.containers[0].resources.limits.memory).toBe('32Gi');
        expect(warnings).toHaveLength(2);
        expect(events).toHaveLength(2);
      } finally { rmSync(mixed.root, { recursive: true, force: true }); }
    } finally { off(); warn.mockRestore(); rmSync(s.root, { recursive: true, force: true }); }
  });
});
