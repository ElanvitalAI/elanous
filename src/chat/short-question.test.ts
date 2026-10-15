import { describe, expect, test } from 'bun:test';
import { classifyShortQuestion, classifyTuiChatIntent, formatTuiRouteLine, isTuiRouteLine } from './short-question';

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

describe('TUI intent (daemon short-question fast verdict is independent)', () => {
  test.each([
    ['나한테 온 결정 카드 있어?', '조회'],
    ['답변을 좀 더 빠른 모델로 바꿔줘', '설정 변경'],
    ['이번 주 업계 소식 조사', '조사'],
    ['매일 아침 8시 뉴스', '상시 일'],
    // review r2: an edit verb whose object is a setting stays a quick settings turn.
    ['모델 설정 수정해줘', '설정 변경'],
    ['매일 아침 8시 뉴스 알림 만들어줘', '상시 일'],
    ['오늘 로그 보여줘', '조회'],
    ['돌고 있는 일 알려줘', '조회'],
    ['진행 중인 일 알려줘', '조회'],
    ['실행 중인 일 알려줘', '조회'],
    ['뭐 하고 있어?', '조회'],
    ['what is running?', '조회'],
    ['what is in progress?', '조회'],
    ['이번 주 업계 소식 조사해줘', '조사'],
    // review r8: «…마다» is a recurring job even when it researches.
    ['아침마다 뉴스 보내줘', '상시 일'],
    ['매주 결정 카드 현황 알려줘', '상시 일'],
    // review r9: editing a schedule is a scheduling request.
    ['매일 아침 뉴스 예약 변경해줘', '상시 일'],
  ] as const)('%s → %s without goal loop', (text, route) => {
    expect(classifyTuiChatIntent(text)).toMatchObject({ route, goalLoop: false });
  });
  test.each([
    'src/acp/server.ts 의 승인 정책 고쳐줘', '하니스로 구현해줘', '이거 좀 해줘',
    // review r1: a research or lookup word does not hide an edit or a file path.
    '뉴스 검색해서 README.md 수정해줘', '로그 보고 고쳐줘', '업계 소식 조사해서 docs/news.md 에 적어줘', 'fix the status page',
    // review r3: running tests and an edit whose object is not the setting stay coding.
    '로그 확인하고 테스트 돌려줘', '테스트 실행해줘', '작업 실행해줘',
    '모델 얘기하고 서버 고쳐줘', '설정 파일 고쳐줘',
    // review r4: a create verb, or a second edit whose object is not the setting, keeps the goal loop.
    '뉴스 조사해서 화면 만들어줘', '모델 설정 고쳐줘 그리고 화면 고쳐줘',
    // review r5: change verbs are checked per occurrence too.
    '모델 설정 바꿔줘 그리고 화면 바꿔줘', '설정 바꿔서 로그 형식 변경해줘',
    // review r6: request verbs are an allowlist — delete, run, move … keep the goal loop.
    '뉴스 조사해서 화면 지워줘', '결정 카드 보고 옮겨줘', '로그 확인하고 다시 돌려줘',
    // review r11: destructive or executing verbs without «…줘» stay coding too.
    'delete status page', '로그 확인하고 화면 지워', '상태 보고 데몬 재시작',
  ])('%s retains goal loop', (text) => {
    expect(classifyTuiChatIntent(text)).toMatchObject({ route: '코딩·구현', goalLoop: true });
  });
  // 10-14 OPT 점검 표본 ⊕ 쓰기 명사형 오탐 표본(대표 «읽기 질문이 goal loop 에 들어간다»).
  test.each([
    'OP 앞 글 읽고 제안 표로', '추가 정보 있으면 알려줘', '최근 갱신된 칸 목록', '기록된 결정 요약',
    'GEO 가 뭐야?', '이 구조가 맞는지 설명해 줄래?', '두 안 비교해줘',
    // A file path or repository noun alone is a read, not a write (live 10-14: README.md 읽기 질문이 UpdateGoal 을 불렀다).
    'README.md 첫 줄이 뭐라고 되어 있는지 읽고 한 줄로 설명해 줄래?', 'src/acp/server.ts 승인 정책 살펴봐줘', '이 저장소 구조 설명해줘',
  ])('%s → 읽기·분석 (single full-tool turn, no goal loop)', (text) => {
    expect(classifyTuiChatIntent(text)).toMatchObject({ route: '읽기·분석', goalLoop: false });
  });
  test('a status summary stays the quick lookup route', () => {
    expect(classifyTuiChatIntent('한 줄 상태 요약')).toMatchObject({ route: '조회', goalLoop: false });
  });
  test.each([
    ['지시 파일에 절 추가', 'write-intent'], ['src/a.ts 의 오류 원인 짚어', 'debug'], ['지시 문서에 절 추가', 'write-intent'], ['교훈 절 추가해', 'create'],
    ['교훈 절 추가하자', 'write-intent'], ['README 에 적어', 'write-intent'], ['화면 개선해', 'write-intent'],
    ['이거 왜 안 돼?', 'debug'], ['이 화면 오류 원인 설명해', 'debug'], ['목표: 칸 목록 정리', 'explicit-goal'],
    // review r1: a quick-route word does not hide debugging or a stated goal.
    ['오류 로그 요약', 'debug'], ['에러 난 상태 알려줘', 'debug'], ['목표: 상태 요약', 'explicit-goal'],
  ])('%s keeps the goal loop (%s)', (text, reason) => {
    expect(classifyTuiChatIntent(text)).toMatchObject({ route: '코딩·구현', reason, goalLoop: true });
  });
  test('running lookups do not turn imperative execution into a lookup', () => {
    for (const text of ['돌고 있는', '진행 중', '실행 중', '뭐 하고 있어', 'running', 'in progress']) {
      expect(classifyTuiChatIntent(text)).toMatchObject({ route: '조회', goalLoop: false });
    }
    for (const text of ['테스트 실행해줘', '작업 실행해줘']) {
      expect(classifyTuiChatIntent(text)).toMatchObject({ route: '코딩·구현', goalLoop: true });
    }
    // A hyphenated word is not the running lookup; with no write intent it is a plain read.
    expect(classifyTuiChatIntent('not-running')).toMatchObject({ route: '읽기·분석', goalLoop: false });
  });
  test('attachments and mixed intents are conservative; daemon verdict is unchanged', () => {
    expect(classifyTuiChatIntent('결정 카드 있어?', { hasAttachments: true }).goalLoop).toBe(true);
    expect(classifyTuiChatIntent('뉴스 조사하고 설정 바꿔줘').goalLoop).toBe(true);
    expect(classifyShortQuestion('안녕')).toEqual({ fast: true, reason: 'greeting' });
    expect(classifyShortQuestion('나한테 온 결정 카드 있어?')).toEqual({ fast: true, reason: 'question' });
  });
});

describe('라우팅 줄 — 형식 하나 · 판별은 그 줄 그대로만', () => {
  test('bridge 가 보내는 줄만 참이고 답 텍스트는 거짓', () => {
    expect(formatTuiRouteLine('읽기·분석')).toBe('라우팅: 읽기·분석\n');
    expect(isTuiRouteLine(formatTuiRouteLine('조회'))).toBe(true);
    expect(isTuiRouteLine('라우팅: 읽기·분석\n')).toBe(true);
    for (const text of ['라우팅: 읽기·분석', '라우팅: 읽기·분석\n답', '라우팅: 엉뚱\n', 'hello', '']) {
      expect(isTuiRouteLine(text)).toBe(false);
    }
  });
});
