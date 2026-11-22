import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

test('ELS remote live-turn and silent-host scenarios run through the kernel expectation table', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-els-'));
  try {
    const result = await runSimWorlds({ worldId: 'els', seed: 33, engine: 'legacy', only: null,
      stateRoot: root, runId: 'els-remote-live', expectBaseFile: null, isolate: 'inline' });
    expect(result.ok).toBe(true);
    expect(result.scenarios.map(row => [row.scenario, row.verdict])).toEqual([
      ['E-REMOTE-LIVE-TURN', 'pass'], ['E-REMOTE-TIMEOUT', 'pass'], ['E-HOST-SNAPSHOT-BOUND', 'pass'],
      ['E-LIVE-CWD-OSC7', 'pass'],
    ]);
    for (const row of result.scenarios) {
      expect(existsSync(join(row.dir, 'events.jsonl'))).toBe(true);
      expect(existsSync(join(row.dir, 'verdict.json'))).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
