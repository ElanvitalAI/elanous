// ELS-GRAPH-LIVE-VIEW real flow: a real graph run (runGraph, in-process handler that reports node-progress) → the
// runner's process-wide listeners → wireElsGraphProducer → els child requests → the child tree the sidetab reads.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake, runGraph } from '../graph-runner/runner.js';
import { createChildTabs } from './child-tabs.js';
import { requestEls } from './client.js';
import type { ElsPty, ElsResult } from './core.js';
import { wireElsGraphProducer } from './graph-producer.js';
import { dispatchChild, elsSocketPath, startElsServer, type ElsRequest } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sources = { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake };

/** verify (handler: reports progress, then waits for `release`) → build (bash) → done. */
function graphFixture(): string {
  const root = tempDir('els-graph-live-');
  writeFileSync(join(root, 'recipes.yaml'), 'build:\n  command: "exit 0"\n');
  writeFileSync(join(root, 'graph.yaml'), `graph_id: live-graph\nversion: 1\nentry_node: verify\nterminal_nodes: [done, failed]\nnodes:
  - { node_id: verify, kind: agent, recipe: handler:verify, max_visits: 1 }
  - { node_id: build, kind: agent, recipe: 'cmd:build', max_visits: 1 }
  - { node_id: done, kind: gate, max_visits: 1 }
  - { node_id: failed, kind: gate, max_visits: 1 }
edges:
  - from: verify
    on: outcome
    map: { ok: build, fail: failed }
  - from: build
    on: outcome
    map: { ok: done, fail: failed }
`);
  return root;
}

function startRun(root: string, runId: string) {
  let release: () => void = () => {};
  let reported: () => void = () => {};
  const progressed = new Promise<void>((resolve) => { reported = resolve; });
  const run = runGraph(join(root, 'graph.yaml'), { runId, deps: { root,
    runBash: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    inProcessHandlers: { verify: async (context: { reportProgress?: (p: object) => Promise<void> }) => {
      await context.reportProgress?.({ round: 2, phase: 'repair', result: { pass: 3, fail: 1 }, target: 'backend/booking.test.ts' });
      reported();
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, outcome: 'ok' };
    } } } as never });
  return { run, progressed, release: () => release() };
}

test('real els server: a running graph shows its node chain and progress note with ●, then ✓ for every node at the end', async () => {
  const stateRoot = tempDir('els-gl-srv-');
  const noPty = (): ElsPty => { throw new Error('no PTY in this test'); };
  const started = await startElsServer({ stateRoot, spawn: noPty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(stateRoot);
  expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
  const producer = wireElsGraphProducer({ ws: 'OP', socketPath: socket, sources, request: requestEls });
  cleanups.push(() => producer.dispose());
  const tree = async (): Promise<[string, string][]> => {
    await producer.idle();
    const answer = await requestEls(socket, { op: 'child', action: 'tree', ws: 'OP' });
    return (JSON.parse(answer.message) as { state: string; text: string }[]).map((row) => [row.state, row.text]);
  };

  const live = startRun(graphFixture(), 'liverun1-0001');
  await live.progressed;
  expect(await tree()).toEqual([
    ['working', '↳ ⎔ graph · live-graph · liverun1'],
    ['working', '  ● verify · r2 · repair · fail 1 · pass 3 · backend/booking.test.ts'],
  ]);
  live.release();
  expect((await live.run).status).toBe('done');
  expect(await tree()).toEqual([
    ['done', '↳ ⎔ graph · live-graph · liverun1'],
    ['done', '  ✓ verify · ok'],
    ['done', '  ✓ build · ok'],
    ['done', '  ✓ done · ok'],
  ]);
});

test('liveness of a running node follows the clock: ● within 5 min, ◐ to 25 min, ✕ past it; the run tab text carries the chain', async () => {
  let now = 0;
  const timers: (() => void)[] = [];
  const tabText: string[] = [];
  const core = {
    openVirtual: () => ({ exitCode: 0 as const, message: JSON.stringify({ pane: 'p1' }) }),
    patchVirtual: (_pane: string, patch: { text?: string }) => { if (patch.text !== undefined) tabText.push(patch.text); return { exitCode: 0 as const, message: 'ok' }; },
    closeVirtual: () => ({ exitCode: 0 as const, message: 'ok' }),
  };
  const tabs = createChildTabs({ core: core as never, now: () => now, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const request = async (_socket: string, req: ElsRequest): Promise<ElsResult> => req.op === 'child' ? dispatchChild(tabs, req) : { exitCode: 2, message: 'no' };
  const producer = wireElsGraphProducer({ ws: 'W', socketPath: '/unused', sources, request });
  cleanups.push(() => producer.dispose());
  const node = async (): Promise<string> => { await producer.idle(); return tabs.tree('W').find((row) => row.depth === 1)!.text; };

  const live = startRun(graphFixture(), 'clockrun-0002');
  await live.progressed;
  now = 300_000; expect(await node()).toBe('  ● verify · r2 · repair · fail 1 · pass 3 · backend/booking.test.ts');
  now = 300_001; expect(await node()).toBe('  ◐ verify · r2 · repair · fail 1 · pass 3 · backend/booking.test.ts');
  now = 1_500_001; expect(await node()).toBe('  ✕ verify · r2 · repair · fail 1 · pass 3 · backend/booking.test.ts');
  for (const fire of timers.splice(0)) fire(); // the run outlived tabAfterMs: it gets its own tab
  expect(tabText.at(-1)).toBe('  ✕ verify · r2 · repair · fail 1 · pass 3 · backend/booking.test.ts');
  live.release();
  expect((await live.run).status).toBe('done');
  await producer.idle();
  // The run's own end line first, then its chain one level in.
  expect(tabText.at(-1)).toBe('✓ done\n  ✓ verify · ok\n  ✓ build · ok\n  ✓ done · ok');
});

test('no els server: requests fail and the graph run still finishes', async () => {
  const sent: string[] = [];
  const producer = wireElsGraphProducer({ ws: 'W', socketPath: '/nowhere.sock', sources,
    request: async (_socket, req) => { sent.push(req.op === 'child' ? req.action : req.op); throw new Error('ECONNREFUSED'); } });
  cleanups.push(() => producer.dispose());
  const live = startRun(graphFixture(), 'noserver-0003');
  await live.progressed;
  live.release();
  expect((await live.run).status).toBe('done');
  await producer.idle();
  expect(sent).toEqual(['start', 'start', 'progress', 'end', 'start', 'end', 'start', 'end', 'end']);
});
