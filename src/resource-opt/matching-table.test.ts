// RESOURCE-OPT-HOURLY (L1) — the matching table is computed from ledgers only. Fixture ledgers → an exact table:
// idle seats × unowned / 2h-stalled 🟡 cells (P0 first), PRs without a same-head pregate receipt by author seat, and
// the judge queue by age. Expected values are literals written here, not built with the module's own helpers.
import { describe, expect, test } from 'bun:test';
import { buildMatchingTable, exceptionTable, formatAssignmentPrompt, hasSameHeadReceipt, seatFromBranch, type MatchingInput } from './matching-table.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takePendingTable, writeResourceOptTrigger } from './gather.js';

const NOW = Date.parse('2026-11-25T05:05:00.000Z'); // 14:05 KST
const min = (n: number): number => NOW - n * 60_000;
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const fixture = (): MatchingInput => ({
  now: NOW, version: '0.3.36', hqSeat: 'OP',
  panes: [
    { seat: 'OP', state: 'IDLE', since: min(90) },          // the coordinator itself — never matched
    { seat: 'TC-H-CX-3', state: 'IDLE', since: min(47) },
    { seat: 'TC-H-CX-3', state: 'IDLE', since: min(12) },   // same seat twice → one row, oldest since
    { seat: 'MK', state: 'IDLE', since: min(130) },
    { seat: 'UX', state: 'IDLE', since: min(20) },
    { seat: 'JUD', state: 'WORKING', since: min(5) },
    { seat: 'RES', state: 'IDLE', since: min(3) },
    { state: 'IDLE', since: min(400) },                     // a pane without a seat name is not a seat
  ],
  cells: [
    { id: 'CELL-P1-UNOWNED', title: 'p1 unowned\nsecond line', status: 'yellow', priority: 'P1', updatedAt: iso(30) },
    { id: 'CELL-P0-UNOWNED', title: 'p0 unowned', status: 'yellow', priority: 'P0', updatedAt: iso(10) },
    { id: 'CELL-P0-STALLED', title: 'p0 stalled', status: 'yellow', priority: 'P0', owner: 'TC-H-CX-9', updatedAt: iso(180) },
    { id: 'CELL-UX-STALLED', title: 'ux stalled, owner idle', status: 'yellow', priority: 'P1', owner: 'UX/cards', updatedAt: iso(150) },
    { id: 'CELL-FRESH', title: 'owned and moving', status: 'yellow', priority: 'P0', owner: 'TC', updatedAt: iso(20) },
    { id: 'CELL-GREEN', title: 'done', status: 'green', updatedAt: iso(500) },
    { id: 'CELL-P2-UNOWNED', title: 'p2 unowned', status: 'yellow', priority: 'P2', updatedAt: iso(60) },
  ],
  prs: [
    { number: 40069, branch: 'fix/tui-restart', headSha: 'ce9c4694dc42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', isDraft: false, title: 'restart' },
    { number: 40064, branch: 'tc-h-cx-5/dr13', headSha: '8ed1dc075cc1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', isDraft: false, title: 'has receipt' },
    { number: 40062, branch: 'tc/wait-cycle', headSha: '99b0dbd9a500cccccccccccccccccccccccccccccc', isDraft: false, title: 'old-head receipt only' },
    { number: 40039, branch: 'cx1/els', headSha: '1f889769f62adddddddddddddddddddddddddddddd', isDraft: true, title: 'draft' },
  ],
  greenLanes: ['40064-8ed1dc075cc1-minim5', '40062-000000000000-node-b', 'x-e4ac0b80da9c-minim5'],
  judgeQueue: [
    { id: 'CELL-J-OLD', owner: 'JUD', sinceMs: min(74), pr: 40001 },
    { id: 'CELL-J-NEW', owner: 'JUD', sinceMs: min(10) },
  ],
});

