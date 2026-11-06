import { describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { buildGridData, createGridDataSource } from './grid.js';
import { readHqLease } from '../../hq/hq.js';
import { measurePoolLease } from '../../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, type PoolKubectl } from '../../task-orchestrator/surfaces/pod-pool.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

const record = { holder: 'mbp', generation: 4, acquiredAt: 900, renewedAt: 990, ttlSeconds: 1500 };

describe('read-only grid data', () => {
  test('reads HQ without status marker writes or CAS and joins measured running/pending with configured capacity', () => {
    let reads = 0, writes = 0;
    const hq = { config: { hostName: 'mbp', arbiter: 'local' }, hostPath: '/nonexistent/grid-test-host',
      store: { read: () => { reads++; return { now: 1000, raw: JSON.stringify(record) }; },
        cas: () => { writes++; return false; } }, seenPath: '/nonexistent/grid-test-seen' };
    const pool = parsePodPool('a:3,b:5');
    const result = buildGridData({ hq, poolSpec: () => 'a:3,b:5', measure: (members) => {
      expect(members).toEqual(pool);
      return { members: [
        { context: 'a', capacity: 3, running: 1, pending: 2, reason: null },
        { context: 'b', capacity: 5, running: null, pending: null, reason: 'unreachable' },
      ] as ReturnType<typeof measurePoolLease>['members'] };
    } });
    expect(result).toEqual({ hq: { record, ageSeconds: 10, expired: false, reason: null },
      members: [{ context: 'a', capacity: 3, running: 1, pending: 2, occupied: 3, reason: null },
        { context: 'b', capacity: 5, running: null, pending: null, occupied: null, reason: 'unreachable' }], poolReason: null });
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  test('reports measured effective capacity even when a member capacity differs from configuration', () => {
    expect(buildGridData({ readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      poolSpec: () => 'a:3', measure: () => ({ members: [
        { context: 'a', capacity: 0, running: 1, pending: 0, reason: 'dns' },
      ] as ReturnType<typeof measurePoolLease>['members'] }) }).members).toEqual([
      { context: 'a', capacity: 0, running: 1, pending: 0, occupied: 1, reason: 'dns' },
    ]);
  });

  test('HQ snapshot does not create a seen-generation marker, including when a record exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grid-hq-'));
    try {
      const seenPath = join(dir, 'seen-generation');
      const read = () => readHqLease({ config: { hostName: 'mbp', arbiter: 'local' }, hostPath: join(dir, 'host'), seenPath,
        store: { read: () => ({ now: 1000, raw: JSON.stringify(record) }), cas: () => { throw new Error('read attempted CAS'); } } });
      expect(read()).toEqual({ record, ageSeconds: 10, expired: false });
      expect(existsSync(seenPath)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('no lease differs from unreadable HQ; pool failure does not hide HQ', () => {
    const base = { poolSpec: () => 'a:2' };
    expect(buildGridData({ ...base, readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      measure: () => ({ members: [] }) })).toMatchObject({ hq: { record: null, reason: null },
      members: [{ context: 'a', capacity: 2, occupied: null, reason: '측정 불가' }] });
    expect(buildGridData({ ...base, readHq: () => { throw new Error('arbiter down'); },
      measure: () => { throw new Error('pool down'); } })).toMatchObject({
      hq: { record: null, reason: 'Error: arbiter down' },
      members: [{ context: 'a', capacity: 2, occupied: null, reason: 'Error: pool down' }], poolReason: 'Error: pool down',
    });
  });

  test('skipDnsProbe performs GET-only kubectl reads even with a healthy cluster', () => {
    const calls: string[][] = [];
    const kubectl: PoolKubectl = (args) => {
      calls.push([...args]);
      const items = args.includes('nodes') ? [{ metadata: { name: 'node' }, status: { allocatable: { memory: '32Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } }] : [];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    };
    const grid = buildGridData({ readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      poolSpec: () => 'a:2', kubectl });
    expect(grid).toMatchObject({ hq: { record: null, reason: null },
      members: [{ context: 'a', capacity: 2, running: 0, pending: 0, occupied: 0, reason: null }] });
    expect(calls.map(args => args.slice(args.indexOf('--request-timeout=10s') + 1))).toEqual([
      ['get', 'nodes', '-o', 'json'], ['-n', 'elanous-test', 'get', 'jobs', '-l', 'elanous.substrate=pod', '-o', 'json'],
      ['get', 'pods', '--all-namespaces', '-o', 'json'],
    ]);
  });

  test('GRID async cache responds cold, coalesces refresh, serves stale data, and logs completed measurements', async () => {
    const { createGridDataSource } = await import('./grid.js');
    let calls = 0;
    let clock = 0;
    let resolveMeasurement!: (value: ReturnType<typeof measurePoolLease>) => void;
    const pending = new Promise<ReturnType<typeof measurePoolLease>>((resolve) => { resolveMeasurement = resolve; });
    const logs: unknown[] = [];
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      if (category === 'nexus.grid' && event === 'pool-measure') logs.push(data);
      originalLog(category, event, data as never);
    }) as typeof debug.log;
    try {
      const source = createGridDataSource({ ttlMs: 10, now: () => clock, deps: {
        readHq: () => ({ record: null, ageSeconds: null, expired: null }),
        poolSpec: () => 'a:2',
        measureAsync: () => { calls++; return pending; },
      } });
      const cold = source.read();
      expect(cold.members).toEqual([{ context: 'a', capacity: 2, running: null, pending: null, occupied: null, reason: '측정 불가' }]);
      source.read();
      await Promise.resolve();
      expect(calls).toBe(1);
      let timerFired = false;
      setTimeout(() => { timerFired = true; }, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(timerFired).toBe(true);
      resolveMeasurement({ members: [{ context: 'a', capacity: 2, running: 1, pending: 0, reason: null }] as ReturnType<typeof measurePoolLease>['members'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(source.read().members[0]).toMatchObject({ running: 1, pending: 0, occupied: 1, reason: null });
      expect(logs).toContainEqual({ ms: 0, members: 1, unmeasured: 0 });
      clock = 10;
      expect(source.read().members[0]).toMatchObject({ running: 1, pending: 0, occupied: 1 });
      source.read();
      await Promise.resolve();
      expect(calls).toBe(2);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('GRID async cache retains failed member measurements until the next cycle', async () => {
    const { createGridDataSource } = await import('./grid.js');
    let calls = 0;
    let clock = 0;
    const source = createGridDataSource({ ttlMs: 10, now: () => clock, deps: {
      readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      poolSpec: () => 'a:2',
      measureAsync: async () => {
        calls++;
        return { members: [{ context: 'a', capacity: 2, running: null, pending: null, reason: 'kubectl timeout' }] as ReturnType<typeof measurePoolLease>['members'] };
      },
    } });
    expect(source.read().members[0]).toMatchObject({ occupied: null, reason: '측정 불가' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.read().members[0]).toMatchObject({ occupied: null, reason: 'kubectl timeout' });
    source.read();
    await Promise.resolve();
    expect(calls).toBe(1);
    clock = 10;
    source.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(source.read().members[0]).toMatchObject({ occupied: null, reason: 'kubectl timeout' });
  });

  test('GRID caches pool measurement but refreshes HQ lease state on every read', () => {
    let generation = 1;
    let hqReads = 0;
    let poolReads = 0;
    const source = createGridDataSource({ deps: {
      readHq: () => {
        hqReads++;
        return { record: { holder: 'mbp', generation, acquiredAt: 1, renewedAt: 2, ttlSeconds: 1500 }, ageSeconds: 3, expired: false };
      },
      poolSpec: () => 'cached:2',
      measure: () => {
        poolReads++;
        return { members: [{ context: 'cached', capacity: 2, running: 1, pending: 0, reason: null }] as ReturnType<typeof measurePoolLease>['members'] };
      },
    } });
    expect(source.read().hq.record?.generation).toBe(1);
    generation = 2;
    expect(source.read().hq.record?.generation).toBe(2);
    expect(hqReads).toBe(2);
    expect(poolReads).toBe(1);
  });

  test('GRID async source preserves the existing injected synchronous kubectl boundary', async () => {
    const calls: string[][] = [];
    const source = createGridDataSource({ deps: {
      readHq: () => ({ record: null, ageSeconds: null, expired: null }),
      poolSpec: () => 'injected:2',
      kubectl: args => {
        calls.push([...args]);
        return { status: 0, stdout: args.includes('nodes')
          ? JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '64Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] } }] })
          : JSON.stringify({ items: [] }), stderr: '' };
      },
    } });
    expect(source.read().members[0]).toMatchObject({ context: 'injected', reason: '측정 불가' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(source.read().members[0]).toMatchObject({ context: 'injected', capacity: 2, running: 0, pending: 0, reason: null });
    expect(calls).toHaveLength(3);
  });

  test('GRID async pool measurement times out a stalled GET and runs all reads concurrently', async () => {
    const { measurePoolLeaseAsync } = await import('../../task-orchestrator/surfaces/pod-lease.js');
    const calls: string[][] = [];
    const result = await measurePoolLeaseAsync(parsePodPool('a:2'), {
      timeoutMs: 20,
      kubectl: (args) => { calls.push([...args]); return new Promise(() => {}); },
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.includes('--request-timeout=3s'))).toBe(true);
    expect(result.members[0]).toMatchObject({ context: 'a', running: null, pending: null, reason: 'kubectl timeout' });
  });

  test('GRID-POD-LEASE-ASYNC: actual HTTP returns cold snapshot and health while fake kubectl hangs, then reaps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grid-stalled-kubectl-'));
    const bin = join(dir, 'bin');
    const pidFile = join(dir, 'pids');
    const kubectlPath = join(bin, 'kubectl');
    const oldPath = process.env.PATH;
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const bus = new NexusEventBus();
    state.bus = bus;
    const server = startNexusHttpServer({
      state, eventBus: bus, registry: new TabRegistry(state), startPort: 44000 + Math.floor(Math.random() * 1000),
      metaApi: { bearerToken: 'grid-test-auth', noAuth: false },
      grid: {
        readHq: () => ({ record: null, ageSeconds: null, expired: null }),
        poolSpec: () => 'stalled:2',
      },
    });
    try {
      mkdirSync(bin);
      writeFileSync(kubectlPath, `#!/bin/sh\necho $$ >> '${pidFile}'\ncase "$*" in *'get nodes'*|*'get jobs'*|*'get pods'*) exec sleep 60 ;; *) exit 1 ;; esac\n`);
      chmodSync(kubectlPath, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      const headers = { authorization: 'Bearer grid-test-auth' };
      let timerFired = false;
      setTimeout(() => { timerFired = true; }, 10);
      const started = performance.now();
      const first = await fetch(`${server.url}/v1/grid`, { headers });
      const firstMs = performance.now() - started;
      expect(first.status).toBe(200);
      expect(firstMs).toBeLessThan(3000);
      expect((await first.json() as { members: Array<{ occupied: number | null; reason: string | null }> }).members)
        .toMatchObject([{ occupied: null, reason: '측정 불가' }]);
      const pidDeadline = Date.now() + 500;
      let pids: number[] = [];
      while (Date.now() < pidDeadline) {
        if (existsSync(pidFile)) pids = readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number);
        if (pids.length === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(pids).toHaveLength(3);
      expect(pids.every(alive)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(timerFired).toBe(true);
      const healthStarted = performance.now();
      const health = await fetch(`${server.url}/v1/health`);
      expect(health.status).toBe(200);
      expect(performance.now() - healthStarted).toBeLessThan(100);
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const timedOut = await fetch(`${server.url}/v1/grid`, { headers });
      const finalGrid = await timedOut.json() as { members: Array<{ occupied: number | null; reason: string | null }> };
      expect(finalGrid.members).toMatchObject([{ occupied: null, reason: expect.stringContaining('kubectl timeout') }]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pids.every(pid => !alive(pid))).toBe(true);
    } finally {
      process.env.PATH = oldPath;
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
