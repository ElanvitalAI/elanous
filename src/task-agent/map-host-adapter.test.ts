import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { GraphRunState } from '../graph-runner/runner.js';
import { mapInventory, type MapCard, type MapInventory } from './map-reduce.js';
import { readMapRun } from './map-run-ledger.js';
import { createMapHostLauncher, type HostMapItem } from './map-host-adapter.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const sha = 'a'.repeat(40);
const recipeRoot = resolve(import.meta.dir, '../../graphs/work');
function root(): string { const value = mkdtempSync(join(tmpdir(), 'map-host-')); roots.push(value); return value; }
function draftItem(pr: number, runId: string): HostMapItem {
  const headOid = `${pr}`.padStart(40, 'b');
  const item = { pr, headOid, title: `draft ${pr}` };
  return { id: `pr-${pr}`, graphInput: { mapRunId: runId, snapshotTime: '2026-10-24T00:00:00Z',
    inventoryComplete: true, inventory: { complete: true, snapshotTime: '2026-10-24T00:00:00Z', mainSha: sha,
      items: [item] }, mainSha: sha, item } };
}
function graph(path: string, input: Record<string, unknown>, kind: 'harvest' | 'close-candidate' | 'hold' = 'harvest'): GraphRunState {
  const item = input.item as { pr: number; headOid: string };
  const result = { mapRunId: input.mapRunId, snapshotTime: input.snapshotTime, inventoryComplete: true,
    pr: item.pr, headOid: item.headOid, kind, classification: kind, reason: 'fixture-decision',
    evidence: ['exact head'], writes: [] };
  return { graphId: 'work-draft-close', runId: `run-${item.pr}`, status: 'done', path: ['decide', kind, 'done'],
    nodes: [{ nodeId: kind, ok: true, exit: 0, executed: true,
      output: JSON.stringify({ outcome: 'done', result, evidence: {} }) }],
    input, graphPath: path, sourceHash: sha, statePath: `/tmp/graph-${item.pr}.json`,
    startedAt: '2026-10-24T00:00:01Z', finishedAt: '2026-10-24T00:00:02Z',
    executed: 2, dryRun: false };
}
function card(item: HostMapItem, mapRunId: string): MapCard {
  return { id: `card-${item.id}`, itemId: item.id, mapRunId, recipe: 'draft-close', text: `classify ${item.id}` };
}

test('five snapshot items run as host graphs at concurrency two and bind five ledger rows to cards', async () => {
  const ledgerRoot = root();
  const mapRunId = 'map-host-five';
  const items = Array.from({ length: 5 }, (_, index) => draftItem(index + 1, mapRunId));
  let active = 0, peak = 0;
  const launch = createMapHostLauncher({ recipeRoot, run: async (path, options) => {
    active++; peak = Math.max(peak, active);
    await Bun.sleep(5);
    active--;
    return graph(path, options.input as Record<string, unknown>);
  } });
  const inventory: MapInventory<HostMapItem> = { items, complete: true, snapshotTime: '2026-10-24T00:00:00Z',
    snapshotRef: 'drafts@fixture', recipeSha: sha, mainSha: sha, checklistSnapshotPath: null,
    requestedPool: 'node-b', selectedPool: 'node-b', imageCommit: null };
  const result = await mapInventory({ recipe: 'draft-close', source: 'drafts', mapRunId,
    root: ledgerRoot, dryRun: false, concurrency: 2 }, {
    inventory: async () => inventory,
    buildCard: (item) => card(item, mapRunId), launchCard: launch,
  });
  expect(result).toMatchObject({ expected: 5, observed: 5, dryRun: false });
  expect(peak).toBe(2);
  const rows = readMapRun(mapRunId, ledgerRoot).rows;
  expect(rows).toHaveLength(5);
  expect(rows.every((row) => row.kind === 'harvest' && row.result?.transport === 'host-graph-run'
    && row.result?.cardId === `card-${row.itemId}` && row.podJob === undefined)).toBe(true);
});

