// B1(UX · 0.2.7) — 짧은 «물음»은 도구 없이 빠른 경로로(첫 글자 ≤2초 · 내부 문서 `EVAL-bot-chat-vs-grok-2026-09-30`).
// 허용 방식(골 ASK-bot-short-question-fast-path-b1b): 아래가 «모두» 참일 때만 fast — 하나라도 거짓이면 fast 아님(보수 쪽).
//   ⓐ 한 줄 · 80자 이하 · 첨부 없음 ⓑ 인사이거나 «물음 꼴» ⓒ 요청·작업 표지 · 경로·URL·코드 꼴 · 실시간 낱말이 없다.
// 거부 목록으로 변형을 다 막을 수는 없다 — 오분류 비용은 «확인해 볼까요?» 한 줄로 막힌다(도구가 안 실릴 뿐 대화는 이어진다).
// 판정 표본 = src/chat/short-question.test.ts 의 고정 표 20개(⊕ 리뷰가 든 변형).

export interface ShortQuestionContext {
  hasAttachments?: boolean;
}
export interface ShortQuestionVerdict {
  fast: boolean;
  reason: string;
}

const GREETING = /^(?:안녕(?:하세요|하십니까)?|반가워(?:요)?|고마워(?:요)?|감사합니다|하이|hi|hello|hey|thanks|thank you)[!?.~\s]*$/i;
// «한 줄로» 같은 짧은 꼬리를 떼고 본다.
const TAIL = /\s*(?:한\s*줄로|짧게|간단히|briefly|in one line)[.!]?\s*$/i;
const KO_QUESTION_END = /(?:\?|까|니|나요|냐|야|어때|뭐|몇|언제|어디|누구|왜|인가|일까)[?.!~]*$/;
const EN_QUESTION = /^(?:what|why|how|who|where|when|which|is|are|does|do)\b.*\?$/i;
const REQUEST_KO = /(?:해\s*줘|해\s*주세요|줘(?:요)?(?=[?.!\s]|$)|주세요|줄래|할래|볼래|줄\s*수\s*있|돌려|실행|고쳐|만들어\s*줘|찾아|검색|확인해|열어|보내|올려|지워|써\s*줘|작성해|요약해|정리해|분석해)/;
const REQUEST_EN = /\b(?:please|can you|could you|would you|run|test|tests|fix|build|open|search|check|send|create|write|deploy|install|summarize)\b/i;
const TASK = /(?:작업|파일|폴더|디렉터리|레포|저장소|커밋|브랜치|\bPR\b|코드|스크립트|테스트|빌드|배포|설치|설정|명령어|로그|버그|이슈)/i;
const PATH_OR_CODE = /(?:https?:\/\/|www\.|[\w.-]+\/[\w./-]+|\.(?:ts|tsx|js|py|md|json|yaml|swift|kt)\b|[`{};=<>])/i;
const LIVE = /(?:오늘\s*(?:날짜|며칠|무슨\s*요일)|지금\s*몇\s*시|최신|뉴스|속보|주가|시세|환율|날씨|today'?s|latest|news|stock|weather|right now)/i;

export type TuiChatRoute = '조회' | '설정 변경' | '조사' | '상시 일' | '코딩·구현';

export interface TuiChatVerdict {
  route: TuiChatRoute;
  reason: string;
  goalLoop: boolean;
}

/** Request verbs a quick lookup/settings/research/scheduling turn can carry out without the repository. */
const QUICK_REQUEST_VERBS = /^(?:보여|알려|확인해|찾아|찾아봐|조사해|검색해|정리해|요약해|바꿔|변경해|전환해|설정해|맞춰|수정해|고쳐|만들어|등록해|예약해|추가해|보내)$/;

/** True when the verb never appears, or each occurrence directly follows an allowed object. */
function everyVerbTakes(text: string, verb: RegExp, object: RegExp): boolean {
  for (const match of text.matchAll(verb)) {
    if (!object.test(text.slice(0, match.index))) return false;
  }
  return true;
}

/** Uncertain or mixed requests retain the full coding goal-loop and tool surface. */
export function classifyTuiChatIntent(text: string, ctx: ShortQuestionContext = {}): TuiChatVerdict {
  const q = text.trim();
  const coding = (reason: string): TuiChatVerdict => ({ route: '코딩·구현', reason, goalLoop: true });
  if (!q || ctx.hasAttachments) return coding(ctx.hasAttachments ? 'attachment' : 'empty');
  if (/(?:하니스|구현|코딩|코드|스크립트|버그|소스|리팩터|커밋|패치|테스트|시험\s*돌|빌드|배포|브랜치|서버|파일|레포|저장소|\bPR\b|\b(?:implement|coding|code|script|refactor|commit|patch|tests?|build|deploy|branch|server|file|repo)\b)/i.test(q)) return coding('coding');
  // Destructive or executing verbs in any form (not only «…줘») are never a quick turn.
  if (/(?:지워|지우|삭제|제거|옮겨|옮기|돌려|실행|설치|되돌려|롤백|재시작|죽여|\b(?:delete|remove|rm|rename|move|run|install|revert|rollback|drop|kill|restart)\b)/i.test(q)) return coding('write-verb');
  // A file path or code shape means the request touches the repository, whatever else it asks.
  if (PATH_OR_CODE.test(q)) return coding('path-or-code');
  // Allowlist, not denylist: every «…줘» request verb must be one a quick turn can do; anything else
  // (지워줘 · 돌려줘 · 옮겨줘 …) keeps the coding goal loop.
  for (const match of q.matchAll(/([가-힣]+?)\s*(?:줘|주세요|줄래|주라)/g)) {
    if (!QUICK_REQUEST_VERBS.test(match[1]!)) return coding('request-verb');
  }
  // Edit and create verbs are coding requests unless every one of them takes a quick object directly
  // («모델 설정 수정해줘» · «알림 만들어줘» stay quick; «… 그리고 화면 고쳐줘» does not).
  if (!everyVerbTakes(q, /(?:수정|고쳐|바꿔|변경|전환|교체|\b(?:edit|fix|modify|change|switch|replace)\b)/gi, /(?:모델|설정|config|provider|예약|일정|알림|리마인더|스케줄|reminder|schedule)\s*(?:을|를|로|으로)?\s*$/i)) return coding('edit');
  if (!everyVerbTakes(q, /(?:만들어|작성|추가해|생성|등록해|\b(?:create|write|make|add)\b)/gi, /(?:알림|일정|예약|리마인더|스케줄|reminder|schedule)\s*(?:을|를)?\s*$/i)) return coding('create');

  const routes: Array<{ route: Exclude<TuiChatRoute, '코딩·구현'>; reason: string; pattern: RegExp }> = [
    { route: '조회', reason: 'lookup', pattern: /(?:결정\s*카드|결정\s*대기|상태|현황|로그|알림\s*(?:왔|있|보여)|\b(?:status|logs?|pending decisions?)\b)/i },
    { route: '설정 변경', reason: 'settings', pattern: /(?:(?:모델|설정|config|provider).*(?:바꿔|변경|전환|설정해|맞춰|수정|고쳐|써\s*줘|set|change|switch|edit|fix|modify)|(?:바꿔|변경|전환).*(?:모델|설정|config|provider)|답변.*빠른\s*모델)/i },
    { route: '조사', reason: 'research', pattern: /(?:조사|검색|찾아\s*봐|뉴스|업계\s*소식|\b(?:research|search|news)\b)/i },
    { route: '상시 일', reason: 'recurring', pattern: /(?:매일|매주|매달|매\s*아침|[가-힣]+마다|정기적|반복\s*일정|예약|리마인더|\b(?:daily|weekly|every|schedule|remind)\b)/i },
  ];
  const matches = routes.filter(({ pattern }) => pattern.test(q));
  // A recurring job that looks something up or researches it is still a scheduling request.
  if (matches.some(({ route }) => route === '상시 일')
    && matches.every(({ route }) => route === '상시 일' || route === '조사' || route === '조회')) {
    return { route: '상시 일', reason: matches.length > 1 ? 'recurring-research' : 'recurring', goalLoop: false };
  }
  if (matches.length !== 1) {
    if (matches.length) return coding('mixed');
    const shortQuestion = classifyShortQuestion(q, ctx);
    return coding(shortQuestion.fast ? `short-${shortQuestion.reason}` : 'ambiguous');
  }
  const { route, reason } = matches[0]!;
  return { route, reason, goalLoop: false };
}

export function classifyShortQuestion(text: string, ctx: ShortQuestionContext = {}): ShortQuestionVerdict {
  const q = text.trim();
  if (!q) return { fast: false, reason: 'empty' };
  if (ctx.hasAttachments) return { fast: false, reason: 'attachment' };
  if (/[\r\n\u2028\u2029]/.test(q)) return { fast: false, reason: 'multiline' };
  if ([...q].length > 80) return { fast: false, reason: 'long' };
  if (PATH_OR_CODE.test(q)) return { fast: false, reason: 'path-or-code' };
  if (LIVE.test(q)) return { fast: false, reason: 'live' };
  if (REQUEST_KO.test(q) || REQUEST_EN.test(q)) return { fast: false, reason: 'request' };
  if (TASK.test(q)) return { fast: false, reason: 'task' };
  if (GREETING.test(q)) return { fast: true, reason: 'greeting' };
  const core = q.replace(TAIL, '').trim();
  if (KO_QUESTION_END.test(core) || EN_QUESTION.test(core)) return { fast: true, reason: 'question' };
  return { fast: false, reason: 'not-a-question' };
}
