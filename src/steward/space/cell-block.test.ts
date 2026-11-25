// HAND-PULL-ON-BLOCK — `eln work block` parks the cell; `eln work next` then pulls a different READY cell (TC-H-CX-2, 11-25 19:05).
import { expect, test } from 'bun:test';
import { blockState, openBlocks, REOFFER_GRACE_MS, workBlock, type CellBlockRow } from './cell-block.js';
import { workNext, type BoardCell } from './work-next.js';

const NOW = Date.parse('2026-11-25T10:05:00Z');
const scopeOf = (s: string): string => (s.startsWith('TC-') ? 'TC' : s === 'RES' ? 'OP' : 'OP');

function world() {
  const cells: BoardCell[] = [
    { id: 'ISO-PROBE-1', title: 'isolation probe', status: 'yellow', owner: 'TC-H-CX-2', priority: 'P0', updatedAt: '2026-11-25T09:00:00Z' },
    { id: 'TSC-DIET-2', title: 'type check diet', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: '2026-11-25T08:00:00Z' },
  ];
  const rows: CellBlockRow[] = [];
  const mails: { to: string; refs: string[] }[] = [];
  const swap = (id: string, input: { expectedOwner: string | null; to: string | null }) => {
    const c = cells.find((x) => x.id === id);
    if (!c) return { outcome: 'missing' as const };
    if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' as const };
    const i = cells.indexOf(c);
    cells[i] = { ...c, ...(input.to ? { owner: input.to } : {}) };
    return { outcome: 'swapped' as const };
  };
  const blockDeps = { now: () => NOW, version: '0.3.36', cells: () => cells, scopeOf, blocks: () => rows, swap,
    mail: (m: { to: string; refs: string[] }) => { mails.push(m); return 900 + mails.length; }, record: (r: CellBlockRow) => { rows.push(r); } };
  const next = (seat: string, repliedAt?: number, at = NOW) => workNext(seat, { now: () => at, version: '0.3.36', cells: () => cells, scopeOf,
    lastActiveMs: () => at, swap: (id, input) => swap(id, input),
    blockOf: (c) => { const b = openBlocks(rows, '0.3.36').get(c.id); return b ? blockState(b, seat, repliedAt, at) : undefined; },
    resume: (c, by) => { const b = openBlocks(rows, '0.3.36').get(c.id)!; rows.push({ op: 'resume', at: new Date(at).toISOString(), version: '0.3.36', cell: c.id, by, on: b.on }); } });
  return { cells, rows, mails, blockDeps, next };
}

test('before: the blocked cell (no PR) is handed back — work next says WIP 1 (exit 4)', () => {
  const w = world();
  expect(w.next('TC-H-CX-2')).toMatchObject({ code: 4, cell: { id: 'ISO-PROBE-1' } });
});

test('after: work block parks it on the TC board, mails the RES coordinator once, then work next pulls TSC-DIET-2', () => {
  const w = world();
  const r = workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'RES', reason: 'needs RES isolation approval' }, w.blockDeps);
  expect(r).toMatchObject({ code: 0, board: 'TC', mailed: true });
  expect(w.cells.find((c) => c.id === 'ISO-PROBE-1')!.owner).toBe('TC');
  expect(w.mails).toEqual([{ to: 'OP', refs: ['cell:ISO-PROBE-1', 'blocked-on:RES', 'steward:TC'], body: expect.any(String) } as never]);
  expect(w.rows).toMatchObject([{ op: 'block', cell: 'ISO-PROBE-1', by: 'TC-H-CX-2', on: 'RES', mailId: 901 }]);
  expect(w.next('TC-H-CX-2')).toMatchObject({ code: 0, cell: { id: 'TSC-DIET-2' } });
  // another hand of TC never gets the blocked cell while RES has not answered
  expect(w.next('TC-H-CX-3')).toMatchObject({ code: 3 });
});

test('a repeat block of the same cell on the same seat sends no second mail', () => {
  const w = world();
  workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'RES', reason: 'needs RES isolation approval' }, w.blockDeps);
  w.cells[0] = { ...w.cells[0]!, owner: 'TC-H-CX-2' };
  const again = workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'RES', reason: 'still no approval' }, w.blockDeps);
  expect(again).toMatchObject({ code: 0, mailed: false });
  expect(w.mails.length).toBe(1);
  expect(w.rows.at(-1)).toMatchObject({ mailId: 901, reason: 'still no approval' });
});

test('RES answers → the last holder gets the cell first; others wait out the grace window', () => {
  const w = world();
  workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'RES', reason: 'needs RES isolation approval' }, w.blockDeps);
  const replied = NOW + 60_000;
  expect(w.next('TC-H-CX-3', replied, NOW + 120_000)).toMatchObject({ code: 0, cell: { id: 'TSC-DIET-2' } });
  expect(w.next('TC-H-CX-2', replied, NOW + 120_000)).toMatchObject({ code: 0, cell: { id: 'ISO-PROBE-1' } });
  expect(w.rows.at(-1)).toMatchObject({ op: 'resume', cell: 'ISO-PROBE-1', by: 'TC-H-CX-2' });
  expect(openBlocks(w.rows, '0.3.36').size).toBe(0);
});

test('blockState: grace 15 min for other hands', () => {
  const b: CellBlockRow = { op: 'block', at: '2026-11-25T10:05:00Z', version: 'v', cell: 'C', by: 'TC-H-CX-2', on: 'RES' };
  expect(REOFFER_GRACE_MS).toBe(900_000);
  expect(blockState(b, 'TC-H-CX-2', undefined, NOW)).toBe('blocked');
  expect(blockState(b, 'tc-h-cx-2', NOW, NOW)).toBe('reoffer');
  expect(blockState(b, 'TC-H-CX-3', NOW, NOW + 899_000)).toBe('reserved');
  expect(blockState(b, 'TC-H-CX-3', NOW, NOW + 900_000)).toBe('ready');
});

test('refusals: not my cell · not yellow · no awaited seat · blocking on myself', () => {
  const w = world();
  expect(workBlock('TC-H-CX-3', 'ISO-PROBE-1', { on: 'RES', reason: 'x' }, w.blockDeps).code).toBe(5);
  expect(workBlock('TC-H-CX-2', 'NOPE', { on: 'RES', reason: 'x' }, w.blockDeps).code).toBe(5);
  expect(workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: '', reason: 'x' }, w.blockDeps).code).toBe(2);
  expect(workBlock('TC-H-CX-2', 'ISO-PROBE-1', { on: 'tc-h-cx-2', reason: 'x' }, w.blockDeps).code).toBe(2);
  expect(w.mails.length).toBe(0);
});
