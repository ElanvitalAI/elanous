import { describe, expect, test } from 'bun:test';
import { classifyShortQuestion } from './short-question';

// 고정 표 20개(골 ASK-bot-short-question-fast-path-b1b) ⊕ 리뷰 라운드가 든 요청형 변형.
const FAST = ['안녕', 'hi', '고마워', '오늘 기분 어때? 한 줄로.', '서울에서 부산까지 KTX 로 대략 몇 시간? 한 줄로.',
  'GEO 가 뭐야?', '엘라누스는 누가 만들었어?', '광합성이 뭔가요?', 'what is RAG?', '파리는 어느 나라 수도야?'];
const SLOW = ['테스트 돌려줘', 'Run tests?', 'can you run the tests?', 'src/chat/index.ts 열어 줄래?', '오늘 삼성전자 주가 몇이야?',
  '최신 뉴스 뭐 있어?', '이 버그 고쳐 줄 수 있어?', 'PR 만들어 줘', 'please check the build', '첫 줄?\n둘째 줄?'];
const REVIEW_VARIANTS = ['테스트 좀 돌려볼래?', '빌드 확인 가능해?', 'run the tests please', 'PR 하나 열 수 있나요?', 'Could you fix it?', '로그 좀 볼래?'];

describe('B1 짧은 물음 빠른 경로 — 허용 방식', () => {
  test.each(FAST)('fast: %s', (t) => { expect(classifyShortQuestion(t).fast).toBe(true); });
  test.each([...SLOW, ...REVIEW_VARIANTS])('not fast: %s', (t) => { expect(classifyShortQuestion(t).fast).toBe(false); });
  test('첨부·긴 글·빈 글은 fast 아님 · 사유를 낸다', () => {
    expect(classifyShortQuestion('뭐야?', { hasAttachments: true })).toEqual({ fast: false, reason: 'attachment' });
    expect(classifyShortQuestion(`${'가'.repeat(81)}?`).reason).toBe('long');
    expect(classifyShortQuestion('  ').reason).toBe('empty');
    expect(classifyShortQuestion('서울 날씨').reason).toBe('live');
    expect(classifyShortQuestion('그냥 적어 둔 메모').reason).toBe('not-a-question');
  });
});
