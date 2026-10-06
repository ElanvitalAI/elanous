import { describe, expect, test } from 'bun:test';
import { buildGridData } from './grid.js';
import { readHqLease } from '../../hq/hq.js';
import { measurePoolLease } from '../../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool, type PoolKubectl } from '../../task-orchestrator/surfaces/pod-pool.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
