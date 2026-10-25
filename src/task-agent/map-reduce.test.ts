import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mapInventory, renderMapReduceTable, type MapCard, type MapInventory, type MapItem, type MapPorts } from './map-reduce.js';
import { readMapRun, type MapRunRow } from './map-run-ledger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);
const items = Array.from({ length: 5 }, (_, index) => ({ id: `cell-${index + 1}` }));
function root(): string { const path = mkdtempSync(join(tmpdir(), 'map-reduce-')); roots.push(path); return path; }
function inventory(complete = true): MapInventory<MapItem> {
  return { items, complete, snapshotTime: '2026-10-24T00:00:00Z', snapshotRef: 'checklist-0.2.37@fixture',
    recipeSha: sha, mainSha: sha, checklistSnapshotPath: '/tmp/checklist-snapshot.json',
    requestedPool: 'node-b', selectedPool: 'node-b', imageCommit: sha };
}
function card(item: MapItem, context: { mapRunId: string; recipe: 'green-close' | 'draft-close' }): MapCard {
  return { id: `card-${item.id}`, itemId: item.id, mapRunId: context.mapRunId,
    recipe: context.recipe, text: `verify ${item.id}` };
}
function row(card: MapCard): MapRunRow {
  return { event: 'row', mapRunId: card.mapRunId, itemId: card.itemId,
    recipe: card.recipe, kind: 'hold', verdict: 'hold', reason: 'fixture-needs-evidence', evidence: [] };
}

test('five inventory items become five distinct cards with two concurrent launches and five read-only rows', async () => {
  const ledgerRoot = root();
  const launched: string[] = [];
  let active = 0;
  let peak = 0;
  const ports: MapPorts<MapItem> = {
    inventory: async () => inventory(), buildCard: card,
    launchCard: async (built) => {
      launched.push(built.id);
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(8);
      active--;
      return row(built);
    },
  };
  const result = await mapInventory({ recipe: 'green-close', source: 'landed-but-yellow',
    concurrency: 2, dryRun: false, root: ledgerRoot, mapRunId: 'map-five' }, ports);
  expect(result).toEqual({ mapRunId: 'map-five', expected: 5, observed: 5, dryRun: false });
  expect(launched).toHaveLength(5);
  expect(new Set(launched).size).toBe(5);
  expect(peak).toBe(2);
  const stored = readMapRun(result.mapRunId, ledgerRoot);
  expect(stored.start.itemIds).toEqual(items.map((item) => item.id));
  expect(stored.rows).toHaveLength(5);
  expect(stored.rows.map((entry) => entry.result?.cardId).sort()).toEqual(launched.sort());
  const reduced = renderMapReduceTable(result.mapRunId, ledgerRoot);
  expect(reduced.writes).toBe(0);
  expect(reduced.markdown.match(/^\| cell-\d \| card-cell-\d \|/gm)).toHaveLength(5);
  expect(reduced.markdown).toContain('Expected: 5 · observed: 5 · writes: 0');
});

test('dry-run is the default and never invokes the live card launcher', async () => {
  const ledgerRoot = root();
  let launches = 0;
  const result = await mapInventory({ recipe: 'green-close', source: 'landed-but-yellow', root: ledgerRoot }, {
    inventory: async () => inventory(), buildCard: card,
    launchCard: async (built) => { launches++; return row(built); },
  });
  expect(result.dryRun).toBe(true);
  expect(launches).toBe(0);
  expect(readMapRun(result.mapRunId, ledgerRoot).rows.map((entry) => entry.reason))
    .toEqual(Array(5).fill('dry-run-preview'));
  expect(renderMapReduceTable(result.mapRunId, ledgerRoot).writes).toBe(0);
});

test('incomplete inventory suppresses item launches and exposes one explicit HOLD', async () => {
  const ledgerRoot = root();
  let cards = 0;
  const result = await mapInventory({ recipe: 'green-close', source: 'landed-but-yellow', dryRun: false, root: ledgerRoot }, {
    inventory: async () => ({ ...inventory(false), reason: 'snapshot-read-failed' }),
    buildCard: (item, context) => { cards++; return card(item, context); },
    launchCard: async (built) => row(built),
  });
  expect(cards).toBe(0);
  expect(result.expected).toBe(0);
  expect(readMapRun(result.mapRunId, ledgerRoot).rows).toMatchObject([
    { itemId: null, rowsSuppressed: true, kind: 'hold', reason: 'snapshot-read-failed' },
  ]);
  expect(renderMapReduceTable(result.mapRunId, ledgerRoot).markdown).toContain('| inventory |  | hold |');
});

test('bad request is rejected before inventory or ledger creation', async () => {
  let reads = 0;
  const ports: MapPorts<MapItem> = {
    inventory: async () => { reads++; return inventory(); }, buildCard: card,
    launchCard: async (built) => row(built),
  };
  await expect(mapInventory({ recipe: 'green-close', source: 'drafts', root: root() }, ports)).rejects.toThrow('recipe/source');
  await expect(mapInventory({ recipe: 'green-close', source: 'landed-but-yellow', concurrency: 0, root: root() }, ports)).rejects.toThrow('concurrency');
  expect(reads).toBe(0);
});
