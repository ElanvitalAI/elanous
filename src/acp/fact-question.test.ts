import { expect, test } from 'bun:test';
import { isFactQuestion } from './fact-question.js';

test('short factual questions with a concrete signal', () => {
  for (const question of ['OpenAI 최근 모델이 뭐야?', '지금 최저시급 얼마야?', '현재 가격은 얼마인가요?', '언제 출시됐나요?', '누가 만들었나요?', '몇 번째 버전인가요?', 'What is the latest version?', '최신 버전 알려줘', '현재 환율 알려주세요?']) {
    expect(isFactQuestion(question)).toBe(true);
  }
});

test('ambiguous, long, multiline and code/delegation requests preserve the old route', () => {
  for (const question of [
    '', '최근 모델', '안녕하세요?', '몇 가지 아이디어를 만들어줘?', 'src/acp/server.ts 의 승인 정책 고쳐줘',
    '`foo`의 최신 버전은?', 'server.ts 최근 버전은?', '/cc 최신 모델이 뭐야?',
    '최근 가격은 얼마야?\n계산해줘', '최근 가격은 얼마야? '.repeat(12),
    '최근 출시 내용을 구현해줘?', '현재 명령을 실행해줘?', '현재 파일을 읽어줘?',
    // round 3: requests with «지금/현재» and a «?» stay on the old route (budgetGrant kept).
    '지금 서버를 재시작해줘?', '현재 버전으로 업데이트해줘?', '지금 데몬 꺼줄래?', '최신 버전 설치해?', 'Can you restart the current server?',
  ]) expect(isFactQuestion(question)).toBe(false);
});
