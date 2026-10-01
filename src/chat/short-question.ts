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
