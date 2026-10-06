import { expect, test } from 'bun:test';
import { splitCard } from './split.js';
import type { TaskCard } from '../task-cards/card-store.js';

const card: TaskCard = {
  id: 'card-1', goalId: 'wish:one', title: '작업 의뢰', status: 'open', createdAt: '2026-10-04T00:00:00Z',
  sections: [{ key: 'intake:wish:1', owner: 'steward', content: JSON.stringify({ text: '- [MK] 원고 준비\n- [TC] 게이트 점검' }), createdAt: '2026-10-04T00:00:00Z' }],
};

test('FLOW1 splits only explicitly owned work identically in shadow and live', () => {
  const expected = [
    { id: 'card-1-1', title: '원고 준비', seat: 'MK' },
    { id: 'card-1-2', title: '게이트 점검', seat: 'TC' },
  ];
  expect(splitCard(card, { shadow: true })).toEqual(expected);
  expect(splitCard(card, { shadow: false })).toEqual(expected);
  expect(splitCard({ ...card, sections: [], title: '주인 미정' })).toEqual([{ id: 'card-1', title: '주인 미정' }]);
});

test('FLOW1 keeps unassigned rows as seatless cells once any row is owned', () => {
  const mixed = { ...card, sections: [{ ...card.sections[0]!, content: JSON.stringify({ text: '[MK] 초안 작성\n검수 담당 지정 필요' }) }] };
  expect(splitCard(mixed)).toEqual([
    { id: 'card-1-1', title: '초안 작성', seat: 'MK' },
    { id: 'card-1-2', title: '검수 담당 지정 필요' },
  ]);
});

test('FLOW1 keeps every intake row even when no row names an owner', () => {
  const none = { ...card, sections: [{ ...card.sections[0]!, content: JSON.stringify({ text: '초안\n검수' }) }] };
  expect(splitCard(none)).toEqual([{ id: 'card-1-1', title: '초안' }, { id: 'card-1-2', title: '검수' }]);
});
