import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerGraphCommands } from './graph-cli.js';
import { listGraphRuns } from './runner.js';

test('graph run CLI passes the model to a JSON prompt and routes its verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-cli-prompt-'));
  const stateRoot = join(root, 'state');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: cli-json\nversion: 1\nentry_node: judge\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: judge, kind: prompt, recipe: 'prompt:judge', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - from: judge\n    on: outcome\n    map: { approve: done, reject: failed, ok: done, fail: failed }\n`);
  writeFileSync(join(root, 'recipes.yaml'), `judge:\n  prompt: 'Judge the synthetic request'\n  output: { fields: { verdict: [approve, reject], reason: string }, outcome: verdict, retries: 0 }\n`);
  const prompts: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerGraphCommands(program, { root: stateRoot, callLLM: async (prompt: string) => {
    prompts.push(prompt);
    return '{"verdict":"approve","reason":"checks passed"}';
  } });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'test', 'graph', 'run', graph]);
    expect(process.exitCode).toBe(0);
    const { runs } = listGraphRuns(stateRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', path: ['judge', 'done'], nodes: [
      { nodeId: 'judge', ok: true, output: '{"verdict":"approve","reason":"checks passed","outcome":"approve"}' },
      { nodeId: 'done', ok: true },
    ] });
    expect(prompts).toEqual(['Judge the synthetic request\n\nReply with only one JSON object: { "verdict": "approve" | "reject", "reason": string }.']);
  } finally {
    process.exitCode = previousExitCode ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});
