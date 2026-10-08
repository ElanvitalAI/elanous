import { describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { checkPodPool, genericConfigPodPool, measureMemberOccupancy, parsePodPool, PodPoolScheduler, preferredMembers, type PodPlacement, resolvePodPoolSpec, syncPoolImage, syncPoolImages, type MemberOccupancy, type RemoteRun } from './pod-pool.js';
import { podPlacementKind, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { HostPoolLease } from '../../pod-lease/host-lease.js';
import { loadRunLedger } from '../../self-implement/run-ledger.js';
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

  test('fills members in proportion to their capacity (free share), ties keep spec order; release reopens a slot', async () => {
    const pool = new PodPoolScheduler(parsePodPool('first:2,second:1'), { occupancy: () => ({}) });
    const got = [await pool.tryAcquire(), await pool.tryAcquire(), await pool.tryAcquire(), await pool.tryAcquire()].map((m) => m?.context ?? null);
    expect(got).toEqual(['first', 'second', 'first', null]);
    pool.release(pool.members[0]!);
    expect((await pool.tryAcquire())?.context).toBe('first');
    expect(pool.snapshot()).toEqual({ first: 2, second: 1 });
  });

  test('picks the member with the largest real free share, not the biggest or the first one', async () => {
    const events: Array<Record<string, unknown>> = [];
    const original = debug.log.bind(debug);
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'pod.pool' && event === 'member-selected' && data) events.push(data);
      return original(category, event, data);
    }) as typeof debug.log;
    try {
      const full: Record<string, MemberOccupancy> = { node-b: { occupied: 20 }, node-c: { occupied: 0 } };
      const fullPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => full });
      expect((await fullPool.tryAcquire())?.context).toBe('node-c');
      expect(events.at(-1)).toEqual({ member: 'node-c', free: { node-b: 0, node-c: 4 }, measured: { node-b: true, node-c: true }, share: { node-b: 0, node-c: 1 } });

      const both: Record<string, MemberOccupancy> = { node-b: { occupied: 10 }, node-c: { occupied: 1 } };
      const bothPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => both });
      // POOL-SPREAD: node-b 10/20 free (50%) vs node-c 3/4 free (75%) — the small member is no longer left idle.
      expect((await bothPool.tryAcquire())?.context).toBe('node-c');

      const mostlyFull: Record<string, MemberOccupancy> = { node-b: { occupied: 16 }, node-c: { occupied: 0 } };
      const mostlyFullPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => mostlyFull });
      expect((await mostlyFullPool.tryAcquire())?.context).toBe('node-c');
      const evenPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => ({ node-b: { occupied: 10 }, node-c: { occupied: 2 } }) });
      expect((await evenPool.tryAcquire())?.context).toBe('node-b');

      const failed: Record<string, MemberOccupancy> = { node-b: { occupied: 0 }, node-c: { occupied: null, reason: 'timeout' } };
      const failedPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => failed });
      expect((await failedPool.tryAcquire())?.context).toBe('node-b');
      expect(events.at(-1)?.measured).toEqual({ node-b: true, node-c: false });
      // An unanswered node must not win on a 100% share while a measured node still has room.
      const busyFailed: Record<string, MemberOccupancy> = { node-b: { occupied: 15 }, node-c: { occupied: null, reason: 'timeout' } };
      const busyFailedPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => busyFailed });
      expect((await busyFailedPool.tryAcquire())?.context).toBe('node-b');
      const fullFailed: Record<string, MemberOccupancy> = { node-b: { occupied: 20 }, node-c: { occupied: null, reason: 'timeout' } };
      const fullFailedPool = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => fullFailed });
      expect((await fullFailedPool.tryAcquire())?.context).toBe('node-c');

      const picked: string[] = [];
      for (let n = 0; n < 10; n++) {
        const occupancy: Record<string, MemberOccupancy> = n % 2 === 0
          ? { node-b: { occupied: 20 }, node-c: { occupied: 0 } }
          : { node-b: { occupied: 10 }, node-c: { occupied: 3 } };
        const launch = new PodPoolScheduler(parsePodPool('node-b:20,node-c:4'), { occupancy: () => occupancy });
        const member = await launch.tryAcquire();
        if (member) picked.push(member.context);
      }
      const minihPicks = picked.filter((context) => context === 'node-c').length;
      expect(picked).toHaveLength(10);
      expect(minihPicks).toBeGreaterThanOrEqual(Math.ceil(10 * 4 / 24));
    } finally { debug.log = original; }
  });

  test('POOLGLOBAL-REG: a self-capped (gate) pool counts its own Jobs, not cluster occupancy — 17 occupied · own 1 · cap 8 → 7 free', async () => {
    let reads = 0;
    const occupancy = () => { reads++; return { node-b: { occupied: 17 } } as Record<string, MemberOccupancy>; };
    const gate = new PodPoolScheduler(parsePodPool('node-b:8'), { occupancy });
    const self = { selfCapped: true };
    expect((await gate.tryAcquire(undefined, undefined, self))?.context).toBe('node-b');   // the gate's own Job 1
    const more: Array<string | null> = [];
    for (let i = 0; i < 8; i++) more.push((await gate.tryAcquire(undefined, undefined, self))?.context ?? null);
    expect(more.filter(Boolean)).toHaveLength(7);   // 8 − 1 = 7 free, the cluster's 17 goal Pods do not count
    expect(more.at(-1)).toBeNull();                 // ⊕ the cap still holds
    expect(reads).toBe(0);
    gate.release(gate.members[0]!);
    expect((await gate.tryAcquire(undefined, undefined, self))?.context).toBe('node-b');
    // The ordinary (harness) pool keeps counting cluster occupancy (#24253): the same reading leaves it no slot.
    expect(await new PodPoolScheduler(parsePodPool('node-b:8'), { occupancy }).tryAcquire()).toBeNull();
    expect(reads).toBe(1);
  });

  describe('POOL-LITE — placement by goal kind', () => {
    const SPEC = 'pool-node-b@node-b:40,pool-node-c@node-c:6';
    const place = async (occ: Record<string, MemberOccupancy>, kind: 'lite' | 'standard' | undefined, spec = SPEC, skip?: Set<string>) => {
      const pool = new PodPoolScheduler(parsePodPool(spec), { occupancy: () => occ });
      let placement: PodPlacement | null = null;
      const member = await pool.tryAcquire(skip, undefined, { kind, onPlacement: (p) => { placement = p; } });
      return { member: member?.context ?? null, placement: placement as PodPlacement | null };
    };

    test('a lite goal goes to node-c when it has room — even though node-b has the larger free share', async () => {
      const r = await place({ 'pool-node-b': { occupied: 10 }, 'pool-node-c': { occupied: 3 } }, 'lite');
      expect(r.member).toBe('pool-node-c');
      expect(r.placement).toMatchObject({ member: 'pool-node-c', kind: 'lite', outcome: 'preferred', preferred: ['pool-node-c'] });
      expect(r.placement!.reason).toContain('lite 골 선호 멤버');
    });

    test('an implementation goal goes to node-b even when node-c has the larger free share', async () => {
      const r = await place({ 'pool-node-b': { occupied: 30 }, 'pool-node-c': { occupied: 0 } }, 'standard');
      expect(r.member).toBe('pool-node-b');
      expect(r.placement).toMatchObject({ outcome: 'preferred', preferred: ['pool-node-b'] });
    });

    test('preferred member full → overflow to the other, with the reason', async () => {
      const lite = await place({ 'pool-node-b': { occupied: 10 }, 'pool-node-c': { occupied: 6 } }, 'lite');
      expect(lite.member).toBe('pool-node-b');
      expect(lite.placement).toMatchObject({ outcome: 'overflow' });
      expect(lite.placement!.reason).toContain('pool-node-c(full)');
      const impl = await place({ 'pool-node-b': { occupied: 40 }, 'pool-node-c': { occupied: 1 } }, 'standard');
      expect(impl.member).toBe('pool-node-c');
      expect(impl.placement!.reason).toContain('pool-node-b(full)');
      // LAUNCH-STALL skip of the preferred member also overflows, and says so.
      const skipped = await place({ 'pool-node-b': { occupied: 0 }, 'pool-node-c': { occupied: 0 } }, 'lite', SPEC, new Set(['pool-node-c']));
      expect(skipped.member).toBe('pool-node-b');
      expect(skipped.placement!.reason).toContain('pool-node-c(skipped)');
    });

    test('overflow among several non-preferred members goes by free-slot ratio', async () => {
      const spec = 'big:40,mid:10,small:4';
      const r = await place({ big: { occupied: 30 }, mid: { occupied: 2 }, small: { occupied: 4 } }, 'lite', spec);
      // small full · big 10/40 = 25% · mid 8/10 = 80% → mid.
      expect(r.member).toBe('mid');
      expect(r.placement).toMatchObject({ outcome: 'overflow', preferred: ['small'] });
    });

    test('both full → null; no kind → the unchanged free-share placement', async () => {
      expect((await place({ 'pool-node-b': { occupied: 40 }, 'pool-node-c': { occupied: 6 } }, 'lite')).member).toBeNull();
      const plain = await place({ 'pool-node-b': { occupied: 10 }, 'pool-node-c': { occupied: 3 } }, undefined);
      expect(plain.member).toBe('pool-node-b');   // 75% vs 50% — free share, exactly as before
      expect(plain.placement).toMatchObject({ kind: null, outcome: 'share', preferred: [] });
    });

    test('a throwing placement observer does not leak the slot or fail the acquire', async () => {
      const pool = new PodPoolScheduler(parsePodPool(SPEC), { occupancy: () => ({}) });
      const got = await pool.tryAcquire(undefined, undefined, { kind: 'lite', onPlacement: () => { throw new Error('observer'); } });
      expect(got?.context).toBe('pool-node-c');
      expect(pool.snapshot()).toEqual({ 'pool-node-b': 0, 'pool-node-c': 1 });
      pool.release(got!);
      expect(pool.snapshot()).toEqual({ 'pool-node-b': 0, 'pool-node-c': 0 });
    });

    test('equal capacities give no preference', () => {
      expect(preferredMembers(parsePodPool('a:4,b:4'), 'lite')).toEqual([]);
      expect(preferredMembers(parsePodPool(SPEC), 'lite')).toEqual(['pool-node-c']);
      expect(preferredMembers(parsePodPool(SPEC), 'standard')).toEqual(['pool-node-b']);
      expect(preferredMembers(parsePodPool(SPEC), null)).toEqual([]);
    });

    test('a capacity-0 member is dropped at parse and never chosen — it does not break the launch', async () => {
      expect(parsePodPool('pool-node-b@node-b:40,pool-node-c@node-c:0').map((m) => m.context)).toEqual(['pool-node-b']);
      expect(() => parsePodPool('pool-node-c@node-c:0')).toThrow('상한은 1 이상');
      const r = await place({ 'pool-node-b': { occupied: 0 } }, 'lite', 'pool-node-b@node-b:40,pool-node-c@node-c:0');
      expect(r.member).toBe('pool-node-b');
      // A directly constructed capacity-0 member (bypassing parse) is skipped too — no share division by zero.
      const pool = new PodPoolScheduler([{ context: 'off', capacity: 0, k3dCluster: 'x' }, { context: 'on', capacity: 2, k3dCluster: 'x' }], { occupancy: () => ({}) });
      expect((await pool.tryAcquire(undefined, undefined, { kind: 'lite' }))?.context).toBe('on');
      expect((await pool.tryAcquire(undefined, undefined, { kind: 'lite' }))?.context).toBe('on');
      expect(await pool.tryAcquire(undefined, undefined, { kind: 'lite' })).toBeNull();
    });

    test('goal kind: lite tier and docs/measurement goals are lite; implementation and high are standard', () => {
      expect(podPlacementKind('lite', 'implement', 'code')).toBe('lite');
      expect(podPlacementKind('standard', 'document', null)).toBe('lite');
      expect(podPlacementKind('standard', 'research', null)).toBe('lite');
      expect(podPlacementKind('standard', null, 'docs')).toBe('lite');
      expect(podPlacementKind('standard', 'implement', 'code')).toBe('standard');
      expect(podPlacementKind('high', 'document', 'docs')).toBe('standard');
    });
  });

  test('occupancy reads Running plus Pending per member and marks a failed member unknown, not zero', () => {
    const members = parsePodPool('node-b:20,node-c:4');
    const kubectl = (args: readonly string[]) => {
      if (args[1] === 'node-c') return { status: 1, stdout: '', stderr: 'timeout' };
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'n' }, status: { allocatable: { memory: '64Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'j', labels: { 'elanous.substrate': 'pod' } } }] }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { namespace: 'elanous-test', name: 'a', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'j' } }, status: { phase: 'Running' }, spec: { nodeName: 'n', containers: [{ resources: { limits: { memory: '1Gi' }, requests: { memory: '1Gi' } } }] } },
        { metadata: { namespace: 'elanous-test', name: 'b', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'j' } }, status: { phase: 'Pending' }, spec: { containers: [{ resources: { limits: { memory: '1Gi' }, requests: { memory: '1Gi' } } }] } },
      ] }), stderr: '' };
    };
    const reading = measureMemberOccupancy(members, { kubectl, dns: () => 'ready' });
    expect(reading.node-b).toEqual({ occupied: 2 });
    expect(reading.node-c?.occupied).toBeNull();
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
    const pool = new PodPoolScheduler(parsePodPool('pool-node-b@node-b:1'), { status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null, capacitySlots: 1, memorySlots: 1, placeableSlots: 1, running: 0, pending: 0 }), occupancy: () => ({}) });
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

  test('GATE-RESERVE-AUTO: the gate reservation does not depend on whether two local Pods were observed before, with or after the gate', async () => {
    // 4 cores · capacity 8 (memory and slots are not the bound) · two local permits whose Pods request 1 core each ·
    // a 1-core gate shard. 4 − 1 − 2 = 1 core ⇒ exactly one more admission (the third), the fourth waits — every order.
    const run = async (order: 'pods-first' | 'together' | 'gate-first') => {
      const dir = mkdtempSync(join(tmpdir(), `gate-order-${order}-`));
      const hostLease = new HostPoolLease(`gate-order-${order}`, { dir });
      let gateActive = false;
      let podsVisible = false;
      const kubectl = (args: readonly string[]) => {
        if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node' }, status: { allocatable: { cpu: '4', memory: '512Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
        if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [...(gateActive ? [{ metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } }, spec: { template: { spec: { containers: [{ resources: { requests: { cpu: '1' } } }] } } }, status: { active: 1 } }] : []), { metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { 'elanous.dev/host-lease-admitted': 'true' } } }] }), stderr: '' };
        if (args.includes('top')) return { status: 1, stdout: '', stderr: 'unavailable' };
        const gatePod = { metadata: { name: 'g', namespace: 'elanous-test', labels: { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' } }, status: { phase: 'Running' }, spec: { nodeName: 'node', containers: [{ resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '2Gi' } } }] } };
        return { status: 0, stdout: JSON.stringify({ items: [...(gateActive ? [gatePod] : []), ...(podsVisible ? [0, 1].map((n) => ({ metadata: { name: `h${n}`, namespace: 'elanous-test', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'harness-job' } }, status: { phase: 'Running' }, spec: { nodeName: 'node', containers: [{ resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '2Gi' } } }] } })) : [])] }), stderr: '' };
      };
      // A waiter whose predecessor never merges keeps the admission re-measuring every poll without taking a slot.
      const pool = new PodPoolScheduler(parsePodPool('gate:8'), { kubectl, dns: () => 'ready', hostLease, pollMs: 2, dependencyMerged: () => 'waiting' });
      const controller = new AbortController();
      const watcher = pool.acquireAdmission(controller.signal, 'never-merges').catch(() => null);
      const releases: Array<() => void> = [];
      try {
        const first = await pool.acquireAdmission(controller.signal);
        const second = await pool.acquireAdmission(controller.signal);
        releases.push(first, second);
        const podsUp = () => { podsVisible = true; first.observed(); second.observed(); };
        if (order === 'pods-first') { podsUp(); await Bun.sleep(15); gateActive = true; }
        if (order === 'together') { podsUp(); gateActive = true; }
        if (order === 'gate-first') { gateActive = true; await Bun.sleep(15); podsUp(); }
        await Bun.sleep(15);
        const third = await pool.acquireAdmission(controller.signal);
        releases.push(third);
        const fourth = pool.acquireAdmission(controller.signal).then((release) => { releases.push(release); return 'admitted'; }, () => 'waiting');
        await Bun.sleep(30);
        const snapshot = pool.admissionSnapshot();
        controller.abort();
        return { active: snapshot.active, fourth: await fourth };
      } finally {
        controller.abort();
        await watcher;
        for (const release of releases) release();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    for (const order of ['pods-first', 'together', 'gate-first'] as const) {
      expect({ order, ...await run(order) }).toEqual({ order, active: 3, fourth: 'waiting' });
    }
  });

  test('GATE-RESERVE-AUTO: local Pods measured Pending (not bound yet) are counted once, not again as unseen permits', async () => {
    // 4 cores · a bound 1-core gate · two local permits whose 1-core Pods are Pending without a node ⇒ 4 − 1 − 2 = 1 more.
    const dir = mkdtempSync(join(tmpdir(), 'gate-pending-'));
    const hostLease = new HostPoolLease('gate-pending', { dir });
    let podsPending = false;
    const container = (cpu: string) => [{ resources: { requests: { cpu, memory: '1Gi' }, limits: { memory: '2Gi' } } }];
    const kubectl = (args: readonly string[]) => {
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node' }, status: { allocatable: { cpu: '4', memory: '512Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } }, spec: { template: { spec: { containers: container('1') } } }, status: { active: 1 } },
        ...['h-a', 'h-b'].map((name) => ({ metadata: { name, labels: { 'elanous.substrate': 'pod' }, annotations: { 'elanous.dev/host-lease-admitted': 'true' } } })),
      ] }), stderr: '' };
      if (args.includes('top')) return { status: 1, stdout: '', stderr: 'unavailable' };
      return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: 'g', namespace: 'elanous-test', labels: { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' } }, status: { phase: 'Running' }, spec: { nodeName: 'node', containers: container('1') } },
        ...(podsPending ? ['h-a', 'h-b'].map((job) => ({ metadata: { name: `${job}-pod`, namespace: 'elanous-test', labels: { 'elanous.job': job } }, status: { phase: 'Pending' }, spec: { containers: container('1') } })) : []),
      ] }), stderr: '' };
    };
    const pool = new PodPoolScheduler(parsePodPool('gate:8'), { kubectl, dns: () => 'ready', hostLease, pollMs: 2 });
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    try {
      // Two local permits; their Jobs are applied and their Pods then show up Pending (no node yet).
      for (const job of ['h-a', 'h-b']) {
        const release = await pool.acquireAdmission(controller.signal);
        release.applied(job, 'gate', 'elanous-test');
        releases.push(release);
      }
      podsPending = true;
      const third = await pool.acquireAdmission(controller.signal);
      releases.push(third);
      const fourth = pool.acquireAdmission(controller.signal).then((r) => { releases.push(r); return 'admitted'; }, () => 'waiting');
      await Bun.sleep(20);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 3, queued: 1 });
      controller.abort();
      expect(await fourth).toBe('waiting');
    } finally {
      controller.abort();
      for (const release of releases) release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GATE-RESERVE-AUTO: an injected gate shard Job lowers the admitted count while active and the normal share returns when it ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-reserve-'));
    const hostLease = new HostPoolLease('gate-test', { dir });
    let active = false;
    const kubectl = (args: readonly string[]) => {
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node' }, status: { allocatable: { cpu: '4', memory: '128Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: active ? [{ metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } }, spec: { template: { spec: { containers: [{ resources: { requests: { cpu: '3' } } }] } } }, status: { active: 1 } }] : [] }), stderr: '' };
      if (args.includes('top')) return { status: 1, stdout: '', stderr: 'unavailable' };
      // The shard's Pod is bound and Running on the node (3 of 4 cores).
      return { status: 0, stdout: JSON.stringify({ items: active ? [{ metadata: { name: 'g', namespace: 'elanous-test', labels: { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' } }, status: { phase: 'Running' }, spec: { nodeName: 'node', containers: [{ resources: { requests: { cpu: '3', memory: '1Gi' }, limits: { memory: '2Gi' } } }] } }] : [] }), stderr: '' };
    };
    const pool = new PodPoolScheduler(parsePodPool('gate:4'), { kubectl, dns: () => 'ready', hostLease, pollMs: 2 });
    const controller = new AbortController();
    try {
      active = true;
      const first = await pool.acquireAdmission();
      const second = pool.acquireAdmission(controller.signal);
      await Bun.sleep(15);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 1, queued: 1 });
      active = false;
      const release = await second;
      expect(pool.admissionSnapshot()).toMatchObject({ active: 2, queued: 0 });
      // The normal share is back in full: capacity 4 admits the third and fourth too, the fifth waits.
      const third = await pool.acquireAdmission(controller.signal);
      const fourth = await pool.acquireAdmission(controller.signal);
      const fifth = pool.acquireAdmission(controller.signal).then((r) => { r(); return 'admitted'; }, () => 'waiting');
      await Bun.sleep(15);
      expect(pool.admissionSnapshot()).toMatchObject({ active: 4, queued: 1, recommended: 4 });
      controller.abort();
      expect(await fifth).toBe('waiting');
      third(); fourth(); release();
      first();
    } finally { controller.abort(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('GATE-ADMIT-EXEMPT: with an unscheduled gate shard Job active, a gate caller is admitted by memory while a harness caller is bounded to 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-exempt-'));
    const hostLease = new HostPoolLease('gate-exempt-test', { dir });
    const kubectl = (args: readonly string[]) => {
      if (args.includes('nodes')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'node' }, status: { allocatable: { cpu: '4', memory: '128Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }), stderr: '' };
      if (args.includes('jobs')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'gate-shard', labels: { 'elanous.substrate': 'pod', 'elanous.kind': 'command' } }, spec: { template: { spec: { containers: [{ resources: { requests: { cpu: '3' } } }] } } }, status: { active: 1 } }] }), stderr: '' };
      if (args.includes('top')) return { status: 1, stdout: '', stderr: 'unavailable' };
      // The shard's Pod exists but is not scheduled yet (no nodeName) — GATE-RESERVE-AUTO reads gate CPU as 0 free.
      return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'g', namespace: 'elanous-test', labels: { 'elanous.job': 'gate-shard', 'elanous.kind': 'command' } }, status: { phase: 'Pending' }, spec: { containers: [{ resources: { requests: { cpu: '3', memory: '1Gi' }, limits: { memory: '2Gi' } } }] } }] }), stderr: '' };
    };
    const events: Array<Record<string, unknown>> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((cat: string, ev: string, data?: unknown) => { if (cat === 'pod.pool' && ev === 'gate-reserve') events.push(data as Record<string, unknown>); }) as typeof debug.log;
    const harnessPool = new PodPoolScheduler(parsePodPool('gate:4'), { kubectl, dns: () => 'ready', hostLease, pollMs: 2 });
    const gatePool = new PodPoolScheduler(parsePodPool('gate:4'), { kubectl, dns: () => 'ready', hostLease: new HostPoolLease('gate-exempt-test-gate', { dir }), pollMs: 2 });
    const controller = new AbortController();
    try {
      const harness = harnessPool.acquireAdmission(controller.signal).then((r) => { r(); return 'admitted'; }, () => 'waiting');
      const gate = await Promise.race([gatePool.acquireAdmission(controller.signal, undefined, { gate: true }).then((r) => { r(); return 'admitted'; }), Bun.sleep(500).then(() => 'timeout')]);
      expect(gate).toBe('admitted');
      await Bun.sleep(15);
      expect(harnessPool.admissionSnapshot()).toMatchObject({ active: 0, queued: 1, recommended: 0 });
      controller.abort();
      expect(await harness).toBe('waiting');
      expect(events.some((e) => e.exempt === 'gate-caller')).toBe(true);
      expect(events.some((e) => e.exempt === undefined && e.recommended === 0)).toBe(true);
    } finally { (debug as { log: typeof debug.log }).log = original; controller.abort(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('POOL-LITE: a document launch lands on node-c, prints the placement line, and journals it in the run ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-poollite-'));
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const pool = new PodPoolScheduler(parsePodPool('pool-node-b@node-b:40,pool-node-c@node-c:6'), {
        status: () => ({ recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null, capacitySlots: 46, memorySlots: 46, placeableSlots: 46, running: 0, pending: 0 }),
        // node-b has the larger free share (75% vs 50%) — only the goal kind sends this Job to node-c.
        occupancy: () => ({ 'pool-node-b': { occupied: 10 }, 'pool-node-c': { occupied: 3 } }),
        hostLease: new HostPoolLease('poollite', { dir: join(root, 'lease') }),
      });
      const runId = 'run-poollite-test';
      const spawn = podSelfImplementSpawn({
        kubectl, pool, pollMs: 1, imageCommit: null, sleep: async () => {},
        credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }),
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId, ELANOUS_POD_MEMORY_TIER: 'lite', ELANOUS_POD_MEMORY_REASON: 'goal-type-default', ELANOUS_POD_GOAL_TYPE: 'document' },
      });
      const done = await spawn({ spaceId: 'poollite', feature: 'Write the guide' } as Parameters<typeof spawn>[0]).done;
      expect(done.exitCode).toBe(0);
      // The Job itself must have been submitted — and to node-c (an empty call list would pass `every` vacuously).
      const applies = calls.filter((c) => c.includes('apply'));
      expect(applies.length).toBeGreaterThan(0);
      expect(applies.every((c) => c[0] === '--context' && c[1] === 'pool-node-c')).toBe(true);
      expect(calls.every((c) => c[0] === '--context' && c[1] === 'pool-node-c')).toBe(true);
      expect(warned.some((line) => line.startsWith('[pod] 배치: pool-node-c · lite 골 선호 멤버'))).toBe(true);
      expect(loadRunLedger(runId, join(root, 'run-ledger'))).toContainEqual(expect.objectContaining({
        event: 'pod-placement', data: expect.objectContaining({ member: 'pool-node-c', kind: 'lite', outcome: 'preferred', preferred: ['pool-node-c'] }),
      }));
    } finally { console.warn = originalWarn; rmSync(root, { recursive: true, force: true }); }
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
    // nodes · jobs · pods ⊕ POD-ADMIT-BY-USAGE `top pods` (admission reads usage).
    expect(calls).toHaveLength(4);
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

  // 🩸 2026-10-06 MINIH-PACK: 멤버마다 build.sh 가 같은 트리에서 pack 을 동시에 돌려 한쪽이 «⛔ pack» 으로 빠졌다.
  test('two remote members share one pack; its failure reason reaches the detail; single and fresh members do not pack', async () => {
    const labels = new Map<string, string>([['node-b', 'old'], ['node-c', 'old']]);
    const run: RemoteRun = (host, cmd) => (cmd.includes('k3d-elanous-registry') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${labels.get(host)}\n`, stderr: '' });
    const tgzSeen: (string | undefined)[] = [];
    const remoteBuild = async (host: string, _cluster: string, _registry?: string, tgz?: string) => { tgzSeen.push(tgz); labels.set(host, 'new'); return { ok: true, detail: 'built' }; };
    let packs = 0, cleanups = 0;
    const pack = async () => { packs++; await new Promise((r) => setTimeout(r, 10)); return { ok: true, tgz: '/shared/elanous.tgz', detail: '✓ pack', cleanup: () => { cleanups++; } }; };
    const members = parsePodPool('pool-node-b@node-b:2,pool-node-c@node-c:1');
    const r = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, pack, waitMaxMs: 0 });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built' });
    expect(r.get('pool-node-c')).toMatchObject({ ok: true, action: 'built' });
    expect(packs).toBe(1);
    expect(tgzSeen).toEqual(['/shared/elanous.tgz', '/shared/elanous.tgz']);
    expect(cleanups).toBe(1);
    // 이미 같은 판이면 pack 도 없다.
    const fresh = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, pack });
    expect([...fresh.values()].map((x) => x.action)).toEqual(['fresh', 'fresh']);
    expect(packs).toBe(1);
    // 멤버 하나뿐이면 종전대로 — 나눠 줄 pack 없이 build.sh 가 스스로.
    labels.set('node-b', 'old'); tgzSeen.length = 0;
    await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'new', { run, remoteBuild, pack });
    expect(packs).toBe(1);
    expect(tgzSeen).toEqual([undefined]);
    // pack 이 실패하면 원인 줄이 detail 에 남고, 종전의 통째 전송으로 떨어진다.
    labels.set('node-b', 'old'); labels.set('node-c', 'old');
    const failing = async () => ({ ok: false, detail: "⛔ pack — error: ENOENT: open 'src/version/packed-revision.json'" });
    const ship = (m: { sshHost?: string }) => { labels.set(m.sshHost!, 'new'); return { ok: true, action: 'shipped' as const, detail: 'old → new' }; };
    let builds = 0;
    const failed = await syncPoolImages(members, 'img', 'new', { run, remoteBuild: async () => { builds++; return { ok: true, detail: 'built' }; }, pack: failing, ship, waitMaxMs: 0 });
    expect(builds).toBe(0);
    for (const ctx of ['pool-node-b', 'pool-node-c']) {
      expect(failed.get(ctx)).toMatchObject({ ok: true, action: 'shipped' });
      expect(failed.get(ctx)!.detail).toContain('packed-revision.json');
    }
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
