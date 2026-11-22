import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

test('ELS remote SSH refusal and disconnect scenarios have registered green kernel receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-els-remote-'));
  try {
    const result = await runSimWorlds({ worldId: 'els-remote', seed: 33, engine: 'legacy', only: null,
      stateRoot: root, runId: 'ssh-refusal', expectBaseFile: null, isolate: 'inline' });
    expect(result.ok).toBe(true);
    expect(result.scenarios.map(row => [row.scenario, row.verdict])).toEqual([
      ['SSH-HOST-KEY-MISMATCH', 'pass'], ['SSH-UNREGISTERED', 'pass'], ['SSH-DISCONNECT', 'pass'],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
