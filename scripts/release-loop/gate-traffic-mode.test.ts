import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithReleaseGateTraffic } from './gate-traffic-mode.js';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('release gate failure exit restores the previous global traffic mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-traffic-'));
  scratch.push(root);
  const path = join(root, 'traffic.json');
  writeFileSync(path, JSON.stringify({ global: 'green', versions: ['0.2.35'], hold: ['KEEP'], reason: 'before', updatedAt: 'old' }));
  const env = { ELANOUS_TRAFFIC_SIGNAL: path,
    ELANOUS_GRAPH_CONTEXT: JSON.stringify({ graphId: 'release-loop', nodeId: 'gate', runId: 'run-failure', input: {} }) };

  const exitCode = await runWithReleaseGateTraffic(env, async () => {
    expect(JSON.parse(readFileSync(path, 'utf8')).global).toBe('gate');
    return 1;
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ global: 'green', versions: ['0.2.35'], hold: ['KEEP'], reason: 'release gate finished' });
});
