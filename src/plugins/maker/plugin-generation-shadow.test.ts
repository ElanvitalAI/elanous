import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { runGraph } from '../../graph-runner/runner.js';
import { makePlugin } from './plugin-maker.js';

const roots: string[] = [];
const previousStateDir = process.env.ELANOUS_STATE_DIR;
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-generation-shadow-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

function twoNodePlugin(dir: string, slug: string): void {
  const graph = join(dir, 'graphs', `${slug}.yaml`);
  writeFileSync(graph, `graph_id: ${slug}
version: 1
entry_node: main
terminal_nodes: [done, failed]
nodes:
  - { node_id: main, kind: agent, recipe: 'cmd:main', max_visits: 1 }
  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: main, on: outcome, map: { ok: second, fail: failed } }
  - { from: second, on: outcome, map: { ok: done, fail: failed } }
`);
  writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'main:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" main\'\n  timeout_ms: 120000\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n  timeout_ms: 120000\n');
  writeFileSync(join(dir, 'examples', 'input.json'), '{}\n');
  const manifestPath = join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.extensions['ai.elanous'].researchDraft;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

test('generated plugin records one mock shadow cycle with counts, judgment, and a redacted receipt', async () => {
  const root = temp();
  const receipts: Array<{ category: string; event: string; data?: unknown }> = [];
  const unregister = debug.registerSink({ name: 'plugin-generation-shadow-e4-test', emit: record => {
    if (record.category === 'plugin.wizard' && record.event === 'generation-shadow-receipt') receipts.push(record);
  } });
  const input = {
    expectedEventIds: ['EVENT_SENTINEL_A', 'EVENT_SENTINEL_B', 'EVENT_SENTINEL_C', 'EVENT_SENTINEL_D'],
    decisions: [
      { eventId: 'EVENT_SENTINEL_A', action: 'invest' },
      { eventId: 'EVENT_SENTINEL_X', action: 'invest' },
      { eventId: 'EVENT_SENTINEL_B', action: 'hold' },
    ],
  };
  let runState: Awaited<ReturnType<typeof runGraph>> | undefined;
  try {
    const result = await makePlugin({ request: 'PROMPT_SENTINEL investment shadow', name: 'mock-investment-shadow',
      parentDir: join(root, 'plugins-local'), run: true, input, deps: {
        codex: async dir => {
          twoNodePlugin(dir, 'mock-investment-shadow');
          writeFileSync(join(dir, 'graphs', 'run-step.ts'), `import { readFileSync } from 'node:fs';
const context = JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT!, 'utf8'));
const input = context.input ?? {};
if (process.argv[2] === 'main') {
  const expected = new Set(input.expectedEventIds ?? []);
  const decisions = input.decisions ?? [];
  const actionable = new Set(decisions.filter((item: { action: string }) => item.action === 'invest').map((item: { eventId: string }) => item.eventId));
  const record = {
    cycle: 1,
    decisions,
    falsePositiveCount: decisions.filter((item: { action: string; eventId: string }) => item.action === 'invest' && !expected.has(item.eventId)).length,
    missedEventCount: [...expected].filter(eventId => !actionable.has(eventId)).length,
    promotionJudgment: 'remain shadow: one mock cycle is not one day of live evidence',
  };
  console.log(JSON.stringify({ outcome: 'ok', ...record }));
} else {
  console.log(JSON.stringify({ outcome: 'ok', cycleCount: 1, decisionRecord: context.outputs.main }));
}
`);
        },
        runGraph: async (path, options) => {
          runState = await runGraph(path, options);
          return runState;
        },
      } });
    expect(result.status).toBe('ran');
    expect(result.runStatus).toBe('done');
    expect(runState?.nodes.map(node => node.nodeId)).toEqual(['main', 'second', 'done']);
    expect(JSON.parse(runState!.nodes[0]!.output as string)).toMatchObject({
      outcome: 'ok', cycle: 1, falsePositiveCount: 1, missedEventCount: 3,
      promotionJudgment: 'remain shadow: one mock cycle is not one day of live evidence',
    });
    expect(JSON.parse(runState!.nodes[1]!.output as string)).toMatchObject({ outcome: 'ok', cycleCount: 1,
      decisionRecord: { cycle: 1, decisions: input.decisions, falsePositiveCount: 1, missedEventCount: 3,
        promotionJudgment: 'remain shadow: one mock cycle is not one day of live evidence' } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.data).toMatchObject({ slug: 'mock-investment-shadow' });
    expect(Object.keys(receipts[0]!.data!).sort()).toEqual(['slug', 'writtenPaths']);
    const serializedReceipt = JSON.stringify(receipts[0]);
    for (const sentinel of ['PROMPT_SENTINEL', 'EVENT_SENTINEL_A', 'EVENT_SENTINEL_B', 'EVENT_SENTINEL_C', 'EVENT_SENTINEL_D', 'EVENT_SENTINEL_X']) {
      expect(serializedReceipt).not.toContain(sentinel);
    }
  } finally {
    unregister();
  }
});
