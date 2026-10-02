import { expect, test } from 'bun:test';
import type { ChecklistItem } from '../../release-loop/checklist.js';
import { buildSeatsBoard, createSeatsCache, kstDayRange, type SeatsSources } from './ops-seats.js';

const item = (id: string, owner: string, status: ChecklistItem['status'], title = id): ChecklistItem => ({ id, title, owner, status, updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'T' });
const sources = (over: Partial<SeatsSources> = {}): SeatsSources => ({
  channel: async () => [
    { body: '**[UX]** 2026-10-02 12:38 KST → OP · first line\nsecond line', createdAt: '2026-10-02T03:38:00Z' },
    { body: '**[UX]** older', createdAt: '2026-10-02T01:00:00Z' },
    { body: '**[TC]** 2026-10-02 12:20 KST → OP · TC line', createdAt: '2026-10-02T03:20:00Z' },
    { body: 'no prefix', createdAt: '2026-10-02T04:00:00Z' },
  ],
  merged: async () => [
    { number: 22741, title: 'OPS1·OPS2 화면', body: '', mergedAt: '2026-10-02T03:30:00Z' },
    { number: 22734, title: 'notes (REL7)', body: '', mergedAt: '2026-10-02T03:10:00Z' },
    { number: 1, title: 'no id here', body: 'mentions nothing', mergedAt: '2026-10-02T02:00:00Z' },
  ],
  checklist: () => ({ current: [item('OPS1', 'UX', 'green'), item('HS1', 'TC', 'red', 'stop leaves job'), item('REL7b', 'O', 'red')], all: [item('OPS1', 'UX', 'green'), item('REL7', 'TC', 'green'), item('HS1', 'TC', 'red')] }),
  openDecisionRaisers: () => ['TC', 'O', 'MK'],
  ...over,
});

test('contract: one row per seat with now, landed by checklist owner (not author), red items, open decisions and counts', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources());
  expect(board.date).toBe('2026-10-02');
  expect(board.seats.map((row) => row.seat)).toEqual(['OP', 'TC', 'MK', 'UX']);
  const ux = board.seats.find((row) => row.seat === 'UX')!;
  expect(ux).toEqual({
    seat: 'UX', role: 'CXO', now: { text: '**[UX]** 2026-10-02 12:38 KST → OP · first line', at: '2026-10-02T03:38:00Z' },
    landed: [{ pr: 22741, title: 'OPS1·OPS2 화면', at: '2026-10-02T03:30:00Z', checklistId: 'OPS1' }],
    blocked: [], pendingDecisions: 0, checklist: { green: 1, yellow: 0, red: 0, done: 0 },
  });
  const tc = board.seats.find((row) => row.seat === 'TC')!;
  expect(tc.landed).toEqual([{ pr: 22734, title: 'notes (REL7)', at: '2026-10-02T03:10:00Z', checklistId: 'REL7' }]);
  expect(tc.blocked).toEqual([{ id: 'HS1', title: 'stop leaves job', status: 'red' }, { id: 'REL7b', title: 'REL7b', status: 'red' }]);
  expect(tc.pendingDecisions).toBe(2); // 'O' is the old name of TC
  expect(board.seats.find((row) => row.seat === 'OP')!.now).toBeNull();
});

test('an unreadable source is null for its fields, never 0 or []', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources({ channel: async () => null, merged: async () => { throw new Error('gh down'); }, checklist: () => null, openDecisionRaisers: () => { throw new Error('locked'); } }));
  for (const row of board.seats) expect(row).toMatchObject({ now: null, landed: null, blocked: null, pendingDecisions: null, checklist: null });
});

test('KST day range and a 60 s cache shared by concurrent requests', async () => {
  expect(kstDayRange('2026-10-02')).toEqual({ start: '2026-10-01T15:00:00.000Z', end: '2026-10-02T15:00:00.000Z' });
  let clock = 0; let calls = 0;
  const cache = createSeatsCache(sources({ channel: async () => { calls++; return []; } }), () => clock);
  await Promise.all([cache('2026-10-02'), cache('2026-10-02')]);
  expect(calls).toBe(1);
  clock += 60_000;
  await cache('2026-10-02');
  expect(calls).toBe(2);
});
