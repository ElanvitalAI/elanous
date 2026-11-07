import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('T0 direct-lane contract rejects stale or incomplete authorization', () => {
  const suite = join(import.meta.dir, '..', 'seat-state', 'OP', 'tools', 'test-gate-tier-lanes.py');
  const result = spawnSync('python3', [suite], { encoding: 'utf8', timeout: 30_000 });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error) throw result.error;
  console.log(output.trim());
  if (result.status !== 0) throw new Error(`Python contract suite failed (status=${result.status}):\n${output}`);
  expect(output).toMatch(/Ran \d+ tests/);
});
