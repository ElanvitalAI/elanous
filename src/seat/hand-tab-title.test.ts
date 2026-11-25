// HAND-NAME-NEUTRAL-DYNAMIC ① — eln side: the title text and when it is sent. Expectations are independent literals.
import { expect, test } from 'bun:test';
import { claimedCellOf, createHandTitleReporter, formatHandTabTitle, isHandSeat, modelTail, shortCell } from './hand-tab-title.js';

test('hand seats are <SPACE>-H-…; leaders, OP and judge hands are not', () => {
  expect(['TC-H-CX-1', 'TC-H-CC-2', 'TC-H-POOL-3', 'ux-h-cx-1'].map(isHandSeat)).toEqual([true, true, true, true]);
  expect(['TC', 'UX', 'OP', 'JUD-3', 'REVIEW-2', 'TC-HAND'].map(isHandSeat)).toEqual([false, false, false, false, false, false]);
});

test('model tail and cell short form', () => {
  expect(modelTail('gpt-6.1-terra')).toBe('terra');
  expect(modelTail('claude-opus-5-5')).toBe('opus');
  expect(modelTail('z-ai/glm-5')).toBe('glm');
  expect(modelTail('')).toBeUndefined();
  expect(shortCell('DEMO-TABS-SCENARIO-2')).toBe('DEMO-TABS-SCENARI…');
  expect(shortCell('DEMO-TABS-SCENARIO-2').length).toBe(18);
  expect(shortCell('LAND-QUEUE-1')).toBe('LAND-QUEUE-1');
});

test('working and idle titles', () => {
  expect(formatHandTabTitle({ seat: 'TC-H-CX-2', space: 'UX', cell: 'DEMO-TABS-SCENARIO-2', model: 'gpt-6.1-terra' }))
    .toBe('TC-H-CX-2 · UX · DEMO-TABS-SCENARI… · terra');
  expect(formatHandTabTitle({ seat: 'TC-H-CX-2', model: 'gpt-6.1-terra' })).toBe('TC-H-CX-2 · idle · terra');
  expect(formatHandTabTitle({ seat: 'tc-h-cx-2' })).toBe('TC-H-CX-2 · idle');
});

test('the claimed cell is the newest yellow cell the seat owns', () => {
  const cells = [
    { id: 'OLD', status: 'yellow', owner: 'TC-H-CX-2', updatedAt: '2026-11-25T01:00:00Z' },
    { id: 'NEW', status: 'yellow', owner: 'TC-H-CX-2/pr 1', updatedAt: '2026-11-25T02:00:00Z' },
    { id: 'DONE', status: 'green', owner: 'TC-H-CX-2', updatedAt: '2026-11-25T03:00:00Z' },
    { id: 'OTHER', status: 'yellow', owner: 'TC-H-CX-3', updatedAt: '2026-11-25T04:00:00Z' },
  ];
  expect(claimedCellOf('TC-H-CX-2', cells)).toBe('NEW');
  expect(claimedCellOf('TC-H-CX-9', cells)).toBeUndefined();
});

test('reporter: claim → title with space · return → idle · unchanged → no second send · leader → nothing', async () => {
  const sent: { title: string; model?: string }[] = [];
  let seat = 'TC-H-CX-2';
  let cells: { id: string; status: string; owner?: string }[] = [{ id: 'DEMO-TABS-SCENARIO-2', status: 'yellow', owner: 'TC-H-CX-2' }];
  const r = createHandTitleReporter({ seat: () => seat, cells: () => cells, spaceOf: () => 'UX', model: async () => 'gpt-6.1-terra', emit: (m) => sent.push(m) });
  expect(await r.refresh('turn-end')).toBe('TC-H-CX-2 · UX · DEMO-TABS-SCENARI… · terra');
  expect(await r.refresh('turn-start')).toBeNull();
  cells = [{ id: 'DEMO-TABS-SCENARIO-2', status: 'green', owner: 'TC-H-CX-2' }];
  expect(await r.refresh('turn-end')).toBe('TC-H-CX-2 · idle · terra');
  expect(sent).toEqual([
    { title: 'TC-H-CX-2 · UX · DEMO-TABS-SCENARI… · terra', model: 'gpt-6.1-terra' },
    { title: 'TC-H-CX-2 · idle · terra', model: 'gpt-6.1-terra' },
  ]);
  seat = 'TC';
  expect(await r.refresh('turn-end')).toBeNull();
  expect(sent.length).toBe(2);
});

test('a throwing source is swallowed and nothing is sent', async () => {
  const sent: unknown[] = [];
  const r = createHandTitleReporter({ seat: () => 'TC-H-CX-2', cells: () => { throw new Error('ledger locked'); }, spaceOf: () => 'TC', model: () => undefined, emit: (m) => sent.push(m) });
  expect(await r.refresh('turn-end')).toBeNull();
  expect(sent).toEqual([]);
});
