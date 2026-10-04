import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHarnessQueue, harnessQueuePath, listHarnessQueue } from '../../harness/harness-queue.js';
import { authorDepth, authorDepthLines, collectAuthorDepth, type AuthorCell } from './author-depth.js';
import type { WorkItem } from './overlap.js';

const now = new Date('2026-10-04T15:00:00Z');
const cells: AuthorCell[] = [
  { id: 'CLAIMS1', title: 'Claims', owner: 'MK/sub', status: 'yellow', version: '0.2.15' },
  { id: 'CLOSED', title: 'Completed', owner: 'MK', status: 'green', version: '0.2.15' },
  { id: 'TC-A', title: 'TC work', owner: 'TC', status: 'yellow', version: '0.2.15' },
  { id: 'KNOW-FIND', title: 'Knowledge discovery', owner: 'MK', status: 'yellow', version: '0.2.16' },
  { id: 'TC-B', title: 'TC other', owner: 'TC', status: 'yellow', version: '0.2.16' },
];
const work: WorkItem[] = [{ kind: 'goal', ref: 'running', seat: 'TC', files: [], cells: ['TC-A'] }];
const input = { seats: ['MK', 'TC'] as const, caps: { MK: 6, TC: 8 }, running: { MK: 6, TC: 5 },
  queued: [{ seat: 'TC' as const, status: 'queued' as const, kind: 'say' as const, input: '0.2.15 칸 TC-QUEUED' }], cells, overlaps: work, now };

test('warm depth counts queued/launching only, orders current then next, and excludes running cells', () => {
  const result = authorDepth(input);
  expect(result.unreadable).toEqual([]);
  expect(result.seats).toEqual([
    { seat: 'MK', cap: 6, running: 6, queued: 0, target: 2, short: 2, wouldAuthor: [
      { cellId: 'CLAIMS1', version: '0.2.15', title: 'Claims' },
      { cellId: 'KNOW-FIND', version: '0.2.16', title: 'Knowledge discovery' },
    ] },
    { seat: 'TC', cap: 8, running: 5, queued: 1, target: 5, short: 4, wouldAuthor: [
      { cellId: 'TC-B', version: '0.2.16', title: 'TC other' },
    ] },
  ]);
  expect(authorDepthLines(result)).toEqual([
    'MK 6/6 · 대기 0 · 목표 2 · 모자람 2 → CLAIMS1, KNOW-FIND',
    'TC 5/8 · 대기 1 · 목표 5 · 모자람 4 → TC-B',
  ]);
});

