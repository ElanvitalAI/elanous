/** Timely factual questions require external evidence before any answer text.
 * Keep execution requests on their ordinary tool path; this is not a new engine. */
const EXECUTION_REQUEST = /(?:구현|코드|버그|배포|설치|재시작|앱.{0,10}만들|\b(?:implement|debug|deploy|install|restart|build)\b)/iu;
const LOCAL_STATE = /\b(?:cwd|git|branch|commits?|directory|filesystem|process|disk)\b|디렉[터토]리|작업\s*폴더|현재\s*경로|커밋|로컬|파일\s*(?:목록|경로|내용|상태)|시스템\s*(?:상태|정보)/iu;

/** Execution requests and local machine/repo state stay on their ordinary tool path.
 * @deprecated 1121 RESEARCH-ROUTING: no longer a research-routing input on a web-capable turn — shadow only
 * (`research.route-mismatch`); the structured plan field `localOnly` decides. Its one remaining use only ACCELERATES the
 * q0 original-question search (old fast path, never blocks entry). 만료: «11-24 불일치율 보고 뒤 삭제 · 칸 만료». */
export function isExecutionOrLocalRequest(text: string | undefined): boolean {
  return !!text && (EXECUTION_REQUEST.test(text) || LOCAL_STATE.test(text));
}

const INFORMATION_QUESTION = /(?:어때|어떻|뭐|무엇|얼마|알려|설명|전망|예측|분석|비교|인용|출처|링크|언제|어디|\?|\b(?:what|how|why|when|where|outlook|forecast|compare|analy[sz]e|explain|cite|source|link)\b)/iu;

/** Information questions (not execution/local requests) are where an answer's URLs must be fetched sources.
 * @deprecated 1121 RESEARCH-ROUTING: never a research-routing input; it only widens the citation guard (unchanged) to
 * ordinary information turns. Re-evaluate with the shadow data. 만료: «11-24 불일치율 보고 뒤 삭제 · 칸 만료». */
export function isCitationGuardedQuestion(text: string | undefined): boolean {
  return !!text?.trim() && !isExecutionOrLocalRequest(text) && INFORMATION_QUESTION.test(text);
}

/** @deprecated 1121 RESEARCH-ROUTING: on a web-capable turn research entry is the plan's structured `route` verdict
 * (default ENTER, skip only on `localOnly: true`); this sentence classifier is shadow only (`research.route-mismatch`)
 * and still picks grounding-first vs provisional MODE and the route of turns with no web tool. 만료: «11-24 불일치율 보고 뒤 삭제 · 칸 만료». */
export function needsGroundingFirst(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  if (isExecutionOrLocalRequest(text)) return false;
  const events = /(?:최신|최근|오늘|현재|요즘|시사|뉴스|속보|근황|스캔들|선거|실적|\b(?:latest|recent|current|today|news|scandal|election|earnings)\b)/iu;
  const question = /(?:어때|어떻|뭐|무엇|얼마|알려|설명|전망|예측|분석|비교|\?|\b(?:what|how|why|outlook|forecast|compare|analy[sz]e|explain)\b)/iu;
  const markets = /(?:주식|증시|시장|금리|환율|경제|채권|\b(?:stocks?|markets?|rates?|economy|bonds?)\b)/iu;
  const horizon = /(?:전망|예측|내년|올해|이번|20\d{2}|\b(?:outlook|forecast|next year|this year)\b)/iu;
  const externalWorld = /(?:시사|뉴스|속보|소식|근황|스캔들|선거|실적|정책|정부|대통령|인물|기업|회사|세계|국제|미국|한국|전쟁|날씨|\b(?:news|scandal|election|earnings|policy|government|president|company|world|international|weather)\b)/iu;
  // Forward-looking public questions (forecast, «앞으로/다음 달/이번 시즌», a dated month) about weather, places,
  // venues or public announcements are timely even without a «latest/news» word (용평 live run4, RES79032).
  const forward = /(?:전망|예보|예측|앞으로|향후|다가오는|다음\s*(?:주|달|시즌|해)|이번\s*(?:주|달|시즌|겨울|여름)|내년|올\s*겨울|20\d{2}\s*년\s*\d{1,2}\s*월|\b(?:outlook|forecast|upcoming|next\s+(?:week|month|season|year)|this\s+(?:week|month|season|winter))\b)/iu;
  const publicWorld = /(?:기상|기후|강설|적설|제설|폭설|한파|태풍|개장|폐장|발표|공지|공식|관광|스키장|리조트|축제|행사|공연|대회|경기장|운항|교통|\b(?:climate|snow(?:fall)?|resort|ski|opening|announcement|festival|tournament|tourism|traffic)\b)/iu;
  // Personal calendar state is local; a company's or venue's public release/opening schedule is not.
  if (/(?:일정|캘린더|\b(?:calendar|schedule)\b)/iu.test(text) && !externalWorld.test(text) && !markets.test(text) && !publicWorld.test(text)) return false;
  if (forward.test(text) && question.test(text) && (externalWorld.test(text) || publicWorld.test(text))) return true;
  return (events.test(text) && question.test(text) && (externalWorld.test(text) || markets.test(text))) || (markets.test(text) && horizon.test(text));
}

export const GROUNDING_UNAVAILABLE = '외부 검색을 사용할 수 없거나 인용할 근거를 확보하지 못했습니다. 최신 사실·전망에 대한 답변을 유보합니다.';
export const GROUNDING_PARTIAL = '일부 검색이 불완전합니다. 아래 답변은 확보한 출처 범위에 한정합니다.';

/** Header for an incomplete search: names the failed axes when the structured partial carries them, else the fixed sentence. */
export function groundingPartialHeader(failedAxes?: readonly string[]): string {
  if (!failedAxes?.length) return GROUNDING_PARTIAL;
  return `${failedAxes.map(axis => `«${axis}»`).join(', ')} 축 검색이 실패했습니다. 아래 답변은 확보한 출처 범위에 한정합니다.`;
}

/** Only structured evidence URLs count; prose or model-generated citations do not open the gate. */
export function hasGroundingSources(result: { output: string; sourceUrls?: string[] } | null | undefined): boolean {
  return !!result?.output.trim() && (result.sourceUrls ?? []).some(value => {
    if (value !== value.trim() || /\s/u.test(value)) return false;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname; }
    catch { return false; }
  });
}
