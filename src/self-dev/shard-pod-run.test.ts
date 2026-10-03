import { expect, test } from 'bun:test';
import type { PoolLeaseMeasure, PodLeaseMember } from '../task-orchestrator/surfaces/pod-lease.js';
import type { GateTestShard } from './shard-plan.js';
import { runGateShardsOnPod } from './shard-pod-run.js';

const giB = 1024 ** 3;
const member = (context: string, free: number): PodLeaseMember => ({
  context, capacity: 5, running: 0, pending: 0, unleasedRunning: 0, memoryLimitBytes: 0, allocatableMemoryBytes: free * giB,
  allocatableCpuMillicores: 1000, availableMemoryByNodeBytes: [free * giB], reason: null,
});
const pool: PoolLeaseMeasure = { members: [member('pool-node-b', 32), member('pool-node-c', 16)] };
const shards: GateTestShard[] = Array.from({ length: 5 }, (_, i) => ({
  id: `shard-${i + 1}`, files: [`test/f${i + 1}.test.ts`], plannedRssMb: 1024, plannedSeconds: 1,
}));
const xml = (file: string) => `<testsuites tests="1"><testsuite file="${file}" tests="1"><testcase name="case-${file}"/></testsuite></testsuites>`;

test('existing Pod command jobs run five shards on memory-weighted fake members; one failed member moves only its unfinished shard', async () => {
  const calls: Array<{ pool: string; file: string; commit: string }> = [];
  let killed = false;
  const result = await runGateShardsOnPod(shards, pool, 'pool-node-b@node-b:5,pool-node-c@node-c:5', 'a'.repeat(40), 'b'.repeat(40), {
    run: async (options) => {
      const file = options.command.at(-1)!;
      const commit = options.source?.kind === 'commit' ? options.source.sha : '';
      calls.push({ pool: options.pool!, file, commit });
      expect(options.clone).toBe(true);
      expect(options.command.slice(0, 2)).toEqual(['bash', '-c']);
      expect(options.command[2]).toContain('bun test --reporter=junit');
      expect(options.command[2]).toContain('"${@:2}"');
      expect(options.memoryLimit).toBe('4Gi');
      expect([ 'a'.repeat(40), 'b'.repeat(40) ]).toContain(commit);
      if (!killed && options.pool?.startsWith('pool-node-c') && file === 'test/f2.test.ts') {
        killed = true;
        throw new Error('machine unavailable');
      }
      return { exitCode: 0, artifactsDir: `${file}:${commit}`, job: 'fake-job' };
    },
    read: (path) => xml(path.split(':')[0]!),
    measure: () => pool,
  });
  expect(result.aggregate).toEqual({ status: 'passed', retryShardIds: [] });
  expect(result.attempts.filter((attempt) => attempt.attempt === 2).map((attempt) => attempt.shardId)).toEqual(['shard-2']);
  expect(result.placements.find((entry) => entry.shardId === 'shard-2')?.context).toBe('pool-node-b');
  expect(calls.filter((call) => call.file === 'test/f1.test.ts')).toHaveLength(2);
  expect(calls.filter((call) => call.file === 'test/f5.test.ts')).toHaveLength(2);
  expect(result.placements.find((entry) => entry.shardId === 'shard-5')?.context).toBe('pool-node-c');
  expect(calls.filter((call) => call.file === 'test/f2.test.ts').map((call) => call.pool))
    .toEqual(['pool-node-c@node-c:5', 'pool-node-b@node-b:5', 'pool-node-b@node-b:5']);
  expect(calls.filter((call) => call.pool.startsWith('pool-node-b'))).toHaveLength(8);
});

test('unavailable alternate Pod member leaves the failed shard unmeasured without rerunning siblings', async () => {
  const calls: string[] = [];
  const result = await runGateShardsOnPod(shards, pool, 'pool-node-b@node-b:5,pool-node-c@node-c:5', 'a'.repeat(40), 'b'.repeat(40), {
    run: async (options) => {
      const file = options.command.at(-1)!;
      calls.push(file);
      if (file === 'test/f2.test.ts') throw new Error('machine unavailable');
      return { exitCode: 0, artifactsDir: file, job: 'fake-job' };
    },
    read: (path) => xml(path.slice(0, path.indexOf('/shard-'))),
    measure: () => ({ members: [member('pool-node-b', 0), member('pool-node-c', 0)] }),
  });
  expect(result.aggregate).toEqual({ status: 'unmeasured', retryShardIds: ['shard-2'] });
  expect(result.attempts).toHaveLength(5);
  expect(calls.filter((file) => file === 'test/f1.test.ts')).toHaveLength(2);
});
