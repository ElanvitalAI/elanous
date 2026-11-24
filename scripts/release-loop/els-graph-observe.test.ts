// RELEASE-GRAPH-IN-ELS: a release-shaped graph run from a plain process (no TUI, no els pane) shows a graph tab when an
// els server is up; without one the run completes and says so once.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../../src/els/client.js';
import type { ElsPty } from '../../src/els/core.js';
import { elsSocketPath, startElsServer } from '../../src/els/server.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { observeGraphInEls } from './els-graph-observe.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function releaseRun(handlerMs: number): Promise<{ status: string }> {
  const root = tmp('rgo-g-');
  writeFileSync(join(root, 'recipes.yaml'), 'noop:\n  command: "exit 0"\n');
  writeFileSync(join(root, 'graph.yaml'), `graph_id: release-shaped\nversion: 1\nentry_node: cut\nterminal_nodes: [done, failed]\nnodes:
  - { node_id: cut, kind: agent, recipe: handler:cut, max_visits: 1 }
  - { node_id: publish, kind: agent, recipe: handler:publish, max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - { from: cut, on: outcome, map: { ok: publish, fail: failed } }
  - { from: publish, on: outcome, map: { ok: done, fail: failed } }
`);
  const step = async () => { await sleep(handlerMs); return { ok: true, outcome: 'ok' }; };
  return runGraph(join(root, 'graph.yaml'), { runId: 'rgo-run-0001', deps: { root, inProcessHandlers: { cut: step, publish: step } } } as never) as never;
}

test('els server up: the release-shaped run from a plain process opens a graph tab with its nodes, closes after success', async () => {
  const stateRoot = tmp('rgo-els-');
  const started = await startElsServer({ stateRoot, spawn: (): ElsPty => { throw new Error('no pty'); }, childTabs: { tabAfterMs: 200, closeDelayMs: 600, tickMs: 100 } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socketPath = elsSocketPath(stateRoot);
  const logs: string[] = [];
  const observer = observeGraphInEls({ socketPath, env: {}, log: (line) => logs.push(line) });
  const run = releaseRun(400);
  await sleep(500);
  const tab = async () => (JSON.parse((await requestEls(socketPath, { op: 'ls' })).message) as { panes: { title: string }[] }).panes.map((p) => p.title);
  const during = await tab();
  expect(during.some((title) => title.includes('graph · release-shaped'))).toBe(true);
  expect((await run).status).toBe('done');
  await observer.stop();
  const tree = JSON.parse((await requestEls(socketPath, { op: 'child', action: 'tree', ws: 'OP' })).message) as { text: string }[];
  expect(tree.map((row) => row.text)).toEqual(['↳ ⎔ graph · release-shaped · rgo-run-', '  ✅ cut · ok', '  ✅ publish · ok', '  ✅ done · ok']);
  await sleep(900);
  expect((await tab()).some((title) => title.includes('release-shaped'))).toBe(false);
  expect(logs).toEqual([]);
});

test('no els server: the run completes and exactly one log line says why', async () => {
  const logs: string[] = [];
  const observer = observeGraphInEls({ socketPath: join(tmp('rgo-none-'), 'els.sock'), env: {}, log: (line) => logs.push(line) });
  expect((await releaseRun(10)).status).toBe('done');
  await observer.stop();
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain('no els server');
});

test('els server answers with an error / drops: the run completes, one log line only', async () => {
  const stateRoot = tmp('rgo-bad-');
  const started = await startElsServer({ stateRoot, spawn: (): ElsPty => { throw new Error('no pty'); } });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const logs: string[] = [];
  const observer = observeGraphInEls({ socketPath: elsSocketPath(stateRoot), env: {}, log: (line) => logs.push(line),
    request: async () => { throw new Error('ECONNRESET'); } });
  expect((await releaseRun(10)).status).toBe('done');
  await observer.stop();
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain('els request failed (ECONNRESET)');
});
