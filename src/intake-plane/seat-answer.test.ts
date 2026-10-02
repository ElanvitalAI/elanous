import { expect, test } from 'bun:test';
import { answerAsSeat, isNoGraphFailure, seatAnswerPrompt } from './seat-answer.js';
import type { ChecklistItem } from '../release-loop/checklist.js';

const item = (id: string, owner: string, status: ChecklistItem['status'] = 'yellow'): ChecklistItem => ({ id, title: `${id} 제목`, status, owner, updatedAt: '', updatedBy: 'cli' });

test('the prompt carries the role file, only the seat-owned items, recent requests and the no-invention rule', async () => {
  let prompt = '';
  const answer = await answerAsSeat('cmo', '오늘 리허설 준비 상황', {
    readRole: (id) => (id === 'MK' ? '# MK 역할\n마케팅·티저·발행' : null),
    ownedItems: (id) => [item('EV10', id, 'green'), item('EV12', id)],
    recentRequests: () => [{ id: 'a', text: '@CMO 10-28 전략 한 장', createdAt: '2026-10-01T12:00:00Z', status: 'done', summary: '', seats: [], results: [], approvals: [] }],
    complete: async (p) => { prompt = p; return '  답입니다  '; },
  });
  expect(answer).toEqual({ title: 'CMO', text: '답입니다' });
  expect(prompt).toContain('CMO(MK) 자리');
  expect(prompt).toContain('마케팅·티저·발행');
  expect(prompt).toContain('🟢 EV10 EV10 제목');
  expect(prompt).toContain('🟡 EV12 EV12 제목');
  expect(prompt).toContain('@CMO 10-28 전략 한 장');
  expect(prompt).toContain('지어내지 말고');
  expect(prompt).toContain('오늘 리허설 준비 상황');
});

test('unknown seat or empty model output gives null (the caller keeps the old reply)', async () => {
  const deps = { readRole: () => null, ownedItems: () => [], recentRequests: () => [], complete: async () => '   ' };
  expect(await answerAsSeat('nobody', 'q', deps)).toBeNull();
  expect(await answerAsSeat('CMO', 'q', deps)).toBeNull();
});

test('isNoGraphFailure matches only the planner «no installed graph» failure', () => {
  const seat = { graphId: '', reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' };
  expect(isNoGraphFailure({ status: 'failed', seats: [seat] })).toBe(true);
  expect(isNoGraphFailure({ status: 'failed', summary: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다', seats: [{ graphId: '' }] })).toBe(true);
  expect(isNoGraphFailure({ status: 'failed', seats: [{ ...seat, graphId: 'doc-draft' }] })).toBe(false);
  expect(isNoGraphFailure({ status: 'done', seats: [seat] })).toBe(false);
  expect(isNoGraphFailure({ status: 'failed', seats: [{ graphId: '', reason: '타임아웃' }] })).toBe(false);
  expect(isNoGraphFailure(null)).toBe(false);
  expect(seatAnswerPrompt({ title: 'CMO', seatId: 'MK', question: 'q', role: null, items: [], recent: [] })).toContain('(담당 칸 없음)');
});

// 10-02 07:4x — a `.slice` cut an emoji in a checklist title («… · 🎉 …»), the prompt carried a lone surrogate, and the
// model API answered «400 Bad Request» to every «@CMO …» question. Cuts are by code point now.
test('the seat prompt never carries a lone surrogate when an emoji sits on a cut boundary', () => {
  const title = `${'가'.repeat(139)}🎉 뒤`;
  const prompt = seatAnswerPrompt({
    title: 'CMO', seatId: 'MK', question: '준비 상황?', role: `${'역'.repeat(5_999)}🎉`,
    items: [{ id: 'X1', title, status: 'yellow', evidence: `${'근'.repeat(159)}🟢 끝` } as never],
    recent: [{ createdAt: '2026-10-02T00:00:00Z', status: 'done', text: `${'요'.repeat(119)}🙂 끝` } as never],
  });
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  expect(lone.test(prompt.replace(/[\u{10000}-\u{10FFFF}]/gu, ''))).toBe(false);
  expect(JSON.parse(JSON.stringify(prompt))).toBe(prompt);
  expect(prompt).toContain(`${'가'.repeat(139)}🎉`);
});