test('candidate limit, cell id order, and blank or completed cells', () => {
  const result = authorDepth({ ...input, cells: [
    { id: 'Z', title: 'later', owner: 'MK', status: 'red', version: '0.2.15' },
    { id: 'A', title: 'first', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'D', title: '  ', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'B', title: 'finished', owner: 'MK', status: 'done', version: '0.2.15' },
    { id: 'C', title: 'next', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['A', 'Z']);
});

test('the same cell in current and next releases is selected once, preferring current', () => {
  const result = authorDepth({ ...input, cells: [
    { id: 'DUP', title: 'current title', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'DUP', title: 'next title', owner: 'MK', status: 'yellow', version: '0.2.16' },
    { id: 'NEXT', title: 'next available', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats[0]?.wouldAuthor).toEqual([
    { cellId: 'DUP', version: '0.2.15', title: 'current title' },
    { cellId: 'NEXT', version: '0.2.16', title: 'next available' },
  ]);
});

test('collector preserves current-first release order when current version number is higher', () => {
  const result = collectAuthorDepth({ seats: ['MK'], now,
    versions: () => ['0.2.20', '0.2.19'], caps: () => ({ MK: 6 }), running: () => ({ MK: 6 }),
    queued: () => [], overlaps: () => [], log: () => {},
    cells: version => version === '0.2.20' ? [
      { id: 'Z-SHARED', title: 'current', owner: 'MK', status: 'yellow', version },
      { id: 'A-CURRENT', title: 'current first by id', owner: 'MK', status: 'yellow', version },
    ] : [
      { id: 'Z-SHARED', title: 'next duplicate', owner: 'MK', status: 'yellow', version },
      { id: 'B-NEXT', title: 'next', owner: 'MK', status: 'yellow', version },
    ],
  });
  expect(result.unreadable).toEqual([]);
  expect(result.seats[0]?.wouldAuthor).toEqual([
    { cellId: 'A-CURRENT', version: '0.2.20', title: 'current first by id' },
    { cellId: 'Z-SHARED', version: '0.2.20', title: 'current' },
  ]);
});

test('current release wins a cell shared across seats and releases', () => {
  const result = authorDepth({ ...input, seats: ['TC', 'MK'], cells: [
    { id: 'SHARED', title: 'current MK', owner: 'MK', status: 'yellow', version: '0.2.15' },
    { id: 'SHARED', title: 'next TC', owner: 'TC', status: 'yellow', version: '0.2.16' },
    { id: 'TC-ONLY', title: 'other TC', owner: 'TC', status: 'yellow', version: '0.2.16' },
  ] });
  expect(result.seats.find(row => row.seat === 'MK')?.wouldAuthor).toEqual([{ cellId: 'SHARED', version: '0.2.15', title: 'current MK' }]);
  expect(result.seats.find(row => row.seat === 'TC')?.wouldAuthor).toEqual([{ cellId: 'TC-ONLY', version: '0.2.16', title: 'other TC' }]);
});

test('invalid snapshot clock makes selection unreadable, not an empty candidate set', () => {
  const result = authorDepth({ ...input, now: new Date(NaN) });
  expect(result.seats.map(row => row.short)).toEqual([null, null]);
  expect(result.seats.every(row => row.wouldAuthor.length === 0)).toBe(true);
  expect(result.unreadable).toEqual([{ source: 'clock', reason: 'invalid observation time' }]);
});

test('queue cell references and PR work exclude candidates even without a second real work item', () => {
  const result = authorDepth({ ...input, queued: [
    { seat: 'MK', status: 'launching', kind: 'say', input: '0.2.15 칸 CLAIMS1' },
    { seat: 'MK', status: 'launched', kind: 'say', input: '0.2.16 칸 KNOW-FIND' },
    { seat: 'TC', status: 'finished' },
  ], overlaps: [{ kind: 'pr', ref: '#42', seat: 'TC', files: [], cells: ['TC-A'] }] });
  expect(result.seats[0]).toMatchObject({ queued: 1, target: 2, short: 1, wouldAuthor: [
    { cellId: 'KNOW-FIND', version: '0.2.16' },
  ] });
  expect(result.seats[1]).toMatchObject({ queued: 0, target: 5, short: 5, wouldAuthor: [
    { cellId: 'TC-B', version: '0.2.16' },
  ] });
  expect(readFileSync(new URL('./author-depth.ts', import.meta.url), 'utf8').includes('addHarnessQueue')).toBe(false);
});

test('collecting a shadow decision leaves the isolated real queue storage unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'author-depth-queue-'));
  try {
    await addHarnessQueue({ seat: 'TC', say: '0.2.15 칸 TC-QUEUED' }, { root, log: () => {} });
    const path = harnessQueuePath(root);
    const before = readFileSync(path, 'utf8');
    const result = collectAuthorDepth({ seats: input.seats, now, versions: () => ['0.2.15', '0.2.16'],
      caps: () => input.caps, running: () => input.running,
      queued: () => listHarnessQueue({ root }), cells: version => cells.filter(cell => cell.version === version),
      overlaps: () => work, log: () => {},
    });
    expect(result.seats[0]?.wouldAuthor.map(cell => cell.cellId)).toEqual(['CLAIMS1', 'KNOW-FIND']);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(listHarnessQueue({ root })).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a thrown checklist source stays unreadable and every affected short is null, with would-author logs', () => {
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const result = collectAuthorDepth({ ...input, versions: () => ['0.2.15', '0.2.16'],
    caps: () => input.caps, running: () => input.running, queued: () => input.queued,
    cells: () => { throw new Error('checklist offline'); }, overlaps: () => work,
    log: (category, event, data) => { events.push({ category, event, data }); },
  });
  expect(result.unreadable).toEqual([{ source: 'checklist', reason: 'checklist offline' }]);
  expect(result.seats.map(row => row.short)).toEqual([null, null]);
  expect(result.seats.every(row => row.wouldAuthor.length === 0)).toBe(true);
  expect(events).toEqual([
    { category: 'loop.orchestrator', event: 'would-author', data: { seat: 'MK', target: 2, have: 0, short: null, cells: [] } },
    { category: 'loop.orchestrator', event: 'would-author', data: { seat: 'TC', target: 5, have: 1, short: null, cells: [] } },
  ]);
});

test('unknown queued cell blocks only its seat while an empty queue is measurable', () => {
  const result = authorDepth({ ...input, queued: [{ seat: 'TC', status: 'queued', kind: 'say', input: 'unattributed' }] });
  expect(result.seats[0]).toMatchObject({ queued: 0, short: 2 });
  expect(result.seats[1]).toMatchObject({ queued: 1, short: null, wouldAuthor: [] });
  expect(result.unreadable).toEqual([{ source: 'queue-cells', reason: 'missing TC observation' }]);
  const empty = authorDepth({ ...input, queued: [] });
  expect(empty.seats.map(row => row.short)).toEqual([2, 5]);
  expect(empty.unreadable).toEqual([]);
});

test('unreadable queue, running or overlap does not masquerade as zero shortfall', () => {
  for (const failure of ['queued', 'running', 'overlaps'] as const) {
    const result = authorDepth({ ...input, [failure]: null });
    expect(result.seats.map(row => row.short)).toEqual([null, null]);
    expect(result.unreadable.some(row => row.source === (failure === 'queued' ? 'queue' : failure === 'overlaps' ? 'overlap' : failure))).toBe(true);
  }
  expect(authorDepth({ ...input, caps: { MK: 6, TC: 8 }, running: { MK: 9, TC: 5 } }).seats[0]).toMatchObject({ target: 2, short: 2 });
});
