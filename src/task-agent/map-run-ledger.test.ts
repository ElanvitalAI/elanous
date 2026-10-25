import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMapRunRow, createMapRun, mapRunLedgerPath, readMapRun, reduceMapRun,
  type MapRunRow, type MapRunStart } from './map-run-ledger.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'map-run-ledger-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function start(overrides: Partial<MapRunStart> = {}): MapRunStart {
  return { event: 'start', mapRunId: 'map-001', recipe: 'green-close', recipeSha: 'a'.repeat(40),
    snapshotTime: '2026-10-24T00:00:00Z', snapshotRef: 'inventory-001',
    mainSha: 'd'.repeat(40), checklistSnapshotPath: '/tmp/checklist-snapshot.json', inventoryComplete: true,
    itemIds: ['cell-a', 'cell-b', 'cell-c'], requestedPool: 'node-b:6', selectedPool: 'node-b:6',
    imageCommit: 'b'.repeat(12), dryRun: true, ...overrides };
}
function row(itemId: string | null, overrides: Partial<MapRunRow> = {}): MapRunRow {
  return { event: 'row', mapRunId: 'map-001', itemId, recipe: 'green-close', kind: 'green-candidate',
    verdict: overrides.kind ?? 'green-candidate', reason: 'exact-head gate and main evidence', evidence: ['sha:abc'],
    e1: { verdict: 'pass', mergeSha: 'c'.repeat(40), mainAncestor: true },
    e2: { verdict: 'pass', command: 'bun test src/example.test.ts', exitCode: 0 },
    e2Source: 'completion-boundary', e3: { verdict: 'pass', reason: 'test reaches production entry' },
    pr: 42, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/42', ...overrides };
}

describe('map-run ledger', () => {
  test('start records exact main and checklist snapshot provenance', () => {
    const dir = root();
    expect(() => createMapRun(start({ mainSha: 'short' }), dir)).toThrow('provenance missing');
    expect(() => createMapRun(start({ checklistSnapshotPath: null }), dir)).toThrow('provenance missing');
    const path = createMapRun(start(), dir);
    expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({
      mainSha: 'd'.repeat(40), checklistSnapshotPath: '/tmp/checklist-snapshot.json',
    });
  });
  test('one inventory and three distinct results reduce to a read-only table', () => {
    const dir = root();
    const path = createMapRun(start(), dir);
    appendMapRunRow(row('cell-a'), dir);
    appendMapRunRow(row('cell-b', { kind: 'implementation-remains' }), dir);
    appendMapRunRow(row('cell-c', { kind: 'hold', reason: 'gate unmeasured', evidence: [] }), dir);
    expect(reduceMapRun('map-001', dir)).toEqual({ mapRunId: 'map-001', verdict: 'hold',
      reason: 'item-hold', expected: 3, observed: 3,
      counts: { 'green-candidate': 1, 'mock-pr': 0, 'implementation-remains': 1,
        harvest: 0, 'close-candidate': 0, hold: 1 }, writes: 0 });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  test('a missing result cannot be counted as a green inventory', () => {
    const dir = root();
    createMapRun(start(), dir);
    appendMapRunRow(row('cell-a'), dir);
    expect(reduceMapRun('map-001', dir)).toMatchObject({ verdict: 'hold', reason: 'results-missing', expected: 3, observed: 1, writes: 0 });
  });

  test('a declared empty inventory is held instead of looking complete', () => {
    const dir = root();
    createMapRun(start({ itemIds: [] }), dir);
    expect(reduceMapRun('map-001', dir)).toMatchObject({ verdict: 'hold', reason: 'empty-inventory', expected: 0, writes: 0 });
  });

  test('fully evidenced rows can be complete while the reducer still writes nothing', () => {
    const dir = root();
    createMapRun(start({ itemIds: ['cell-a'] }), dir);
    appendMapRunRow(row('cell-a'), dir);
    expect(reduceMapRun('map-001', dir)).toMatchObject({ verdict: 'complete', reason: 'all-items-accounted', writes: 0 });
  });

  test('duplicate and foreign item rows never enter the ledger', () => {
    const dir = root();
    const path = createMapRun(start(), dir);
    appendMapRunRow(row('cell-a'), dir);
    expect(() => appendMapRunRow(row('cell-a'), dir)).toThrow('duplicate row');
    expect(() => appendMapRunRow(row('cell-z'), dir)).toThrow('unknown item');
    expect(readMapRun('map-001', dir).rows).toHaveLength(1);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('partial inventory suppresses all item rows and reduces to hold', () => {
    const dir = root();
    createMapRun(start({ inventoryComplete: false, itemIds: [] }), dir);
    appendMapRunRow(row(null, { kind: 'hold', pr: null, rowsSuppressed: true, reason: 'page cap', evidence: [] }), dir);
    expect(() => appendMapRunRow(row('cell-a'), dir)).toThrow('incomplete inventory');
    expect(reduceMapRun('map-001', dir)).toMatchObject({ verdict: 'hold', reason: 'inventory-incomplete', observed: 1, writes: 0 });
  });

  test('failed Pod cannot produce a close candidate and a torn tail is never accepted', () => {
    const dir = root();
    expect(() => createMapRun(start({ recipe: 'draft-close', itemIds: ['cell-a'] }), dir)).toThrow('provenance missing');
    createMapRun(start({ recipe: 'draft-close', checklistSnapshotPath: null, itemIds: ['cell-a'] }), dir);
    expect(() => appendMapRunRow(row('cell-a', { recipe: 'draft-close', kind: 'close-candidate' }), dir)).toThrow('exact PR head');
    expect(() => appendMapRunRow(row('cell-a', { recipe: 'draft-close', kind: 'close-candidate', pr: 42, headOid: 'c'.repeat(40), rc: 1 }), dir)).toThrow('failed Pod');
    const path = mapRunLedgerPath('map-001', dir);
    appendFileSync(path, '{"event":"row"');
    expect(() => reduceMapRun('map-001', dir)).toThrow('truncated JSONL tail');
  });

  test('recipe and green evidence cannot cross into an unrelated decision', () => {
    const dir = root();
    createMapRun(start({ itemIds: ['cell-a'] }), dir);
    expect(() => appendMapRunRow(row('cell-a', { kind: 'close-candidate', headOid: 'c'.repeat(40) }), dir)).toThrow('kind outside recipe');
    expect(() => appendMapRunRow(row('cell-a', { e1: { verdict: 'pass', mergeSha: 'bad', mainAncestor: true } }), dir)).toThrow('E1/E2/E3');
    expect(() => appendMapRunRow(row('cell-a', { e2: { verdict: 'pass', command: 'bun test', exitCode: 1 } }), dir)).toThrow('E1/E2/E3');
    expect(() => appendMapRunRow(row('cell-a', { e2Source: 'prior-evidence', e2: { verdict: 'pass' } }), dir)).toThrow('E1/E2/E3');
    expect(() => appendMapRunRow(row('cell-a', { podUid: '' }), dir)).toThrow('invalid podUid');
    expect(readMapRun('map-001', dir).rows).toHaveLength(0);
  });
});
