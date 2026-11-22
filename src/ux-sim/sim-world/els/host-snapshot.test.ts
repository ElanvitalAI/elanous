import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

test('ELS worker_hosts snapshot device executes the registered kernel expectation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-els-hosts-'));
  try {
    const result = await runSimWorlds({ worldId: 'els', seed: 33, engine: 'legacy', only: 'E-HOST-SNAPSHOT-BOUND',
      stateRoot: root, runId: 'els-worker-host-snapshot', expectBaseFile: null, isolate: 'inline' });
    expect(result.ok).toBe(true);
    expect(result.scenarios.map(row => [row.scenario, row.verdict])).toEqual([['E-HOST-SNAPSHOT-BOUND', 'pass']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
