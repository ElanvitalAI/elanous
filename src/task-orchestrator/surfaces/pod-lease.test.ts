import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePodPool, type PoolKubectl } from './pod-pool.js';
import { measurePoolLease, probePoolDns, recommendConcurrency, POD_HOST_LEASE_ANNOTATION, type PoolLeaseMeasure } from './pod-lease.js';
import { podJobManifest } from './self-implement-pod.js';
import { debug } from '../../debug/log.js';

const uncachedProbe = (context: string, kubectl: PoolKubectl) => {
  const dir = mkdtempSync(join(tmpdir(), 'dns-probe-test-'));
  try { return probePoolDns(context, kubectl, { dir }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const gi = 1024 ** 3;
const node = (memory = '263471132Ki', cpu = '32') => JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory, cpu }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
interface FixturePod {
  metadata: { namespace: string; name: string; labels: Record<string, string> };
  status: { phase?: string };
  spec: { nodeName?: string; containers: Array<{ resources: { limits: { memory: string }; requests?: { memory: string } } }>; initContainers?: Array<{ resources: { limits?: { memory: string }; requests?: { memory: string } } }> };
}
let podSerial = 0;
const pod = (phase: string, memory = '16Gi', labeled = true): FixturePod => ({
  metadata: { namespace: 'elanous-test', name: `fixture-${++podSerial}`, labels: labeled ? { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } : {} },
  status: { phase }, spec: { nodeName: 'node-1', containers: [{ resources: { limits: { memory }, requests: { memory } } }] },
});
const fixture = (pods: ReturnType<typeof pod>[], nodes = node()): PoolKubectl => (args) => {
  expect(args.slice(0, 3)).toEqual(['--context', 'node-b', '--request-timeout=10s']);
  expect(args).toContain('get');
  if (args.includes('nodes')) return { status: 0, stdout: nodes, stderr: '' };
  if (args.includes('jobs')) expect(args).toContain('elanous-test');
  else expect(args).toContain('--all-namespaces');
  if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }] }), stderr: '' };
  expect(args).toContain('pods');
  return { status: 0, stdout: JSON.stringify({ items: pods }), stderr: '' };
};
const measured = (pods: ReturnType<typeof pod>[], nodes = node()) => measurePoolLease(parsePodPool('node-b:20'), { kubectl: fixture(pods, nodes), dns: () => 'ready' });
const recommend = (pods: ReturnType<typeof pod>[], accounts = 10, nodes = node()) => recommendConcurrency(measured(pods, nodes), { capacity: 20, accounts, perAccount: 4 });

describe('pod lease measurement and recommendation', () => {
  test('DNS probe requires Ready coredns and one successful in-Pod lookup, then deletes the probe', () => {
    for (const [ready, succeeded] of [[0, true], [1, false], [1, true]] as const) {
      const calls: string[][] = [];
      const kubectl: PoolKubectl = (args, input) => {
        calls.push([...args]);
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: ready } }), stderr: '' };
        if (args.includes('create')) {
          expect(JSON.parse(input!).spec.containers[0].command).toEqual(['nslookup', 'kubernetes.default.svc.cluster.local']);
          expect(JSON.parse(input!).metadata).toMatchObject({ namespace: 'elanous-test', labels: { 'elanous.probe': 'dns' } });
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: succeeded ? 'Succeeded' : 'Failed' } }), stderr: '' };
        return { status: args.includes('wait') && !succeeded ? 1 : 0, stdout: args.includes('logs') ? succeeded ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : 'nslookup: no servers could be reached' : '', stderr: '' };
      };
      expect(uncachedProbe('node-b', kubectl)).toBe(ready === 0 || !succeeded ? 'dns' : 'ready');
      expect(calls.some((args) => args.includes('create'))).toBe(ready === 1);
      expect(calls.at(-1)).toContain('delete');
      expect(calls.every((args) => args[1] === 'node-b')).toBe(true);
    }
  });
  test('a successful member lookup is cached for ten minutes, not shared with another member, and expires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-cache-'));
    let at = 1000, creates = 0;
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('create')) creates++;
      return { status: 0, stdout: args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\nAddress: 10.43.0.1' : '', stderr: '' };
    };
    try {
      const read = (context: string) => probePoolDns(context, kubectl, { dir, now: () => at });
      expect(read('node-b')).toBe('ready');
      at += 599_999;
      expect(read('node-b')).toBe('ready');
      expect(creates).toBe(1);
      expect(read('other')).toBe('ready');
      expect(creates).toBe(2);
      at++;
      expect(read('node-b')).toBe('ready');
      expect(creates).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('DNS failures and unknown readings are never cached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-failure-'));
    let creates = 0;
    const cache = join(dir, `dns-${createHash('sha256').update('node-b').digest('hex')}.cache`);
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('create')) creates++;
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Failed' } }), stderr: '' };
      return { status: 0, stdout: args.includes('logs') ? 'nslookup: no servers could be reached' : '', stderr: '' };
    };
    try {
      expect(probePoolDns('node-b', kubectl, { dir })).toBe('dns');
      expect(existsSync(cache)).toBe(false);
      expect(probePoolDns('node-b', kubectl, { dir })).toBe('dns');
      expect(existsSync(cache)).toBe(false);
      expect(creates).toBe(2);
      expect(probePoolDns('other', () => ({ status: 1, stdout: '', stderr: '' }), { dir })).toBe('unknown');
      expect(probePoolDns('other', kubectl, { dir })).toBe('dns');
      expect(creates).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('concurrent CLI processes measure one member only once under a host lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-parallel-'));
    const bin = join(dir, 'kubectl');
    const calls = join(dir, 'creates');
    writeFileSync(bin, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('deployment')) console.log(JSON.stringify({spec:{replicas:1},status:{readyReplicas:1}}));
