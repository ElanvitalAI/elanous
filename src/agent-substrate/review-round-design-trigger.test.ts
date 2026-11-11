import { expect, test } from 'bun:test';
import { assessReviewRoundDesignTrigger, reviewDesignCategory } from './review-round-design-trigger.js';

// Source: aws2 review-results/pr-36684-{d6a07af15a38,c38457ecc150}.json;
// the third reviewed head introduced another sed boundary variant after prior misses.
const priorBoundary = 'sed 파서가 주소가 붙은 w와 -f 스크립트의 쓰기를 놓치고 known으로 반환한다. 쓰기 대상을 완전히 판별하지 못하면 거부해야 한다.';
const newBoundary = 'sed 스크립트의 주소가 정규식이면 새 w 탐지식에 걸리지 않아 경계 밖 쓰기를 허용한다. 쓰기 대상을 확정할 수 없으면 거부해야 한다.';

test('#36684 ledger: a more specific regex address alone cannot prove a new failure path', () => {
  const signal = assessReviewRoundDesignTrigger({ round: 3, previousReviewFindings: [priorBoundary], currentFindings: [newBoundary] });
  expect(signal).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 2, previousReviewFindings: [priorBoundary], currentFindings: [newBoundary] })).toBeNull();
});

test('a repeated exact finding and a different category do not become a new design signal', () => {
  expect(assessReviewRoundDesignTrigger({ round: 4, previousReviewFindings: [priorBoundary], currentFindings: [priorBoundary] })).toBeNull();
  expect(reviewDesignCategory('후속 쓰기 명령을 경계 밖에서 허용하는 우회형 결함이다.')).toBe('boundary-bypass');
  expect(assessReviewRoundDesignTrigger({ round: 4, previousReviewFindings: [priorBoundary],
    currentFindings: ['후속 쓰기 명령을 경계 밖에서 허용하는 우회형 결함이다.'] })).toBeNull();
});

test('generic omissions and a reworded defect cannot create a design-transition signal', () => {
  expect(reviewDesignCategory('테스트 검증이 누락됐다.')).toBeNull();
  expect(reviewDesignCategory('검증 결과 로그가 누락된다.')).toBeNull();
  expect(reviewDesignCategory('외부 WebSocket 접근을 허용한다. 로그가 누락된다.')).toBeNull();
  expect(reviewDesignCategory('sed 정규식 탐지식은 경계 밖 쓰기를 허용하지 않는다.')).toBeNull();
  expect(reviewDesignCategory('외부 쓰기를 허용하지 않는 sed 펜스가 경계 밖 쓰기를 차단하지 못한다.')).toBe('boundary-omission');
  const reworded = '주소를 붙인 sed w 스크립트에서 쓰기 대상을 파서가 놓친다. 판별하지 못하면 거부해야 한다!';
  expect(assessReviewRoundDesignTrigger({ round: 3, previousReviewFindings: [priorBoundary], currentFindings: [reworded] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['외부 WebSocket을 차단하지 못해 연결을 허용한다.'],
    currentFindings: ['외부 WebSocket 연결을 허용한다. 차단하지 못했다!'] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['Web Worker에서 외부 연결을 차단하지 못한다.'],
    currentFindings: ['Web Worker에서 외부 WebSocket 연결을 차단하지 못한다.'] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['외부 연결을 차단하지 못한다.'],
    currentFindings: ['Web Worker에서 외부 연결을 차단하지 못한다.'] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['외부 WebSocket 연결을 차단하지 못한다.'],
    currentFindings: ['서비스 워커에서 외부 WebSocket 연결을 차단하지 못한다.'] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['정규식 주소의 쓰기를 차단하지 못한다.'],
    currentFindings: ['sed 정규식 주소의 쓰기를 차단하지 못한다.'] })).toBeNull();
});

test('two explicit, different bypass surfaces justify an advisory signal', () => {
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['sed가 경계 밖 쓰기를 허용한다.'],
    currentFindings: ['awk가 경계 밖 쓰기를 허용한다.'] }))
    .toMatchObject({ signal: 'design-transition', category: 'boundary-bypass', round: 3 });
  expect(assessReviewRoundDesignTrigger({ round: 3,
    previousReviewFindings: ['sed가 경계 밖 쓰기를 허용한다.'],
    currentFindings: ['sed와 awk가 경계 밖 쓰기를 허용한다.'] }))
    .toMatchObject({ signal: 'design-transition', category: 'boundary-bypass', round: 3 });
});

test('#36694 ledger: one reviewed head cannot trigger round three; generic findings remain unknown', () => {
  // Source: aws2 review-results/pr-36694-1588d17929d0.json has one reviewed head.
  const credentialFinding = '무관한 셸 명령이 전체 키 후보를 미해결로 바꾸므로 변수 후보를 보존해야 한다.';
  expect(reviewDesignCategory(credentialFinding)).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 2, previousReviewFindings: [credentialFinding], currentFindings: [newBoundary] })).toBeNull();
});

test('#36715 ledger: worker and service-worker boundary omissions trigger in rounds three and four', () => {
  // Source: aws2 seat-state/R-FRAG/fixtures/review-36715/pr-36715-{c93df7ce,978cd138,c8bdb0ee,9d70e672}.json;
  // basedOn links establish this order, and the new worker variants appear in rounds three and four.
  const first = '외부 요청 검사는 요청을 차단하지 않고 마지막 장면만 검사한다. 브라우저 경계에서 차단해야 한다.';
  const second = '외부 WebSocket은 기록만 하고 차단하지 않으며 연결 전에 차단해야 한다.';
  const third = 'WebSocket 펜스는 각 문서의 window.WebSocket만 교체하므로 Web Worker에서 생성한 외부 WebSocket은 연결 전에 차단하지 못한다. 워커를 포함한 브라우저 경계에서 막아야 한다.';
  const fourth = '서비스 워커의 외부 WebSocket을 연결 전에 차단해야 한다. 새 펜스는 Worker와 SharedWorker 생성자만 막으며 서비스 워커에는 적용되지 않는다.';
  expect(assessReviewRoundDesignTrigger({ round: 2, previousReviewFindings: [first], currentFindings: [first, second] })).toBeNull();
  expect(assessReviewRoundDesignTrigger({ round: 3, previousReviewFindings: [first, second], currentFindings: [first, second, third] }))
    .toMatchObject({ category: 'boundary-omission', round: 3 });
  expect(assessReviewRoundDesignTrigger({ round: 4, previousReviewFindings: [first, second, third], currentFindings: [third, fourth] }))
    .toMatchObject({ category: 'boundary-omission', round: 4 });
});
