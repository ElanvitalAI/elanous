import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(['fail', 'error'] as const)('heal-loop sends observe-deeper %s to explicit human approval', async (outcome) => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-heal-observe-failure-'));
  roots.push(root);
  const graphPath = join(import.meta.dir, '../../graphs/heal/heal-loop.yaml');
  const graphSource = readFileSync(graphPath, 'utf8').replace('entry_node: collect', 'entry_node: observe-deeper');
  let dispatched = 0;

  const result = await runGraph(graphPath, {
    runId: `observe-deeper-${outcome}`,
    graphSource,
    deps: {
      root,
      runBash: async (command) => {
        expect(command).toContain('observe-deeper');
        dispatched++;
        return { stdout: JSON.stringify({ outcome }), stderr: 'simulated deeper-observation failure', exitCode: 1 };
      },
    },
  });

  expect(dispatched).toBe(1);
  expect(result.status).toBe('awaiting-approval');
  expect(result.path).toEqual(['observe-deeper', 'observe-deeper-human']);
  expect(result.pending?.nodeId).toBe('observe-deeper-human');
});