else if (args.includes('create')) { appendFileSync(process.env.DNS_CALLS, 'create\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); }
else if (args.includes('get')) console.log(JSON.stringify({status:{phase:'Succeeded'}}));
else if (args.includes('logs')) console.log('Name: kubernetes.default.svc.cluster.local\\nAddress: 10.43.0.1');
`);
    chmodSync(bin, 0o755);
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DNS_CALLS: calls };
    const command = ['bun', '-e', `import { probePoolDns } from ${JSON.stringify(entry)}; console.log(probePoolDns('node-b', undefined, {dir:${JSON.stringify(dir)}}))`];
    try {
      const children = Array.from({ length: 4 }, () => Bun.spawn(command, { env, stdout: 'pipe', stderr: 'pipe' }));
      const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(outputs).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stdout: 'ready\n', stderr: '' })));
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('concurrent DNS failures share one probe, but the next call retries instead of caching failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-failure-parallel-'));
    const calls = join(dir, 'creates');
    const ready = join(dir, 'waiters');
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const script = `
      import { appendFileSync, readFileSync } from 'node:fs';
      import { probePoolDns } from ${JSON.stringify(entry)};
      if (process.env.DNS_WAITER === '1') appendFileSync(${JSON.stringify(ready)}, 'ready\\n');
      const kubectl = (args) => {
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
        if (args.includes('create')) {
          appendFileSync(${JSON.stringify(calls)}, 'create\\n');
          if (process.env.DNS_HOLDER === '1') {
            const end = Date.now() + 10_000;
            while (Date.now() < end) {
              try { if (readFileSync(${JSON.stringify(ready)}, 'utf8').split('ready').length - 1 === 3) break; } catch {}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          }
        }
        return { status: 0, stdout: args.includes('get') ? JSON.stringify({ status: { phase: 'Failed' } }) : args.includes('logs') ? 'nslookup: no servers could be reached' : '', stderr: '' };
      };
      console.log(probePoolDns('node-b', kubectl, { dir: ${JSON.stringify(dir)} }));
    `;
    const command = ['bun', '-e', script];
    const env = { ...process.env };
    const children: Array<ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>> = [];
    try {
      children.push(Bun.spawn(command, { env: { ...env, DNS_HOLDER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(calls)).toBe(true);
      for (let i = 0; i < 3; i++) children.push(Bun.spawn(command, { env: { ...env, DNS_WAITER: '1' }, stdout: 'pipe', stderr: 'pipe' }));
      const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(outputs).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stdout: 'dns\n', stderr: '' })));
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create']);
      const retry = spawnSync('bun', ['-e', script], { env, encoding: 'utf8', timeout: 10_000 });
      expect(retry.status).toBe(0);
      expect(retry.stdout.trim()).toBe('dns');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
    } finally {
      for (const child of children) { child.kill(); await child.exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a process killed while holding the DNS flock before a cache write releases it for the next process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dns-crash-'));
    const key = createHash('sha256').update('node-b').digest('hex');
    const cache = join(dir, `dns-${key}.cache`);
    const lock = join(dir, `dns-${key}.flock`);
    const calls = join(dir, 'creates');
    const entry = resolve(import.meta.dir, 'pod-lease.ts');
    const script = `
      import { appendFileSync } from 'node:fs';
      import { probePoolDns } from ${JSON.stringify(entry)};
      const kubectl = (args) => {
        if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
        if (args.includes('create')) {
          appendFileSync(${JSON.stringify(calls)}, 'create\\n');
          if (process.env.DNS_HOLD === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 360_000);
        }
        return { status: 0, stdout: args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: kubernetes.default.svc.cluster.local\\nAddress: 10.43.0.1' : '', stderr: '' };
      };
      console.log(probePoolDns('node-b', kubectl, { dir: ${JSON.stringify(dir)} }));
    `;
    const command = ['bun', '-e', script];
    const holder = Bun.spawn(command, { env: { ...process.env, DNS_HOLD: '1' }, stdout: 'pipe', stderr: 'pipe' });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(calls) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(calls)).toBe(true);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(cache)).toBe(false);
      const contender = spawnSync('bun', ['-e', `
        import { openSync, closeSync } from 'node:fs';
        import { dlopen } from 'bun:ffi';
        const fd = openSync(${JSON.stringify(lock)}, 'a');
        const flock = dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
          flock: { args: ['int', 'int'], returns: 'int' },
        }).symbols.flock;
        const held = flock(fd, 1 | 4) !== 0;
        if (!held) flock(fd, 8);
        closeSync(fd);
        process.exit(held ? 0 : 1);
      `], { encoding: 'utf8', timeout: 5_000 });
      expect(contender.status).toBe(0);
      holder.kill('SIGKILL');
      await holder.exited;
      expect(existsSync(cache)).toBe(false);
      const start = Date.now();
      const next = spawnSync('bun', ['-e', script], { env: { ...process.env, DNS_HOLD: '0' }, encoding: 'utf8', timeout: 5_000 });
      expect(next.status).toBe(0);
      expect(next.stdout.trim()).toBe('ready');
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['create', 'create']);
      expect(existsSync(cache)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('one member DNS failure contributes zero slots, reason dns; healthy peer remains eligible', () => {
    const kubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : JSON.stringify({ items: [] }), stderr: '' });
    const measure = measurePoolLease(parsePodPool('bad:2,good:2'), { kubectl, dns: (context) => context === 'good' ? 'ready' : 'dns' });
    expect(measure.members.map((m) => [m.context, m.capacity, m.reason])).toEqual([['bad', 0, 'dns'], ['good', 2, null]]);
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 1, perAccount: 4 })).toMatchObject({ recommended: 2, capacitySlots: 2, memorySlots: 4, reason: 'dns' });
  });
  test('DNS probe rejects a succeeded Pod without evidence of the requested DNS answer', () => {
    const kubectl: PoolKubectl = (args) => args.includes('deployment')
      ? { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' }
      : { status: 0, stdout: args.includes('get') ? JSON.stringify({ status: { phase: 'Succeeded' } }) : args.includes('logs') ? 'Name: another.service\nAddress: 10.43.0.1' : '', stderr: '' };
    expect(uncachedProbe('node-b', kubectl)).toBe('dns');
  });
  test('image pull failure is not classified as DNS failure or a measured zero slot', () => {
    const kubectl: PoolKubectl = (args) => {
      if (args.includes('deployment')) return { status: 0, stdout: JSON.stringify({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: JSON.stringify({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }), stderr: '' };
      return { status: args.includes('wait') ? 1 : 0, stdout: '', stderr: '' };
    };
    expect(uncachedProbe('node-b', kubectl)).toBe('image');
    const leaseKubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : JSON.stringify({ items: [] }), stderr: '' });
    const member = measurePoolLease(parsePodPool('node-b:2'), { kubectl: leaseKubectl, dns: (context) => uncachedProbe(context, kubectl) }).members[0]!;
    expect(member).toMatchObject({ capacity: 2, availableMemoryByNodeBytes: null, reason: '측정 불가: dns probe image' });
    expect(recommendConcurrency({ members: [member] }, { capacity: 2, accounts: 1, perAccount: 4 }).recommended).toBeNull();
  });
  test('pool recommended is the sum of per-member free slots: an over-cap member cannot zero another member', () => {
    const member = (context: string, capacity: number, running: number, unleasedRunning = 0): PoolLeaseMeasure['members'][number] => ({
      context, capacity, running, pending: 0, unleasedRunning, memoryLimitBytes: 0, allocatableMemoryBytes: 256 * gi,
      allocatableCpuMillicores: 32_000, availableMemoryByNodeBytes: [256 * gi], reason: null,
    } as PoolLeaseMeasure['members'][number]);
    // node-b runs 21 on a cap of 20 (one leftover Pod) · node-c is idle with cap 1 → one free slot pool-wide.
    expect(recommendConcurrency({ members: [member('node-b', 20, 21), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }))
      .toMatchObject({ recommended: 1, capacitySlots: 1 });
    // The over-cap member's unleased Pods only consume its own (zero) free slots.
    expect(recommendConcurrency({ members: [member('node-b', 20, 21, 21), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }).recommended).toBe(1);
    expect(recommendConcurrency({ members: [member('node-b', 20, 18), member('node-c', 1, 0)] }, { capacity: 21, accounts: 1, perAccount: 4 }).recommended).toBe(3);
  });
  test('DNS-broken member occupancy cannot consume healthy member capacity', () => {
    const kubectl: PoolKubectl = (args) => ({ status: 0, stdout: args.includes('nodes') ? node('64Gi') : args.includes('jobs') ? JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' } } }] }) : JSON.stringify({ items: args[1] === 'bad' ? [pod('Running')] : [] }), stderr: '' });
    const measure = measurePoolLease(parsePodPool('bad:2,good:2'), { kubectl, dns: (context) => context === 'good' ? 'ready' : 'dns' });
    expect(measure.members[0]).toMatchObject({ running: 1, unleasedRunning: 1, reason: 'dns' });
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 1, perAccount: 4 })).toMatchObject({ recommended: 2, capacitySlots: 2, unleasedRunning: 1, reason: 'dns' });
  });
  test('20 slots, 10 Running (6×16Gi + 4×32Gi): memory allows one 16Gi goal', () => {
    const pods = [...Array.from({ length: 6 }, () => pod('Running')), ...Array.from({ length: 4 }, () => pod('Running', '32Gi'))];
    const measuredPool = measured(pods);
    expect(measuredPool.members[0]).toMatchObject({ capacity: 20, running: 10, pending: 0, memoryLimitBytes: 224 * gi, allocatableCpuMillicores: 32_000 });
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, limitedBy: 'memory', capacitySlots: 10, memorySlots: 1, accountSlots: 30 });
    // POD7: the same headroom counted in lite (2Gi / 1Gi) goals is reported separately; recommended stays on the standard size.
    const headroom = measuredPool.members[0]!.allocatableMemoryBytes! - measuredPool.members[0]!.memoryLimitBytes!;
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, liteMemorySlots: Math.floor(headroom / (2 * gi)) });
    expect(recommendConcurrency(measuredPool, { capacity: 20, accounts: 10, perAccount: 4, liteGoalMemory: '1Gi' }).liteMemorySlots).toBe(Math.floor(headroom / gi));
  });
  test('18 Running with plenty of memory: capacity allows two', () => {
    expect(recommend(Array.from({ length: 18 }, () => pod('Running', '1Gi')), 10, node('1024Gi'))).toMatchObject({ recommended: 2, limitedBy: 'capacity' });
  });
  test('Pending occupies capacity; negative slot budgets clamp to zero', () => {
    expect(recommend([pod('Running'), pod('Pending')], 10, node('1024Gi'))).toMatchObject({ running: 1, pending: 1, capacitySlots: 18, recommended: 18, limitedBy: 'capacity' });
    expect(recommend(Array.from({ length: 22 }, () => pod('Running')), 10, node('1024Gi'))).toMatchObject({ capacitySlots: 0, recommended: 0, limitedBy: 'capacity' });
  });
  test('accounts are observed only, never a bound (10-03 decision): zero accounts still recommend by slots and memory', () => {
    expect(recommend([], 0, node('1024Gi'))).toMatchObject({ recommended: 20, limitedBy: 'capacity', accountSlots: 0 });
    expect(recommend(Array.from({ length: 20 }, () => pod('Running')), 0, node('1024Gi'))).toMatchObject({ recommended: 0, limitedBy: 'capacity' });
  });
  test('configured per-goal memory and per-account slots are applied without usage percentages', () => {
    expect(recommendConcurrency(measured([pod('Running')], node('64Gi')), { capacity: 20, accounts: 1, perAccount: 2, perGoalMemory: '32Gi' })).toMatchObject({ memorySlots: 1, accountSlots: 1, recommended: 1 });
  });
  test('unreachable context is unknown, never zero', () => {
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl: () => ({ status: 1, stdout: '', stderr: 'connection refused' }) });
    expect(measure.members[0]).toMatchObject({ running: null, pending: null, allocatableMemoryBytes: null, reason: expect.stringContaining('connection refused') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('host lease admission annotation persists on a Job while its file lease awaits Pod observation', () => {
    const options = { name: 'leased-job', namespace: 'elanous-test', image: 'image', repoUrl: 'repo', args: [], passEnv: [], deadlineSeconds: 60 };
    const leased = podJobManifest({ ...options, hostLeaseAdmitted: true, execution: { key: 'key', attempt: 2 } });
    expect(leased.metadata).toMatchObject({ annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true', 'elanous.dev/attempt': '2' } });
    expect(podJobManifest(options).metadata).not.toHaveProperty('annotations');
  });
  test('two unleased Running legacy Jobs consume two more recommendations; Pending and leased Jobs do not', () => {
    const legacy = [0, 1].map((i) => ({ ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: `legacy-${i}`, labels: { 'elanous.job': `legacy-job-${i}` } } }));
    const leased = { ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: 'leased', labels: { 'elanous.job': 'leased-job' } } };
    const pending = { ...pod('Pending', '1Gi'), metadata: { namespace: 'elanous-test', name: 'pending', labels: { 'elanous.job': 'legacy-job-0' } } };
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [
        ...legacy.map((_, i) => ({ metadata: { name: `legacy-job-${i}`, labels: { 'elanous.substrate': 'pod' } } })),
        { metadata: { name: 'leased-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } },
      ] }) }
      : args.includes('pods') ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [...legacy, leased, pending] }) }
        : { status: 0, stderr: '', stdout: node('1024Gi') };
    const m = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(m.members[0]).toMatchObject({ running: 3, pending: 1, pendingJobs: [{ context: 'node-b', namespace: 'elanous-test', job: 'legacy-job-0' }], unleasedRunning: 2, memoryLimitBytes: 3 * gi });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({
        running: 3, pending: 1, pendingJobs: [{ context: 'node-b', namespace: 'elanous-test', job: 'legacy-job-0' }], unleasedRunning: 2, capacitySlots: 16, placeableSlots: 16, recommended: 14, limitedBy: 'capacity',
      });
      expect(log).toHaveBeenCalledWith('pod-lease', 'unleased', { unleasedRunning: 2, running: 3, recommended: 14 });
    } finally { log.mockRestore(); }
  });
  test('a dns-labeled Pod never counts as a goal even with legacy job labels; its node reservation remains real', () => {
    const probe = { ...pod('Running', '1Gi'), metadata: { namespace: 'elanous-test', name: 'elanous-dns-example', labels: { 'elanous.probe': 'dns', 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } } };
    const result = measured([probe, pod('Running')], node('32Gi'));
    expect(result.members[0]).toMatchObject({ running: 1, pending: 0, unleasedRunning: 0, memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [15 * gi] });
    expect(measured([{ ...probe, status: { phase: 'Pending' } }]).members[0]?.pending).toBe(0);
  });
  test('a Pod with a substrate label and no job label is counted', () => {
    const labeled = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'labeled', labels: { 'elanous.substrate': 'pod' } } };
    expect(measured([labeled]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('finished init container does not add to a Running Pod memory limit', () => {
    const running = { ...pod('Running'), spec: { containers: [{ resources: { limits: { memory: '16Gi' } } }], initContainers: [{ resources: { limits: { memory: '64Gi' } } }] } };
    expect(measured([running]).members[0]?.memoryLimitBytes).toBe(16 * gi);
  });
  test('legacy harness Pod with only elanous.job is counted through the labeled Job', () => {
    const legacy = { ...pod('Running'), metadata: { namespace: 'elanous-test', name: 'legacy', labels: { 'elanous.job': 'harness-job' } } };
    expect(measured([legacy]).members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi });
  });
  test('unlabeled infrastructure Pod is not counted', () => {
    const result = measured([pod('Running', '64Gi', false), pod('Running', '16Gi'), pod('Pending')]);
    expect(result.members[0]).toMatchObject({ running: 1, pending: 1, memoryLimitBytes: 16 * gi });
  });
  test('each member has its own memory budget; unused capacity on a full cluster cannot be borrowed', () => {
    const members = parsePodPool('node-b:20,other:20');
    const kubectl: PoolKubectl = (args) => args[1] === 'node-b'
      ? fixture(Array.from({ length: 10 }, () => pod('Running', '16Gi')), node('160Gi'))(args)
      : { status: 0, stdout: args.includes('nodes') ? node('16Gi') : JSON.stringify({ items: [] }), stderr: '' };
    const measure = measurePoolLease(members, { kubectl, dns: () => 'ready' });
    expect(recommendConcurrency(measure, { capacity: 40, accounts: 10, perAccount: 4 }).memorySlots).toBe(1);
  });
  test('disjoint capacity and memory across clusters never recommend an unplaceable goal', () => {
    const members = parsePodPool('node-b:2,other:2');
    const kubectl: PoolKubectl = (args) => {
      const first = args[1] === 'node-b';
      if (args.includes('nodes')) return { status: 0, stdout: node(first ? '64Gi' : '31Gi'), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: first ? [pod('Running'), pod('Running')] : [pod('Running')] }), stderr: '' };
    };
    const measure = measurePoolLease(members, { kubectl, dns: () => 'ready' });
    expect(measure.members.map((m) => ({ capacity: m.capacity, running: m.running, freeMemory: m.allocatableMemoryBytes! - m.memoryLimitBytes! })))
      .toEqual([{ capacity: 2, running: 2, freeMemory: 32 * gi }, { capacity: 2, running: 1, freeMemory: 15 * gi }]);
    expect(recommendConcurrency(measure, { capacity: 4, accounts: 10, perAccount: 4 })).toMatchObject({
      capacitySlots: 1, memorySlots: 2, placeableSlots: 0, accountSlots: 37, recommended: 0, limitedBy: 'memory',
    });
  });
  test('an unassigned Pending harness Pod occupies a slot but not a node memory reservation', () => {
    const pending = { ...pod('Pending'), spec: { ...pod('Pending').spec, nodeName: '' } };
    const m = measured([pending], node('16Gi'));
    expect(m.members[0]).toMatchObject({ pending: 1, running: 0, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, capacitySlots: 19, placeableSlots: 1 });
  });
  test('a foreign namespace reservation exhausts memory despite empty harness slots', () => {
    const infrastructure = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([infrastructure], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('a foreign Pod limit without an explicit request reserves memory without counting as harness Running', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, containers: [{ resources: { limits: { memory: '16Gi' } } }] } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]).toMatchObject({ running: 0, memoryLimitBytes: 0, availableMemoryByNodeBytes: [0] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory' });
  });
  test('node-local availability reflects the largest init request and Pod overhead without changing Running app limits', () => {
    const running = { ...pod('Running'), spec: { ...pod('Running').spec,
      initContainers: [{ resources: { requests: { memory: '32Gi' } } }], overhead: { memory: '1Gi' } } };
    const m = measured([running], node('48Gi'));
    expect(m.members[0]).toMatchObject({ memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [15 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('a foreign reservation is subtracted once, not once per harness Pod', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign, pod('Running')], node('48Gi'));
    expect(m.members[0]).toMatchObject({ running: 1, memoryLimitBytes: 16 * gi, availableMemoryByNodeBytes: [16 * gi] });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 1, placeableSlots: 1, limitedBy: 'memory' });
  });
  test('node-local reservations cannot be pooled between nodes for a 16Gi goal', () => {
    const nodes = JSON.stringify({ items: [
      { metadata: { name: 'node-1' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'node-2' }, status: { allocatable: { memory: '16Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } },
    ] });
    const first = { ...pod('Running', '8Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const second = { ...first, metadata: { ...first.metadata, name: 'foreign-2' }, spec: { ...first.spec, nodeName: 'node-2' } };
    const m = measured([first, second], nodes);
    expect(m.members[0]?.availableMemoryByNodeBytes).toEqual([8 * gi, 8 * gi]);
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, memorySlots: 2, placeableSlots: 0, limitedBy: 'memory' });
  });
  test('NotReady and cordoned nodes cannot place a goal despite abundant allocatable memory', () => {
    for (const unavailable of [
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'False' }] } },
      { status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { unschedulable: true } },
    ]) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, ...unavailable }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, limitedBy: 'memory', placeableSlots: 0 });
    }
  });
  test('a NoSchedule/NoExecute taint keeps toleration-less harness Jobs off the node; PreferNoSchedule does not', () => {
    for (const effect of ['NoSchedule', 'NoExecute']) {
      const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'dedicated', value: 'gpu', effect }] } }] });
      const m = measured([], nodes);
      expect(m.members[0]).toMatchObject({ allocatableMemoryBytes: 128 * gi, availableMemoryByNodeBytes: [] });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: 0, placeableSlots: 0 });
    }
    const soft = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x', effect: 'PreferNoSchedule' }] } }] });
    expect(measured([], soft).members[0]?.availableMemoryByNodeBytes).toEqual([128 * gi]);
  });
  test('a malformed taint list makes node placement unknown', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] }, spec: { taints: [{ key: 'x' }] } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing node readiness cannot be interpreted as available memory', () => {
    const nodes = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '128Gi', cpu: '32' } } }] });
    expect(recommend([], 10, nodes)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('missing or Unknown phase makes the whole measurement unknown, including foreign Pods', () => {
    for (const status of [{}, { phase: 'Unknown' }]) {
      const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, status };
      const m = measured([foreign], node('32Gi'));
      expect(m.members[0]).toMatchObject({ running: null, pending: null, memoryLimitBytes: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('missing/Unknown phase') });
      expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('측정 불가: cluster') });
    }
  });
  test('duplicate Pod name makes reservations unknown instead of double-counting', () => {
    const duplicate = pod('Running');
    const m = measured([duplicate, duplicate], node('48Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a foreign Pod with invalid reservation cannot turn missing data into free space', () => {
    const foreign = { ...pod('Running', 'bad', false), metadata: { namespace: 'system', name: 'foreign', labels: {} } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('unassigned foreign Running Pod makes memory unknown rather than free', () => {
    const foreign = { ...pod('Running', '16Gi', false), metadata: { namespace: 'system', name: 'foreign', labels: {} }, spec: { ...pod('Running').spec, nodeName: undefined } };
    const m = measured([foreign], node('16Gi'));
    expect(m.members[0]?.availableMemoryByNodeBytes).toBeNull();
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
  test('a failed all-namespace Pod read leaves reservation and recommendation unknown', () => {
    const kubectl: PoolKubectl = (args) => args.includes('pods')
      ? { status: 1, stdout: '', stderr: 'forbidden' } : fixture([])(args);
    const measure = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(measure.members[0]).toMatchObject({ running: null, availableMemoryByNodeBytes: null, reason: expect.stringContaining('forbidden') });
    expect(recommendConcurrency(measure, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null, limitedBy: null });
  });
  test('malformed Job metadata cannot hide legacy harness Pods from the counts', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: JSON.stringify({ items: [{ metadata: { labels: { 'elanous.substrate': 'pod' } } }] }), stderr: '' }
      : fixture([pod('Running')])(args);
    const m = measurePoolLease(parsePodPool('node-b:20'), { kubectl, dns: () => 'ready' });
    expect(m.members[0]).toMatchObject({ running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
    expect(recommendConcurrency(m, { capacity: 20, accounts: 10, perAccount: 4 })).toMatchObject({ recommended: null });
  });
  test('a malformed jobs response does not erase the node reading', () => {
    const kubectl: PoolKubectl = (args) => args.includes('jobs')
      ? { status: 0, stdout: '{bad', stderr: '' } : fixture([])(args);
    const member = measurePoolLease(parsePodPool('node-b:20'), { kubectl }).members[0]!;
    expect(member).toMatchObject({ allocatableCpuMillicores: 32_000, running: null, memoryLimitBytes: null, reason: expect.stringContaining('cluster jobs') });
  });
  test('malformed node or missing Running memory limits are unknown rather than zero', () => {
    expect(measured([pod('Running', '')]).members[0]?.memoryLimitBytes).toBeNull();
    expect(measured([], JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: 'bad', cpu: '32' } } }] })).members[0]?.allocatableMemoryBytes).toBeNull();
  });
});
