import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerGraphCommands } from '../../graph-cli.js';
import { graphTick } from '../../graph-tick.js';
import { latestGraphRun } from '../../runner.js';

test('graph run installs the default market registry and persists a keyless Upbit response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-graph-default-sim-'));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).startsWith('https://api.upbit.com/v1/ticker?')) throw new Error('unexpected_network_request');
    requests += 1;
    return Response.json([{ market: 'KRW-BTC', trade_price: 90000000, timestamp: 1794182400000 }]);
  }) as typeof fetch;
  try {
    const graph = join(root, 'graph.yaml');
    const stateRoot = join(root, 'state');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: market-default-sim\nversion: 1\nentry_node: quote\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: quote, kind: capability, recipe: none, requires: market.crypto@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: quote, on: outcome, map: { ok: done, failed: failed } }\n`);
    const program = new Command();
    registerGraphCommands(program, { root: stateRoot });
    await program.parseAsync(['node', 'test', 'graph', 'run', graph, '--input', '{"market":"KR","symbol":"KRW-BTC"}']);
    const run = latestGraphRun('market-default-sim', stateRoot);
    expect(run?.status).toBe('done');
    expect(JSON.parse(String(run?.nodes[0]?.output))).toMatchObject({ result: { source: 'upbit', value: 90000000 } });
    expect(requests).toBe(1);
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});

test('graph tick installs the default market registry for a scheduled market contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'market-graph-tick-sim-'));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json([{ market: 'KRW-BTC', trade_price: 90000000, timestamp: 1794182400000 }]);
  }) as typeof fetch;
  try {
    const graph = join(root, 'graph.yaml');
    const stateRoot = join(root, 'state');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: market-tick-sim\nversion: 1\nentry_node: quote\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: quote, kind: capability, recipe: none, requires: market.crypto@1, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: quote, on: outcome, map: { ok: done, failed: failed } }\n`);
    const tick = await graphTick(graph, { startIfIdle: true, input: { market: 'KR', symbol: 'KRW-BTC' },
      mineDir: join(root, 'mine'), deps: { root: stateRoot } });
    expect(tick).toMatchObject({ action: 'started', status: 'done' });
    expect(JSON.parse(String(latestGraphRun('market-tick-sim', stateRoot)?.nodes[0]?.output)))
      .toMatchObject({ result: { source: 'upbit', value: 90000000 } });
    expect(requests).toBe(1);
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});
