/**
 * APP-BUILD-NATURAL-ROUTE-DETERMINISTIC — plugin-declared intent → forced first route.
 *
 * Manifest route tools are always deferred (tier-flip `manifestRoute`), so a one-line app request
 * reached app_build only if the model chose to call ToolSearch and its paraphrase hit a trigger.
 * The same ticketing line therefore picked app_build once and Bash/deploy-check the next time.
 *
 * Policy lives here, in the plugin layer. Core only asks «does a plugin pin this turn?» and, when
 * it does, exposes that one route tool on the first request with a named tool choice — the same
 * mechanism as the named-skill → skill_exec route. A pin applies only when the pinned plugin tool
 * is in the turn's live pool; otherwise nothing is forced and the ordinary pool is untouched.
 */
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { APP_BUILD_PLUGIN_ID, APP_BUILD_TOOL_NAME, classifyAppBuildIntent } from './app-build-autofill.js';

/** force = expose and make it the named first tool · expose = only put it in the pool (model still decides). */
export type TurnRoutePinMode = 'force' | 'expose';

export interface TurnRoutePin {
  pluginId: string;
  toolName: string;
  /** Observation label for the pinned route. */
  reason: string;
  /** undefined = this pin does not apply to the line. */
  mode(line: string): TurnRoutePinMode | undefined;
}

export interface TurnRoutePinDecision {
  tool: LLMToolSpec;
  pluginId: string;
  reason: string;
  mode: TurnRoutePinMode;
}

/** Explicit opt-outs win over the creation cue («앱 만들지 말고 …», «don't build an app»). */
const APP_BUILD_OPT_OUT = /((?:만들|생성하|구축하|개발하|제작하)지\s*(?:말|마|않)|\b(?:don'?t|do not|never|without)\s+(?:build|create|make|develop|building|creating|making)\b)/i;

export function wantsAppBuildRoute(line: string): boolean {
  return classifyAppBuildIntent(line) && !APP_BUILD_OPT_OUT.test(line);
}

/** Work about code/ops rather than a user-facing product (tests, prompts, docs, checks) never forces app_build. */
const NOT_A_PRODUCT = /(테스트|시험|프롬프트|문서|주석|설명서|스크립트|함수|클래스|모듈|확인|점검|상태|로그|\b(?:tests?|unit|specs?|prompts?|docs?|documentation|readme|scripts?|functions?|class|modules?|sure|check|status|running|logs?|logging)\b)/i;
/** Nouns that are themselves a user-facing product. */
const PRODUCT_NOUN = /(앱|어플|애플리케이션|어플리케이션|웹앱|웹사이트|홈페이지|사이트|\b(?:apps?|application|web ?app|website|site)\b)/i;
/** «서비스·시스템·플랫폼» are a product only next to something end users do there. */
const GENERIC_NOUN = /(서비스|시스템|플랫폼|\b(?:service|system|platform)\b)/i;
const USER_DOMAIN = /(예약|예매|티켓|티케팅|쇼핑|주문|게시판|커뮤니티|회원|신청|접수|강습|수강|\b(?:booking|reservations?|tickets?|ticketing|shop(?:ping)?|store|orders?|community|signups?|members?)\b)/i;

/** The person asks for research as a step of the request («리서치해서 … 만들어줘»): that step must not be skipped. */
const EXPLICIT_RESEARCH_ASK = /(리서치|조사|찾아보|검색해|알아보|분석해|\b(?:research|investigate|look\s*up|search)\b)/i;

/** High confidence → force; any other app-creation cue → expose only; otherwise no pin. An app line that asks for
 *  research is exposed, never forced (#38215 REVIEW-2): the research runs and the app route is offered after it. */
export function appBuildRouteMode(line: string): TurnRoutePinMode | undefined {
  if (!wantsAppBuildRoute(line)) return undefined;
  if (NOT_A_PRODUCT.test(line) || EXPLICIT_RESEARCH_ASK.test(line)) return 'expose';
  return PRODUCT_NOUN.test(line) || (GENERIC_NOUN.test(line) && USER_DOMAIN.test(line)) ? 'force' : 'expose';
}

export const TURN_ROUTE_PINS: readonly TurnRoutePin[] = [
  { pluginId: APP_BUILD_PLUGIN_ID, toolName: APP_BUILD_TOOL_NAME, reason: 'app-build-intent', mode: appBuildRouteMode },
];

/** First matching pin whose exact plugin route tool is in `tools`; undefined leaves the turn unchanged. */
export function resolveTurnRoutePin(
  userText: string | undefined,
  tools: readonly LLMToolSpec[],
  pins: readonly TurnRoutePin[] = TURN_ROUTE_PINS,
): TurnRoutePinDecision | undefined {
  const line = userText?.trim();
  if (!line) return undefined;
  for (const pin of pins) {
    const tool = tools.find((candidate) => candidate.name === pin.toolName && candidate.pluginId === pin.pluginId);
    const mode = tool ? pin.mode(line) : undefined;
    if (tool && mode) return { tool, pluginId: pin.pluginId, reason: pin.reason, mode };
  }
  return undefined;
}