describe('buildMatchingTable', () => {
  test('fixture ledgers → exact rows: P0 first, an idle owner gets its stalled cell back, the P2 cell finds no seat, PRs without a same-head receipt, aged judge items, idle leftovers', () => {
    const table = buildMatchingTable(fixture());
    expect(table.rows).toEqual([
      { id: 'RO-1', kind: 'assign', seat: 'MK', idleMin: 130, cell: 'CELL-P0-UNOWNED', title: 'p0 unowned', priority: 'P0', why: 'unowned' },
      { id: 'RO-2', kind: 'assign', seat: 'TC-H-CX-3', idleMin: 47, cell: 'CELL-P0-STALLED', title: 'p0 stalled', priority: 'P0', why: 'stalled' },
      { id: 'RO-3', kind: 'assign', seat: 'RES', idleMin: 3, cell: 'CELL-P1-UNOWNED', title: 'p1 unowned', priority: 'P1', why: 'unowned' },
      { id: 'RO-4', kind: 'assign', seat: 'UX', idleMin: 20, cell: 'CELL-UX-STALLED', title: 'ux stalled, owner idle', priority: 'P1', why: 'owner-idle' },
      { id: 'RO-5', kind: 'pregate', seat: 'TC', branch: 'tc/wait-cycle', pr: 40062, head: '99b0dbd9a500', title: 'old-head receipt only' },
      { id: 'RO-6', kind: 'pregate', seat: 'UNKNOWN', branch: 'fix/tui-restart', pr: 40069, head: 'ce9c4694dc42', title: 'restart' },
      { id: 'RO-7', kind: 'judge', cell: 'CELL-J-OLD', owner: 'JUD', ageMin: 74, pr: 40001 },
    ]);
    expect(table.summary).toEqual({ idle: 4, unowned: 3, stalled: 2, prsWithoutReceipt: 2, judgeQueue: 2, judgeOldestMin: 74, unmatchedCells: 1, overflow: 0 });
  });

  test('an idle seat that owns a stalled cell gets its own cell back before a stranger does', () => {
    const input = fixture();
    const table = buildMatchingTable({ ...input, cells: input.cells.filter((cell) => cell.id === 'CELL-UX-STALLED') });
    expect(table.rows.filter((row) => row.kind === 'assign')).toEqual([
      { id: 'RO-1', kind: 'assign', seat: 'UX', idleMin: 20, cell: 'CELL-UX-STALLED', title: 'ux stalled, owner idle', priority: 'P1', why: 'owner-idle' },
    ]);
    // the rest of the idle seats stay rows of their own: OP must still dispose of them
    expect(table.rows.filter((row) => row.kind === 'idle').map((row) => row.id + ' ' + (row as { seat: string }).seat)).toEqual(['RO-5 MK', 'RO-6 TC-H-CX-3', 'RO-7 RES']);
  });

  test('more than 20 rows: the table keeps 20 and counts the overflow', () => {
    const cells = Array.from({ length: 30 }, (_, i) => ({ id: `C${i}`, title: `t${i}`, status: 'yellow', priority: 'P1', updatedAt: iso(5) }));
    const panes = Array.from({ length: 30 }, (_, i) => ({ seat: `H${i}`, state: 'IDLE', since: min(60 - i) }));
    const table = buildMatchingTable({ ...fixture(), panes, cells, prs: [], judgeQueue: [] });
    expect(table.rows.length).toBe(20);
    expect(table.rows[19]!.id).toBe('RO-20');
    expect(table.summary.overflow).toBe(10);
  });

  test('helpers: author seat from branch · same-head receipt only', () => {
    expect(seatFromBranch('tc-h-cx-2/compact-order')).toBe('TC-H-CX-2');
    expect(seatFromBranch('cc2/baseline')).toBe('CC2');
    expect(seatFromBranch('no-slash')).toBeNull();
    expect(hasSameHeadReceipt(40064, '8ed1dc075cc1ffff', ['40064-8ed1dc075cc1-minim5'])).toBe(true);
    expect(hasSameHeadReceipt(40064, '8ed1dc075cc2ffff', ['40064-8ed1dc075cc1-minim5'])).toBe(false);
  });

  test('the prompt carries the contract and every row id', () => {
    const prompt = formatAssignmentPrompt(buildMatchingTable({ ...fixture(), unmeasured: ['prs(gh down)'] }));
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('[resource-opt] 14:05 hourly resource optimization — matching table from ledgers (no LLM) · release 0.3.36');
    expect(lines[1]).toBe('idle 4 · unowned 3 · stalled 2 · PR no receipt 2 · judge 2 (oldest 74m) · cells without an idle seat 1');
    expect(lines[2]).toBe('unmeasured: prs(gh down)');
    expect(prompt).toContain('(b) a reply line "RO-3 reject: <reason>".');
    expect(lines).toContain('RO-1 assign · MK (idle 130m) ← P0 CELL-P0-UNOWNED «p0 unowned» (unowned)');
    expect(lines).toContain('RO-5 pregate · #40062 head 99b0dbd9a500 by TC (tc/wait-cycle) — no same-head receipt «old-head receipt only»');
    expect(lines.at(-1)).toBe('RO-7 judge · CELL-J-OLD #40001 waiting 74m (owner JUD)');
  });

  test('LOOP-TRAFFIC R1 hand-off: only the exception rows reach the assignment turn, ids kept, consumed once', () => {
    const exceptions = exceptionTable(buildMatchingTable(fixture()), ['RO-2', 'RO-6']);
    expect(exceptions.rows.map((row) => `${row.id} ${row.kind}`)).toEqual(['RO-2 assign', 'RO-6 pregate']);
    const dir = mkdtempSync(join(tmpdir(), 'resource-opt-pending-'));
    writeResourceOptTrigger(dir, 'TRAFFIC', exceptions);
    expect(takePendingTable(dir)?.rows.map((row) => row.id)).toEqual(['RO-2', 'RO-6']);
    expect(takePendingTable(dir)).toBeNull();
  });
});
