import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ExternalResearchResult } from '../../src/research-bridge/types.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { buildMakeDocOutput, buildVerifyEnvelope, buildVerifyOutput, unpackMakeDocEnvelope } from '../../scripts/graph-units/verbs-envelope.js';
import { researchUnitOutput } from '../../scripts/graph-units/verbs/research.js';

const graphPath = resolve(import.meta.dir, 'research-report.yaml');
const researchFixture: ExternalResearchResult = {
  topic: 'Bun v1.4.3 changes and reported build memory result',
  skill: 'omni-crawl',
  startedAt: '2026-10-27T13:00:00.000Z',
  finishedAt: '2026-10-27T13:00:01.000Z',
  durationMs: 1000,
  ok: true,
  output: 'Official notes: v1.4.1/v1.4.2 regression fixes; lower memory for large builds (vendor-reported); [hashN] names. https://bun.sh/blog/bun-v1.4.3',
};

function graphContext(options: { env?: NodeJS.ProcessEnv }): Record<string, unknown> {
  const path = options.env?.ELANOUS_GRAPH_CONTEXT;
  if (!path) throw new Error('missing graph context in event-injected runner');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const output = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 });

test('WORK-COMPOSE-FU: mocked external research records a source envelope, passes it to make-doc, and exits done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-compose-research-'));
  const searchCalls: string[] = [];
  const recipeCommands: string[] = [];
  let documentPrior: Record<string, unknown> | undefined;
  const search = async (query: string): Promise<ExternalResearchResult> => {
    searchCalls.push(query);
    return { ...researchFixture, topic: query };
  };
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const recipe = command.replaceAll('"', '').replaceAll("'", '');
    recipeCommands.push(recipe);
    const context = graphContext(options);
    if (recipe.includes('scripts/graph-units/verbs/research.ts')) {
      const unitInput = context.input as { ask?: string };
      return output(await researchUnitOutput(unitInput.ask ?? '', search));
    }
    if (recipe.includes('scripts/graph-units/verbs-envelope.ts make-doc-input')) {
      return output(unpackMakeDocEnvelope(context.input as { ask?: string; context?: unknown; prior?: unknown }));
    }
    if (recipe.includes('scripts/graph-units/verbs/headless-goal-loop.ts')) {
      const unitInput = context.input as { prior?: Record<string, unknown> };
      documentPrior = unitInput.prior;
      return output({ outcome: 'done', result: 'brief draft', evidence: { changedFiles: ['brief.md'] } });
    }
    if (recipe.includes('scripts/graph-units/verbs-envelope.ts make-doc-output')) return output(buildMakeDocOutput(context as never));
    if (recipe.includes('scripts/graph-units/verbs-envelope.ts verify-envelope')) return output(buildVerifyEnvelope(context as never));
    if (recipe.includes('scripts/graph-units/verbs/verify-stage.ts gate')) return output({ outcome: 'pass', passed: true, 'gate-log': 'event-injected gate pass' });
    if (recipe.includes('scripts/graph-units/verbs/verify-stage.ts review')) return output({ outcome: 'pass', verdict: 'pass', 'must-fix': [], 'review-summary': 'event-injected review pass' });
    if (recipe.includes('scripts/graph-units/verbs-envelope.ts verify-output done')) return output(buildVerifyOutput(context as never, 'done'));
    throw new Error(`unexpected research-report recipe: ${command}`);
  };

  try {
    const result = await runGraph(graphPath, {
      input: { ask: researchFixture.topic, context: { worktree: '/tmp/research-report-output' } },
      deps: { root, runBash },
    });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['research', 'make-doc', 'verify', 'done']);
    expect(result.unitCalls?.find((call) => call.node === 'research')).toMatchObject({ unit: 'verb-research', exit: 'done' });
    expect(searchCalls).toEqual([researchFixture.topic]);
    expect(recipeCommands).toHaveLength(8);
    expect(recipeCommands.every((command) => command.includes('$ELANOUS_GRAPH_DIR/../../../scripts/graph-units/'))).toBe(true);
    expect(documentPrior?.result).toMatchObject({ title: researchFixture.topic, sources: ['https://bun.sh/blog/bun-v1.4.3'] });
    expect(documentPrior?.evidence).toMatchObject({ source: 'omni-crawl', outcome: 'complete' });
    const graph = parseYaml(readFileSync(graphPath, 'utf8')) as { entry_node: string; nodes: Array<{ node_id: string }> };
    expect(graph.entry_node).toBe('research');
    expect(graph.nodes.map(({ node_id }) => node_id)).toContain('research');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
