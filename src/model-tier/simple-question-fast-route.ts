/** A narrow fast path for single, stable factual questions in a fresh TUI session. */
const UNSAFE_OR_DYNAMIC = /(?:검색|찾아|조사|확인해|검증|비교|분석|설명해\s*줘|왜|어떻게|코드|파일|실행|수정|삭제|지워|만들어|생성|작성|최신|최근|현재|지금|오늘|내일|가격|주가|날씨|일정|운영|로그|대통령|총리|시장|대표|회장|사장|내\s*이름|나의|저의|저장소|리포지토리|프로젝트|워크스페이스|\bmy\b|\bour\b|\bname\b|\buser\b|\bpersonal\b|\brepo\b|\brepository\b|\bproject\b|\bworkspace\b|\bfolder\b|\bdirectory\b|\b(?:src|lib|app|plugins|docs|tests?)\s*[/\\]|\.(?:ts|tsx|js|jsx|json|ya?ml)\b|search\w*|browse|research|verify|compare|analy[sz]e|debug|code|file|run|execute|edit|write|delete|remove|create|update|please|can\s+you|could\s+you|would\s+you|will\s+you|should\s+I|recommend|opinion|advice|latest|recent|current|today|tomorrow|president|prime\s+minister|mayor|ceo|weather|price|stock|schedule|status)/iu;
const SIMPLE_QUESTION_SHAPE = /(?:\?\s*$|(?:무엇|뭐|누구|어디|언제)(?:인가요|입니까|야|예요|죠)\s*[?]?\s*$|몇\s*(?:명|미터|개|층|년|가지)(?:인가요|입니까)?\s*[?]?\s*$|^(?:what|who|when|where|which|how many|how much)\b)/iu;
const STABLE_FACT_CUE = /(?:^(?:what|who|when|where|which|how many|how much)\b|무엇|뭐|누구|어디|언제|몇\s*(?:명|미터|개|층|년|가지)|가장|최고|최대|최소|수도|인구|면적|높이|높은|깊이|깊은|길이|거리|넓이)/iu;
const COMPOUND_QUESTION = /(?:\b(?:and|or|also|then|plus)\b|그리고|이며|이고|하면서|뿐만\s*아니라|하고)/iu;

/**
 * Conservative by design: uncertain, dynamic, multi-part, action, and follow-up
 * turns remain on the normal model/tool path. `priorUserTurns` prevents the fast
 * path from dropping conversation-dependent facts.
 */
export function isSimpleQuestionFastRoute(input: {
  readonly text: string;
  readonly priorUserTurns?: number;
  readonly hasAttachments?: boolean;
}): boolean {
  const text = input.text.trim();
  if (!text || text.length > 100 || (input.priorUserTurns ?? 0) > 0 || input.hasAttachments) return false;
  if (/[\n;]|\.{2,}|[.!?]\s*\S/u.test(text) || UNSAFE_OR_DYNAMIC.test(text)) return false;
  if ((text.match(/\?/gu)?.length ?? 0) > 1) return false;
  if (COMPOUND_QUESTION.test(text) || !STABLE_FACT_CUE.test(text)) return false;
  if (/(?:무엇|뭐|누구|몇|어디|언제).{0,30}(?:무엇|뭐|누구|몇|어디|언제)/iu.test(text)) return false;
  return SIMPLE_QUESTION_SHAPE.test(text);
}