test('failed launch, foreign input, and altered emitter identity yield HOLD rows', async () => {
  const mapRunId = 'map-host-hold';
  const item = draftItem(7, mapRunId);
  const context = { mapRunId, recipe: 'draft-close' as const, source: 'drafts' as const, dryRun: false };
  const expected = card(item, mapRunId);
  const failed = createMapHostLauncher({ recipeRoot, run: async () => { throw new Error('private failure'); } });
  expect((await failed(expected, item, context)).reason).toBe('host-graph-launch-failed');
  const foreign = createMapHostLauncher({ recipeRoot, run: async (path, options) => ({
    ...graph(path, options.input as Record<string, unknown>), input: { foreign: true },
  }) });
  expect((await foreign(expected, item, context)).reason).toBe('host-graph-provenance-mismatch');
  const altered = createMapHostLauncher({ recipeRoot, run: async (path, options) => {
    const state = graph(path, options.input as Record<string, unknown>);
    state.nodes[0]!.output = JSON.stringify({ outcome: 'done', result: {
      mapRunId, snapshotTime: item.graphInput.snapshotTime, pr: 8, headOid: item.graphInput.item &&
        (item.graphInput.item as { headOid: string }).headOid, kind: 'harvest', reason: 'wrong PR', evidence: ['wrong'] } });
    return state;
  } });
  expect((await altered(expected, item, context)).reason).toBe('host-graph-result-invalid');
});

test('green candidate requires E1 E2 E3 proof and the exact snapshot PR URL', async () => {
  const item: HostMapItem = { id: 'CELL-1', graphInput: { cellId: 'CELL-1', version: '0.2.37', title: 'fixture',
    paths: ['src/a.ts', 'src/a.test.ts'], candidates: [{ pr: 42, prUrl: 'https://github.com/example/repo/pull/42' }],
    main: { ref: 'origin/main', sha } } };
  const expected: MapCard = { id: 'card-cell-1', itemId: item.id, mapRunId: 'map-green', recipe: 'green-close', text: 'verify' };
  const context = { mapRunId: expected.mapRunId, recipe: expected.recipe, source: 'landed-but-yellow' as const, dryRun: false };
  const run = async (path: string, options: { input?: unknown }): Promise<GraphRunState> => ({
    graphId: 'green-close', runId: 'run-green', status: 'done', path: ['e1', 'e2', 'e3', 'produce', 'boundary', 'result', 'done'],
    nodes: [
      { nodeId: 'e1', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'pass', pr: 42, mergeSha: sha }) },
      { nodeId: 'e2', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'pass', command: 'bun test src/a.test.ts', exitCode: 0 }) },
      { nodeId: 'e3', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'pass', reason: 'asserted' }) },
      { nodeId: 'produce', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'pass', proofRef: 'boundary-proofs/CELL-1/run-green.json' }) },
      { nodeId: 'boundary', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'pass', reason: 'boundary-proven' }) },
      { nodeId: 'result', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', cellId: 'CELL-1', version: '0.2.37',
        kind: 'green-candidate', reason: 'proof complete', pr: 42, mergeSha: sha, evidence: ['E1', 'E2', 'E3'] }) },
    ], input: options.input, graphPath: path, statePath: '/tmp/green-state.json', sourceHash: sha,
    executed: 6, dryRun: false });
  const row = await createMapHostLauncher({ recipeRoot, run })(expected, item, context);
  expect(row).toMatchObject({ kind: 'green-candidate', pr: 42, e1: { verdict: 'pass', mainAncestor: true },
    e2: { verdict: 'pass', exitCode: 0 }, e3: { verdict: 'pass' }, result: { transport: 'host-graph-run', cardId: expected.id } });
  item.graphInput.candidates = [{ pr: 42 }];
  expect((await createMapHostLauncher({ recipeRoot, run })(expected, item, context)).kind).toBe('hold');
  item.graphInput.candidates = [{ pr: 42, prUrl: 'https://github.com/example/repo/pull/42' }];
  const missingBoundary = createMapHostLauncher({ recipeRoot, run: async (path, options) => {
    const state = await run(path, options);
    state.nodes = state.nodes.filter((node) => node.nodeId !== 'boundary');
    return state;
  } });
  expect((await missingBoundary(expected, item, context)).kind).toBe('hold');
  const missingProducer = createMapHostLauncher({ recipeRoot, run: async (path, options) => {
    const state = await run(path, options);
    state.nodes = state.nodes.filter((node) => node.nodeId !== 'produce');
    return state;
  } });
  expect((await missingProducer(expected, item, context)).kind).toBe('hold');
});
