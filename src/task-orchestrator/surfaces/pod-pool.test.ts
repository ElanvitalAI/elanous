import { describe, expect, test } from 'bun:test';
import { checkPodPool, genericConfigPodPool, parsePodPool, PodPoolScheduler, resolvePodPoolSpec, syncPoolImage, syncPoolImages, type RemoteRun } from './pod-pool.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { HostPoolLease } from '../../pod-lease/host-lease.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('pod pool — priority ⊕ per-node capacity', () => {
  test('parses context[@ssh][:capacity] in priority order', () => {
    expect(parsePodPool('pool-node-b@node-b:12, k3d-elanous-h1, pool-node-c@node-c:3')).toEqual([
      { context: 'pool-node-b', sshHost: 'node-b', capacity: 12, k3dCluster: 'elanous-pool' },
      { context: 'k3d-elanous-h1', capacity: 2, k3dCluster: 'elanous-h1' },
      { context: 'pool-node-c', sshHost: 'node-c', capacity: 3, k3dCluster: 'elanous-pool' },
    ]);
    expect(() => parsePodPool('a:0')).toThrow('상한은 1 이상');
    expect(() => parsePodPool('a,a')).toThrow('겹친다');
    expect(() => parsePodPool('bad node')).toThrow('못 읽는 노드');
  });

  test('two registry addresses stay attached to their members through lookup and build', async () => {
    const members = parsePodPool('pool-node-b@node-b:2#k3d-elanous-registry:5051,pool-node-c@node-c:2#k3d-elanous-registry:5052');
    const lookups: string[] = [];
    const builds: string[] = [];
    const run: RemoteRun = (host, cmd) => {
      if (cmd.includes('/tags/list')) { lookups.push(`${host} ${cmd}`); return { status: 0, stdout: '{"tags":["abc123"]}', stderr: '' }; }
      if (cmd.includes('docker inspect k3d-')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: 'abc123', stderr: '' };
    };
    const result = await syncPoolImages(members, 'img', 'abc123', { run, remoteBuild: async (host, _cluster, registry) => { builds.push(`${host} ${registry}`); return { ok: true, detail: 'built' }; }, localSkillsDigest: 'different' });
    expect(lookups).toContain('node-b curl -fsS --max-time 5 http://localhost:5051/v2/elanous-harness/tags/list 2>/dev/null');
    expect(lookups).toContain('node-c curl -fsS --max-time 5 http://localhost:5052/v2/elanous-harness/tags/list 2>/dev/null');
    expect(builds.sort()).toEqual(['node-c k3d-elanous-registry:5052', 'node-b k3d-elanous-registry:5051']);
    expect(result.get('pool-node-b')?.imageRef).toBe('k3d-elanous-registry:5051/elanous-harness:abc123');
    expect(result.get('pool-node-c')?.imageRef).toBe('k3d-elanous-registry:5052/elanous-harness:abc123');
    expect(parsePodPool('pool-node-b@node-b:2')[0]?.registry).toBeUndefined();
    expect(() => parsePodPool('pool-node-b@node-b:2#k3d-elanous-registry:65536')).toThrow('65535');
  });

  test('explicit spec wins over env; neither → null (single current context)', () => {
    expect(resolvePodPoolSpec('a:1', { ELANOUS_POD_POOL: 'b:1' }, () => 'c:1')).toBe('a:1');
    expect(resolvePodPoolSpec(undefined, { ELANOUS_POD_POOL: 'b:1' }, () => undefined)).toBe('b:1');
    expect(resolvePodPoolSpec(undefined, {}, () => undefined)).toBeNull();
    expect(resolvePodPoolSpec(undefined, {}, () => 'pool-node-b@node-b:4')).toBe('pool-node-b@node-b:4');   // configured harness pool — «--substrate pod 만» 으로 분배
    expect(resolvePodPoolSpec(undefined, { ELANOUS_POD_POOL: 'b:1' }, () => 'c:1')).toBe('b:1');
  });

  test('fills the first node to capacity before spilling to the next; release reopens a slot', () => {
    const pool = new PodPoolScheduler(parsePodPool('first:2,second:1'));
    const got = [pool.tryAcquire(), pool.tryAcquire(), pool.tryAcquire(), pool.tryAcquire()].map((m) => m?.context ?? null);
    expect(got).toEqual(['first', 'first', 'second', null]);
    pool.release(pool.members[0]!);
    expect(pool.tryAcquire()?.context).toBe('first');
    expect(pool.snapshot()).toEqual({ first: 2, second: 1 });
  });

  test('check drops unreachable nodes with the reason, never silently', () => {
    const kubectl = (args: readonly string[]) => args[1] === 'bad'
      ? { status: 1, stdout: '', stderr: 'Unable to connect to the server: dial tcp: i/o timeout' }
      : { status: 0, stdout: 'elanous-test', stderr: '' };
    const r = checkPodPool(parsePodPool('good:1,bad:1'), kubectl);
    expect(r.ok).toBe(true);
    expect(r.ready.map((m) => m.context)).toEqual(['good']);
    expect(r.dropped).toEqual([{ context: 'bad', reason: 'Unable to connect to the server: dial tcp: i/o timeout' }]);
    expect(checkPodPool(parsePodPool('bad:1'), kubectl).ok).toBe(false);
  });

  test('image sync is a no-op for a local node and for a remote node already on the same commit', () => {
    const run: RemoteRun = () => ({ status: 0, stdout: 'abc123\n', stderr: '' });
    const [local, remote] = parsePodPool('k3d-elanous-h1:1,pool-node-b@node-b:1');
    expect(syncPoolImage(local!, 'img', 'abc123', run)).toMatchObject({ ok: true, action: 'local' });
    expect(syncPoolImage(remote!, 'img', 'abc123', run)).toMatchObject({ ok: true, action: 'fresh' });
  });

  test('every kubectl call of a pooled job carries that node\'s --context, and the slot is released', async () => {
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const pool = new PodPoolScheduler(parsePodPool('pool-node-b@node-b:1'), { status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null, capacitySlots: 1, memorySlots: 1, placeableSlots: 1, running: 0, pending: 0 }) });
    const spawn = podSelfImplementSpawn({
      kubectl, pool, pollMs: 1, imageCommit: null, sleep: async () => {},
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }),
    });
    const done = await spawn({ spaceId: 's1', feature: 'f' } as Parameters<typeof spawn>[0]).done;
    expect(done.exitCode).toBe(0);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((c) => c[0] === '--context' && c[1] === 'pool-node-b')).toBe(true);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('three pooled Job launches share FIFO admission: N=2 holds the third goal', async () => {
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), {
      status: () => ({ recommended: 2, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 3, memorySlots: 3, placeableSlots: 3, running: 0, pending: 0 }),
    });
    const applied: string[] = [];
    const completed = new Set<string>();
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind: string; metadata: { name: string } };
        if (object.kind === 'Job') applied.push(object.metadata.name);
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('get') && args.includes('job') && args.includes('jsonpath={.status.conditions[*].type}')) {
        return { status: 0, stdout: completed.has(args[args.indexOf('job') + 1]!) ? 'Complete' : '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ pool, kubectl, env: {}, repoUrl: 'not-a-github-repository',
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }), pollMs: 2 });
    const controllers = ['ask', 'say', 'self'].map(() => new AbortController());
    const jobs = ['ask', 'say', 'self'].map((spaceId, i) => spawn({ spaceId, feature: spaceId, signal: controllers[i]!.signal } as Parameters<typeof spawn>[0]));
    const waitUntil = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    try {
      await waitUntil(() => applied.length === 2);
      expect(applied[0]).toContain('ask');
      expect(applied[1]).toContain('say');
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1, recommended: 2 });
      await Bun.sleep(10);
      expect(applied).toHaveLength(2);
      completed.add(applied[0]!);
      await jobs[0]!.done;
      await waitUntil(() => applied.length === 3);
      expect(applied[2]).toContain('self');
      completed.add(applied[1]!);
      completed.add(applied[2]!);
      await Promise.all(jobs.slice(1).map((job) => job.done));
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 0 });
      expect(pool.snapshot()).toEqual({ fake: 0 });
    } finally {
      controllers.forEach((controller) => controller.abort());
      for (const name of applied) completed.add(name);
      await Promise.all(jobs.map((job) => job.done));
    }
  });

  test('a Job remains leased after apply until its Pod phase is observed Running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-running-lease-'));
    const host = new HostPoolLease('p', { dir });
    const pool = new PodPoolScheduler(parsePodPool('p:2'), { hostLease: host, pollMs: 2,
      status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }) });
    let phase = 'Pending';
    let applied = false;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') applied = true;
      if (args.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: phase === 'Complete' ? 'Complete' : '', stderr: '' };
      if (args.includes('jsonpath={.items[*].status.phase}')) return { status: 0, stdout: phase, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ pool, kubectl, pollMs: 2, imageCommit: null,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) });
    const controller = new AbortController();
    try {
      const job = spawn({ spaceId: 'pending-phase', feature: 'f', signal: controller.signal } as Parameters<typeof spawn>[0]);
      for (let n = 0; n < 100 && !applied; n++) await Bun.sleep(5);
      expect(applied).toBe(true);
      expect(host.live()).toContainEqual(expect.objectContaining({ stage: 'job' }));
      phase = 'Running';
      for (let n = 0; n < 100 && host.live().length; n++) await Bun.sleep(5);
      expect(host.live()).toHaveLength(0);
      phase = 'Complete';
      await job.done;
    } finally { controller.abort(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('terminal Job without a Running Pod also releases its host lease', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-terminal-lease-'));
    const host = new HostPoolLease('p', { dir });
    const pool = new PodPoolScheduler(parsePodPool('p:2'), { hostLease: host, pollMs: 2,
      status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }) });
    let phase = 'Pending';
    let applied = false;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') applied = true;
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: phase === 'Failed' ? 'Failed' : '', stderr: '' };
      if (args.includes('jsonpath={.items[*].status.phase}')) return { status: 0, stdout: 'Pending', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ pool, kubectl, pollMs: 2, imageCommit: null,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) });
    const controller = new AbortController();
    try {
      const job = spawn({ spaceId: 'terminal-before-running', feature: 'f', signal: controller.signal } as Parameters<typeof spawn>[0]);
      for (let n = 0; n < 100 && !applied; n++) await Bun.sleep(5);
      expect(host.live()).toContainEqual(expect.objectContaining({ stage: 'job' }));
      phase = 'Failed';
      await job.done;
      expect(host.live()).toHaveLength(0);
    } finally { controller.abort(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('pool admission forwards after goal ID and PR number to the dependency gate before reserving a free slot', async () => {
    let merged = false;
    const checked: Array<string | number> = [];
    const pool = new PodPoolScheduler(parsePodPool('fake:2'), {
      status: () => ({ recommended: 2, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
      dependencyMerged: (after) => { checked.push(after); return merged; },
      pollMs: 2,
    });
    const controller = new AbortController();
    const first = pool.acquireAdmission(controller.signal, 'goal-before');
    const second = pool.acquireAdmission(controller.signal, 123);
    try {
      await Bun.sleep(10);
      expect(checked).toContain('goal-before');
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 2, recommended: 2 });
      merged = true;
      const releaseFirst = await first;
      const releaseSecond = await second;
      expect(checked).toContain(123);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 0 });
      releaseFirst(); releaseSecond();
    } finally { controller.abort(); }
  });

  test('Pod Job launch waits for its predecessor even with free pool capacity', async () => {
    let merged = false;
    const checked: Array<string | number> = [];
    const pool = new PodPoolScheduler(parsePodPool('fake:2'), {
      status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 }),
      dependencyMerged: (after) => { checked.push(after); return merged; },
      pollMs: 2,
    });
    const applied: string[] = [];
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const object = JSON.parse(input) as { kind: string; metadata: { name: string } };
        if (object.kind === 'Job') applied.push(object.metadata.name);
      }
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ pool, kubectl, env: {}, repoUrl: 'not-a-github-repository',
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }), pollMs: 2 });
    const controller = new AbortController();
    const job = spawn({ spaceId: 'dependent', feature: 'dependent', after: 123, signal: controller.signal });
    try {
      await Bun.sleep(10);
      expect(checked).toContain(123);
      expect(applied).toEqual([]);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      merged = true;
      const done = await job.done;
      expect(done.exitCode).toBe(0);
      expect(applied).toHaveLength(1);
    } finally { controller.abort(); await job.done; }
  });

  test('an authored lease transfers to admission and remains held after Job apply until Running observation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-pool-transfer-'));
    const oldId = process.env.ELANOUS_POD_RESERVED_LEASE;
    try {
      const starts: Record<number, string> = { 101: 'parent', [process.pid]: 'child' };
      const host = new HostPoolLease('p', { dir, processStart: (pid) => starts[pid] ?? null });
      const parent = new HostPoolLease('p', { dir, pid: 101, processStart: (pid) => starts[pid] ?? null });
      const reservation = parent.tryReserve((n) => n < 2)!;
      process.env.ELANOUS_POD_RESERVED_LEASE = reservation.id;
      const pool = new PodPoolScheduler(parsePodPool('p:2'), { hostLease: host, pollMs: 2, status: () => ({
        recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0,
      }) });
      const release = await pool.acquireAdmission();
      reservation();
      expect(host.live()).toHaveLength(1);
      release.applied('created-job', 'p', 'elanous-test');
      expect(host.live()).toContainEqual(expect.objectContaining({ stage: 'job', job: 'created-job' }));
      release.observed();
      expect(host.live()).toHaveLength(0);
      release();
    } finally {
      if (oldId === undefined) delete process.env.ELANOUS_POD_RESERVED_LEASE;
      else process.env.ELANOUS_POD_RESERVED_LEASE = oldId;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a Pending Job already counted by cluster status does not consume a second host slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-pool-pending-'));
    const starts: Record<number, string> = { 101: 'other', [process.pid]: 'self' };
    const host = new HostPoolLease('p', { dir, processStart: (pid) => starts[pid] ?? null });
    const other = new HostPoolLease('p', { dir, pid: 101, processStart: (pid) => starts[pid] ?? null });
    const pending = other.tryReserve((n) => n < 2)!;
    pending.applied('pending-job', 'p', 'elanous-test');
    try {
      const pool = new PodPoolScheduler(parsePodPool('p:2'), { hostLease: host, pollMs: 2, status: () => ({
        recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 1, memorySlots: 1, placeableSlots: 1, running: 0, pending: 1,
        pendingJobs: [{ context: 'p', namespace: 'elanous-test', job: 'pending-job' }],
      }) });
      const admitted = await pool.acquireAdmission();
      expect(host.live()).toHaveLength(2);
      admitted();
    } finally { pending(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('an observed same-name Pending Pod in another namespace does not make a foreign Job lease free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-pool-scoped-pending-'));
    const starts: Record<number, string> = { 101: 'other', [process.pid]: 'self' };
    const host = new HostPoolLease('p', { dir, processStart: (pid) => starts[pid] ?? null });
    const other = new HostPoolLease('p', { dir, pid: 101, processStart: (pid) => starts[pid] ?? null });
    const lease = other.tryReserve(() => true)!;
    lease.applied('same-name', 'p', 'other-namespace');
    const pool = new PodPoolScheduler(parsePodPool('p:2'), { hostLease: host, pollMs: 2, status: () => ({
      recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
      capacitySlots: 1, memorySlots: 1, placeableSlots: 1, running: 0, pending: 1,
      pendingJobs: [{ context: 'p', namespace: 'elanous-test', job: 'same-name' }],
    }) });
    const controller = new AbortController();
    try {
      const waiting = pool.acquireAdmission(controller.signal).then((release) => { release(); return 'admitted'; }, (error: Error) => error.message);
      await Bun.sleep(12);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      controller.abort();
      expect(await waiting).toBe('pod lease admission aborted');
    } finally { controller.abort(); lease(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('a stale free-slot measurement never admits a third Job before a release', async () => {
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({ recommended: 2,
      accountSlots: 100, limitedBy: 'capacity', reason: null, capacitySlots: 3, memorySlots: 3,
      placeableSlots: 3, running: 0, pending: 0 }), pollMs: 2 });
    const first = await pool.acquireAdmission();
    const second = await pool.acquireAdmission();
    const controller = new AbortController();
    const third = pool.acquireAdmission(controller.signal).catch((error: Error) => error.message);
    try {
      await Bun.sleep(12);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
    } finally {
      controller.abort();
      await third;
      first(); second();
    }
  });

  test('unknown/failed lease reads preserve two active permits across recovery before Jobs become visible', async () => {
    let unavailable: 'null' | 'throw' | null = null;
    const pool = new PodPoolScheduler(parsePodPool('fake:4'), { status: () => {
      if (unavailable === 'throw') throw new Error('lease temporarily unavailable');
      return { recommended: unavailable === 'null' ? null : 2, accountSlots: 99,
        limitedBy: 'capacity', reason: null, capacitySlots: 4, memorySlots: 4,
        placeableSlots: 4, running: 0, pending: 0 };
    }, pollMs: 2 });
    const first = await pool.acquireAdmission();
    const second = await pool.acquireAdmission();
    const controller = new AbortController();
    const third = pool.acquireAdmission(controller.signal).catch((error: Error) => error.message);
    try {
      for (const outage of ['null', 'throw'] as const) {
        unavailable = outage;
        await Bun.sleep(12);
        expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
        unavailable = null;
        await Bun.sleep(12);
        expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1, recommended: 2 });
      }
    } finally {
      controller.abort();
      expect(await third).toBe('pod lease admission aborted');
      first(); second();
    }
  });

  test('a 2→0 recommendation cannot reopen the queued third launch on release', async () => {
    let free = 2;
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({ recommended: free,
      accountSlots: 100, limitedBy: 'capacity', reason: null, capacitySlots: 3, memorySlots: 3,
      placeableSlots: 3, running: 0, pending: 0 }), pollMs: 2 });
    const first = await pool.acquireAdmission();
    const second = await pool.acquireAdmission();
    const controller = new AbortController();
    let thirdAdmitted = false;
    const third = pool.acquireAdmission(controller.signal).then((release) => {
      thirdAdmitted = true;
      return release;
    }, (error: Error) => error.message);
    try {
      free = 0;
      await Bun.sleep(12);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
      first();
      await Bun.sleep(12);
      expect(thirdAdmitted).toBe(false);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 1, queued: 1 });
      free = 1;
      const thirdRelease = await third;
      expect(typeof thirdRelease).toBe('function');
      if (typeof thirdRelease === 'function') thirdRelease();
    } finally {
      controller.abort();
      const pending = await third;
      if (typeof pending === 'function') pending();
      first(); second();
    }
  });

  test('measured free slots stay at N=2 until the first local Job is visible', async () => {
    let visible = 0;
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({ recommended: 2,
      accountSlots: 0, limitedBy: 'capacity', reason: null, capacitySlots: 3, memorySlots: 3,
      placeableSlots: 3, running: visible, pending: 0 }), pollMs: 2 });
    const first = await pool.acquireAdmission();
    const second = await pool.acquireAdmission();
    const controller = new AbortController();
    const third = pool.acquireAdmission(controller.signal).catch((error: Error) => error.message);
    try {
      await Bun.sleep(8);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
      visible = 1;
      await Bun.sleep(8);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 1 });
    } finally {
      controller.abort();
      await third;
      first(); second();
    }
  });

  test('default status reads the lease on the configured pool, not the current context', async () => {
    const calls: string[][] = [];
    const kubectl = (args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'n' }, status: { allocatable: { memory: '64Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: [] }), stderr: '' };
    };
    const pool = new PodPoolScheduler(parsePodPool('configured:2'), { kubectl, dns: () => 'ready' });
    const release = await pool.acquireAdmission();
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.slice(0, 2).join(' ') === '--context configured')).toBe(true);
    release();
  });

  test('a measured rise in free slots admits the oldest queued goal without a local release', async () => {
    let free = 0;
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({ recommended: free,
      accountSlots: 0, limitedBy: 'capacity', reason: null, capacitySlots: 3, memorySlots: 3,
      placeableSlots: 3, running: 0, pending: 0 }), pollMs: 2 });
    const controller = new AbortController();
    const first = pool.acquireAdmission(controller.signal);
    try {
      await Bun.sleep(8);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      free = 1;
      const release = await first;
      expect(pool.admissionSnapshot()).toMatchObject({ active: 1, queued: 0 });
      release();
    } finally { controller.abort(); }
  });

  test('after a lease read fails, a later healthy recommendation reopens the FIFO queue', async () => {
    let unavailable = true;
    const pool = new PodPoolScheduler(parsePodPool('fake:2'), { status: () => {
      if (unavailable) throw new Error('read failed');
      return { recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
        capacitySlots: 2, memorySlots: 2, placeableSlots: 2, running: 0, pending: 0 };
    }, pollMs: 2 });
    const controller = new AbortController();
    const waiting = pool.acquireAdmission(controller.signal);
    try {
      await Bun.sleep(8);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      unavailable = false;
      const release = await waiting;
      expect(pool.admissionSnapshot()).toMatchObject({ active: 1, queued: 0 });
      release();
    } finally { controller.abort(); }
  });

  test('unknown measured lease does not bypass admission with pool capacity', async () => {
    const pool = new PodPoolScheduler(parsePodPool('fake:3'), { status: () => ({ recommended: null,
      accountSlots: 100, limitedBy: null, reason: 'unknown', capacitySlots: 3, memorySlots: null,
      placeableSlots: null, running: null, pending: null }), pollMs: 5 });
    const controller = new AbortController();
    const acquired = pool.acquireAdmission(controller.signal).catch((error: Error) => error.message);
    await Bun.sleep(10);
    expect(pool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1, recommended: 0 });
    controller.abort();
    expect(await acquired).toBe('pod lease admission aborted');
  });

  test('remote nodes sync in parallel via node-side build; a failed build falls back to shipping', async () => {
    const labels = new Map<string, string>([['node-b', 'old'], ['node-c', 'old']]);
    const run: RemoteRun = (host, cmd) => (cmd.includes('k3d-elanous-registry') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${labels.get(host)}\n`, stderr: '' });   // 레지스트리 없는 옛 노드
    const started: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const remoteBuild = async (host: string) => {
      started.push(host); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (host === 'node-c') return { ok: false, detail: 'keychain locked' };
      labels.set(host, 'new');
      return { ok: true, detail: 'built' };
    };
    const ship = (m: { sshHost?: string }) => { labels.set(m.sshHost!, 'new'); return { ok: true, action: 'shipped' as const, detail: 'old → new' }; };
    const r = await syncPoolImages(parsePodPool('k3d-elanous-h1:1,pool-node-b@node-b:2,pool-node-c@node-c:1'), 'img', 'new', { run, remoteBuild, ship, waitMaxMs: 0 });
    expect(maxInFlight).toBe(2);                       // 동시에
    expect(r.get('k3d-elanous-h1')?.action).toBe('local');
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built' });
    expect(r.get('pool-node-c')).toMatchObject({ ok: true, action: 'shipped' });
    expect(r.get('pool-node-c')!.detail).toContain('keychain locked');
    const again = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'new', { run, remoteBuild, ship });
    expect(again.get('pool-node-b')?.action).toBe('fresh');   // 같은 판이면 아무것도 안 한다
  });

  // 델타(대표 2026-09-26): 레지스트리 노드는 «커밋 ⊕ 스킬 해시 ⊕ 레지스트리 태그»가 다 맞아야 fresh — 셋 중 하나라도 어긋나면 다시 굽는다.
  test('registry node: fresh only when commit, skills digest and registry tag all match; Pod gets the registry ref', async () => {
    const state = { commit: 'new', skills: 'sk1', tags: [] as string[] };
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: state.tags }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: `${state.skills}\n`, stderr: '' };
      return { status: 0, stdout: `${state.commit}\n`, stderr: '' };
    };
    let builds = 0;
    const remoteBuild = async () => { builds++; state.tags = ['new']; state.skills = 'sk2'; return { ok: true, detail: 'built' }; };
    const members = parsePodPool('pool-node-b@node-b:2');
    const r1 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk2' });
    expect(r1.get('pool-node-b')).toMatchObject({ action: 'built', imageRef: 'k3d-elanous-registry:5050/elanous-harness:new' });
    const r2 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk2' });
    expect(r2.get('pool-node-b')).toMatchObject({ action: 'fresh', imageRef: 'k3d-elanous-registry:5050/elanous-harness:new' });
    const r3 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk3' });   // 스킬만 바뀌었다
    expect(r3.get('pool-node-b')?.action).toBe('built');
    expect(builds).toBe(2);
  });
  // 🩸 2026-09-26(🅣): 동시 발사가 가변 태그 `:local` 을 남의 판으로 덮어도, 레지스트리에 «이 판 커밋 태그»가 있으면 노드를 빼지 않는다.
  test('concurrent launches overwrite :local — a registry commit tag still counts as synced', async () => {
    const state = { local: 'old', tags: [] as string[] };
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: state.tags }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\n', stderr: '' };
      return { status: 0, stdout: `${state.local}\n`, stderr: '' };
    };
    let shipped = 0;
    const ship = () => { shipped++; return { ok: false, action: 'failed' as const, detail: 'shipped' }; };
    // 내 빌드는 레지스트리에 `mine` 태그를 올렸지만, 그사이 남의 빌드가 `:local` 을 `other` 로 덮었다
    const remoteBuild = async () => { state.tags = ['mine', 'other']; state.local = 'other'; return { ok: true, detail: 'built' }; };
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'mine', { run, remoteBuild, ship, localSkillsDigest: 'sk' });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built', imageRef: 'k3d-elanous-registry:5050/elanous-harness:mine' });
    expect(shipped).toBe(0);
    // 대조군: 레지스트리에 내 태그가 없으면(빌드가 안 올렸다) 종전대로 통째 전송으로 떨어진다
    const state2Build = async () => { state.tags = ['other']; state.local = 'other'; return { ok: true, detail: 'built' }; };
    const r2 = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'mine', { run, remoteBuild: state2Build, ship, localSkillsDigest: 'sk' });
    expect(r2.get('pool-node-b')?.ok).toBe(false);
    expect(shipped).toBe(1);
  });

  // 동시 발사: 노드 쪽 빌드가 부딪혀 실패해도, 같은 판을 굽는 첫째가 레지스트리에 태그를 올리면 그 판을 쓴다.
  test('failed node build waits for the concurrent registry tag and does not ship', async () => {
    const target = 'b95a3c071f5c';
    let lookups = 0;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) { lookups++; return { status: 0, stdout: JSON.stringify({ tags: lookups >= 2 ? [target.slice(0, 12)] : [] }), stderr: '' }; }
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\\n', stderr: '' };
      return { status: 0, stdout: 'old\\n', stderr: '' };
    };
    let shipped = 0;
    const ship = () => { shipped++; return { ok: true, action: 'shipped' as const, detail: 'should not ship' }; };
    const remoteBuild = async () => ({ ok: false, detail: '⛔ pack' });
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', target, { run, remoteBuild, ship, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 5_000 });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built', imageRef: `k3d-elanous-registry:5050/elanous-harness:${target.slice(0, 12)}`, detail: '동시 빌드 결과 사용' });
    expect(shipped).toBe(0);
    expect(lookups).toBeGreaterThanOrEqual(2);
  });

  // 빌드가 성공하면 레지스트리 태그를 기다리지 않고 즉시 끝난다.
  test('a successful node build returns immediately without waiting', async () => {
    let lookups = 0;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) { lookups++; return { status: 0, stdout: JSON.stringify({ tags: ['new'] }), stderr: '' }; }
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\\n', stderr: '' };
      return { status: 0, stdout: 'new\\n', stderr: '' };
    };
    let waited = false;
    const sleep = async () => { waited = true; };
    const remoteBuild = async () => ({ ok: true, detail: 'built' });
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk', sleep, waitIntervalMs: 1, waitMaxMs: 5_000 });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built' });
    expect(waited).toBe(false);
    expect(lookups).toBe(2);   // 발사 전 1번 ⊕ 빌드 직후 1번. 대기 폴링은 없다.
  });

  test('whole-image ship only when this machine label matches the target commit', () => {
    const member = parsePodPool('pool-node-b@node-b:1')[0]!;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('k3d image import')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('elanous.commit')) return { status: 0, stdout: remoteLabel, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    let remoteLabel = 'old';
    let saves = 0;
    const transfer = () => { saves++; remoteLabel = 'targetcommit'; return { status: 0, stderr: '' }; };
    const mismatched = syncPoolImage(member, 'elanous-harness:local', 'targetcommit', { run, inspect: () => ({ status: 0, stdout: 'othercommit' }), transfer });
    expect(mismatched).toMatchObject({ ok: false, action: 'failed', detail: '로컬 이미지 판이 다르다 · 보내지 않음' });
    expect(saves).toBe(0);

    // 대조군: 이 기계 라벨이 목표와 같으면 통째 전송을 한 번 한다.
    const matched = syncPoolImage(member, 'elanous-harness:local', 'targetcommit', { run, inspect: () => ({ status: 0, stdout: 'targetcommit' }), transfer });
    expect(matched.action).toBe('shipped');
    expect(saves).toBe(1);
  });

  test('build failure with no registry tag and a mismatched local commit ships nothing; a match ships once', async () => {
    const target = 'b95a3c071f5c';
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: [] }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk', stderr: '' };
      if (cmd.includes('k3d image import')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('elanous.commit')) return { status: 0, stdout: remoteLabel, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const remoteBuild = async () => ({ ok: false, detail: 'pack-fail' });
    let remoteLabel = 'old';
    let saves = 0;
    const transfer = () => { saves++; remoteLabel = target; return { status: 0, stderr: '' }; };
    const mismatched = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'elanous-harness:local', target, {
      run, remoteBuild, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 0, transfer,
      inspect: () => ({ status: 0, stdout: '30f95cf1aaaa' }),
    });
    expect(mismatched.get('pool-node-b')).toMatchObject({ ok: false, action: 'failed' });
    expect(mismatched.get('pool-node-b')!.detail).toContain('로컬 이미지 판이 다르다 · 보내지 않음');
    expect(saves).toBe(0);

    const matched = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'elanous-harness:local', target, {
      run, remoteBuild, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 0, transfer,
      inspect: () => ({ status: 0, stdout: target }),
    });
    expect(matched.get('pool-node-b')?.action).toBe('shipped');
    expect(saves).toBe(1);
  });
});

test('generic Pod path keeps pod.pool — harness.podPool does not leak into it', () => {
  expect(genericConfigPodPool({ pod: { pool: 'generic:2' }, harness: { podPool: 'harness:20' } })).toBe('generic:2');
  expect(genericConfigPodPool({ harness: { podPool: 'harness:20' } })).toBeUndefined();
});
