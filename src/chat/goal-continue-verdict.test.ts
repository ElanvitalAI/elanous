import { expect, test } from 'bun:test';
import { classifyReplyTail } from './goal-continue-verdict.js';

const pledges = [
  // D 07:46 — the sentence that ended a turn without turn.auto-continue.
  '다음 스텝은 이 관측자와 childFinished 를 배선하는 커밋 작업입니다.',
  '체인 검증은 끝났습니다. 다음 스텝은 RESULT.md 를 작성하는 작업입니다.',
  '남은 일은 xxwkcj.txt 부터 이어서 따라가는 것입니다.',
  '할 일은 pzqvgg 부터 체인을 계속 따라가 RESULT.md 를 쓰는 것입니다',
  '다음 턴에 pzqvgg부터 체인 계속 따라가 RESULT.md 작성 예정',
  '다음 턴에서 RESULT.md 를 작성할 예정입니다.',
  'The next step is wiring the observer to childFinished.',
  'Remaining work is writing RESULT.md from the chain.',
];
const notPledges = [
  '남은 일은 없습니다.',
  '할 일은 모두 끝났습니다.',
  'The next step is nothing: no more remaining work.',
  '다음 스텝은 어느 쪽으로 할까요?',
  '다음 스텝은 승인이 필요합니다. 원하시면 알려 주세요.',
  '모든 항목을 완료했습니다.',
];

test('prose declarations of the next step count as a pledge', () => {
  for (const tail of pledges) expect(classifyReplyTail(tail).pledge, tail).toBe(true);
});

test('nothing-left closings and questions to a person are not pledges', () => {
  for (const tail of notPledges) expect(classifyReplyTail(tail).pledge, tail).toBe(false);
});
