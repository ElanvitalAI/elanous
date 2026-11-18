import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimWorlds } from '../kernel.js';

test('C7 MCP axis reports the actual held main turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c7-mcp-'));
  try {
    const result = await runSimWorlds({ worldId: 'capsule-events', seed: 1, engine: 'legacy', only: 'C7',
      expectBaseFile: null, stateRoot: root, runId: 'c7-default', isolate: 'inline' });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ scenario: 'C7', actual: 'fail', verdict: 'xfail',
      observedReason: 'silent MCP holds the main turn' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
