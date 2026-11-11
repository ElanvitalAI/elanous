import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerGraphCommands } from '../../graph-cli.js';
import { graphTick } from '../../graph-tick.js';
import { latestGraphRun } from '../../runner.js';
import { createFinnhubDeclarations } from './finnhub.js';
import { marketDataRegistry } from './registry.js';

test('graph run command executes a market contract through the injected provider registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-graph-cli-sim-'));
  try {
    const graph = join(root, 'graph.yaml');
    const stateRoot = join(root, 'state');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: market-cli-sim\nversion: 1\nentry_node: quote\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: quote, kind: capability, recipe: none, requires: market.quote@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: quote, on: outcome, map: { ok: done, failed: failed } }\n`);
    let requests = 0;
    const registry = marketDataRegistry(createFinnhubDeclarations({ apiKey: 'fixture-key', fetcher: async () => {
      requests += 1;
      return { ok: true, json: async () => ({ c: 260.5, t: 1794182400 }) };
    } }));
    const program = new Command();
    registerGraphCommands(program, { root: stateRoot, capabilityProviders: registry });
    await program.parseAsync(['node', 'test', 'graph', 'run', graph, '--input', '{"market":"US","symbol":"AAPL"}']);
    const run = latestGraphRun('market-cli-sim', stateRoot);
    expect(run?.status).toBe('done');
    expect(JSON.parse(String(run?.nodes[0]?.output))).toMatchObject({ result: { source: 'finnhub', price: 260.5 } });
    expect(requests).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
